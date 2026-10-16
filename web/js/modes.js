// Game modes used by the campaign, ported from hunt.py, fight.py, freestyle.py,
// medoc.py, airplane.py and arena.py.
import * as THREE from 'three';
import { A, ROUND } from './physics.js';
import { act, goto, wallClimber, attackRunFull, attackFrontRun, attackSideRun, flee, feinte, wander, pushToKill, localOf, clamp } from './ai.js';
import { tr, HuntFailed, MissionCompleted, Mission14Outro, PLAYER, addPerso, GnuSpeech } from './campaign.js';
import { FixTraveling, Dir } from './camera.js';

const isPoint = p => p && p.isVector3;

// ======================================================== hunt.py
const HUNT_CHROMOSOMS = [0.1, 0.5, 1.0].map(ms => [0.9, 0.54152636319441949, 0.057433463934462713, 1.5669823329989161, 15.877046130951882, 0.18908021610553249, 0.066441050148349098, 3.0216818334258322, ms]);

// hunt.Praise: runs along `path` (points or message generators) and escapes from hunters.
export function makePraise(ch, { escapeDist = 40, waitDist = 10 } = {}) {
  ch.path = []; ch.escapeDist = escapeDist; ch.waitDist = waitDist;
  ch.finished = () => 1;
  ch.escapedFrom = hunter => HuntFailed(ch.game).start({ praise: ch, hunter });
  ch.controler.stack[0] = praiseBrain(ch);
}
function* praiseBrain(ch) {
  const g = ch.game;
  const c = HUNT_CHROMOSOMS[g.difficulty];
  const maxSpeed = c[8];
  let jumping = false, mx = 0, my = 0;
  while (!ch.path.length) yield act();
  while (ch.waitDist) {
    for (const h of g.characters) if (h.isCompetitor) { if (ch.distanceTo(h) < ch.waitDist) ch.waitDist = 0; }
    yield act();
  }
  while (true) {
    if (!ch.path.length) {
      while (ch.finished()) yield act();
      while (true) yield act();
    }
    const next = ch.path.shift();
    if (!isPoint(next)) { yield next(); continue; }
    let dist = 10;
    while (dist > 2.0) {
      dist = ch.pos.distanceTo(next);
      for (const h of g.characters) {
        if (h.isCompetitor && !h.failed && ch.distanceTo(h) > ch.escapeDist) { h.failed = true; ch.escapedFrom(h); }
      }
      const f = localOf(ch, next);
      let noGround;
      if (jumping) { if (ch.onGround) jumping = false; noGround = 0; }
      else noGround = g.collision.raypickB(ch.pos, ch.toWorld(new THREE.Vector3(0, -1.5, -2)), 4.0) ? 0 : 1;
      let action = A.WAIT;
      if ((dist < 12 && c[5] * f.y + c[6] * f.z + c[7] * noGround > 2.0) || ch.speedW.length() < 0.05) {
        if (Math.random() < 0.7) { action = A.JUMP; jumping = true; }
        else yield wallClimber(ch);
      }
      let tmx = Math.min(1, -c[0] * Math.sqrt(Math.abs(f.x / f.z)));
      if (f.x > 0) tmx = -tmx;
      mx = 0.8 * mx + 0.2 * tmx;
      my = (5 * my + Math.min(maxSpeed, Math.max(-maxSpeed, c[1] * Math.abs(f.x) + c[2] * f.y + c[3] * f.z + c[4] * noGround))) / 6;
      yield act(action, mx, my);
    }
  }
}

export class PathComputer {
  constructor() { this.paths = {}; }
  add(from, to, path, reverse = true) {
    ((this.paths[from] ||= {})[to] ||= []).push(path);
    if (reverse) this.add(to, from, [...path].reverse(), false);
  }
  randomPath(start, end, approxLength) {
    const pick = a => a[Math.floor(Math.random() * a.length)];
    let old = null, loc = start, length = 0;
    const path = [];
    for (let guard = 0; loc !== end && guard < 100; guard++) {
      if (length >= approxLength && this.paths[loc][end]) { path.push(...pick(this.paths[loc][end])); break; }
      let locs = Object.keys(this.paths[loc]);
      if (length < approxLength && locs.length > 1) locs = locs.filter(l => l !== end);
      if (locs.length > 1) locs = locs.filter(l => l !== old);
      old = loc; loc = pick(locs);
      path.push(...pick(this.paths[old][loc]));
      length++;
    }
    return path;
  }
}

