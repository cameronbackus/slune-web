// Port of Slune's opponent AI: controler.goto / Wall_climber / AttackRun and
// race.Opponent.IAControler with its per-character "chromosomes".
// Python generators become JS generators that yield actions {action, mx, my}.
import * as THREE from 'three';
import { A } from './physics.js';

const GOTO_X_2_TURN = 0.21412933552126162;
const GOTO_X_2_SPEED = 0.49762284312684019;
const GOTO_Y_2_SPEED = 0.49762284312684019;
const GOTO_Z_2_SPEED = 1.6085952599320903;
const GOTO_NOGROUND_2_SPEED = -18.661345433135967;
const GOTO_Y_2_JUMP = 0.38818320682881224;
const GOTO_Z_2_JUMP = 0.059585204340943942;
const GOTO_NOGROUND_2_JUMP = 13.608682920401893;

// RaceChromosom(max_speed, innitiative, will, agressivity, turbosity) per (perso, difficulty).
export const CHROMOSOMS = {
  tux:    [[0.2, 80, 30, 0.5, -7.0], [0.6, 30, 50, 0.5, -1.0], [1.1, 20, 50, 0.6, 0.5]],
  gnu:    [[0.1, 50, 60, 0.7, -2.0], [0.5, 15, 90, 0.8, 0.7], [1.0, 10, 150, 0.9, 1.0]],
  shark:  [[0.1, 40, 50, 0.3, -9.0], [0.5, 15, 50, 0.3, -4.0], [1.0, 10, 60, 0.2, 0.0]],
  python: [[0.2, 70, 30, 0.4, -1.0], [0.55, 25, 40, 0.4, 1.3], [1.0, 15, 50, 0.4, 2.0]],
};

export const act = (action = A.WAIT, mx = 0, my = 1) => ({ action, mx, my });
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function localOf(self, p) { return self.toLocal(p.clone().sub(self.pos)); }

function checkVerticalAngle(self) {
  if (self.onGround && !self.gripped && self.verticalAngle < -45) { self.verticalAngle = 0; return A.ROTDOWN; }
  return A.WAIT;
}

export function* wallClimber(self) {
  yield act(A.JUMP, self.defaultMouseX(), -1);
  const up = new THREE.Vector3();
  let n = 0;
  while (up.set(0, 1, 0).applyQuaternion(self.quat).y > 0 && n++ < 60) yield act(A.ROTUP, self.defaultMouseX(), -1);
  let i = 0;
  for (i = 0; i < 10; i++) yield act(A.ROTDOWN, self.defaultMouseX(), -1);
  while (!self.onGround && i < 25 * 7 / self.rotupSpeed) { i++; yield act(A.ROTDOWN, self.defaultMouseX(), -1); }
}

// controler.goto: one steering action toward target (a Vector3 in world space).
export function goto(self, target, { canjump = true, turbosity = -100, turboPeriod = -1 } = {}) {
  const f = localOf(self, target);
  const g = self.game;
  let noGround;
  if (self.jumping) { if (self.onGround) self.jumping = false; noGround = 0; }
  else noGround = (!self.onGround && !g.collision.raypickB(self.pos, self.toWorld(new THREE.Vector3(0, -1, -2)), 6.0)) ? 1 : 0;

  let action;
  // Character.speed in the original is updated by collisions, so a blocked car reads ~0.
  const slow = self.speedW.length() < 0.001;
  if (self.gripped) {
    if (canjump && (GOTO_Y_2_JUMP * f.y + GOTO_Z_2_JUMP * f.z + GOTO_NOGROUND_2_JUMP * noGround > 8.0 || slow)) {
      self.jumping = true; action = A.JUMP;
    } else action = checkVerticalAngle(self);
  } else {
    if (canjump && f.y > 3.5 && Math.abs(f.x) < 2.0 && -10 < f.z && f.z < 0) {
      self.jumping = true;
      return wallClimber(self);
    } else if (canjump && (GOTO_Y_2_JUMP * f.y + GOTO_Z_2_JUMP * f.z + GOTO_NOGROUND_2_JUMP * noGround > 2.0 || (slow && self.current.my < 1.0))) {
      self.jumping = true; action = A.JUMP;
    } else action = checkVerticalAngle(self);
  }
  if (!self.flameThrower && turbosity > 0 && action === A.WAIT && !self.gripped) {
    if (turboPeriod === -1) { if (turbosity * (-f.z - Math.abs(f.x) - Math.abs(f.y)) > 45) action = A.TURBO; }
    else if (f.z < 0 && turbosity * (f.z - Math.abs(f.x) - Math.abs(f.y)) > -10) action = A.TURBO;
  }
  const c = self.current;
  return act(action,
    (5 * c.mx + clamp(GOTO_X_2_TURN * f.x, -1, 1)) / 6,
    (5 * c.my + Math.min(1, Math.max(-self.maxSpeed, 1 + GOTO_X_2_SPEED * Math.abs(f.x) + GOTO_Y_2_SPEED * f.y + GOTO_Z_2_SPEED * f.z + GOTO_NOGROUND_2_SPEED * noGround))) / 6);
}

