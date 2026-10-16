"""Decode Soya3D C-state blobs (as found in Slune .data files) into plain data.

Formats were reverse engineered from the __getcstate__/__setcstate__ methods of
Soya 0.12's Pyrex sources (soya3d/*.pyx, model/*.pyx). All numbers are written
by chunk_add_*_endian_safe, i.e. big-endian 32-bit ints / floats.
"""
import struct

import soyapickle as sp


class Reader:
    def __init__(self, data):
        self.d, self.p = data, 0

    def i(self, n=None):
        k = 1 if n is None else n
        v = struct.unpack_from(">%di" % k, self.d, self.p)
        self.p += 4 * k
        return v[0] if n is None else list(v)

    def f(self, n=None):
        k = 1 if n is None else n
        v = struct.unpack_from(">%df" % k, self.d, self.p)
        self.p += 4 * k
        return v[0] if n is None else list(v)

    def c(self, n):
        v = self.d[self.p:self.p + n]
        self.p += n
        return v

    def left(self):
        return len(self.d) - self.p


# ---- option bits (definitions/base.pxd) ----
MODEL_DIFFUSES = 1 << 5
MODEL_EMISSIVES = 1 << 6
MODEL_TEXCOORDS = 1 << 8
MODEL_VERTEX_OPTIONS = 1 << 10
MODEL_NEIGHBORS = 1 << 15
MODEL_HAS_SPHERE = 1 << 20
MODEL_SIMPLE_NEIGHBORS = 1 << 24
FACE_TRIANGLE, FACE_QUAD, FACE_NON_SOLID, FACE_HIDDEN, FACE_ALPHA, FACE_DOUBLE_SIDED = 1, 2, 4, 8, 16, 32
FACE_SMOOTH_LIT = 1 << 6
FACE_NON_LIT = 1 << 10
TERRAIN_VERTEX_OPTIONS = 1 << 7
TERRAIN_COLORED = 1 << 8
MATERIAL_ADDITIVE_BLENDING, MATERIAL_ALPHA, MATERIAL_MASK, MATERIAL_CLAMP = 4, 8, 16, 32
MATERIAL_ENVIRONMENT_MAPPING = 64


def s(b):
    return b.decode("latin-1") if isinstance(b, bytes) else b


def coordsyst(blob):
    r = Reader(blob)
    opt = r.i()
    m = r.f(19)
    return opt, m[:16], m[16:19]


def ref(o):
    """A reference to an external Soya object: returns (kind, name)."""
    if isinstance(o, sp.Loaded):
        cls = o.args[0]
        return {"ref": getattr(cls, "cls", str(cls)).split(".")[-1], "name": s(o.args[1])}
    return None


def attrs(st):
    """Python-side __dict__ of an object (state[1]), with bytes keys decoded."""
    if len(st) > 1 and isinstance(st[1], dict):
        return {s(k): v for k, v in st[1].items()}
    return {}


def plain(v, conv):
    if isinstance(v, bytes):
        return s(v)
    if isinstance(v, (int, float, str)) or v is None:
        return v
    if isinstance(v, (list, tuple)):
        return [plain(x, conv) for x in v]
    if isinstance(v, dict):
        return {s(k): plain(x, conv) for k, x in v.items()}
    return conv(v)


# ---------------------------------------------------------------- materials
def image(o):
    st = o.state[0]
    blob, filename = (st[0], st[1]) if isinstance(st, tuple) else (st, None)
    r = Reader(blob)
    nb, w, h = r.i(3)
    px = r.c(nb * w * h)
    assert r.left() == 0, ("image trailing", r.left())
    return {"channels": nb, "width": w, "height": h, "pixels": px, "filename": s(filename)}


def material(o):
    if isinstance(o, sp.Loaded):
        return ref(o)
    if o is None:
        return None
    blob, filename, tex = o.state[0]
    r = Reader(blob)
    m = {
        "option": r.i(),
        "shininess": r.f(),
        "diffuse": r.f(4),
        "specular": r.f(4),
        "emissive": r.f(4),
        "filename": s(filename),
        "texture": image(tex) if tex is not None and not isinstance(tex, sp.Loaded) else ref(tex),
    }
    opt = m["option"]
    m["additive"] = bool(opt & MATERIAL_ADDITIVE_BLENDING)
    m["alpha"] = bool(opt & MATERIAL_ALPHA)
    m["mask"] = bool(opt & MATERIAL_MASK)
    m["clamp"] = bool(opt & MATERIAL_CLAMP)
    m["envmap"] = bool(opt & MATERIAL_ENVIRONMENT_MAPPING)
    return m


