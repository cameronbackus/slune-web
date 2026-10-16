// The Slune campaign: a port of videosequence.py (15 missions) and of the Python
// scripts embedded in the level-mission-N.data files.
//
// As in the original, a "video sequence" is a generator run on each participating
// character's controller (one run per role, sharing the sequence object `this`).
// `yield g.Pause()` waits for a click (all controllers wait), `yield g.Fade()` fades
// to black and back in 40 rounds, and `yield act(...)` is one round of driving.
import * as THREE from 'three';
import { loadJSON } from './assets.js';
import { A } from './physics.js';
import { act, lookAt, gotoGen, wallClimber } from './ai.js';
import { FixTraveling, Pos, Dir } from './camera.js';
import {
  makePraise, PathComputer, makeFighter, makeMission6Killer, makeMission7Pusher, FIGHT_CHROMOSOMS, FreeStyle,
  TimerLabel, startFreestyleGame, addMedocs, medocWaiters, Airplane, KillerAirplane, arenaMiniMap,
} from './modes.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V3(0, 1, 0);
export const PLAYER = Symbol('PLAYER'), AUTO = Symbol('AUTO');

let STR = {};
export async function initStrings() { if (!STR.__ready__) STR = await loadJSON('strings.json'); }
export const tr = k => (k in STR ? STR[k] : k);

// ---------------------------------------------------------------- framework
class Sequence {
  constructor(g) { this.g = g; }
  // VideoSequence.start: run between two rounds, one generator per role.
  start(roles) { this.g.nextRound(() => this._start(roles)); return this; }
  _start(roles) {
    const g = this.g;
    for (const [name, v] of Object.entries(roles)) {
      if (v === PLAYER) { for (const c of g.characters) if (c.isPlayer) c.animate(this.run({ tux: c })); }
      else if (v === AUTO) { for (const c of g.characters) if (c.name === name) c.animate(this.run({ [name]: c })); }
      else if (v && v.alive) v.animate(this.run({ [name]: v }));
    }
  }
}
const seq = (g, run, init = {}) => Object.assign(new Sequence(g), init, { run });

// add_perso: a non-player character, optionally with a special brain.
export function addPerso(g, name, vehicle = 1, kind = null, opts = {}) {
  const ch = g.addCharacter(name, vehicle, false, { grid: false });
  ch.name = name;
  if (kind === 'praise') makePraise(ch, opts);
  else if (kind === 'fighter') makeFighter(ch, opts.chromosom);
  else if (kind === 'alienboss') { makeFighter(ch, FIGHT_CHROMOSOMS.alien_boss[g.difficulty]); ch.isCompetitor = true; }
  else if (kind === 'mission6killer') makeMission6Killer(ch);
  else if (kind === 'mission7pusher') makeMission7Pusher(ch);
  return ch;
}

// Character helpers mirroring Soya's API.
const tp = (ch, x, y, z) => ch.teleport(V3(x, y, z));
const lookDir = (ch, x, y, z) => ch.lookAt(V3(x, y, z));
const lookPoint = (ch, p) => ch.lookAt(p.clone().sub(ch.pos));
const rotLat = (ch, d) => ch.rotateAxe(d, UP);
const persoRot = (ch, axis, d) => ch.persoBase.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, d * Math.PI / 180));
const hidePerso = (ch, hidden = true) => { ch.persoVisible = !hidden; ch.persoObj.visible = !hidden; };
const P = (obj, x, y, z) => new Pos(obj, x, y, z);
const persoOf = ch => () => ch.persoObj;

// LookAt{Front,Back,Left,Right}OfCharacterTraveling: camera near the driver, looking at him.
function lookAtChar(ch, ox, oz, d = 1) {
  return new FixTraveling(P(persoOf(ch), ox * d, 0.3 + 0.4 * d, oz * d), P(persoOf(ch), 0, 0.3, 0), true, true);
}
const LookAtFront = (ch, d) => lookAtChar(ch, 0, -1.2, d);
const LookAtBack = (ch, d) => lookAtChar(ch, 0, 1.2, d);
const LookAtLeft = (ch, d) => lookAtChar(ch, 1.0, -0.5, d);
const LookAtRight = (ch, d) => lookAtChar(ch, -1.0, -0.5, d);

function* SayYes(ch, duration) {
  let total = 0;
  for (let i = 0; i < duration; i++) { const a = 5 * Math.cos(i * 0.3); total -= a; persoRot(ch, V3(1, 0, 0), a); yield act(); }
  persoRot(ch, V3(1, 0, 0), total);
}
const acts = function* (n, a = A.WAIT, mx = 0, my = 1) { for (let i = 0; i < n; i++) yield act(a, mx, my); };

// Moves a character's driver model to a world point / by a world vector (Soya perso.move / add_vector).
function persoMoveWorld(ch, w) { ch.internal.updateWorldMatrix(true, false); ch.persoBase.position.copy(ch.internal.worldToLocal(w.clone())); }
function persoAddWorld(ch, v) {
  ch.internal.updateWorldMatrix(true, false);
  const q = new THREE.Quaternion(); ch.internal.getWorldQuaternion(q);
  ch.persoBase.position.add(v.clone().applyQuaternion(q.invert()));
}
// A prop parented to a character's vehicle (medicine boxes on the truck).
function carry(g, ch, model, x, y, z) {
  const p = g.prop(model, ch.internal, { solid: false });
  p.setXYZ(x, y, z);
  (ch.internalExtras ||= []).push(p.obj);
  return p;
}
function detach(g, p) {  // reparent a carried prop into the level, keeping its world transform
  const m = p.obj.matrixWorld.clone();
  p.obj.parent.remove(p.obj); g.scene.add(p.obj);
  m.decompose(p.obj.position, p.obj.quaternion, p.obj.scale);
}
// videosequence.ExorbitedEye: an eye popping in and out.
function exorbitedEye(g, at, rot) {
  const e = g.prop('gnu-eye', null, { solid: false });
  e.move(at); e.rotateLateral(rot);
  let angle = 0, destroying = false;
  g.addUpdater({ round() {
    angle += 0.1;
    const s = Math.abs(Math.sin(angle)) / 10;
    e.obj.scale.setScalar(Math.max(1e-3, s));
    if (destroying && s < 0.01) { e.remove(); this.removed = true; }
  } });
  return { destroy: () => (destroying = true) };
}
function* lookAtThenGoto(self, lookTarget, gotoTarget, door) {
  const look = lookAt(self, lookTarget), go = gotoGen(self, gotoTarget);
  let lookDone = false;
  const step = () => {
    if (!lookDone) { const r = look.next(); if (!r.done) return r.value; lookDone = true; }
    const r = go.next(); return r.done ? null : r.value;
  };
  for (let i = 0; i < 32; i++) { door.turnLateral(3.0); const a = step(); yield a || act(); }
  for (let a = step(); a; a = step()) yield a;
}

// ---------------------------------------------------------------- shared sequences
export const MissionCompleted = (g, winner, message) => seq(g, function* ({ tux }) {
  if (!tux || !tux.isPlayer) return;
  g.message(message || (winner ? (g.mode === 'mission' ? 'Level completed!' : tr('__race_winner__')) : tr('__gameover__')));
  yield g.Pause();
  g.endMission(winner);
});
export const HuntFailed = (g, message) => seq(g, function* ({ praise, hunter }) {
  if (!hunter || !hunter.isPlayer) return;
  g.message(message || tr('__hunt_failed__'));
  g.message(tr('__gameover__'));
  yield g.Pause();
  g.endMission(false);
});
export const GnuSpeech = (g, messages, endGameAfter = true) => seq(g, function* ({ tux }) {
  if (tux) {
    const cam = g.cam, fwd = cam.camera.getWorldDirection(V3(0, 0, 0));
    const t = new FixTraveling(P(null, ...cam.pos.toArray()), new Dir(null, ...fwd.toArray()), false, false);
    cam.add(t); cam.zap();
    const gnu = g.prop('gnu1', null, { solid: false });
    const c = cam.camera; c.updateWorldMatrix(true, false);
    gnu.move(V3(-0.25, -0.5, -0.5).applyMatrix4(c.matrixWorld));
    gnu.lookAt(new Dir(null, ...V3(1, 0, 0.5).transformDirection(c.matrixWorld).toArray()));
  }
  for (const m of messages) {
    if (tux) { g.clearMessages(); g.message(m); }
    yield g.Pause();
  }
  if (tux && endGameAfter) g.endMission(false);
});

