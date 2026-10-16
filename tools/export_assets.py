"""Export Slune 1.0.14 assets into web-friendly JSON + PNG.

usage: python3 -I export_assets.py <Slune-1.0.14 dir> <output assets dir>

Outputs
  textures/<name>.png        one per material with an embedded image
  materials.json             material properties
  models/<name>.json         triangle groups per material (base64 float32)
  worlds/<name>.json         terrain heightmap, lights, atmosphere, static bodies
  levels/<name>.json         race levels: flags, bonuses, pushables, start grid
  index.json                 list of exported race levels
"""
import ast, base64, glob, json, os, re, struct, sys, zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import soyapickle as sp
import soyadecode as sd


def b64f(arr):
    return base64.b64encode(struct.pack("<%df" % len(arr), *arr)).decode()


def b64u8(arr):
    return base64.b64encode(bytes(arr)).decode()


def png(path, w, h, channels, pixels):
    ctype = {1: 0, 3: 2, 4: 6}[channels]
    stride = w * channels
    raw = b"".join(b"\x00" + pixels[y * stride:(y + 1) * stride] for y in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ctype, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def r4(v):
    return [round(x, 4) for x in v]


def mat_name(m):
    if m is None:
        return None
    if isinstance(m, dict) and "ref" in m:
        return m["name"]
    return m.get("filename") or None


# --------------------------------------------------------------- materials
def export_materials(src, out):
    os.makedirs(os.path.join(out, "textures"), exist_ok=True)
    mats = {}
    for f in sorted(glob.glob(os.path.join(src, "materials", "*.data"))):
        name = os.path.basename(f)[:-5]
        m = sd.material(sp.load(f))
        t = m["texture"]
        entry = {k: m[k] for k in ("diffuse", "specular", "emissive", "shininess", "additive", "alpha", "mask", "clamp", "envmap")}
        entry["diffuse"], entry["specular"], entry["emissive"] = r4(m["diffuse"]), r4(m["specular"]), r4(m["emissive"])
        if t and "pixels" in t:
            png(os.path.join(out, "textures", name + ".png"), t["width"], t["height"], t["channels"], t["pixels"])
            entry["texture"] = name + ".png"
            entry["channels"] = t["channels"]
        mats[name] = entry
    json.dump(mats, open(os.path.join(out, "materials.json"), "w"), separators=(",", ":"))
    return mats


# ------------------------------------------------------------------ models
def export_model(M, name, out):
    groups = []
    for (mi, solid, double), g in sorted(sd.model_to_mesh(M).items()):
        groups.append({
            "material": mat_name(M["materials"][mi]),
            "solid": solid,
            "double": double,
            "alpha": g["alpha"],
            "count": len(g["pos"]) // 3,
            "pos": b64f(g["pos"]),
            "nrm": b64f(g["nrm"]),
            "uv": b64f(g["uv"]),
            "col": b64f(g["col"]),
        })
    data = {"name": name, "class": M["class"], "groups": groups}
    if "sphere" in M:
        data["sphere"] = r4(M["sphere"])
    if "outline_width" in M:
        data["outline"] = {"width": M["outline_width"], "color": r4(M["outline_color"])}
    json.dump(data, open(os.path.join(out, "models", name + ".json"), "w"), separators=(",", ":"))
    return data


def export_models(src, out):
    os.makedirs(os.path.join(out, "models"), exist_ok=True)
    names = []
    for f in sorted(glob.glob(os.path.join(src, "shapes", "*.data"))):
        name = os.path.basename(f)[:-5]
        export_model(sd.model(sp.load(f)), name, out)
        names.append(name)
    return names


# ------------------------------------------------------------------ worlds
def collect(world, parent_chain, acc):
    """Walk a world, accumulating terrains / bodies / lights with their matrix chain."""
    for c in world.get("children", []):
        if not isinstance(c, dict):
            continue
        t = c.get("type")
        chain = parent_chain + [c["matrix"]] if "matrix" in c else parent_chain
        if t == "terrain":
            acc["terrains"].append((parent_chain, c["terrain"]))
        elif t == "light":
            acc["lights"].append((parent_chain, c))
        elif t in ("world", "body") and c.get("model"):
            acc["bodies"].append((chain, c))
        if t == "world":
            if c.get("atmosphere") and not acc["atmosphere"]:
                acc["atmosphere"] = c["atmosphere"]
            collect(c, chain, acc)
        elif "ref" in c:
            acc["refs"].append((parent_chain, c))


def export_world(src, out, name):
    w = sd.node(sp.load(os.path.join(src, "worlds", name + ".data")))
    acc = {"terrains": [], "lights": [], "bodies": [], "refs": [], "atmosphere": w.get("atmosphere")}
    if w.get("model"):
        acc["bodies"].append(([w["matrix"]], w))
    collect(w, [w["matrix"]], acc)
    res = {"name": name, "terrains": [], "lights": [], "bodies": []}
    for chain, T in acc["terrains"]:
        res["terrains"].append({
            "chain": [r4(m) for m in chain] + [r4(T["matrix"])],
            "w": T["w"], "d": T["d"],
            "scale": T["scale_factor"], "texture_factor": T["texture_factor"],
            "heights": b64f(T["heights"]),
            "mat_index": b64u8(T["mat_index"]),
            "materials": [mat_name(m) for m in T["materials"]],
            "vertex_options": b64u8(T["vertex_options"]) if "vertex_options" in T else None,
        })
    for chain, L in acc["lights"]:
        res["lights"].append({"chain": [r4(m) for m in chain] + [r4(L["matrix"])],
                              "w": L["w"], "diffuse": r4(L["diffuse"]), "ambient": r4(L["ambient"]),
                              "angle": L["angle"], "linear": L["linear"], "constant": L["constant"], "quadratic": L["quadratic"]})
    for chain, B in acc["bodies"]:
        mref = B["model"]
        res["bodies"].append({"chain": [r4(m) for m in chain], "model": mref.get("name") if isinstance(mref, dict) else None,
                              "name": B.get("attrs", {}).get("name")})
    a = acc["atmosphere"]
    if a:
        res["atmosphere"] = {k: (r4(v) if isinstance(v, list) and v and isinstance(v[0], float) else v)
                             for k, v in a.items() if k in ("fog", "fog_type", "fog_start", "fog_end", "fog_density", "ambient", "bg_color", "fog_color", "sky_color", "cloud_scale")}
        if a.get("cloud"):
            res["atmosphere"]["cloud"] = mat_name(a["cloud"])
        if a.get("sky_box"):
            res["atmosphere"]["sky_box"] = [mat_name(m) for m in a["sky_box"]]
    json.dump(res, open(os.path.join(out, "worlds", name + ".json"), "w"), separators=(",", ":"))
    return res


# ------------------------------------------------------------------ levels
_ALLOWED = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name, ast.Load,
            ast.Add, ast.Sub, ast.Mult, ast.Div, ast.USub, ast.UAdd)


