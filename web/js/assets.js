// Loading and building three.js objects from the exported Slune / Soya3D data.
import * as THREE from 'three';

const BASE = 'assets/';
const jsonCache = new Map();
export async function loadJSON(path) {
  if (!jsonCache.has(path)) jsonCache.set(path, fetch(BASE + path).then(r => {
    if (!r.ok) throw new Error(path + ': ' + r.status);
    return r.json();
  }));
  return jsonCache.get(path);
}

function b64(s) {
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
export const f32 = s => new Float32Array(b64(s).buffer);
export const u8 = s => b64(s);

// Soya stores matrices column-major like OpenGL; so does THREE.Matrix4.fromArray.
export const mat4 = a => new THREE.Matrix4().fromArray(a);
export function chainMatrix(chain) {
  const m = new THREE.Matrix4();
  for (const c of chain) m.multiply(mat4(c));
  return m;
}

// ------------------------------------------------------------------ materials
let MATERIALS = null;
const texCache = new Map();
const texLoader = new THREE.TextureLoader();
const pendingTextures = [];
// Resolves once every texture requested so far has loaded (or failed).
export const texturesReady = () => Promise.all(pendingTextures.splice(0));

export async function initMaterials() { MATERIALS = await loadJSON('materials.json'); }
export const materialInfo = name => (MATERIALS && MATERIALS[name]) || null;

export function texture(name) {
  const info = materialInfo(name);
  if (!info || !info.texture) return null;
  if (!texCache.has(name)) {
    let done;
    pendingTextures.push(new Promise(r => (done = r)));
    const t = texLoader.load(BASE + 'textures/' + info.texture, done, undefined, done);
    // Soya uploads image rows top-first and samples them with OpenGL's convention.
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = info.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    t.anisotropy = 4;
    texCache.set(name, t);
  }
  return texCache.get(name);
}

// A three-step ramp, the look of Soya's cell-shading shader texture.
const toonRamp = (() => {
  const d = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
})();

const matCache = new Map();
export function surface(name, { toon = false, double = false, vertexColors = false } = {}) {
  const key = [name, toon, double, vertexColors].join('|');
  if (matCache.has(key)) return matCache.get(key);
  const info = materialInfo(name) || { diffuse: [1, 1, 1, 1], emissive: [0, 0, 0, 1] };
  const map = texture(name);
  const params = {
    color: new THREE.Color().setRGB(info.diffuse[0], info.diffuse[1], info.diffuse[2], THREE.SRGBColorSpace),
    map, side: double ? THREE.DoubleSide : THREE.FrontSide, vertexColors,
  };
  let m;
  if (info.additive) {
    m = new THREE.MeshBasicMaterial({ ...params, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  } else {
    if (toon) m = new THREE.MeshToonMaterial({ ...params, gradientMap: toonRamp });
    else m = new THREE.MeshLambertMaterial(params);
    const e = info.emissive || [0, 0, 0];
    if (e[0] + e[1] + e[2] > 0) m.emissive = new THREE.Color(e[0], e[1], e[2]);
    if (info.alpha && map && info.channels === 4) {
      if (info.mask) m.alphaTest = 0.5;
      else { m.transparent = true; m.alphaTest = 0.05; m.depthWrite = !!info.mask; }
    }
    if (info.diffuse[3] < 1) { m.transparent = true; m.opacity = info.diffuse[3]; }
  }
  matCache.set(key, m);
  return m;
}

// Black inverted-hull outline, standing in for Soya's cell-shading outline pass.
const outlineMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
outlineMat.onBeforeCompile = sh => {
  sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>',
    'vec3 transformed = position + normalize(normal) * 0.025;');
};

// --------------------------------------------------------------------- models
const modelData = new Map();
const modelReady = new Map();
export async function loadModel(name) {
  if (!modelData.has(name)) modelData.set(name, loadJSON('models/' + name + '.json').then(buildModelData).then(md => (modelReady.set(name, md), md)));
  return modelData.get(name);
}
// Synchronous access to an already loaded model (scripts create props mid-sequence).
export function modelSync(name) {
  const md = modelReady.get(name);
  if (!md) throw new Error('model not preloaded: ' + name);
  return md;
}

function buildModelData(d) {
  const groups = d.groups.map(g => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(f32(g.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(f32(g.nrm), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(f32(g.uv), 2));
    const col = f32(g.col);
    let hasColor = false;
    for (let i = 0; i < col.length; i++) if (col[i] !== 1) { hasColor = true; break; }
    if (hasColor) geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.computeBoundingSphere();
    return { geo, material: g.material, solid: g.solid, double: g.double, hasColor };
  });
  return { name: d.name, toon: d.class.startsWith('CellShading'), outline: d.outline, groups, sphere: d.sphere };
}

export function instantiate(md, { outline = true } = {}) {
  const obj = new THREE.Group();
  obj.name = md.name;
  for (const g of md.groups) {
    const m = new THREE.Mesh(g.geo, surface(g.material, { toon: md.toon, double: g.double, vertexColors: g.hasColor }));
    m.castShadow = false;
    obj.add(m);
    if (md.toon && outline && !materialInfo(g.material)?.additive) {
      const o = new THREE.Mesh(g.geo, outlineMat);
      o.renderOrder = -1;
      obj.add(o);
    }
  }
  return obj;
}

// Collect solid triangles of a model, transformed to world space.
export function solidTriangles(md, matrix, out) {
  const v = new THREE.Vector3();
  for (const g of md.groups) {
    if (!g.solid) continue;
    const p = g.geo.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(matrix);
      out.push(v.x, v.y, v.z);
    }
    if (g.double) {  // add the reversed winding too so culled rays see both sides
      for (let i = 0; i < p.length; i += 9) {
        for (const k of [0, 6, 3]) {
          v.set(p[i + k], p[i + k + 1], p[i + k + 2]).applyMatrix4(matrix);
          out.push(v.x, v.y, v.z);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------- world
const VERTEX_HIDDEN = 1, VERTEX_NON_SOLID = 4;

function buildTerrain(t, collide) {
  const W = t.w, D = t.d, s = t.scale, tf = t.texture_factor;
  const h = f32(t.heights), mi = u8(t.mat_index);
  const vo = t.vertex_options ? u8(t.vertex_options) : null;
  const m = chainMatrix(t.chain);
  const nVert = W * D;
  const pos = new Float32Array(nVert * 3), uv = new Float32Array(nVert * 2);
  for (let i = 0; i < D; i++) for (let j = 0; j < W; j++) {
    const k = j + i * W;
    pos[k * 3] = j * s; pos[k * 3 + 1] = h[k]; pos[k * 3 + 2] = i * s;
    uv[k * 2] = j * tf; uv[k * 2 + 1] = i * tf;
  }
  // Triangulation and winding follow Soya's Terrain._compute_normals:
  // quad (v1..v4) = (x,z) (x+1,z) (x+1,z+1) (x,z+1), diagonal alternating by parity.
  const byMat = t.materials.map(() => []);
  const tri = (a, b, c) => {
    // Soya drops a triangle only when all three vertices are hidden / non-solid.
    if (vo && (vo[a] & vo[b] & vo[c] & VERTEX_HIDDEN)) return;
    let mat = mi[a];
    if (mi[b] === mi[c]) mat = mi[b];
    byMat[mat].push(a, b, c);
    if (!(vo && (vo[a] & vo[b] & vo[c] & VERTEX_NON_SOLID))) collide.terrain.push(a, b, c);
  };
  for (let z = 0; z < D - 1; z++) for (let x = 0; x < W - 1; x++) {
    const v1 = x + z * W, v2 = v1 + 1, v4 = v1 + W, v3 = v4 + 1;
    if ((x & 1) === (z & 1)) { tri(v4, v3, v1); tri(v2, v1, v3); }
    else { tri(v1, v4, v2); tri(v3, v2, v4); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const index = [];
  const mats = [];
  byMat.forEach((list, k) => {
    if (!list.length) return;
    geo.addGroup(index.length, list.length, mats.length);
    for (const x of list) index.push(x);
    mats.push(surface(t.materials[k]));
  });
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.applyMatrix4(m);
  const mesh = new THREE.Mesh(geo, mats);
  // Collision triangles in world space.
  const wp = geo.attributes.position.array;
  for (const k of collide.terrain) collide.tris.push(wp[k * 3], wp[k * 3 + 1], wp[k * 3 + 2]);
  collide.terrain.length = 0;
  return mesh;
}

function skyDome(atm) {
  const horizon = new THREE.Color().fromArray(atm.fog ? atm.fog_color : atm.bg_color);
  const zenith = new THREE.Color().fromArray((atm.sky_color || atm.bg_color).map(x => Math.min(1, x)));
  const geo = new THREE.SphereGeometry(900, 32, 16);
  const col = [];
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = Math.max(0, p.getY(i) / 900);
    const c = horizon.clone().lerp(zenith, Math.pow(y, 0.6));
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  dome.renderOrder = -10;
  const g = new THREE.Group();
  g.add(dome);
  if (atm.cloud && texture(atm.cloud)) {
    const t = texture(atm.cloud).clone();
    t.repeat.set(6, 6);
    t.needsUpdate = true;
    const clouds = new THREE.Mesh(new THREE.CircleGeometry(880, 48), new THREE.MeshBasicMaterial({
      map: t, transparent: true, depthWrite: false, fog: false, opacity: 0.85, side: THREE.DoubleSide,
    }));
    clouds.rotation.x = Math.PI / 2;
    clouds.position.y = 120;
    clouds.renderOrder = -9;
    g.add(clouds);
    g.userData.clouds = t;
  }
  return g;
}

export async function buildWorld(name, vision = 1.0, atmosphereOverride = null) {
  // A level may have no world file at all (mission 12 is only sky and an airplane).
  const w = name ? await loadJSON('worlds/' + name + '.json') : { terrains: [], bodies: [], lights: [] };
  if (atmosphereOverride) w.atmosphere = atmosphereOverride;
  const group = new THREE.Group();
  const collide = { tris: [], terrain: [] };
  const named = [];
  for (const t of w.terrains) group.add(buildTerrain(t, collide));
  for (const b of w.bodies) {
    if (!b.model) continue;
    const md = await loadModel(b.model);
    const m = chainMatrix(b.chain);
    if (b.name) { named.push({ name: b.name, md, matrix: m }); continue; }  // movable (doors): built by the game
    const o = instantiate(md, { outline: false });
    o.matrixAutoUpdate = false;
    o.matrix.copy(m);
    group.add(o);
    solidTriangles(md, m, collide.tris);
  }
  const atm = w.atmosphere || { fog: false, bg_color: [0.3, 0.3, 0.5, 1], ambient: [0.5, 0.5, 0.5, 1] };
  const lights = [];
  const amb = atm.ambient || [0.5, 0.5, 0.5, 1];
  lights.push(new THREE.AmbientLight(new THREE.Color(amb[0], amb[1], amb[2]), 1.0 * Math.PI));
  for (const l of w.lights) {
    const m = chainMatrix(l.chain);
    const c = new THREE.Color(l.diffuse[0], l.diffuse[1], l.diffuse[2]);
    if (l.w === 0) {
      // Directional: Soya lights shine along their local -Z axis.
      const dir = new THREE.Vector3(0, 0, -1).transformDirection(m);
      const dl = new THREE.DirectionalLight(c, 1.0 * Math.PI);
      dl.position.copy(dir).multiplyScalar(-100);
      lights.push(dl);
    } else {
      const pl = new THREE.PointLight(c, 1.0 * Math.PI, 0, 0);
      pl.position.setFromMatrixPosition(m);
      lights.push(pl);
    }
  }
  if (!w.lights.length) {  // night levels rely on character headlights
    const dl = new THREE.DirectionalLight(0x445588, 0.6 * Math.PI);
    dl.position.set(30, 100, 20);
    lights.push(dl);
  }
  for (const l of lights) group.add(l);
  const fogEnd = (atm.fog_end || 60) * vision;
  const fog = new THREE.Fog(new THREE.Color().fromArray(atm.fog ? atm.fog_color : atm.bg_color),
    (atm.fog_start || 20) * vision, fogEnd);
  const sky = skyDome(atm);
  return { group, tris: new Float32Array(collide.tris), fog, sky, far: fogEnd + 10, atmosphere: atm, named };
}

const localTris = new Map();
export function modelTriangles(md) {
  if (!localTris.has(md)) { const out = []; solidTriangles(md, new THREE.Matrix4(), out); localTris.set(md, new Float32Array(out)); }
  return localTris.get(md);
}