// ---------------------------------------------------------------- mission 1
const Mission1Intro = g => seq(g, function* ({ tux, gnu }) {
  g.cam.speed = 0.1;
  let t, old;
  if (tux) { g.clearMessages(); g.message(tr('__scenar1-intro-0__')); }
  else if (gnu) { tp(gnu, 85.4329071045, -5.0, -16.2530593872); lookDir(gnu, 1, 0, 0); }
  yield g.Pause();
  if (gnu) { g.sound.play('phone.ogg'); g.clearMessages(); g.message(tr('__scenar1-intro-1__')); }
  else if (tux && tux.isPlayer) { t = LookAtLeft(tux); g.cam.add(t); }
  yield g.Pause(85); yield g.Fade();
  if (gnu) {
    old = gnu.persoBase.position.clone();
    gnu.persoBase.position.set(-0.4, 0.3, -1.4);
    t = LookAtRight(gnu, 2.0); g.cam.add(t); g.cam.zap();
    g.clearMessages(); g.message(tr('__scenar1-intro-2__'), 100);
  } else if (tux && tux.isPlayer) g.cam.remove(t);
  yield g.Pause(); yield g.Fade();
  if (gnu) { g.cam.remove(t); yield acts(70); }
  else if (tux) {
    if (tux.isPlayer) { g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar1-intro-3__'), 100); }
    yield SayYes(tux, 50);
    yield acts(8, A.ROTUP);
    yield acts(12);
  }
  yield g.Pause(); yield g.Fade();
  if (gnu) { g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar1-intro-4__'), 100); }
  else if (tux && tux.isPlayer) g.cam.remove(t);
  yield g.Pause(1000); yield g.Fade();
  if (gnu) {
    g.cam.remove(t); g.cam.zap();
    gnu.persoBase.position.copy(old);
    g.cam.speed = 0.3; g.clearMessages();
    g.sound.playMusic(g.level.preloaded_music);
  }
});

const Mission1Outro = g => seq(g, function* ({ tux, gnu }) {
  g.cam.speed = 0.2;
  this.tuxArrived = false;
  let t, shark, tShark, e1, e2;
  if (gnu) { g.clearMessages(); g.message(tr('__scenar1-outro-1__'), 100); tp(gnu, 85.4329071045, -5.0, -16.2530593872); lookDir(gnu, 1, 0, 0); }
  yield g.Pause(); yield g.Fade();
  if (gnu) {
    shark = g.prop('shark1', null, { solid: false });
    shark.setXYZ(78.6, -3.8, -8.04504203796); shark.rotateIncline(50);
    tShark = new FixTraveling(P(null, 78.1, -3.7, -9.04504203796), P(shark.obj), true, true);
    g.cam.add(tShark); g.cam.zap();
    g.clearMessages(); g.message(tr('__scenar1-outro-2__'), 100);
  }
  yield g.Pause(); yield g.Fade();
  if (tux) {
    const rank = tux.rank % 2;
    yield lookAt(tux, V3(83.7683410645, -5.65, -23.7621879578));
    yield gotoGen(tux, V3(83.7683410645, -5.65, -23.7621879578), 2.0);
    yield gotoGen(tux, V3(61.7737007141, -5.925, -4.8 + 2.1 * rank), 2.0);
    yield lookAt(tux, V3(-1, 0, 0));
    if (tux.isPlayer) { t = new FixTraveling(P(null, 64.5751266479, 0.286143124104, -1.177742660046), P(null, 66.2650909424, -0.830011188984, -3.27568721771), true, true); g.cam.add(t); }
    yield acts(100, A.WAIT, 0, 2.5);
    if (tux.isPlayer) { this.tuxArrived = true; this.tux = tux; }
  } else if (gnu) {
    g.cam.remove(tShark); shark.visible = false;
    while (!this.tuxArrived) yield act();
  }
  yield acts(20);
  yield g.Fade();
  if (tux && tux.isPlayer) { g.cam.remove(t); t = new FixTraveling(P(tux, 0, 0.7, 1.45), P(tux, 0, 0.45, 0), true, true); g.cam.add(t); g.cam.zap(); }
  yield acts(20);
  if (gnu) {
    const TUX = this.tux;
    for (let i = 0; i < 3; i++) {  // the boxes of medicine falling into the truck
      const m = g.prop('medoc', null, { solid: false });
      m.move(TUX.localPoint(0.2 * (i - 1), 0.8 + 0.2 * i, 1.2)); m.rotateLateral(15 * i - 10);
      g.addUpdater({ round() { if (m.y > TUX.pos.y + 0.45) m.addVector(TUX.toWorld(V3(0, -0.01, -0.01))); } });
    }
  }
  yield acts(50);
  if (tux) yield acts(30);
  else if (gnu) {
    persoRot(gnu, UP, 130);
    persoMoveWorld(gnu, this.tux.localPoint(-1.0, 0.08, 1.0));
    for (let i = 0; i < 30; i++) { persoAddWorld(gnu, this.tux.toWorld(V3(0.02, 0, 0))); yield act(); }
    g.clearMessages(); g.message(tr('__scenar1-outro-3__'), 100);
    gnu.obj.updateWorldMatrix(true, true);
    e1 = exorbitedEye(g, gnu.persoObj.localToWorld(V3(-0.02214474081995, 0.4375665187835, -0.1125)), 20);
    e2 = exorbitedEye(g, gnu.persoObj.localToWorld(V3(0.02214474081995, 0.4375665187835, -0.1125)), -20);
  }
  yield g.Pause();
  if (tux) yield acts(35);
  else if (gnu) {
    e1.destroy(); e2.destroy();
    shark.visible = true; shark.rotateIncline(-50); shark.rotateLateral(-130);
    shark.move(this.tux.localPoint(1.0, 0.14, 1.0));
    for (let i = 0; i < 35; i++) { shark.addVector(this.tux.toWorld(V3(-0.02, 0, 0))); yield act(); }
    g.clearMessages(); g.message(tr('__scenar1-outro-4__'), 100);
  }
  yield g.Pause();
  if (tux && tux.isPlayer) {
    g.clearMessages(); g.message(tr('__scenar1-outro-5__'), 100);
    g.cam.remove(t);
    t = new FixTraveling(P(persoOf(tux), -1, 0, -0.5), P(persoOf(tux), 0, 0, 0), true, true); g.cam.add(t);
  }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.cam.speed = 0.3; g.levelCompleted(tux, true); yield acts(3); }
});

// ---------------------------------------------------------------- mission 2
const Mission2Intro = g => seq(g, function* ({ tux, gnu, shark }) {
  g.cam.speed = 0.1;
  let t, t2, light, gnuPerso, sharkPerso;
  if (gnu) {
    tp(gnu, 85.4329071045, -5.25 + 0.3, -16.2530593872); lookDir(gnu, 1, 0, 0);
    light = g.light(V3(75.5, -3.5, -7.0));
    hidePerso(gnu);
    gnuPerso = g.prop('gnu1', null, { solid: false }); gnuPerso.setXYZ(75.0, -4.35, -8.4); gnuPerso.rotateLateral(-90);
    t = new FixTraveling(P(null, 75.5, -3.35, -6.4), P(gnuPerso.obj, 0, 1, 0), true, true);
  } else if (shark) {
    g.clearMessages(); g.message(tr('__scenar2-intro-1__'), 100);
    tp(shark, 69.4181060791, -5.625 + 0.3, -15.2002220154); lookDir(shark, -0.3, 0, 0.6);
    hidePerso(shark);
    sharkPerso = g.prop('shark1', null, { solid: false }); sharkPerso.setXYZ(76.0, -4.3, -8.4); sharkPerso.rotateLateral(90);
    t = new FixTraveling(P(null, 75.5, -3.35, -6.4), P(sharkPerso.obj, 0, 0.95, 0), true, true);
    t2 = new FixTraveling(P(null, 75.5, -3.35, -6.4), P(null, ...sharkPerso.localPoint(0, 0.95, 0).toArray()), true, true);
    g.cam.add(t);
    this.sharkArrived = false;
    const printMessage = () => (function* () { g.message(tr('__scenar2-1__')); })();
    const L = pts => pts.map(p => V3(...p));
    const start = [...L([[50.3923454285, -5.625, 8.96249961853], [40.7581253052, -5.625, 13.6631250381], [32.8351249695, -6.375, 10.6235160828]]), printMessage];
    const ga = L([[22.4124565125, -6.38087177277, 4.67110776901], [21.2822265625, -6.375, 4.576171875], [7.29548740387, -0.638323783875, 4.44479942322], [-4.91449213028, -0.375, 4.22445392609], [-3.81179690361, -1.125, -26.1578102112]]);
    const gd = L([[22.4124565125, -6.38087177277, 4.67110776901], [25.8687057495, -6.75, -35.6249084473], [36.8348083496, -6.75, -56.1541824341], [36.7147674561, -6.37904405594, -74.4520797729]]);
    const af = L([[-3.81179690361, -1.125, -26.1578102112], [6.46447372437, 0, -19.9380531311], [9.95081996918, 0, -8.88684940338], [16.5414352417, 0, -7.946393013], [26.5414352417, 0, -7.946393013]]);
    const fb = L([[26.5414352417, 0, -7.946393013], [35.0200386047, 0, -7.946393013], [44.4480857849, 0, -18.4586982727], [55.1251296997, -5.25, -18.3392944336]]);
    const fd = L([[26.5414352417, 0, -7.946393013], [36.7147674561, -6.37904405594, -74.4520797729]]);
    const ad = L([[-3.81179690361, -1.125, -26.1578102112], [-13.2186756134, -1.125, -37.5811576843], [-18.7928314209, -1.125, -48.8303947449], [-2.38635921478, -1.5, -49.7544670105], [3.55569171906, -2.52949953079, -43.9239654541], [12.7745409012, -4.66128826141, -41.5636520386], [14.374162674, -5.8355588913, -34.8440742493], [24.2375221252, -6.75, -33.8340492249], [37.3864936829, -6.75, -53.8386001587], [36.7147674561, -6.37904405594, -74.4520797729]]);
    const ae = L([[-3.81179690361, -1.125, -26.1578102112], [-13.2186756134, -1.125, -37.5811576843], [-18.7928314209, -1.125, -48.8303947449], [-20.2157287598, -1.125, -58.9511184692], [-20.3266277313, -4.84918022156, -83.0176239014], [-33.139339447, -4.875, -85.9998779297], [-40.6741409302, -4.875, -93.6274795532], [-41.3330497742, -4.88650131226, -109.911811829], [-19.4819507599, -4.875, -112.883102417]]);
    const bc = L([[55.1251296997, -5.25, -18.3392944336], [61.5, -1.6, -42.9324378967], [62.3, -1.6, -42.9324378967], [63.1, -1.6, -42.9324378967], [62.5395393372, -4.73901462555, -29.3159122467], [71.4511871338, -6.375, -29.7449493408], [71.5570297241, -6.375, -47.8265609741], [68.75, -6.75, -53.25], [83.6261444092, -6.75, -61.8628501892], [84.954574585, -6.75, -77.4120330811]]);
    const bd = L([[55.1251296997, -5.25, -18.3392944336], [61.7998275757, -6.75, -51.3839759827], [37.3864936829, -6.75, -53.8386001587], [36.7147674561, -6.37904405594, -74.4520797729]]);
    const cd1 = L([[84.954574585, -6.75, -77.4120330811], [74.9383087158, -6.75, -91.9014434814], [56.2909927368, -6.75, -92.180557251], [36.9404945374, -6.75, -91.0073547363], [36.7147674561, -6.37904405594, -74.4520797729]]);
    const cd2 = L([[84.954574585, -6.75, -77.4120330811], [73.7326126099, -6.375, -79.3630218506], [84.3498153687, -6.75, -78.2598114014], [85.0124969482, -6.75, -64.4933624268], [76.25, -6.75, -58.25], [45.850944519, -6.75, -56.559967041], [37.3864936829, -6.75, -53.8386001587], [36.7147674561, -6.37904405594, -74.4520797729]]);
    const ce = L([[84.954574585, -6.75, -77.4120330811], [74.4355697632, -6.75454902649, -92.2824172974], [12.4784030914, -5.44571590424, -91.5136260986], [11.6511468887, -4.875, -112.090705872], [-19.4819507599, -4.875, -112.883102417]]);
    const de = L([[36.7147674561, -6.37904405594, -74.4520797729], [32.1165390015, -6.375, -74.219833374], [29.6399059296, -6.41641902924, -74.2720947266], [24.3786563873, -6.31310939789, -74.284362793], [8.0750837326, -3.28853082657, -75.6640548706], [-5.37833976746, -4.875, -87.4066848755], [0.75, -4.875, -94.0], [0.65097117424, -4.92752599716, -112.467048645], [-19.4819507599, -4.875, -112.883102417]]);
    const pc = new PathComputer();
    pc.add('g', 'a', ga); pc.add('g', 'd', gd); pc.add('a', 'f', af); pc.add('f', 'b', fb); pc.add('f', 'd', fd, false);
    pc.add('a', 'd', ad); pc.add('a', 'e', ae, false); pc.add('b', 'c', bc, false); pc.add('b', 'd', bd, false);
    pc.add('c', 'd', cd1); pc.add('c', 'd', cd2, false); pc.add('c', 'e', ce); pc.add('d', 'e', de);
    if (g.difficulty === 0) shark.path = Math.random() < 0.5 ? [...start, ...gd, ...de] : [...start, ...ga, ...ae];
    else shark.path = [...start, ...pc.randomPath('g', 'e', [0, 4, 7][g.difficulty])];
    const hunters = g.characters.filter(c => c.isCompetitor);
    shark.finished = () => {
      for (const c of hunters) if (c.alive && c.distanceTo(shark) < 6) { Mission2Outro(g).start({ tux: c, shark }); hunters.splice(hunters.indexOf(c), 1); break; }
      return 1;
    };
    shark.onDie = () => GnuSpeech(g, [tr('__scenar2-2__'), tr('__gameover__')]).start({ tux: PLAYER });
  }
  yield g.Pause();
  if (gnu) { g.clearMessages(); g.message(tr('__scenar2-intro-2__'), 100); g.cam.add(t); }
  else if (shark) g.cam.remove(t);
  yield g.Pause();
  if (gnu) g.cam.remove(t);
  else if (shark) { g.clearMessages(); g.message(tr('__scenar2-intro-3__'), 100); g.cam.add(t); }
  yield g.Pause();
  if (gnu) { g.clearMessages(); g.message(tr('__scenar2-intro-4__'), 100); g.cam.add(t); }
  else if (shark) g.cam.remove(t);
  yield g.Pause();
  if (gnu) g.cam.remove(t);
  else if (shark) { g.clearMessages(); g.message(tr('__scenar2-intro-5__'), 100); g.cam.add(t2); }
  yield g.Pause();
  if (gnu || tux) yield acts(45);
  else if (shark) for (let i = 0; i < 45; i++) { sharkPerso.addVector(V3(-0.06, 0, -0.007)); yield act(); }
  yield g.Fade();
  if (shark) {
    g.cam.remove(t2);
    t = new FixTraveling(P(null, 75.5, -3.35, -6.4), P(shark, 0, 0.95, 0), true, true);
    g.cam.add(t);
    sharkPerso.remove(); hidePerso(shark, false);
    g.cam.zap();
    yield gotoGen(shark, V3(54.1, -5.625 + 0.3, 4.3));
    g.nextRound(() => (this.sharkArrived = true));
  }
  while (!this.sharkArrived) yield act();
  if (gnu) { g.clearMessages(); g.message(tr('__scenar2-intro-6__')); g.cam.add(t); }
  else if (shark) g.cam.remove(t);
  yield g.Pause(); yield g.Fade();
  if (gnu) {
    g.cam.remove(t); g.cam.zap(); gnuPerso.remove();
    g.cam.speed = 0.3; g.clearMessages();
    g.removeCharacter(gnu); light.remove();
  } else if (tux) {
    g.changeVehicle(tux, 1);
    tp(tux, 85.4329071045, -5.25 + 0.3, -16.2530593872); lookDir(tux, -1, 0, 0);
  } else if (shark && g.difficulty === 2) { shark.waitDist = 0; yield acts(10); }
});

const Mission2Outro = g => seq(g, function* ({ tux, shark }) {
  g.cam.speed = 0.2;
  this.sharkArrived = false;
  yield g.Fade();
  if (shark) {
    const t = new FixTraveling(P(null, -30, -2, -114), new Dir(null, 1, -0.2, -0.2), false, false);
    g.cam.add(t); g.cam.zap();
    this.door = g.named_('palace_door');
    g.sound.play('porte-1.wav', this.door.pos);
    for (let i = 0; i < 65; i++) { this.door.turnLateral(-1.5); yield act(); }
  } else if (tux) yield acts(64);
  if (shark) {
    yield lookAt(shark, V3(-21.375, -4.5, -130));
    yield gotoGen(shark, V3(-21.375, -4.5, -118), 2.0);
    g.nextRound(() => { this.sharkArrived = true; g.removeCharacter(shark); });
  }
  while (!this.sharkArrived) yield act();
  if (tux) {
    g.sound.play('porte-1.wav', this.door.pos);
    yield lookAtThenGoto(tux, V3(-21.375, -4.5, -130), V3(-21.375, -4.5, -118), this.door);
  }
  if (tux && tux.isPlayer) { g.cam.speed = 0.3; g.levelCompleted(tux, true); yield acts(3); }
});

// ---------------------------------------------------------------- mission 3
const Mission3Intro = g => seq(g, function* ({ tux }) {
  g.cam.speed = 0.1;
  let tTux, tGnu, gnu, light;
  if (tux && tux.isPlayer) {
    tTux = LookAtRight(tux);
    tGnu = new FixTraveling(P(null, -6.3, 2.1, 6.8), P(null, -9.53, 2.6, 6.6), false, false);
    gnu = g.prop('gnu1', null, { solid: false }); gnu.setXYZ(-7.0, 1.6, 6.9); gnu.lookAt(new Dir(null, 0.4, 0, -1));
    light = g.light(V3(-6, 3, 3));
    g.cam.add(tTux);
    g.clearMessages(); g.message(tr('__scenar3-intro-1__'), 100);
  }
  yield g.Pause(); yield g.Fade();
  if (tux && tux.isPlayer) { g.cam.remove(tTux); g.cam.add(tGnu); g.clearMessages(); g.message(tr('__scenar3-intro-2__'), 100); }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.clearMessages(); g.message(tr('__scenar3-intro-3__'), 100); }
  yield g.Pause(); yield g.Fade();
  if (tux) {
    const fs = new FreeStyle(g, tux);
    fs.phase = 0;
    const factor = [2.9, 1.0, 0.5][g.difficulty];
    fs.onRecognized = () => {
      for (let i = fs.phase; i < Math.floor((tux.score * factor) / 100); i++) {
        fs.phase++;
        if (fs.phase === 6 && !g.doorOpened) {
          g.doorOpened = true;
          const door = g.named_('palace_door');
          g.sound.play('porte-1.wav', door.pos);
          let duration = 100;
          g.addUpdater({ round() { door.turnLateral(-1.0); if (--duration <= 0) this.removed = true; } });
          g.prop('secretpassage1-c').setXYZ(-22.5, -4.5, -118.5);
          g.scripts.push({ pos: V3(-21.0, -18.5, -160.5), radius: 3.0, disabled: 0, data: { ok: [] }, fn: (g, s, c) => {
            if (!s.data.ok.includes(c)) { Mission3Outro(g).start({ tux: c }); s.data.ok.push(c); }
          } });
        }
        if (fs.phase <= 6) g.message(tr(`__scenar3-${fs.phase}__`));
      }
    };
    g.addUpdater(fs);
  }
  if (tux && tux.isPlayer) {
    light.remove(); gnu.remove();
    g.cam.remove(tGnu); g.cam.zap(); g.cam.speed = 0.3; g.clearMessages();
    startFreestyleGame(g, [800, 100, 20][g.difficulty], tr('__scenar3-7__'));
  }
});
const Mission3Outro = g => seq(g, function* ({ tux }) {
  if (tux && tux.isPlayer) { g.levelCompleted(tux, true); yield acts(3); }
});