// ======================================================== fight.py
// FightChromosom(max_speed, will, turbosity, autododge, run, dodge, flee, frontrun, siderun, wander)
const FC = (...a) => ({ maxSpeed: a[0], will: a[1], turbosity: a[2], autododge: a[3], run: a[4], dodge: a[5], flee: a[6], frontrun: a[7], siderun: a[8], wander: a[9] });
export const FIGHT_CHROMOSOMS = {
  tux: [FC(0.65, 100, -7, 0, 0.8, 1, 0.1, 1.7, 1, 1.3), FC(0.8, 100, -1, 0, 1, 1.1, 0.6, 1.1, 1.3, 1), FC(0.9, 100, 0.5, 2.5, 1, 1.5, 1.1, 1, 1.5, 0.5)],
  gnu: [FC(0.6, 150, -2, 0, 1.2, 1, 0.1, 2, 0.6, 1.5), FC(0.75, 150, 0.7, 0, 1.8, 0.6, 0.3, 1.2, 0.7, 1.1), FC(0.9, 150, 1, 1.5, 2, 0.5, 0.4, 0.5, 1, 0.5)],
  shark: [FC(0.6, 80, -9, 0, 0.9, 1, 0.2, 1.6, 0.5, 1.5), FC(0.7, 80, -4, 1, 1, 1.4, 0.5, 1, 0.5, 1.2), FC(0.9, 70, 0, 1.5, 1, 1.5, 0.6, 0.2, 0.5, 0.9)],
  python: [FC(0.6, 100, 0, 0, 1.2, 1, 0.1, 2, 0.6, 1.5), FC(0.8, 100, 1.3, 0.5, 1.8, 0.6, 0.3, 1.2, 0.7, 1.1), FC(0.9, 100, 2, 2.5, 2, 0.5, 0.4, 0.5, 1, 0.5)],
  killer: [FC(0.6, 150, 0.2, 0, 1.2, 1, 0.1, 2, 0.6, 1.5), FC(0.75, 150, 0.7, 0, 1.8, 0.6, 0.3, 1.2, 0.7, 1.1), FC(0.9, 150, 1, 1.5, 2, 0.5, 0.4, 0.5, 1, 0.5)],
  killer_flight: [FC(0.6, 150, -10, 0, 1.2, 1, 0.1, 2, 0.6, 1.5), FC(0.75, 150, -10, 0, 1.8, 0.6, 0.3, 1.2, 0.7, 1.1), FC(0.9, 150, -10, 1.5, 2, 0.5, 0.4, 0.5, 1, 0.5)],
  alien_boss: [FC(0.9, 150, 1.5, 1.5, 2, 0.5, 0.4, 0.5, 1, 0.5), FC(0.9, 150, 1, 0, 1.8, 0.6, 0.3, 1.2, 0.7, 1.1), FC(0.9, 150, 0.7, 0, 1.2, 1, 0.1, 2, 0.6, 1.5)],
};

function chooseTarget(self) {
  let best = null, bestDist = 10000;
  for (const c of self.game.characters) {
    if (c !== self && c.alive && (self.targetAny || (c.clan > 0 && c.clan !== self.clan))) {
      const d = c.distanceTo(self);
      if (d < bestDist) { best = c; bestDist = d; }
    }
  }
  return best;
}