function* checkBonus(self, aggressivity) {
  for (const b of self.game.bonuses) {
    if (!b.visible || self.pos.distanceTo(b.pos) >= 25) continue;
    if ((b.kind === 'life' && self.life < 0.6) || (b.kind === 'flame' && Math.random() < aggressivity)) {
      for (let i = 0; i < 250; i++) {
        yield goto(self, b.pos);
        if (!b.visible || self.pos.distanceTo(b.pos) < 0.3) break;
      }
    }
  }
}

function* attackRun(self, target, duration) {
  for (let i = 0; i < duration && target.alive; i++) {
    let a = goto(self, target.pos, { turboPeriod: 1.0 });
    if (self.flameThrower && !(a && a.next)) {
      const f = localOf(self, target.pos);
      if (-15 < f.z && f.z < -0.2 && Math.abs(f.y / f.z) < 0.5 && Math.abs(f.x / f.z) < 0.5 && a.action === A.WAIT) a.action = A.TURBO;
    }
    yield a;
  }
}

// race.Opponent.IAControler
export function* opponentBrain(self) {
  const g = self.game;
  const [maxSpeed, innitiative, will, agressivity, turbosity] = CHROMOSOMS[self.perso][g.difficulty];
  self.maxSpeed = maxSpeed;
  while (true) {
    for (let i = 0; i < Math.floor(innitiative); i++) {
      const flag = g.flags[self.nextFlag];
      yield goto(self, flag.pos, { turbosity: turbosity + 2.0 * self.life });
    }
    // Rubber-banding against the player.
    const p = g.player;
    if (p && p.alive) {
      const n = g.flags.length;
      const delta = (self.laps * n + self.nextFlag) - (p.laps * n + p.nextFlag);
      if (delta > 1 && g.difficulty < 2) self.maxSpeed *= 0.9;
      else if (delta < -1 && g.difficulty > 0) self.maxSpeed = 1.1;
      else if (delta > 0) self.maxSpeed = maxSpeed;
    } else self.maxSpeed = maxSpeed;

    yield checkBonus(self, agressivity);

    if (Math.random() < agressivity) {  // attack someone just in front
      for (const o of g.characters) {
        if (o === self || !o.alive) continue;
        const f = localOf(self, o.pos);
        if (-5 < f.z && f.z < 0 && -2 < f.y && f.y < 2 && -5 < f.x && f.x < 5) { yield attackRun(self, o, will); break; }
      }
    } else {  // dodge someone right behind
      for (const o of g.characters) {
        if (o === self || !o.alive) continue;
        const f = localOf(o, self.pos);
        if (-5 < f.z && f.z < 0 && -2 < f.y && f.y < 2 && -5 < f.x && f.x < 5) {
          const h = Math.random();
          if (h < 0.3) for (let i = 0; i < 10; i++) yield act(A.WAIT, -1, self.maxSpeed);
          else if (h < 0.6) for (let i = 0; i < 10; i++) yield act(A.WAIT, 1, self.maxSpeed);
          else {
            self.jumping = true;
            yield act(A.JUMP, 0, self.maxSpeed);
            for (let i = 0; i < 2; i++) yield act(A.ROTDOWN, 0, self.maxSpeed);
          }
          break;
        }
      }
    }
  }
}