// ---------------------------------------------------------------- mission 4 / 5 (the mountain)
function diplomat(g, lookX, lookZ) {
  const d = g.prop('vehicle1', null, { solid: false });
  d.setXYZ(-0.186012268066, -3.9, -3.07724571228); d.lookAt(new Dir(null, lookX, 0, lookZ));
  g.prop('monk1', d.obj, { solid: false }).setXYZ(0, 0.1, 0);
  return d;
}
const Mission4Intro = g => seq(g, function* ({ tux, shark }) {
  if (shark) {
    diplomat(g, 1, 1);
    shark.escapeDist = 100;
    tp(shark, 71.861579895, -7.61357212067 + 0.3, 233.545715332);
    shark.path = [];
    for (let i = 0; i < [1, 3, 6][g.difficulty]; i++) {
      for (let tries = 0; tries < 50; tries++) {
        const p = V3(-13 + Math.floor(Math.random() * 238), 100, -13 + Math.floor(Math.random() * 238));
        const h = g.collision.raypick(p, V3(0, -1, 0), 1000, false, true);
        if (h) { shark.path.push(h.point); break; }
      }
    }
    shark.path.push(V3(3.25515937805, -3.92874336243, -3.19477081299));
    const hunters = g.characters.filter(c => c.isCompetitor);
    shark.finished = () => {
      for (const c of hunters) if (c.alive && c.distanceTo(shark) < 6) { Mission4Outro(g).start({ tux: c, shark }); hunters.splice(hunters.indexOf(c), 1); break; }
      return 1;
    };
    shark.onDie = () => GnuSpeech(g, [tr('__scenar2-2__'), tr('__gameover__')]).start({ tux: PLAYER });
    if (g.difficulty === 2) { yield acts(100); shark.waitDist = 0; }
  }
  yield act();
});
const Mission4Outro = g => seq(g, function* ({ tux, shark }) {
  g.cam.speed = 0.2;
  yield g.Fade();
  let tShark, tDiplo;
  const say = (k, cam) => { g.clearMessages(); g.message(tr(k), 100); };
  if (shark) {
    lookPoint(shark, V3(-0.186012268066, shark.pos.y, -3.07724571228));
    tShark = LookAtRight(shark);
    tDiplo = new FixTraveling(P(null, -0.686012268066, -3.3, -2.07724571228), P(null, -0.186012268066, -3.4, -3.07724571228), true, true);
    g.cam.add(tDiplo); g.cam.zap(); say('__scenar4-outro-1__');
  }
  yield g.Pause();
  if (shark) { g.cam.remove(tDiplo); g.cam.add(tShark); say('__scenar4-outro-2__'); }
  yield g.Pause();
  if (shark) { g.cam.remove(tShark); g.cam.add(tDiplo); say('__scenar4-outro-3__'); }
  yield g.Pause();
  if (shark) { g.cam.remove(tDiplo); g.cam.add(tShark); say('__scenar4-outro-4__'); }
  yield g.Pause();
  if (shark) { g.cam.remove(tShark); g.cam.add(tDiplo); say('__scenar4-outro-5__'); }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.cam.speed = 0.3; g.levelCompleted(tux, true); yield acts(3); }
});