// fight.Fighter (and AlienBoss): picks a strategy at random, weighted by its chromosome.
export function makeFighter(ch, chromosom = null, { keepVehicle = false } = {}) {
  ch.clan = 2;
  ch.chromosom = chromosom;
  if (!keepVehicle) ch.game.changeVehicle(ch, Math.floor(Math.random() * 5));  // Fighter.init
  ch.controler.stack[0] = fighterBrain(ch);
}
function* fighterBrain(self) {
  const c = { ...(self.chromosom || FIGHT_CHROMOSOMS[self.perso][self.game.difficulty]) };
  for (const k of Object.keys(c)) if (k !== 'maxSpeed' && Math.random() < 0.4) c[k] *= 0.5 + Math.random();  // mutate
  self.maxSpeed = c.maxSpeed;
  let target = null;
  while (true) {
    target = chooseTarget(self) || target;
    if (!target || !target.alive) { yield act(); continue; }
    const dist = self.distanceTo(target), r = Math.random, l = self.life;
    const options = [
      [l + r() * c.run, 'run'], [l - 0.1 * dist + r() * c.dodge, 'dodge'], [1 - 2 * l + r() * c.flee, 'flee'],
      [l + r() * c.frontrun, 'frontrun'], [l + r() * c.siderun, 'siderun'], [r() * c.wander, 'wander']];
    const s = options.reduce((a, b) => (b[0] > a[0] ? b : a))[1];
    const turbo = c.turbosity + 2.0 * self.life;
    if (s === 'run') yield attackRunFull(self, target, c.will, c.autododge, turbo);
    else if (s === 'frontrun') yield attackFrontRun(self, target, c.will, c.autododge, turbo);
    else if (s === 'siderun') yield attackSideRun(self, target, c.will, c.autododge, turbo);
    else if (s === 'flee') yield flee(self, target, c.will);
    else if (s === 'dodge') yield feinte(self, target, c.will, c.autododge + 3);
    else yield wander(self, c.will);
  }
}

// fight.Mission6Killer: patrols toward Tux; catching him low in front of it is a warning, then game over.
export function makeMission6Killer(ch) {
  ch.clan = 2;
  ch.controler.stack[0] = (function* () {
    const g = ch.game, c = FIGHT_CHROMOSOMS.killer[g.difficulty];
    ch.maxSpeed = c.maxSpeed;
    let target = null;
    while (true) {
      target = chooseTarget(ch) || target;
      if (!target) { yield act(); continue; }
      if (target.nbAvertissements === undefined) { target.disabledWarn = 0; target.nbAvertissements = [4, 2, 0][g.difficulty]; }
      for (let i = 0; i < 100; i++) {
        const f = localOf(ch, target.pos);
        if (target.disabledWarn) target.disabledWarn--;
        else if (target.pos.y < 1.4 && f.z < 0 && ch.distanceTo(target) < 3.0) {
          g.message(tr('__scenar6-1__'));
          if (target.nbAvertissements) { target.disabledWarn = 100; target.nbAvertissements--; }
          else {
            GnuSpeech(g, [tr('__scenar6-2__'), tr('__gameover__')], true).start({ tux: target });
            while (true) yield act();
          }
        }
        yield goto(ch, target.pos, { canjump: false });
      }
    }
  })();
}

// fight.Mission7Pusher: pushes trunks onto Tux, then goes berserk.
export function makeMission7Pusher(ch) {
  ch.clan = 2;
  ch.controler.stack[0] = (function* () {
    const g = ch.game, c = FIGHT_CHROMOSOMS.killer[g.difficulty];
    ch.maxSpeed = c.maxSpeed;
    let target = null;
    for (let i = 0; i < [10000, 10, 6][g.difficulty]; i++) {
      target = chooseTarget(ch) || target;
      if (!target) { yield act(); continue; }
      yield pushToKill(ch, target, c.turbosity + 2 * ch.life);
    }
    while (true) {
      target = chooseTarget(ch) || target;
      if (!target) { yield act(); continue; }
      yield attackRunFull(ch, target, 100, 0, c.turbosity + 2 * ch.life);
    }
  })();
}

// ======================================================== freestyle.py
const SCORES = { jump: 5, longjump: 10, verylongjump: 150, climbing: 10, highjump: 15, 180: 50, 360: 85, 720: 110, rotup: 50, rotup180: 120,
  rotup360: 150, rotup720: 1000, looping: 100, doublelooping: 1000, retrolooping: 200, doubleretrolooping: 1500, s: 100, doubles: 1000,
  spinfall: 150, bigspinfall: 1200, flamingtorch: 80, bigflamingtorch: 800 };