// controler.StackControler: generators may yield sub-generators, which run to completion first.
export class StackControler {
  constructor(gens = []) { this.stack = gens; this.uncancelable = null; }
  push(gen, uncancelable = false) { this.stack.push(gen); if (uncancelable) this.uncancelable = gen; }
  get busy() { return this.stack.length > 0; }
  clear() { if (!this.uncancelable || !this.stack.includes(this.uncancelable)) { this.stack.length = 0; this.uncancelable = null; } }
  animate(gen) { this.push(gen, true); }
  next() {
    for (let guard = 0; guard < 64 && this.stack.length; guard++) {
      const top = this.stack[this.stack.length - 1];
      const r = top.next();
      // (remove that generator, not the top: it may have pushed another controller while finishing)
      if (r.done) { this.stack.splice(this.stack.lastIndexOf(top), 1); if (this.uncancelable === top) this.uncancelable = null; continue; }
      const v = r.value;
      if (v && typeof v.next === 'function') { this.stack.push(v); continue; }
      return v;
    }
    return null;
  }
}

// ---------------------------------------------------------------- more of controler.py
// (used by the campaign: hunt.Praise, fight.Fighter, the video sequences)
const cmp = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const toPoint = t => (t && t.isVector3 ? t : t && t.world ? t.world() : t && t.pos ? t.pos : t);