const Mission5Intro = g => seq(g, function* ({ tux, shark, killer1, killer2, killer3 }) {
  let t, dip;
  if (shark) {
    dip = diplomat(g, 1, 0);
    tp(shark, 3.25515937805, -3.92874336243 + 0.3, -3.19477081299); rotLat(shark, 90); g.addHeadlight(shark);
  } else if (killer1) { killer1.name = 'killer1'; tp(killer1, 7.90801048279, -2.74877929688 + 0.3, -4.25709342957); rotLat(killer1, 90); g.addHeadlight(killer1); }
  else if (killer2) { killer2.name = 'killer2'; tp(killer2, 111.350158691, 4.24810218811, 63.3203811646); rotLat(killer2, 60); g.addHeadlight(killer2); }
  else if (killer3) { killer3.name = 'killer3'; tp(killer3, -3.10736656189, 2.05653381348, 34.0876617432); rotLat(killer3, 60); g.addHeadlight(killer3); }
  if (tux) yield acts(15, A.WAIT, 0, 0); else yield acts(15);
  if (tux && tux.isPlayer) { t = LookAtFront(tux); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar5-intro-1__'), 100); }
  yield g.Pause();
  if (tux && tux.isPlayer) g.cam.remove(t);
  else if (shark) { t = LookAtLeft(shark); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar5-intro-2__'), 100); }
  yield g.Pause();
  if (shark) g.cam.remove(t);
  else if (tux) tux.turn(UP, -60);
  else if (killer1) { t = LookAtFront(killer1); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar5-intro-3__'), 100); }
  yield g.Pause();
  if (killer1) g.cam.remove(t);
  else if (tux && tux.isPlayer) { g.cam.add(t); g.clearMessages(); g.message(tr('__scenar5-intro-4__'), 100); }
  yield g.Pause();
  if (shark) { g.removeCharacter(shark); dip.remove(); }
  if (tux && tux.isPlayer) { g.cam.remove(t); g.cam.zap(); g.clearMessages(); }
});
const Mission5Outro = g => seq(g, function* ({ tux, gnu, shark, killer1, killer2, killer3 }) {
  g.cam.speed = 0.2;
  let t;
  if (gnu) {
    tp(gnu, 72.0, -6.03447341919, 246.203475952);
    const cam = carry(g, gnu, 'webcam1', gnu.persoBase.position.x - 0.15, gnu.persoBase.position.y + 0.43, gnu.persoBase.position.z - 0.15);
    cam.rotateLateral(180);
    const spot = new THREE.SpotLight(0xffffff, 8, 20, Math.PI / 4, 0.5, 1);
    spot.position.set(0, 2, -2); gnu.obj.add(spot); spot.target = gnu.obj;
  } else if (shark) { tp(shark, 75.9881744385, -7.94097805023, 230.705337524); rotLat(shark, 180); }
  else if (tux && tux.light) { tux.light.remove(); tux.light = null; }
  if (gnu) {
    this.door1 = g.named_('door1'); this.door2 = g.named_('door2');
    g.sound.play('porte-1.wav', this.door1.pos);
    for (let i = 0; i < 65; i++) { this.door1.turnLateral(1.5); this.door2.turnLateral(-1.5); yield act(); }
    yield acts(20, A.WAIT, 0, -0.7);
  } else yield acts(85);
  if (gnu) {
    t = new FixTraveling(P(persoOf(gnu), 0, 0.15, -1.2), P(persoOf(gnu), 0, 0.3, 0), true, true);
    g.cam.add(t); g.clearMessages(); g.message(tr('__scenar5-outro-1__'), 100);
  }
  yield g.Pause(); yield g.Fade();
  if (gnu) g.cam.remove(t);
  if (shark) {
    shark.obj.updateWorldMatrix(true, true);
    const target = shark.persoObj.localToWorld(V3(0, 0.3, 0));
    const from = shark.persoObj.localToWorld(V3(1, 0.7, -0.5));
    t = new FixTraveling(P(null, ...from.toArray()), P(null, ...target.toArray()), true, true);
    g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar5-outro-2__'), 100);
  }
  yield g.Pause();
  if (shark || killer1 || killer2 || killer3) yield acts(30, A.WAIT, 0, 3.0); else yield acts(30);
  if (tux && tux.isPlayer) { g.cam.speed = 0.3; g.levelCompleted(tux, true); yield acts(3); }
});

// ---------------------------------------------------------------- mission 6
const Mission6Intro = g => seq(g, function* ({ tux, gnu, killer, killer2 }) {
  g.cam.speed = 0.1;
  this.tuxArrived = false;
  let t, python, tPython;
  if (tux) { g.clearMessages(); g.message(tr('__scenar6-intro-0__')); }
  else if (gnu) { tp(gnu, -5.3388633728, -0.375, 5.75051689148); g.named_('palace_door').turnLateral(-97.5); g.addHeadlight(gnu); }
  else if (killer) { tp(killer, -8.65006446838, -1.125, -30.5899105072); g.addHeadlight(killer); }
  else if (killer2) { tp(killer2, -1.49378943443, -1.69866323471, -65.828414917); g.addHeadlight(killer2); }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.clearMessages(); g.message(tr('__scenar6-intro-1__')); t = LookAtRight(tux); g.cam.add(t); }
  yield g.Pause();
  if (gnu) { g.clearMessages(); g.message(tr('__scenar6-intro-2__')); t = LookAtLeft(gnu); g.cam.add(t); }
  else if (tux && tux.isPlayer) g.cam.remove(t);
  yield g.Pause();
  if (gnu) { g.sound.play('phone.ogg'); g.clearMessages(); g.message(tr('__scenar6-intro-3__')); }
  yield g.Pause(); yield g.Fade();
  if (gnu) {
    python = g.prop('python1', null, { solid: false }); python.y = 100;
    tPython = new FixTraveling(P(python.obj, 0.2, 0.2, -0.5), P(python.obj, 0, 0.4, 0), false, false);
    g.cam.add(tPython); g.clearMessages(); g.message(tr('__scenar6-intro-4__'));
  }
  yield g.Pause(); yield g.Fade();
  if (gnu) { python.remove(); g.cam.remove(tPython); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar6-intro-5__')); }
  yield g.Pause();
  if (gnu) { g.sound.play('tutut.ogg'); g.clearMessages(); g.message(tr('__scenar6-intro-6__')); }
  yield g.Pause();
  if (gnu) { g.clearMessages(); g.message(tr('__scenar6-intro-7__')); }
  yield g.Pause();
  if (gnu) g.cam.remove(t);
  if (killer) {
    rotLat(killer, 90);
    t = new FixTraveling(P(null, killer.pos.x + 4, killer.pos.y + 1, killer.pos.z + 15), P(killer, 0, 1, 0), true, true);
    g.cam.add(t);
    yield acts(60); yield acts(60, A.WAIT, 0, 0.6);
  } else yield acts(120);
  if (killer) g.cam.remove(t);
  else if (gnu) { g.cam.add(t); g.clearMessages(); g.message(tr('__scenar6-intro-8__')); }
  yield g.Pause();
  if (gnu) { g.cam.remove(t); g.clearMessages(); }
  else if (tux) {
    yield gotoGen(tux, V3(2.5, -0.375, 3.15875339508));
    yield lookAt(tux, V3(0.5, 0, -1));
    yield wallClimber(tux);
    yield lookAt(tux, tux.pos.clone().add(V3(0, 0, -1)));
    g.nextRound(() => (this.tuxArrived = true));
  }
  while (!this.tuxArrived) yield act();
  yield g.Pause();
  if (gnu) { g.cam.speed = 0.3; g.clearMessages(); g.sound.playMusic(g.level.preloaded_music); g.removeCharacter(gnu); }
});
const Mission6Outro = g => seq(g, function* ({ tux }) {
  if (tux && tux.isPlayer) { g.levelCompleted(tux, true); yield acts(3); }
});

// ---------------------------------------------------------------- mission 7
const Mission7Intro = g => seq(g, function* ({ tux }) {
  let t;
  if (tux) { t = LookAtRight(tux); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar7-intro-1__')); }
  yield g.Pause();
  if (tux) g.cam.remove(t);
  if (tux && tux.isPlayer) {
    g.clearMessages();
    const python = g.levelPython = g.prop('vehicle3');
    python.setXYZ(34.326007843, 0.888233947754, 12.4514389038); python.rotateLateral(180);
    g.prop('python1', python.obj, { solid: false }).setXYZ(0, 0.2, 0.35);
  }
});
const Mission7AddEnemy = (g, character, x, y, z, makeFall) => seq(g, function* ({ tux, killer }) {
  let t;
  if (killer) {
    tp(killer, x, y + 0.3, z);
    const p = character.localPoint(0, 0, -50); p.y = killer.pos.y;
    lookPoint(killer, p);
    t = LookAtLeft(killer, 1.8); g.cam.add(t); g.cam.speed = 0.1;
    g.clearMessages(); g.message(tr('__scenar7-1__'), 100);
  }
  yield g.Pause();
  if (killer) {
    g.cam.remove(t); t = LookAtRight(killer, 4.0); g.cam.add(t);
    yield act(A.JUMP, 0, -1);
    yield acts(25, A.WAIT, 0, -1);
    yield acts(5, A.ROTDOWN, 0, -1);
    if (makeFall) for (const p of g.pushables) if (p.name === makeFall) p.worthPlaying = true;
  } else if (tux) yield acts(31);
  yield g.Fade();
  if (killer) { g.cam.remove(t); g.cam.zap(); g.cam.speed = 0.3; g.clearMessages(); }
});
const Mission7Cabane = g => seq(g, function* ({ tux }) {
  let t;
  if (tux) {
    t = new FixTraveling(P(null, 39, 5, 50), P(g.levelPython.obj), true, true); g.cam.add(t); g.cam.speed = 0.1;
    g.clearMessages(); g.message(tr('__scenar7-3__'));
  }
  yield g.Pause();
  if (tux) { g.cam.remove(t); t = new FixTraveling(P(null, 39, 4, 12), P(g.levelPython.obj), true, true); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar7-4__')); }
  yield g.Pause(); yield g.Fade();
  if (tux) { g.cam.remove(t); g.cam.zap(); g.cam.speed = 0.3; g.clearMessages(); }
});
const Mission7Outro = g => seq(g, function* ({ tux, python }) {
  let t;
  if (python) {
    g.levelPython.remove();
    tp(python, 34.326007843, 0.888233947754, 12.4514389038); rotLat(python, 180);
    t = LookAtLeft(python); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar7-outro-1__'));
  } else if (tux) t = LookAtFront(tux);
  yield g.Pause();
  if (python) { g.clearMessages(); g.message(tr('__scenar7-outro-2__')); }
  yield g.Pause();
  if (python) g.cam.remove(t); else if (tux) { g.cam.add(t); g.clearMessages(); g.message(tr('__scenar7-outro-3__')); }
  yield g.Pause();
  if (python) { g.cam.add(t); g.clearMessages(); g.message(tr('__scenar7-outro-4__')); } else if (tux) g.cam.remove(t);
  yield g.Pause();
  if (python) g.cam.remove(t); else if (tux) { g.cam.add(t); g.clearMessages(); g.message(tr('__scenar7-outro-5__')); }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.levelCompleted(tux, true); yield acts(3); }
});

// ---------------------------------------------------------------- mission 8
const KILLER8_PATHS = [
  [[34.8027191162, 1.44117641449, 29.5947685242], [46.1448402405, 1.85601460934, 30.3215751648], [81.4145278931, 0.97967171669, 25.0217971802], [111.195541382, 1.05167841911, 29.1344203949], [121.912506104, 0.637456178665, 37.2835159302], [117.454689026, 0.754901885986, 49.2385520935], [100.839179993, 2.17436337471, 64.9775848389], [80.5361251831, 1.03603553772, 82.7462387085], [83.7344207764, 1.67107856274, 88.8338546753], [83.6148300171, 2.98795938492, 97.6328277588], [77.1922988892, 3.52166175842, 122.451568604], [77.2774047852, 4.43288946152, 133.972122192], [87.7821273804, 0.435206890106, 164.775939941], [99.5029144287, 0.191377609968, 171.15852356], [120.222740173, 1.00903081894, 170.174957275], [113.933013916, 0.985481381416, 153.547088623], [111.715179443, 1.5, 137.749237061]],
  [[35.5492134094, 1.45529460907, 30.0423545837], [39.0626983643, 1.5195453167, 29.293756485], [46.2384185791, 1.22116327286, 33.888671875], [50.2972183228, 4.51887798309, 55.5366172791], [50.5635108948, 3.77171492577, 73.3933181763], [54.1204223633, 4.86251068115, 79.1944656372], [62.8503303528, 5.32229709625, 81.8691711426], [80.2222290039, 1.01580369473, 82.4425430298], [84.3109283447, 1.74578893185, 90.013092041], [77.6757354736, 2.99731588364, 114.772651672], [77.3346099854, 5.98569726944, 131.621459961], [88.3166275024, 0.463613271713, 165.38381958], [97.915977478, 0.106691598892, 170.075210571], [120.215400696, 1.00970244408, 170.159225464], [113.949005127, 1.03407847881, 152.886978149], [111.71975708, 1.5, 138.088562012]],
];
const Mission8Intro = g => seq(g, function* ({ tux, gnu, shark, killer1, killer2 }) {
  let t;
  if (tux) { t = LookAtBack(tux, 1.5); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar8-intro-0__')); }
  else if (gnu) { tp(gnu, 21.9561328888, 0.397022294998, 28.5); rotLat(gnu, -90); }
  else if (shark) tp(shark, 21.7788066864, 0.934619772434, 34.0);
  else if (killer1) { this.killer1 = killer1; tp(killer1, 31.9246749878, 1.45169377327, 42.7683944702); }
  else if (killer2) { this.killer2 = killer2; if (g.difficulty === 0) g.removeCharacter(killer2); else tp(killer2, 33.9246749878, 1.45169377327, 45.7683944702); }
  yield g.Pause();
  if (gnu) { t = LookAtBack(gnu, 1.0); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar8-intro-1__')); } else if (tux) g.cam.remove(t);
  yield g.Pause();
  if (shark) { t = LookAtRight(shark, 5.0); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar8-intro-2__')); } else if (gnu) g.cam.remove(t);
  yield g.Pause();
  if (tux) { t = LookAtRight(tux, 1.0); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar8-intro-3__')); } else if (shark) g.cam.remove(t);
  yield g.Pause();
  if (gnu) { t = LookAtRight(gnu, 1.0); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar8-intro-4__')); } else if (tux) g.cam.remove(t);
  yield g.Pause();
  if (gnu) g.cam.remove(t);
  if (tux && tux.isPlayer) {
    g.clearMessages();
    const pv = g.prop('vehicle3');
    pv.setXYZ(111.893669128, 1.8, 136.298706055); pv.rotateLateral(180);
    g.prop('python1', pv.obj, { solid: false }).setXYZ(0, 0.2, 0.35);
    const self = this;
    g.addUpdater({ round() {
      if (!self.killer1.alive && !self.killer2.alive) { Mission8Outro2(g).start({ tux: PLAYER, killer1: AUTO, killer2: AUTO }); this.removed = true; }
    } });
  }
  function* killerControler(killer, path) {
    for (const p of path) yield gotoGen(killer, V3(...p), 2.0);
    yield acts(10);
    Mission8Outro1(g).start({ tux: PLAYER, killer1: AUTO, killer2: AUTO, winner: killer });
  }
  if (killer1) { killer1.maxspeedz = 0.5; killer1.weight = 1.0; killer1.animate(killerControler(killer1, KILLER8_PATHS[0])); }
  if (killer2) { killer2.maxspeedz = 0.5; killer2.weight = 1.0; killer2.animate(killerControler(killer2, KILLER8_PATHS[1])); }
});
const Mission8Outro1 = g => seq(g, function* ({ tux, killer1, killer2, winner }) {
  let t;
  if (winner) { t = LookAtFront(winner, 2.0); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar8-1__')); }
  yield g.Pause();
  if (winner) { g.sound.play('explose-3.wav', winner.pos); g.fx.explosion(winner.pos.clone(), 1000, 2.0); }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.levelCompleted(tux, false); yield acts(3); }
});
const Mission8Outro2 = g => seq(g, function* ({ tux, killer1, killer2 }) {
  let t, pythonT;
  yield g.Fade();
  if (tux) { tp(tux, 108.586151123, 1.38258528709, 142.891616821); lookDir(tux, 1, 0, -0.5); }
  if (tux && tux.isPlayer) {
    pythonT = new FixTraveling(P(null, 111.893669128, 3.8, 139.0), P(null, 111.893669128, 2.8, 136.298706055));
    g.cam.add(pythonT); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar8-outro-1__'));
  }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.clearMessages(); g.message(tr('__scenar8-outro-2__')); }
  yield g.Pause();
  if (tux && tux.isPlayer) g.cam.remove(pythonT);
  if (tux) { t = LookAtRight(tux, 2.0); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar8-outro-3__')); }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.cam.add(pythonT); g.clearMessages(); g.message(tr('__scenar8-outro-4__')); }
  if (tux) g.cam.remove(t);
  yield g.Pause();
  if (tux && tux.isPlayer) { g.levelCompleted(tux, true); yield acts(3); }
});

// ---------------------------------------------------------------- mission 9
const Mission9Intro = g => seq(g, function* ({ tux, python, killer }) {
  let t;
  if (python) { this.python = python; tp(python, 2.8, 0.3, 5.2); rotLat(python, -30); t = LookAtLeft(python); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar9-intro-1__')); }
  else if (killer) { this.killer = killer; tp(killer, 10.0, 0.4, -1.0); rotLat(killer, 180); killer.weight = 0.3; killer.floating = 0.4; killer.life = 1000; killer.pushFly = 0.1; killer.radius = 0.8; }
  yield g.Pause();
  if (tux) { t = LookAtRight(tux); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar9-intro-2__')); } else if (python) g.cam.remove(t);
  yield g.Pause();
  if (tux) g.cam.remove(t); else if (killer) { t = LookAtFront(killer); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar9-intro-3__')); }
  yield g.Pause();
  if (tux) { t = LookAtBack(tux, 2.5); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar9-intro-4__')); } else if (killer) g.cam.remove(t);
  yield g.Pause();
  if (tux) g.cam.remove(t);
  if (tux && tux.isPlayer) {
    g.clearMessages();
    const timer = new TimerLabel(g, [tux], 5, () => Mission9Outro1(g).start({ tux: PLAYER, python: AUTO, killer: AUTO }));
    g.widgets.push(timer); g.addUpdater(timer);
    const { killer: k, python: p } = this;
    g.addUpdater({ round() {
      if (k.pos.z < -30 && !g.pushables.some(q => q.alive && q.name === 'quille')) {
        Mission9Outro2(g).start({ tux, python: p, killer: k }); this.removed = true; timer.timeLimit = -1;
      }
    } });
  }
});
const Mission9Outro1 = g => seq(g, function* ({ tux, python, killer }) {
  if (killer) { g.cam.add(LookAtFront(killer)); g.clearMessages(); g.message(tr('__scenar9-outro-1__')); }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.levelCompleted(tux, false); yield acts(3); }
});
const Mission9Outro2 = g => seq(g, function* ({ tux, python, killer }) {
  let t;
  if (python) { t = LookAtLeft(python); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar9-outro-2__')); }
  yield g.Pause();
  if (python) g.cam.remove(t);
  if (python || tux) yield acts(120);
  else if (killer) {
    t = new FixTraveling(P(null, ...g.cam.pos.toArray()), P(killer), true, true); g.cam.add(t);
    g.clearMessages(); g.message(tr('__scenar9-outro-3__'));
    const engine = g.prop('engine1', null, { solid: false }); engine.setXYZ(10, 11, -37.1);
    yield acts(20);
    for (let i = 0; i < 50; i++) { engine.y -= 0.1; yield act(); }
    killer.visible = false;
    for (let i = 0; i < 50; i++) { engine.y += 0.1; yield act(); }
  }
  yield g.Pause();
  if (tux && tux.isPlayer) { g.levelCompleted(tux, true); yield acts(3); }
});

// ---------------------------------------------------------------- mission 10
const Mission10Intro = g => seq(g, function* ({ tux, shark }) {
  let t, medocs;
  if (tux) { medocs = tux.medocs; t = LookAtRight(tux); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar10-intro-1__')); }
  else if (shark) { tp(shark, 40.0, 0.1, 146.5); lookDir(shark, 1, 0, 0); }
  yield g.Pause();
  if (tux) g.cam.remove(t); else if (shark) { t = LookAtRight(shark, 2.0); g.cam.add(t); }
  for (let i = 0; i < 40; i++) yield tux ? act() : act(A.TURBO, 0, -1);
  if (tux) {
    t = LookAtRight(tux, 4.0); g.cam.add(t);
    for (const m of medocs) { const a = Math.random() * 6.2832; detach(g, m); m.speed = V3(0.3 * Math.cos(a), 0.4, 0.3 * Math.sin(a)); }
    tux.internalExtras = [];
  } else if (shark) g.cam.remove(t);
  if (tux) {
    yield acts(20);
    for (let i = 0; i < 80; i++) { for (const m of medocs) { m.addVector(m.speed); m.speed.y -= 0.01; } yield act(); }
  } else if (shark) { yield acts(10, A.TURBO, 0, -1); yield acts(90); }
  if (tux) g.cam.remove(t); else if (shark) { t = LookAtRight(shark, 2.0); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar10-intro-2__')); }
  yield g.Pause();
  if (shark) { g.clearMessages(); g.message(tr('__scenar10-intro-3__')); }
  yield g.Pause();
  if (tux) { for (const m of medocs) m.remove(); t = LookAtRight(tux, 2.0); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar10-intro-4__')); }
  else if (shark) g.cam.remove(t);
  yield g.Pause();
  if (tux) g.cam.remove(t); else if (shark) g.removeCharacter(shark);
  if (tux && tux.isPlayer) {
    g.clearMessages();
    const timer = new TimerLabel(g, [tux], [1000, 450, 130][g.difficulty], () => GnuSpeech(g, [tr('__scenar10-1__'), tr('__gameover__')]).start({ tux: PLAYER }));
    g.widgets.push(timer); g.addUpdater(timer);
    addMedocs(g, [4, 7, 8][g.difficulty]);
    const killer = addPerso(g, 'killer', 0, 'fighter');
    tp(killer, 49.9499931335, 0.8, 14.455827713);
    killer.flameThrower = g.difficulty;
  }
});

// ---------------------------------------------------------------- mission 11 / 12 (the airplane)
const Mission11Intro = g => seq(g, function* ({ tux, gnu }) {
  let t, tA, light;
  if (tux) {
    t = LookAtLeft(tux); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar11-intro-1__'));
    const plane = this.airplane = new Airplane(g);
    plane.prop.lookAt(new Dir(null, 1, 0, 0)); plane.prop.setXYZ(286.385559082, 18.117647171, 129.48248291);
  } else if (gnu) { tp(gnu, 246.7, 26.2, 105.8); lookDir(gnu, 0.5, 0, 1); }
  yield g.Pause(); yield g.Fade();
  if (tux) {
    g.cam.remove(t);
    const po = this.airplane.prop.obj;
    tA = new FixTraveling(P(po, -7, 2, -15), P(po, 0, 5, 0), false, false); g.cam.add(tA);
    light = new THREE.PointLight(0xffffff, 3 * Math.PI, 0, 0); light.position.set(2, 5, -10); po.add(light);
  }
  yield g.Pause(); yield g.Fade();
  if (tux) { g.cam.remove(tA); light.parent.remove(light); }
  else if (gnu) { t = LookAtLeft(gnu); g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar11-intro-2__')); }
  yield g.Pause();
  if (gnu) { g.clearMessages(); g.message(tr('__scenar11-intro-3__')); }
  yield g.Pause();
  if (tux) { g.cam.add(t); g.clearMessages(); g.message(tr('__scenar11-intro-4__')); } else if (gnu) g.cam.remove(t);
  yield g.Pause();
  if (tux) g.cam.remove(t);
  if (tux && tux.isPlayer) {
    g.clearMessages();
    const plane = this.airplane;
    if (g.difficulty === 1) plane.startInRound = 50; else if (g.difficulty === 2) plane.start();
    g.addUpdater({ round() {
      if (plane.x > 600) {
        if (plane.charactersOn.length) { g.levelCompleted(tux, true); g.chase.distance = 27; }
        else GnuSpeech(g, [tr('__scenar11-1__'), tr('__gameover__')]).start({ tux: PLAYER });
        this.removed = true;
      }
    } });
  }
});
const Mission12Intro = g => seq(g, function* ({ tux }) {
  let tA, t;
  const plane = g.flyingAirplane, po = plane.prop.obj;
  if (tux) {
    tA = new FixTraveling(P(po, -20, 2, -8), P(po, 0, 7, 0), true, true);
    g.cam.add(tA); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar12-intro-1__'));
  }
  yield g.Pause();
  if (tux) {
    g.cam.remove(tA); g.cam.speed = 0.7;
    t = new FixTraveling(P(po, -15, 12, -7), P(po, 0, 7, 0), true, true);
    g.cam.add(t); g.clearMessages(); g.message(tr('__scenar12-intro-2__'));
  }
  yield g.Pause();
  if (tux) g.cam.remove(t);
  if (tux && tux.isPlayer) {
    g.clearMessages();
    g.chase.distance = 15;
    const killer = (x, y, dz) => {
      const k = addPerso(g, 'killer', 1, 'fighter', { chromosom: FIGHT_CHROMOSOMS.killer_flight[g.difficulty] });
      k.teleport(V3(x, y, plane.z + dz));
    };
    killer(1, 15, -15);
    let round = 0;
    g.addUpdater({ round() {
      round++;
      if (round === 200) { if (g.difficulty >= 1) killer(0, 20, -20); }
      else if (round === 300) { if (g.difficulty === 2) killer(1, 20, -20); }
      else if (round === 400) { killer(1, 20, -20); if (g.difficulty === 2) killer(-1, 20, -22); }
      else if (round > 400 && g.characters.length === 1 && plane.charactersOn.length) {
        g.levelCompleted(tux, true); g.chase.distance = 27; this.removed = true;
      }
    } });
  }
});

// ---------------------------------------------------------------- mission 13
const Mission13Intro = g => seq(g, function* ({ tux, girafe }) {
  let t;
  yield g.Fade();
  if (tux) { g.clearMessages(); g.message(tr('__scenar13-intro-0__')); }
  else if (girafe) { tp(girafe, 27.7, 12.1, 187.7); lookDir(girafe, 1, 0, 0); }
  yield g.Pause();
  if (girafe) { t = LookAtLeft(girafe); g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar13-intro-1__')); }
  yield g.Pause();
  if (girafe) { g.cam.remove(t); g.clearMessages(); }
  yield acts(120, A.WAIT, 0, 0);
  yield g.Fade();
  if (tux) { tp(tux, 192.968460083, 1.06084299088, 177.368118286); yield acts(70); }
  else if (girafe) {
    tp(girafe, 199.3, 2.2, 179.0); lookDir(girafe, 1, 0, 0); rotLat(girafe, 33);
    t = new FixTraveling(P(null, 189.499481201, 5.0965461731, 177.350845337), P(girafe));
    g.cam.add(t); g.cam.zap();
    yield acts(70, A.TURBO, 0, -1);
    g.cam.remove(t); g.removeCharacter(girafe);
  }
  if (tux) { t = LookAtLeft(tux); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar13-intro-2__')); }
  yield g.Pause();
  if (tux) { g.clearMessages(); g.message(tr('__scenar13-intro-3__')); }
  yield g.Pause();
  if (tux) { g.clearMessages(); g.message(tr('__scenar13-intro-4__')); }
  yield g.Pause();
  if (tux) g.cam.remove(t);
  if (tux && tux.isPlayer) {
    g.clearMessages();
    const fs = new FreeStyle(g, tux);
    fs.onRecognized = () => {
      if (tux.score > [500, 2000, 5000][g.difficulty]) { Mission13Outro(g).start({ tux, girafe: addPerso(g, 'girafe', 3) }); fs.removed = true; }
    };
    g.addUpdater(fs);
    startFreestyleGame(g, [500, 80, 80][g.difficulty], tr('__scenar13-1__'));
  }
});
const Mission13Outro = g => seq(g, function* ({ tux, girafe }) {
  let t;
  yield g.Fade();
  if (girafe) { tp(girafe, 193.8, 17.0, 210.9); t = LookAtLeft(girafe); g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar13-outro-1__')); }
  yield g.Pause();
  if (girafe) { g.clearMessages(); g.message(tr('__scenar13-outro-2__')); }
  yield g.Pause();
  if (girafe) { g.clearMessages(); g.message(tr('__scenar13-outro-3__')); }
  yield g.Pause();
  if (tux) { t = LookAtLeft(tux); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar13-outro-4__')); } else if (girafe) g.cam.remove(t);
  yield g.Pause();
  if (tux) g.levelCompleted(tux, true);
});

// ---------------------------------------------------------------- mission 14
const Mission14Intro = g => seq(g, function* ({ tux, gnu }) {
  let t, ka;
  if (tux) {
    g.chase.distance = 7.0;
    ka = this.ka = new KillerAirplane(g, tux, [0.2, 0.4, 0.5][g.difficulty]);
    ka.prop.setXYZ(110.0, 34.5516757965, 229.495330811); ka.prop.rotateLateral(180);
  } else if (gnu) {
    tp(gnu, 96.435836792, 28.2565994263, 144.252090454); lookDir(gnu, 1, 0, -1);
    t = LookAtRight(gnu); g.cam.add(t); g.clearMessages(); g.message(tr('__scenar14-intro-1__'));
  }
  yield g.Pause();
  if (gnu) { g.clearMessages(); g.message(tr('__scenar14-intro-2__')); }
  yield g.Pause(); yield g.Fade();
  if (gnu) { g.cam.remove(t); g.removeCharacter(gnu); }
  else if (tux) {
    const o = ka.prop.obj;
    t = new FixTraveling(P(o, -1, 5, -11), P(o, 1, 2, -3), true, true);
    g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar14-intro-3__'));
  }
  yield g.Pause();
  if (tux) g.cam.remove(t);
  if (tux && tux.isPlayer) {
    g.clearMessages();
    medocWaiters(g, [[26.7519454956, 24.5517711639, 211.49319458], [180.690795898, 26.0294113159, 152.907470703], [204.346420288, 25.8917675018, 94.5336685181],
      [89.7115478516, 25.9517688751, 72.2400970459], [90.653137207, 20.6758728027, 191.899993896]]);
    if (g.difficulty === 2) { const k = addPerso(g, 'killer', 4, 'fighter'); tp(k, 202.747375488, 23.6, 163.512329102); k.flameThrower = g.difficulty; }
    ka.play = true;
  }
});
export const Mission14Outro = g => seq(g, function* ({ tux, gnu, shark }) {
  let t;
  yield g.Fade();
  if (tux) { for (const u of g.updaters) if (u instanceof KillerAirplane) u.play = false; }
  else if (gnu) { tp(gnu, 96.435836792, 28.2565994263, 144.252090454); lookDir(gnu, 1, 0, -1); }
  else if (shark) { tp(shark, 118.8, 26.2, 228.5); lookDir(shark, 0, 0, 1); t = LookAtLeft(shark); g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar14-outro-1__')); }
  yield g.Pause();
  if (gnu) { t = LookAtRight(gnu); g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar14-outro-2__')); } else if (shark) g.cam.remove(t);
  yield g.Pause();
  if (gnu) g.cam.remove(t); else if (shark) { g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar14-outro-3__')); }
  yield g.Pause();
  if (shark) { g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar14-outro-4__')); }
  yield g.Pause();
  if (tux) { t = LookAtFront(tux); g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar14-outro-5__')); } else if (shark) g.cam.remove(t);
  yield g.Pause();
  if (tux) g.cam.remove(t);
  else if (shark) {
    const p = shark.localPoint(0, 0.8, 0.2), v = shark.toWorld(V3(0.5, -0.6, -1.8));
    t = new FixTraveling(P(null, ...p.clone().add(v).toArray()), P(shark, 0, 0.8, 0.2), true, true);
    g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar14-outro-6__'));
  }
  yield acts(10);
  if (shark) {  // green smoke: Shark turns into an alien
    const at = shark.localPoint(0, 0.5, 0);
    for (let i = 0; i < 200; i++) {
      const d = V3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      g.fx.spawn(at, d.setLength(0.03 * (1 + Math.random()) * 0.4), V3(0, 0, 0), 33 * (1 + Math.random()),
        [[0.1, 0.1, 0.1, 1], [0.3, 1, 0.5, 1], [0.3, 1, 0.6, 1], [0.1, 0.1, 0.1, 1]], 1.2);
    }
  }
  yield acts(20);
  if (shark) g.setPersoModel(shark, 'alien1');
  yield g.Pause();
  for (let i = 0; i < 50; i++) { if (shark) shark.force.y += 15; yield act(); }
  if (shark) { g.cam.remove(t); g.removeCharacter(shark); }
  else if (tux) {
    tux.obj.updateWorldMatrix(true, true);
    const target = tux.persoObj.localToWorld(V3(0, 0.3, 0)), from = tux.persoObj.localToWorld(V3(0, 0.7, -1.2));
    t = new FixTraveling(P(null, ...from.toArray()), P(persoOf(tux), 0, 0.3, 0), true, true);
    g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar14-outro-7__'));
  }
  yield g.Pause();
  for (let i = 0; i < 50; i++) { if (tux) tux.force.y += 15; yield act(); }
  if (tux) g.levelCompleted(tux, true);
});

// ---------------------------------------------------------------- mission 15
const Mission15Intro = g => seq(g, function* ({ tux, shark }) {
  let t, t1, t2, t3;
  yield g.Fade();
  if (tux) arenaMiniMap(g, [V3(0, 0, 0), V3(316, 0, 316)]);
  else if (shark) {
    tp(shark, 78.0, 19.5, 130.7); lookDir(shark, 1, 0, 0);
    g.setPerso(shark, 'alien');
    t1 = new FixTraveling(P(persoOf(shark), 0, 0, -0.6), P(persoOf(shark), 0, 0.8, 0), true, true);
    g.cam.add(t1); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar15-intro-1__'));
  }
  yield g.Pause();
  if (shark) {
    g.cam.remove(t1);
    t2 = new FixTraveling(P(persoOf(shark), 0.8, 1.0, -0.5), P(persoOf(shark), 0.3, 1.0, 0), true, true);
    g.cam.add(t2); g.clearMessages(); g.message(tr('__scenar15-intro-2__'));
  }
  yield g.Pause();
  if (shark) {
    g.cam.remove(t2);
    t3 = new FixTraveling(P(persoOf(shark), -0.8, 1.0, -0.5), P(persoOf(shark), -0.3, 1.0, 0), true, true);
    g.cam.add(t3); g.clearMessages(); g.message(tr('__scenar15-intro-3__'));
  }
  yield g.Pause(); yield g.Fade();
  if (tux) { t = LookAtRight(tux); g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar15-intro-4__')); }
  else if (shark) g.cam.remove(t3);
  yield g.Pause(); yield g.Fade();
  if (tux) g.cam.remove(t);
  else if (shark) { g.cam.add(t1); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar15-intro-5__')); }
  yield g.Pause();
  if (shark) { g.cam.remove(t1); g.bossBar = shark; }
  if (tux && tux.isPlayer) {
    g.clearMessages();
    g.addUpdater({ round() { if (g.characters.length === 1) { Mission15Outro(g).start({ tux }); this.removed = true; } } });
  }
});
const Mission15Outro = g => seq(g, function* ({ tux }) {
  let t, t1;
  yield g.Fade();
  if (tux) {
    const alien = g.prop('alien1', null, { solid: false });
    alien.setXYZ(127.4, 20.6, 53.2); alien.rotateVertical(-90);
    t1 = new FixTraveling(P(alien.obj, 1, 0.8, 0.4), P(alien.obj, 0, 0, 0.2), true, true);
    g.cam.add(t1); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar15-outro-1__'));
    g.cam.camera.updateWorldMatrix(true, false);
    g.light(V3(-0.1, 1.0, 2.0).applyMatrix4(g.cam.camera.matrixWorld));
  }
  yield g.Pause(); yield g.Fade();
  if (tux) { g.cam.remove(t1); t = LookAtLeft(tux); g.cam.add(t); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar15-outro-2__')); }
  yield g.Pause(); yield g.Fade();
  if (tux) { g.cam.remove(t); g.cam.zap(); GnuSpeech(g, [tr('__scenar15-outro-3__')], false).start({ tux }); }
  yield g.Pause(); yield g.Fade();
  if (tux) { g.cam.add(t1); g.cam.zap(); g.clearMessages(); g.message(tr('__scenar15-outro-4__')); }
  yield g.Pause();
  if (tux) { g.clearMessages(); g.message(tr('__scenar15-outro-5__')); }
  yield g.Pause();
  if (tux) { GnuSpeech(g, [tr('__scenar15-outro-6__')], false).start({ tux }); g.cam.remove(t1); }
  g.levelCompleted(tux, true);
});

// ---------------------------------------------------------------- the missions
// title / where: for the menu. initCharacter: init_character_script beyond the start grid.
// start: the level's start_script. scripts: SphericalScript code by index in the level file.
const msg = (i, n) => (g, s, c) => { if (c.isPlayer) { g.message(tr(`__scenar${i}-${n}__`)); s.disabled += 234; } };
export const MISSIONS = {
  1: { title: 'The big truck', where: 'Crashfunkel',
    start: g => Mission1Intro(g).start({ tux: PLAYER, gnu: addPerso(g, 'gnu') }),
    scripts: [...Array.from({ length: 10 }, (_, i) => msg(1, i + 1)),
      (g, s, c) => { if (c.isPlayer) { s.removed = true; Mission1Outro(g).start({ tux: c, gnu: AUTO }); } }] },
  2: { title: 'Tailing Shark', where: 'Crashfunkel',
    start: g => Mission2Intro(g).start({ tux: PLAYER, gnu: addPerso(g, 'gnu'), shark: addPerso(g, 'shark', 1, 'praise') }) },
  3: { title: 'The palace door', where: 'Crashfunkel',
    start: g => Mission3Intro(g).start({ tux: PLAYER }) },
  4: { title: 'Mountain chase', where: 'At the Mountain',
    start: g => Mission4Intro(g).start({ tux: PLAYER, shark: addPerso(g, 'shark', 1, 'praise') }) },
  5: { title: 'Assassins in the night', where: 'At the Mountain (night)',
    initCharacter: (g, ch) => g.addHeadlight(ch),
    start: g => {
      const ck = () => ({ chromosom: FIGHT_CHROMOSOMS.killer[g.difficulty] });
      const killer2 = g.difficulty > 0 ? addPerso(g, 'killer', 3, 'fighter', ck()) : null;
      const killer3 = g.difficulty > 1 ? addPerso(g, 'killer', 3, 'fighter', ck()) : null;
      Mission5Intro(g).start({ tux: PLAYER, shark: addPerso(g, 'shark'), killer1: addPerso(g, 'killer', 3, 'fighter', ck()), killer2, killer3 });
    },
    scripts: [(g, s, c) => {
      s.removed = true;
      Mission5Outro(g).start({ tux: PLAYER, gnu: addPerso(g, 'gnu', 2), shark: addPerso(g, 'shark'), killer1: AUTO, killer2: AUTO, killer3: AUTO });
    }] },
  6: { title: 'Escape from the palace', where: 'Crashfunkel (night)',
    start: g => Mission6Intro(g).start({ tux: PLAYER, gnu: addPerso(g, 'gnu'), killer: addPerso(g, 'killer', 1, 'mission6killer'), killer2: addPerso(g, 'killer', 1, 'mission6killer') }),
    scripts: [(g, s, c) => { if (c.isPlayer && !(s.data.ok ||= []).includes(c)) { Mission6Outro(g).start({ tux: c }); s.data.ok.push(c); } }] },
  7: { title: "Python's hut", where: 'Indus Meeting',
    start: g => Mission7Intro(g).start({ tux: PLAYER }),
    scripts: [
      (g, s, c) => { Mission7AddEnemy(g, c, 108.2, -0.2, 234.3, 'trunc1').start({ tux: PLAYER, killer: addPerso(g, 'killer', 1, 'mission7pusher') }); s.removed = true; },
      (g, s, c) => { if (c.isPlayer) { s.removed = true; Mission7Outro(g).start({ tux: c, python: addPerso(g, 'python', 3) }); } },
      (g, s, c) => { Mission7AddEnemy(g, c, 269.965057373, 14.6452522278, 194.861618042).start({ tux: PLAYER, killer: addPerso(g, 'killer', 1, 'mission7pusher') }); s.removed = true; },
      (g, s, c) => { Mission7AddEnemy(g, c, 212.91293335, -1.61803436279, 44.2955245972).start({ tux: PLAYER, killer: addPerso(g, 'killer', 1, 'mission7pusher') }); s.removed = true; },
      (g, s, c) => { g.message(tr('__scenar7-2__')); s.removed = true; },
      (g, s, c) => { Mission7Cabane(g).start({ tux: PLAYER }); s.removed = true; },
      (g, s, c) => { for (const p of g.pushables) if (p.name === 'trunc2') p.worthPlaying = true; },
      (g, s, c) => { for (const p of g.pushables) if (p.name === 'trunc3') p.worthPlaying = true; },
    ] },
  8: { title: 'Race to the laboratory', where: 'Cyberbombay',
    start: g => Mission8Intro(g).start({ tux: PLAYER, gnu: addPerso(g, 'gnu', 3), shark: addPerso(g, 'shark', 0), killer1: addPerso(g, 'killer', 0), killer2: addPerso(g, 'killer', 0) }) },
  9: { title: 'Strike!', where: 'Bombay bowling',
    initCharacter: g => { const w = [0.1, 0.4, 0.6][g.difficulty]; for (const p of g.pushables) if (p.name === 'quille') p.weight = w; },
    start: g => Mission9Intro(g).start({ tux: PLAYER, python: addPerso(g, 'python'), killer: addPerso(g, 'killer', 0) }) },
  10: { title: 'Scattered medicine', where: 'Urban Call',
    initCharacter: (g, ch) => { ch.medocs = Array.from({ length: 10 }, (_, i) => carry(g, ch, 'medoc2', 0, 0.5, 0.15 + i / 20)); },
    start: g => Mission10Intro(g).start({ tux: PLAYER, shark: addPerso(g, 'shark', 0) }) },
  11: { title: 'Catch the plane', where: 'Airport',
    initCharacter: (g, ch) => carry(g, ch, 'medoc2', 0, 0.5, 0.3),
    start: g => Mission11Intro(g).start({ tux: PLAYER, gnu: addPerso(g, 'gnu', 1) }) },
  12: { title: 'Flight to Africa', where: 'On the plane',
    initCharacter: (g, ch) => { carry(g, ch, 'medoc2', 0, 0.5, 0.3); g.flyingAirplane = new Airplane(g, { flying: true }); },
    start: g => Mission12Intro(g).start({ tux: PLAYER }) },
  13: { title: 'Lost in the desert', where: 'Desertic Sorry',
    initCharacter: (g, ch) => carry(g, ch, 'medoc2', 0, 0.5, 0.3),
    start: g => Mission13Intro(g).start({ tux: PLAYER, girafe: addPerso(g, 'girafe', 3) }) },
  14: { title: 'Medicine for the village', where: 'Chapakalake',
    initCharacter: (g, ch) => carry(g, ch, 'medoc2', 0, 0.5, 0.3),
    start: g => Mission14Intro(g).start({ tux: PLAYER, gnu: addPerso(g, 'gnu', 1) }) },
  15: { title: "Shark's true face", where: 'Ride Park',
    start: g => Mission15Intro(g).start({ tux: PLAYER, shark: addPerso(g, 'shark', 4, 'alienboss') }) },
};