// freestyle.FreeStyle: recognises stunts while the character is airborne.
export class FreeStyle {
  constructor(g, ch) {
    this.g = g; this.ch = ch;
    this.lastFigure = ''; this.lastNb = 0; this.lastTime = 0;
    this.onGround = true; this.jumpDir = new THREE.Vector3(); this.last180Dir = new THREE.Vector3(); this.yDir = new THREE.Vector3();
    this.last180Y = 1; this.yAngle = 0; this.jumpTime = 0; this.nb180 = 0; this.nbS = 0; this.nextSDir = -1; this.jumpY = 0; this.maxY = 0;
    this.spinfall = 0; this.flamingtorch = 0;
    ch.score = ch.score || 0;
  }
  recognized(figure) {
    const ch = this.ch;
    let bonus;
    if (this.lastFigure === figure && ch.round - this.lastTime < 500) {
      this.lastNb++; this.lastTime = ch.round; bonus = this.lastNb * SCORES[figure];
      this.g.message(`${tr('__figure_' + figure + '__')} X ${this.lastNb} (${bonus})`);
    } else {
      this.lastFigure = figure; this.lastNb = 1; this.lastTime = ch.round; bonus = SCORES[figure];
      this.g.message(`${tr('__figure_' + figure + '__')} (${bonus})`);
    }
    ch.score += bonus;
    if (this.onRecognized) this.onRecognized(figure);
  }
  round() {
    const ch = this.ch;
    if (!ch.alive) { this.removed = true; return; }
    const up = () => ch.toWorld(new THREE.Vector3(0, 1, 0)), fwd = () => ch.toWorld(new THREE.Vector3(0, 0, -1));
    if (this.onGround && !ch.onGround) {
      Object.assign(this, { jumpTime: 0, onGround: false, yAngle: 0, nb180: 0, nbS: 0, nextSDir: -1, spinfall: 0, flamingtorch: 0, jumpY: ch.pos.y, maxY: ch.pos.y, last180Y: 1 });
      this.jumpDir.copy(fwd()); this.last180Dir.copy(this.jumpDir); this.yDir.copy(this.jumpDir);
    } else if (ch.onGround && !this.onGround) {
      this.onGround = true;
      if (this.jumpTime < 20) return;
      const R = f => this.recognized(f);
      if (this.yAngle > 560) return R('doublelooping');
      if (this.yAngle > 200) return R('looping');
      if (this.yAngle < -560) return R('doubleretrolooping');
      if (this.yAngle < -200) return R('retrolooping');
      if (this.nbS === 2) return R('s');
      if (this.nbS === 4) return R('doubles');
      if (this.spinfall > 27) return R('bigspinfall');
      if (this.spinfall > 10) return R('spinfall');
      if (this.flamingtorch > 30) return R('bigflamingtorch');
      if (this.flamingtorch > 10) return R('flamingtorch');
      if (this.yDir.y > 0.75) {
        if (this.nb180 === 1) return R('180');
        if (this.nb180 === 2) return R('360');
        if (this.nb180 === 4) return R('720');
      } else if (this.yDir.y < -0.75) {
        if (this.nb180 === 2) return R('rotup180');
        if (this.nb180 === 3) return R('rotup360');
        if (this.nb180 === 5) return R('rotup720');
      }
      if (this.yDir.y < -0.5) return R('rotup');
      if (this.jumpTime > 200) return R('verylongjump');
      if (ch.pos.y - this.jumpY > 3) return R('climbing');
      if (this.maxY - this.jumpY > 7) return R('highjump');
      if (this.jumpTime > 70) return R('longjump');
      if (this.jumpTime > 20) return R('jump');
    }
    if (!ch.onGround) {
      this.jumpTime++;
      if (this.maxY < ch.pos.y) this.maxY = ch.pos.y;
      const a = ch.current.action;
      if (a === A.ROTUP) this.yAngle += ch.rotupSpeed;
      else if (a === A.ROTDOWN) this.yAngle -= ch.rotupSpeed;
      this.yDir.copy(up());
      if (this.yDir.y * this.nextSDir > 0.8) { this.nbS++; this.nextSDir *= -1; }
      const V = fwd();
      if (V.dot(this.last180Dir) < -0.5) {
        if (this.last180Y * this.yDir.y > 0.3) { this.nb180++; this.last180Dir.multiplyScalar(-1); }
        else this.last180Y *= -1;
      }
      if (a === A.ROTLAT) {
        if (V.y < -0.6) this.spinfall++;
        else if (V.y > 0.8 && ch.current.my > 0.8) this.flamingtorch++;
      }
    }
  }
}