export function* lookAt(self, target) {
  for (let n = 0; n < 400; n++) {
    const f = localOf(self, toPoint(target));
    if (Math.abs(f.x / f.z) < 0.2 && f.z < 0) break;
    yield act(A.WAIT, cmp(f.x) || 1, 1);
  }
}
export function* gotoGen(self, target, minDistance = 0.7) {
  for (let n = 0; n < 3000 && self.pos.distanceTo(toPoint(target)) > minDistance; n++) yield goto(self, toPoint(target));
}
export function* dodge() {
  yield act(A.JUMP, 0, 0);
  for (let j = 0; j < 30; j++) yield act(A.ROTUP, 0, 0);
  for (let j = 0; j < 30; j++) yield act(A.WAIT, 0, 0);
}
function gotoDodge(self, target, dodgeDist, opts) {
  const f = localOf(self, target);
  if (dodgeDist && f.z > 0 && self.pos.distanceTo(target) < dodgeDist) return dodge();
  return goto(self, target, opts);
}
function flameCheck(self, target, a) {
  if (self.flameThrower && a && !a.next) {
    const f = localOf(self, target.pos);
    if (-15 < f.z && f.z < -0.2 && Math.abs(f.y / f.z) < 0.5 && Math.abs(f.x / f.z) < 0.5 && a.action === A.WAIT) a.action = A.TURBO;
  }
  return a;
}
export function* attackRunFull(self, target, duration = 100, dodgeDist = 0, turbosity = -100) {
  for (let i = 0; i < duration && target.alive; i++)
    yield flameCheck(self, target, gotoDodge(self, target.pos, dodgeDist, { turbosity, turboPeriod: 1.0 }));
}
export function* attackFrontRun(self, target, duration = 100, dodgeDist = 0, turbosity = -100) {
  for (let i = 0; i < duration && target.alive; i++) {
    const g = localOf(target, self.pos);
    let p = target.pos;
    if (!(g.z <= 0 || self.distanceTo(target) > 10)) p = target.localPoint(g.x < 0 ? -3 : 3, 0, -7);
    yield flameCheck(self, target, gotoDodge(self, p, dodgeDist, { turbosity, turboPeriod: 1.0 }));
  }
}
export function* attackSideRun(self, target, duration = 100, dodgeDist = 0, turbosity = -100) {
  for (let i = 0; i < duration && target.alive; i++) {
    const g = localOf(target, self.pos);
    let p = target.pos;
    if (!(g.z <= 0 || self.distanceTo(target) > 10)) p = target.localPoint(g.x < 0 ? -7 : 7, 0, 0);
    yield flameCheck(self, target, gotoDodge(self, p, dodgeDist, { turbosity, turboPeriod: 1.0 }));
  }
}
export function* flee(self, target, duration = 100) {
  let noGround = 0;
  for (let i = 0; i < duration && target.alive; i++) {
    const f = localOf(self, target.pos), dist = self.distanceTo(target);
    if (self.jumping) { if (!noGround) self.jumping = false; noGround = 0; }
    else noGround = self.game.collision.raypickB(self.pos, self.toWorld(new THREE.Vector3(0, -1, -2)), 4.0) ? 0 : 1;
    if (self.speedW.length() * 10 + dist < 3) {
      const h = Math.random();
      if (h < 0.2) break;
      else if (h < 0.4) yield dodge();
    }
    const c = self.current;
    yield act(A.WAIT,
      (5 * c.mx + clamp(-0.27955060118474129 * f.x, -1, 1)) / 6,
      (5 * c.my + Math.min(1, Math.max(-self.maxSpeed, -0.94713263528551006 * Math.abs(f.x) - 0.0076398049940541654 * f.y - 0.46242007806615826 * f.z + 22.758284696585228 * noGround))) / 6);
  }
}
export function* feinte(self, target, duration = 100, dodgeDist = 1.0) {
  for (let i = 0; i < duration; i++) {
    if (self.distanceTo(target) < dodgeDist) { yield dodge(); break; }
    yield act(A.WAIT, 0.5, 0.1);
  }
}
export function* wander(self, duration = 100) {
  let mx = self.current.mx, my = self.current.my;
  for (let i = 0; i < duration; i++) {
    mx += clamp((Math.random() - 0.5) / 20, -1, 1);
    my += clamp((Math.random() - 0.5) / 20, -1, 1);
    yield act(A.WAIT, mx, my);
  }
}
// controler.PushToKill: push the nearest pushable onto the target.
export function* pushToKill(self, target, turbosity = -100) {
  const g = self.game;
  const dist = self.distanceTo(target);
  const front = target.localPoint(0, 0, -15);
  let best = null, bestDist = 1e6;
  for (const p of g.pushables) {
    if (!p.alive || p.pos.distanceTo(front) >= 55) continue;
    const d = self.pos.distanceTo(p.pos);
    if (d < dist && d < bestDist) { bestDist = d; best = p; }
  }
  if (!best) { if (dist > 50) yield attackRunFull(self, target); else yield flee(self, target); return; }
  const p = best;
  for (let n = 0; n < 2000 && p.alive; n++) {
    const v = p.pos.clone().sub(target.pos).setLength(p.radius * 2);
    const t = p.pos.clone().add(v);
    const d = Math.hypot(t.x - self.pos.x, t.z - self.pos.z), dp = self.distanceTo(p);
    if (d < 1.5) break;
    if (!self.jumping && self.onGround && dp < d - 1 && dp < p.radius * 2.5) { self.jumping = true; yield act(A.JUMP, self.current.mx, -1); }
    yield goto(self, t, { turbosity });
  }
  const v = p.pos.clone().sub(target.pos).setLength(p.radius + self.radius - 0.1);
  yield lookAt(self, p.pos.clone().add(v));
  for (let i = 0; i < 50 && !p.worthPlaying && p.alive; i++) yield act(A.WAIT, 0, -1);
  const s = Math.random() < 0.5 ? -1 : 1;
  for (let i = 0; i < 10; i++) yield act(A.WAIT, s, 0);
  for (let i = 0; i < 10; i++) yield act(A.WAIT, 0, -1);
}