# ------------------------------------------------------------------- models
def simple_model(cstate):
    blob, filename, materials = cstate
    r = Reader(blob)
    opt, nv, nc, nn, ncol, nval, nf = r.i(7)
    M = {"option": opt, "filename": s(filename)}
    M["coords"] = r.f(3 * nc)
    M["vnormals"] = r.f(3 * nn)
    M["colors"] = r.f(4 * ncol)
    M["values"] = r.f(nval)
    M["vertex_coords"] = r.i(nv)
    if opt & MODEL_VERTEX_OPTIONS:
        M["vertex_options"] = list(r.c(nv))
    if opt & MODEL_TEXCOORDS:
        M["vertex_texcoords"] = r.i(nv)
    if opt & MODEL_DIFFUSES:
        M["vertex_diffuses"] = r.i(nv)
    if opt & MODEL_EMISSIVES:
        M["vertex_emissives"] = r.i(nv)
    if opt & MODEL_HAS_SPHERE:
        M["sphere"] = r.f(4)
    faces = []
    for _ in range(nf):
        fo, mat, normal = r.i(3)
        v = r.i(4)
        faces.append((fo, mat, normal, v))
    M["faces"] = faces
    if opt & MODEL_NEIGHBORS:
        r.i(nf * 4); r.c(nf * 4)
    if opt & MODEL_SIMPLE_NEIGHBORS:
        r.i(nf * 4); r.c(nf * 4)
    assert r.left() == 0, ("model trailing", r.left())
    M["materials"] = [material(m) for m in materials]
    return M


def model(o):
    if isinstance(o, sp.Loaded) or o is None:
        return ref(o)
    cls = o.cls.split(".")[-1]
    st = o.state[0]
    if cls in ("SimpleShape", "SimpleModel", "Shape", "Model", "SolidShape", "SolidModel"):
        M = simple_model(st)
    elif cls in ("CellShadingShape", "CellShadingModel"):
        M = simple_model(st[0])
        r = Reader(st[1])
        M["outline_width"], M["outline_attenuation"] = r.f(2)
        M["outline_color"] = r.f(4)
        M["shader"] = material(st[2])
    elif cls in ("TreeShape", "TreeModel"):
        M = simple_model(st[0])  # st[1] is the BSP-like culling tree; not needed
    else:
        raise ValueError("unknown model class " + cls)
    M["class"] = cls
    return M


def model_to_mesh(M):
    """Flatten a Soya model into per-material triangle lists.

    Each Soya "vertex" indexes into shared coord / texcoord / color arrays.
    Returns {material_index: {"pos": [...], "uv": [...], "col": [...], "nrm": [...], "flags": set}}.
    """
    coords, vals, cols, vn = M["coords"], M["values"], M["colors"], M["vnormals"]
    vc, vt = M["vertex_coords"], M.get("vertex_texcoords")
    vd = M.get("vertex_diffuses")
    out = {}

    def emit(g, vi, smooth, fnormal):
        c = vc[vi]  # already an offset into coords (multiple of 3)
        g["pos"] += coords[c:c + 3]
        # Smooth-lit faces use the vertex normal stored at the coord's offset
        # (model.pyx: glNormal3fv(self._vnormals + self._vertex_coords[index]));
        # flat faces use the face plane normal stored in _values.
        if smooth and c + 3 <= len(vn):
            g["nrm"] += vn[c:c + 3]
        else:
            g["nrm"] += fnormal
        if vt is not None:
            t = vt[vi]
            g["uv"] += vals[t:t + 2]
        else:
            g["uv"] += [0.0, 0.0]
        if vd is not None:
            d = vd[vi]
            g["col"] += cols[d:d + 4]
        else:
            g["col"] += [1.0, 1.0, 1.0, 1.0]

    for fo, mat, normal, v in M["faces"]:
        if fo & FACE_HIDDEN:
            continue
        solid = not (fo & FACE_NON_SOLID)
        double = bool(fo & FACE_DOUBLE_SIDED)
        g = out.setdefault((mat, solid, double), {"pos": [], "uv": [], "col": [], "nrm": [], "alpha": False})
        if fo & FACE_ALPHA:
            g["alpha"] = True
        fnormal = vals[normal:normal + 3] if 0 <= normal and normal + 3 <= len(vals) else [0.0, 1.0, 0.0]
        smooth = bool(fo & FACE_SMOOTH_LIT)
        tris = [(v[0], v[1], v[2])]
        if fo & FACE_QUAD:
            tris.append((v[0], v[2], v[3]))
        for t in tris:
            for vi in t:
                emit(g, vi, smooth, fnormal)
    return out