// freestyle.ScoreLabel / TimerLabel (time counted in game time rather than wall clock).
export class TimerLabel {
  constructor(g, characters, timeLimit, noTimeLeft, { score = false } = {}) {
    this.g = g; this.characters = characters; this.timeLimit = timeLimit; this.noTimeLeft = noTimeLeft || tr('__no_time_left__');
    this.score = score; this.start = g.roundNo;
  }
  timeLeft() { return this.timeLimit === -1 ? 0 : this.timeLimit - (this.g.roundNo - this.start) * ROUND; }
  round() {
    if (this.g.completed) return;  // the mission is already won or lost
    if (this.timeLimit !== -1 && this.timeLeft() < 0) {
      this.timeLimit = -1;
      if (typeof this.noTimeLeft === 'function') this.noTimeLeft(this.characters);
      else for (const c of this.characters) MissionCompleted(this.g, false, this.noTimeLeft).start({ tux: c });
    }
  }
  draw(hud, g, W, H) {
    const lines = [tr('__scoreformat1__').replace('%.2f', Math.max(0, this.timeLeft()).toFixed(2))];
    if (this.score) for (const c of this.characters) lines.push(c.perso[0].toUpperCase() + c.perso.slice(1) + tr('__scoreformat2__').replace('%s', c.score || 0));
    g.font = `bold ${W < 600 ? 16 : 22}px "Trebuchet MS", sans-serif`; g.textBaseline = 'bottom';
    lines.reverse().forEach((l, i) => hud.text(l, 12, H - 12 - i * (W < 600 ? 20 : 28) - (this.g.blackbands ? H / 10 : 0)));
  }
}
export function startFreestyleGame(g, timeLimit = -1, message) {
  const comps = g.characters.filter(c => c.isCompetitor);
  for (const c of comps) c.score = 0;
  const label = new TimerLabel(g, comps, timeLimit, message, { score: true });
  g.widgets.push(label); g.addUpdater(label);
  return label;
}

// ======================================================== medoc.py
export function addMedocs(g, nb) {
  const down = new THREE.Vector3(0, -1, 0);
  const medocs = [];
  for (let i = 0; i < nb; i++) {
    for (let tries = 0; tries < 200; tries++) {
      const p = new THREE.Vector3(5 + Math.random() * 195, 1000, 5 + Math.random() * 195);
      const h = g.collision.raypick(p, down, 2000, true, true);
      if (h) {
        const m = g.prop('medoc2', null, { solid: false });
        m.setXYZ(p.x, h.point.y + 0.5, p.z);
        m.radius = 2.5; m.nbMax = nb; medocs.push(m);
        break;
      }
    }
  }
  g.addUpdater({ round() {
    for (const m of medocs) {
      if (m.removed) continue;
      for (const c of g.characters) {
        if (c.isCompetitor && c.alive && c.pos.distanceTo(m.pos) < m.radius) {
          g.sound.play('flag-1.wav', c.pos);
          g.fx.smoke(m.pos.clone());
          c.nbMedoc = (c.nbMedoc || 0) + 1;
          if (c.nbMedoc >= m.nbMax) g.levelCompleted(c, true, tr('__medoc_winner__'));
          m.remove();
          break;
        }
      }
    }
  } });
  g.widgets.push({ minimap: true, draw: (hud) => hud.minimap(g, medocs.filter(m => !m.removed).map(m => m.pos), {}) });
}

// medoc.MedocWaiter: a giraffe waiting for medicine; GiveMedoc flies a box to it.
export function medocWaiters(g, positions) {
  const waiters = positions.map(([x, y, z]) => { const w = g.prop('girafe1', null, { solid: false }); w.setXYZ(x, y, z); w.received = false; return w; });
  g.addUpdater({ round() {
    for (const w of waiters) {
      if (w.received || !g.player.alive || g.player.pos.distanceTo(w.pos) >= 10) continue;
      w.received = true;
      g.sound.play('flag-1.wav', w.pos);
      const m = g.prop('medoc2', null, { solid: false });
      m.move(g.player.localPoint(0, 0.5, 0.3));
      g.addUpdater({ round() {
        const v = w.pos.clone().sub(m.pos);
        if (v.length() < 1.0) {
          if (waiters.every(x => x.received)) Mission14Outro(g).start({ tux: PLAYER, gnu: addPerso(g, 'gnu', 1), shark: addPerso(g, 'shark', 4) });
          m.remove(); this.removed = true; return;
        }
        m.addVector(v.setLength(Math.min(0.2, v.length())));
      } });
    }
  } });
  g.widgets.push({ minimap: true, draw: (hud) => hud.minimap(g, waiters.map(w => w.pos), { squares: waiters.filter(w => !w.received).map(w => w.pos) }) });
  return waiters;
}