def safe_eval(expr, env):
    """Evaluate a tiny arithmetic expression (numbers, + - * /, named variables)."""
    tree = ast.parse(expr.strip(), mode="eval")
    for n in ast.walk(tree):
        if not isinstance(n, _ALLOWED):
            raise ValueError("disallowed expression: " + expr)

    def ev(n):
        if isinstance(n, ast.Expression): return ev(n.body)
        if isinstance(n, ast.Constant): return float(n.value)
        if isinstance(n, ast.Name): return env[n.id]
        if isinstance(n, ast.UnaryOp): return -ev(n.operand) if isinstance(n.op, ast.USub) else ev(n.operand)
        a, b = ev(n.left), ev(n.right)
        op = type(n.op)
        if op is ast.Add: return a + b
        if op is ast.Sub: return a - b
        if op is ast.Mult: return a * b
        return a / b
    return ev(tree)


def split_args(s):
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "," and depth == 0:
            out.append(cur); cur = ""
            continue
        depth += ch == "("
        depth -= ch == ")"
        cur += ch
    out.append(cur)
    return out


def call_args(line, fn):
    i = line.find(fn + "(")
    if i < 0:
        return None
    j, depth = i + len(fn) + 1, 1
    k = j
    while depth:
        depth += {"(": 1, ")": -1}.get(line[k], 0)
        k += 1
    return line[j:k - 1]