# ------------------------------------------------------------------ terrain
def terrain(o):
    blob, materials = o.state[0]
    r = Reader(blob)
    T = {"option": r.i(), "matrix": r.f(19)[:16]}
    T["w"], T["d"], T["patch_size"] = r.i(3)
    T["texture_factor"], T["scale_factor"], T["split_factor"] = r.f(3)
    nb_colors = r.i()
    nb = T["w"] * T["d"]
    if T["option"] & TERRAIN_COLORED and nb_colors > 0:
        T["colors"] = r.f(4 * nb_colors)
        T["vertex_colors"] = r.i(nb)
    if T["option"] & TERRAIN_VERTEX_OPTIONS:
        T["vertex_options"] = list(r.c(nb))
    hm = struct.unpack_from(">" + "fi" * nb, r.d, r.p)
    r.p += 8 * nb
    T["heights"] = list(hm[0::2])
    T["mat_index"] = list(hm[1::2])
    assert r.left() == 0, ("terrain trailing", r.left())
    T["materials"] = [material(m) for m in materials]
    return T


# ------------------------------------------------------------- scene graph
WORLD_CLASSES = {"World", "Level"}


def node(o):
    """Convert a scene-graph object to a plain dict."""
    if isinstance(o, sp.Loaded):
        return ref(o)
    if not isinstance(o, sp.Stub):
        return plain(o, node)
    full = o.cls
    cls = full.split(".")[-1]
    st = o.state
    cst = st[0]
    a = attrs(st)
    if cls in ("Point", "Vector"):
        r = Reader(cst[0])
        return {"type": cls.lower(), "xyz": r.f(3)}
    n = {"type": None, "class": full}
    if cls in ("Land", "Terrain"):
        n.update(type="terrain", terrain=terrain(o))
    elif cls == "Light":
        r = Reader(cst)
        opt = r.i(); m = r.f(19)
        n.update(type="light", option=opt, matrix=m[:16])
        n["radius"], n["angle"], n["exponent"], n["linear"], n["constant"], n["quadratic"], n["w"] = r.f(7)
        c = r.f(16)
        n["ambient"], n["diffuse"], n["specular"], n["shadow_color"] = c[0:4], c[4:8], c[8:12], c[12:16]
    elif cls in ("Atmosphere", "SkyAtmosphere"):
        blob = cst[0] if isinstance(cst, tuple) else cst
        r = Reader(blob)
        n.update(type="atmosphere", option=r.i(), fog_type=r.i())
        n["fog_start"], n["fog_end"], n["fog_density"] = r.f(3)
        n["ambient"], n["bg_color"], n["fog_color"] = r.f(4), r.f(4), r.f(4)
        if cls == "SkyAtmosphere":
            n["sky_color"] = r.f(4)
            if r.left() >= 4:
                n["cloud_scale"] = r.f()
            n["cloud"] = material(cst[1])
            n["sky_box"] = [material(x) for x in cst[2]]
        n["fog"] = bool(n["option"] & (1 << 3))  # ATMOSPHERE_FOG
    elif cls in ("Bonus", "Sprite", "CameraSprite", "CylinderSprite", "Flag", "LifeBonus", "FlameThrowerBonus"):
        blob, mat, halo = cst
        r = Reader(blob)
        opt = r.i(); m = r.f(19)
        n.update(type="bonus", option=opt, matrix=m[:16], color=r.f(4), material=material(mat), halo=material(halo))
    elif cls in ("Smoke", "Particles", "FlagFirework", "Fountain"):
        n.update(type="particles")
    elif isinstance(cst, tuple) and len(cst) >= 6 and isinstance(cst[0], bytes):
        # World-like: (coordsyst, model, filename, children, atmosphere, model_builder[, data])
        opt, m, _ = coordsyst(cst[0])
        n.update(type="world", option=opt, matrix=m, model=model(cst[1]), filename=s(cst[2]),
                 children=[node(c) for c in (cst[3] or [])], atmosphere=node(cst[4]) if cst[4] is not None else None)
    elif isinstance(cst, tuple) and len(cst) in (2, 3) and isinstance(cst[0], bytes) and len(cst[0]) == 80:
        # Body / Volume: (coordsyst, model[, data])
        opt, m, _ = coordsyst(cst[0])
        n.update(type="body", option=opt, matrix=m, model=model(cst[1]))
    elif isinstance(cst, bytes) and len(cst) == 80:
        opt, m, _ = coordsyst(cst)
        n.update(type="coordsyst", option=opt, matrix=m)
    else:
        n.update(type="unknown")
    if a:
        n["attrs"] = {k: plain(v, node) for k, v in a.items() if k not in ("context",)}
    return n