// ======================================================== airplane.py
// airplane.Airplane: a moving platform; characters on its roof are carried along.
export class Airplane {
  constructor(g, { flying = false } = {}) {
    this.g = g;
    this.prop = g.prop('avion');
    this.speed = 0;            // along its local -Z (Soya's speed.z is negative)
    this.accelerate = false; this.startInRound = 0; this.charactersOn = [];
    this.trails = false;
    if (flying) { this.speed = 0.5; this.trails = true; }
    g.addUpdater(this);
  }
  get x() { return this.prop.x; } get z() { return this.prop.z; }
  roof() { return this.prop.localPoint(0, 7.9, 0); }
  start() { this.accelerate = true; this.trails = true; }
  round() {
    const p = this.prop;
    if (this.accelerate && this.speed < 2.0) {
      this.speed += 0.003;
      if (this.speed > 1.0) p.turnVertical(0.05);
    }
    const v = new THREE.Vector3(0, 0, -this.speed).applyQuaternion(p.quat);
    const roof = this.roof();
    this.charactersOn = this.g.characters.filter(c => c.alive && c.onGround && Math.abs(c.pos.y - roof.y) < 2.0 && c.pos.distanceTo(roof) < 11.0);
    for (const c of this.charactersOn) c.platformSpeed = v.clone();
    if (this.speed === 0) {
      if (this.charactersOn.length) this.start();
      else if (this.startInRound) { if (--this.startInRound === 0) this.start(); }
    }
    p.addVector(v);
    if (this.trails) for (const sx of [1, -1]) this.g.fx.spawn(p.localPoint(sx, 3.5, 9.6), new THREE.Vector3(), new THREE.Vector3(), 16,
      [[1, 1, 1, 1], [1, 1, 0, 1], [1, 0, 0, 1], [0.1, 0, 0, 1]], 1.0);
  }
}

// airplane.KillerAirplane: a small plane that tracks Tux and drops on him.
export class KillerAirplane {
  constructor(g, target, speed) {
    this.g = g; this.target = target; this.speed = speed; this.phase = 1; this.play = false;
    this.prop = g.prop(null);   // the KillerAirplane World is unscaled; its plane Volume is half size
    g.prop('avion', this.prop.obj, { solid: false }).obj.scale.set(0.5, 0.5, 0.5);
    g.addUpdater(this);
  }
  round() {
    if (!this.play) return;
    const g = this.g, p = this.prop;
    if (this.phase === 1) {
      const t = this.target.alive ? this.target.localPoint(0, 0, -4) : p.pos.clone();
      if (Math.abs(p.x - t.x) + Math.abs(p.z - t.z) < 2.0) {
        const r = g.collision.raypick(p.pos.clone().add(new THREE.Vector3(0, -3, 0)), new THREE.Vector3(0, -1, 0), 500, true, true);
        if (r) {
          this.dropY = Math.max(r.point.y, 0);
          this.phase = 2;
          this.traveling = new FixTraveling(null, new Dir(null, ...g.cam.camera.getWorldDirection(new THREE.Vector3()).toArray()));
          this.traveling.target = { world: () => g.cam.pos.clone() };
          g.cam.add(this.traveling);
        }
      }
      const v = t.sub(p.pos); v.y = 0;
      if (v.length() > 1e-4) { v.setLength(this.speed); p.lookAt(v.clone().add(p.pos)); p.addVector(v); }
    } else if (this.phase === 2) {
      p.y -= this.speed;
      if (p.y < this.dropY) {
        this.phase = 3;
        g.cam.remove(this.traveling);
        const victim = g.characters.find(c => c.alive && c.pos.distanceTo(p.pos) < 3.0);
        if (victim) victim.die();
        else { g.sound.play('explose-3.wav', p.pos); g.fx.explosion(p.pos.clone(), 30, 1.0); }
      }
    } else if (this.phase === 3) {
      p.y += this.speed;
      if (p.y > this.dropY + 10) this.phase = 1;
    }
  }
}

// arena.MiniMap: start positions as squares, competitors with their heads.
export function arenaMiniMap(g, points) {
  g.widgets.push({ minimap: true, draw: (hud) => hud.minimap(g, points, {}) });
}
