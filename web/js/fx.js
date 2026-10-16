// Particle effects modelled on the soya.Particles subclasses in Slune
// (Explosion, Nitro, FlameThrower, LifeBonusParticle, Smoke).
import * as THREE from 'three';
import { texture } from './assets.js';

const MAX = 4000;
const vert = `
attribute float size; attribute vec4 pcolor; varying vec4 vColor;
void main() {
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * 600.0 / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const frag = `
uniform sampler2D map; varying vec4 vColor;
void main() {
  vec4 t = texture2D(map, gl_PointCoord);
  gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
  if (gl_FragColor.a < 0.01) discard;
}`;

function gradient(colors, t) {
  const n = colors.length - 1, x = Math.min(0.9999, Math.max(0, t)) * n, i = Math.floor(x), f = x - i;
  const a = colors[i], b = colors[Math.min(n, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

const EXPLOSION = [[0.9, 0.0, 0.2, 0.4], [0.9, 0.2, 0.2, 0.8], [0.8, 0.7, 0.1, 0.9], [0.6, 0.4, 0.2, 0.2]];
const NITRO = [[0.4, 0.7, 0.8, 0.4], [0.2, 0.7, 0.9, 0.8], [0.2, 0.9, 0.9, 0.9], [0.1, 0.3, 0.3, 0.2]];
const FLAME = [[0.0, 0.8, 0.0, 0.4], [0.1, 0.8, 0.1, 0.9], [0.8, 0.1, 0.1, 0.9], [0.1, 0.1, 0.8, 0.9], [0.2, 0.2, 0.8, 0.2]];
const LIFE = [[0.2, 0.0, 0.1, 1.0], [1.0, 0.2, 0.6, 1.0], [0.1, 0.0, 0.0, 1.0]];
const SMOKE = [[1.0, 1.0, 0.6, 0.8], [1.0, 0.9, 0.3, 0.5], [0.6, 0.6, 0.6, 0.0]];

export class FX {
  constructor(scene) {
    this.p = [];
    this.emitters = [];
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 4);
    this.size = new Float32Array(MAX);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const map = texture('halo-noadd') || texture('halo');
    this.mat = new THREE.ShaderMaterial({ uniforms: { map: { value: map } }, vertexShader: vert, fragmentShader: frag,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }
  get explosions() { return this.emitters.filter(e => e.kind === 'explosion' || e.kind === 'flame').length; }

  spawn(pos, vel, acc, life, colors, size) {
    if (this.p.length >= MAX) return;
    this.p.push({ pos: pos.clone(), vel, acc, life, max: life, colors, size });
  }
  // Explosion.generate
  explosion(at, rounds = 25, size = 1.0, max = 30) {
    const origin = at.clone();
    this.emitters.push({ kind: 'explosion', rounds, max, alive: 0, gen: () => {
      const angle = Math.random() * 3.1417;
      const sx = Math.cos(angle), sy = -Math.sqrt(Math.random() * 3.0), sz = Math.sin(angle);
      const l = (0.06 * (1.5 + Math.random())) / Math.sqrt(sx * sx + sy * sy + sz * sz);
      return [origin, new THREE.Vector3(sx * l, -sy * l, sz * l), new THREE.Vector3(0, 0.01, 0), (0.5 + Math.random()) * 33, EXPLOSION, size];
    } });
  }
  // Nitro: cyan trail particles left behind the vehicle
  nitro(ch) {
    for (let i = 0; i < 4; i++) {
      const p = ch.localPoint((Math.random() - 0.5) * 0.2, 0.15 + (Math.random() - 0.5) * 0.2, 0.5);
      this.spawn(p, new THREE.Vector3(), new THREE.Vector3(), (0.5 + Math.random()) * 20, NITRO, 0.7);
    }
  }
  flameThrower(ch) {
    this.emitters.push({ kind: 'flame', rounds: 30, max: 35, alive: 0, owner: ch, gen: () => {
      const v = ch.toWorld(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, -1.0 - Math.random() * 0.5));
      const a = ch.toWorld(new THREE.Vector3(0, 0, 0.02));
      return [ch.localPoint(0, 0.3, -0.6), v, a, (0.5 + Math.random()) * 25, FLAME, 1.6];
    } });
  }
  lifeBonus(at) {
    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * 3.1417;
      const sx = Math.cos(angle), sy = -Math.sqrt(Math.random() * 3.0), sz = Math.sin(angle);
      const l = (0.06 * (1.5 + Math.random())) / Math.sqrt(sx * sx + sy * sy + sz * sz);
      this.spawn(at, new THREE.Vector3(sx * l, sy * l, sz * l), new THREE.Vector3(0, 0.03, 0), (0.5 + Math.random()) * 25, LIFE, 0.8);
    }
  }
  smoke(at) {
    for (let i = 0; i < 25; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(0.15);
      this.spawn(at, v, new THREE.Vector3(0, -0.004, 0), (0.6 + Math.random()) * 25, SMOKE, 1.2);
    }
  }
  round() {
    for (const e of this.emitters) {
      if (e.rounds <= 0) continue;
      e.rounds--;
      e.alive = this.p.filter(p => p.em === e).length;
      for (let k = 0; k < 6 && e.alive < e.max; k++, e.alive++) {
        const [pos, vel, acc, life, colors, size] = e.gen();
        this.spawn(pos, vel, acc, life, colors, size);
        this.p[this.p.length - 1].em = e;
      }
    }
    this.emitters = this.emitters.filter(e => e.rounds > 0);
    for (const p of this.p) { p.pos.add(p.vel); p.vel.add(p.acc); p.life--; }
    this.p = this.p.filter(p => p.life > 0);
  }
  render() {
    const n = this.p.length;
    for (let i = 0; i < n; i++) {
      const p = this.p[i];
      this.pos[i * 3] = p.pos.x; this.pos[i * 3 + 1] = p.pos.y; this.pos[i * 3 + 2] = p.pos.z;
      const c = gradient(p.colors, 1 - p.life / p.max);
      this.col.set(c, i * 4);
      this.size[i] = p.size;
    }
    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = this.geo.attributes.pcolor.needsUpdate = this.geo.attributes.size.needsUpdate = true;
  }
  clear() { this.p.length = 0; this.emitters.length = 0; }
}