def start_grid(script, nb=4):
    """Interpret Slune's init_character_script for ranks 0..nb-1 without executing it."""
    lines, cur = [], ""
    for l in script.splitlines():
        cur += l.split("#")[0].strip()
        if cur.count("(") <= cur.count(")"):
            if cur: lines.append(cur)
            cur = ""
    grid = []
    for rank in range(nb):
        env = {"rank": float(rank)}
        pos, look, rot, vehicle, headlight = None, None, 0.0, None, False
        for l in lines:
            l2 = l.replace("character.rank", "rank")
            m = re.match(r"^(\w+)\s*=\s*([^=].*)$", l2)
            if m and "(" not in m.group(2):
                env[m.group(1)] = safe_eval(m.group(2), env)
                continue
            a = call_args(l2, "character.set_xyz")
            if a is not None and not l2.startswith("if"):
                pos = [safe_eval(x, env) for x in split_args(a)]
            a = call_args(l2, "character.look_at")
            if a is not None:
                inner = call_args(a, "Vector")
                if inner is not None:
                    parts = split_args(inner)[1:]  # drop the parent coordsyst argument
                    look = [safe_eval(x, env) for x in parts]
                elif call_args(a, "Point") is not None and pos:  # look_at(Point(...)): direction toward it
                    target = [safe_eval(x, env) for x in split_args(call_args(a, "Point"))[1:]]
                    look = [t - p for t, p in zip(target, pos)]
            a = call_args(l2, "character.rotate_lateral")
            if a is not None:
                rot = safe_eval(a, env)
            if "add_headlight" in l2:
                headlight = True
            m = re.search(r"character\.set_vehicle\((\d)\)", l2)
            if m and "vehicle != " in l2 and "not character.played" not in l2:
                vehicle = int(m.group(1))
        grid.append({"pos": pos, "look": look, "rotate_lateral": rot})
    return {"grid": grid, "force_vehicle": vehicle, "headlight": headlight}


def export_level(src, out, name):
    L = sd.node(sp.load(os.path.join(src, "worlds", name + ".data")))
    a = L.get("attrs", {})
    lev = {"name": name, "world": None, "max_laps": a.get("max_laps", 2), "music": a["music_name"] if "music_name" in a else "summum_of_the_light.ogg",
           "flags": [], "bonuses": [], "pushables": [], "vehicles": [], "scripts": [], "volumes": [], "lights": [],
           "preloaded_music": a.get("preloaded_music_name")}
    if L.get("atmosphere"):
        atm = L["atmosphere"]
        lev["atmosphere"] = {k: (r4(v) if isinstance(v, list) and v and isinstance(v[0], float) else v)
                             for k, v in atm.items() if k in ("fog", "fog_type", "fog_start", "fog_end", "fog_density", "ambient", "bg_color", "fog_color", "sky_color")}
        if atm.get("cloud"): lev["atmosphere"]["cloud"] = mat_name(atm["cloud"])
    for c in L["children"]:
        if not isinstance(c, dict):
            continue
        if c.get("ref") == "World":
            lev["world"] = c["name"]
            continue
        cls = c.get("class", "")
        ca = c.get("attrs", {})
        if cls.endswith("race.Flag"):
            try:
                fid = int(ca.get("name", "flag_0")[5:])
            except ValueError:
                fid = 0
            lev["flags"].append({"id": fid, "matrix": r4(c["matrix"])})
        elif cls.endswith(("LifeBonus", "FlameThrowerBonus")):
            lev["bonuses"].append({"kind": "life" if "Life" in cls else "flame", "matrix": r4(c["matrix"])})
        elif cls.endswith("Pushable"):
            mref = c.get("model")
            lev["pushables"].append({
                "name": ca.get("name"),
                "model": mref.get("name") if isinstance(mref, dict) else None,
                "matrix": r4(c["matrix"]),
                "radius": ca.get("radius", 1.0), "radius_y": ca.get("radius_y", 1.0),
                "weight": ca.get("weight", 1.0), "life": ca.get("life", 1.0),
            })
        elif cls.endswith("TakeableVehicle"):
            lev["vehicles"].append({"vehicle": ca.get("vehicle", 3), "matrix": r4(c["matrix"])})
        elif cls.endswith("SphericalScript"):
            lev["scripts"].append({"index": len(lev["scripts"]), "radius": ca.get("radius", 1.0), "matrix": r4(c["matrix"])})
        elif c.get("type") == "light":
            lev["lights"].append({"matrix": r4(c["matrix"]), "w": c["w"], "diffuse": r4(c["diffuse"])})
        elif c.get("type") in ("body", "world") and c.get("model"):
            mref = c["model"]
            lev["volumes"].append({"model": mref.get("name") if isinstance(mref, dict) else None,
                                   "matrix": r4(c["matrix"]), "name": ca.get("name")})
    lev["flags"].sort(key=lambda f: f["id"])
    lev["start"] = start_grid(a.get("init_character_script", ""))
    json.dump(lev, open(os.path.join(out, "levels", name + ".json"), "w"), separators=(",", ":"), indent=None)
    return lev


def parse_po(path):
    """Minimal gettext .po reader: msgid -> msgstr, with continuation lines."""
    out, cur, key, val = {}, None, None, None
    def unq(x):
        return ast.literal_eval(x.strip()) if x.strip().startswith('"') else ""
    for line in open(path, encoding="latin-1"):
        line = line.rstrip("\n")
        if line.startswith("msgid"):
            if key is not None and val is not None: out[key] = val
            key, val, cur = unq(line[5:]), None, "id"
        elif line.startswith("msgstr"):
            val, cur = unq(line[6:]), "str"
        elif line.strip().startswith('"'):
            if cur == "id": key += unq(line)
            elif cur == "str": val += unq(line)
    if key is not None and val is not None: out[key] = val
    out.pop("", None)
    return out


def main(src, out):
    for d in ("worlds", "levels", "sounds"):
        os.makedirs(os.path.join(out, d), exist_ok=True)
    mats = export_materials(src, out)
    print("materials", len(mats))
    models = export_models(src, out)
    print("models", len(models))
    levels, worlds = [], set()
    for f in sorted(glob.glob(os.path.join(src, "worlds", "level-*race*.data"))):
        name = os.path.basename(f)[:-5]
        lev = export_level(src, out, name)
        if not lev["world"] or not lev["flags"]:
            continue
        worlds.add(lev["world"])
        levels.append({"name": name, "world": lev["world"], "flags": len(lev["flags"]), "laps": lev["max_laps"]})
    for w in sorted(worlds):
        res = export_world(src, out, w)
        print("world", w, "terrains", len(res["terrains"]), "bodies", [b["model"] for b in res["bodies"]], "lights", len(res["lights"]))
    extras = []
    for name in ("level-bowling-1", "level-bowling-2", "level-bowling-3", "level-crashfunkel-duel", "level-cyberbombay-arena-1",
                 "level-urbancall-arena-1", "level-indusmeeting-shoot-1", "level-ridepark-clock-1"):
        lev = export_level(src, out, name)
        worlds.add(lev["world"])
        extras.append({"name": name, "world": lev["world"]})
    missions = []
    for i in range(1, 16):
        name = "level-mission-%d" % i
        lev = export_level(src, out, name)
        if lev["world"]: worlds.add(lev["world"])
        missions.append({"name": name, "world": lev["world"]})
    for w in sorted(worlds):
        if not os.path.exists(os.path.join(out, "worlds", w + ".json")):
            res = export_world(src, out, w)
            print("world", w, "terrains", len(res["terrains"]), "bodies", [b["model"] for b in res["bodies"]])
    json.dump(parse_po(os.path.join(src, "locale", "en", "LC_MESSAGES", "slune.po")),
              open(os.path.join(out, "strings.json"), "w"), ensure_ascii=False, indent=0)
    for f in glob.glob(os.path.join(src, "sounds", "*")):
        data = open(f, "rb").read()
        open(os.path.join(out, "sounds", os.path.basename(f)), "wb").write(data)
    json.dump({"levels": levels, "missions": missions, "extras": extras}, open(os.path.join(out, "index.json"), "w"), indent=1)
    print("levels", len(levels))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
