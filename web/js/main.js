// Slune for the browser: game loop, race rules (race.py), level setup (level.py),
// the idler's pause / fade / messages (level.Idler), player input
// (controler.KeyboardMouseControler) and menus. The campaign (videosequence.py)
// lives in campaign.js and drives this engine through the Game object.
import * as THREE from 'three';
import { initMaterials, loadJSON, loadModel, modelSync, instantiate, buildWorld, texture, texturesReady, mat4, modelTriangles } from './assets.js';
import { CollisionWorld, Character, Pushable, VEHICLES, VEHICLE_PERSO_COORDS, A, ROUND, makeBVH } from './physics.js';
import { opponentBrain, wallClimber, StackControler, act } from './ai.js';
import { FX } from './fx.js';
import { Sound } from './sound.js';
import { HUD, fmt } from './hud.js';
import { TravelingCamera, ThirdPersonTraveling } from './camera.js';
import { MISSIONS, MissionCompleted, initStrings, tr } from './campaign.js';
import { EXTRAS } from './extras.js';

const $ = id => document.getElementById(id);
const PERSOS = ['tux', 'gnu', 'shark', 'python'];
const DIFFS = ['Newbie', 'Hacker', 'Guru'];
const FLAG_RADIUS = 3.5, BONUS_RADIUS = 3.0;
const UP = new THREE.Vector3(0, 1, 0);
// Every model a script may create at any time (characters, vehicles, cutscene props).
const PRELOAD = ['vehicle0', 'vehicle1', 'vehicle2', 'vehicle3', 'vehicle4', 'tux1', 'gnu1', 'shark1', 'python1', 'killer1',
  'girafe1', 'alien1', 'monk1', 'avion', 'medoc', 'medoc2', 'gnu-eye', 'engine1', 'webcam1', 'secretpassage1-c', 'sphericalscript'];

// --------------------------------------------------------------- settings
const DEFAULTS = { level: 'level-canion-race-1', perso: 'tux', vehicle: 1, difficulty: 0, laps: 2, opponents: 3, vision: 1.5, sound: true, nextMission: 1, mode: 'campaign' };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('slune') || '{}')); } catch (e) {}
const save = () => { try { localStorage.setItem('slune', JSON.stringify(settings)); } catch (e) {} };

// --------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight, false);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});
const hud = new HUD($('hud'));
const sound = new Sound();

// --------------------------------------------------------------- player input
class PlayerInput {
  constructor() { this.reset(); this.keyboardMode = true; this.pixel = null; }
  reset() {
    this.mouseX = 0; this.mouseY = 1; this.dX = this.dY = 0; this.allowMoveBack = 0;
    this.defaultAction = A.WAIT; this.events = []; this.stack = new StackControler(); this.keys = new Set();
  }
  // Video sequences run on the player's controller and can't be cancelled.
  animate(gen) { this.stack.push(gen, true); }
  next(ch) {
    let a = this.defaultAction;
    if ((a === A.ROTUP || a === A.ROTDOWN) && ch.onGround) this.defaultAction = a = A.WAIT;
    for (const e of this.events.splice(0)) {
      if (e.type === 'move') {
        this.keyboardMode = false;
        this.pixel = [e.x, e.y];
        this.mouseX = (e.x / innerWidth - 0.5) * 2.0;
        if (this.allowMoveBack < 10) {
          this.mouseY = (e.y / innerHeight - 0.5) * 2.0;
          if (this.mouseY > 0.95) this.allowMoveBack += 2;
        } else {
          this.mouseY = (e.y / innerHeight) * 3.0 - 1.0;
          if (this.mouseY < 1.0) this.allowMoveBack = 0;
        }
        continue;
      }
      if (e.type !== 'release') this.stack.clear();
      if (this.stack.uncancelable) continue;
      if (e.type === 'jump') { if (ch.onGround) a = A.JUMP; else this.defaultAction = a = A.ROTUP; }
      else if (e.type === 'climb') {
        if (ch.onGround) { this.stack.push(wallClimber(ch)); return this.stack.next(); }
        this.defaultAction = a = A.ROTDOWN;
      } else if (e.type === 'turbo') this.defaultAction = a = A.TURBO;
      else if (e.type === 'release') this.defaultAction = a = A.WAIT;
      else if (e.type === 'wheel') {
        if (e.dy < 0) this.defaultAction = a = this.defaultAction === A.ROTUP ? A.WAIT : A.ROTDOWN;
        else this.defaultAction = a = this.defaultAction === A.ROTDOWN ? A.WAIT : A.ROTUP;
      }
    }
    if (this.stack.busy) { const r = this.stack.next(); if (r) return r; }
    if (this.keyboardMode) {
      this.mouseX *= 0.9;
      if (this.mouseY < 0) this.mouseY *= 0.9;
      this.mouseX = Math.max(-1, Math.min(1, this.mouseX + this.dX));
      this.mouseY += this.dY;
      if (this.mouseY < -1) this.mouseY = -1;
      else if (this.allowMoveBack < 10) { if (this.mouseY > 1) this.mouseY = 1; }
      else if (this.mouseY < 1) this.allowMoveBack = 0;
      else if (this.mouseY > 2) this.mouseY = 2;
    }
    return { action: a, mx: this.mouseX, my: this.mouseY };
  }
}

// --------------------------------------------------------------- props (soya.Volume)
// A model placed in the level by a script or the level file. Rotation helpers follow
// Soya: rotate_* turn about the parent's axes, turn_* about the prop's own axes.
export class Prop {
  constructor(game, modelData, parent = null, { solid = true } = {}) {
    this.game = game;
    this.obj = modelData ? instantiate(modelData) : new THREE.Group();
    this.md = modelData;
    (parent || game.scene).add(this.obj);
    this.collider = null;
    if (solid && modelData && !parent) {
      const tris = modelTriangles(modelData);
      if (tris.length) this.collider = game.collision.addDynamic(modelData.bvh || (modelData.bvh = makeBVH(tris)), this.obj);
    }
    this.updaters = [];
  }
  get pos() { return this.obj.position; }
  get x() { return this.obj.position.x; } set x(v) { this.obj.position.x = v; }
  get y() { return this.obj.position.y; } set y(v) { this.obj.position.y = v; }
  get z() { return this.obj.position.z; } set z(v) { this.obj.position.z = v; }
  get visible() { return this.obj.visible; } set visible(v) { this.obj.visible = v; if (this.collider) this.collider.enabled = v; }
  get alive() { return !!this.obj.parent; }
  setXYZ(x, y, z) { this.obj.position.set(x, y, z); return this; }
  move(p) {
    const w = p.world ? p.world() : p.isVector3 ? p.clone() : p.pos.clone();
    if (this.obj.parent && this.obj.parent !== this.game.scene) this.obj.parent.worldToLocal(w);
    this.obj.position.copy(w); return this;
  }
  lookAt(target) {  // a Dir (direction) or a point; local -Z ends up pointing there
    const from = new THREE.Vector3(); this.obj.getWorldPosition(from);
    const dir = target.local && target.constructor.name === 'Dir' ? target.world() : (target.world ? target.world() : target.isVector3 ? target.clone() : target.pos.clone()).sub(from);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.normalize(), UP);
    this.obj.quaternion.setFromRotationMatrix(m);
    return this;
  }
  rotateLateral(d) { this.obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, d * Math.PI / 180)); return this; }
  rotateVertical(d) { this.obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), d * Math.PI / 180)); return this; }
  rotateIncline(d) { this.obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), d * Math.PI / 180)); return this; }
  turnLateral(d) { this.obj.rotateY(d * Math.PI / 180); return this; }
  turnVertical(d) { this.obj.rotateX(d * Math.PI / 180); return this; }
  addVector(v) { this.obj.position.add(v); return this; }
  localPoint(x, y, z) { this.obj.updateWorldMatrix(true, false); return new THREE.Vector3(x, y, z).applyMatrix4(this.obj.matrixWorld); }
  toWorld(v) { this.obj.updateWorldMatrix(true, false); return v.transformDirection(this.obj.matrixWorld).multiplyScalar(1); }
  get quat() { return this.obj.quaternion; }
  setModel(md) {
    const parent = this.obj.parent, o = instantiate(md);
    o.position.copy(this.obj.position); o.quaternion.copy(this.obj.quaternion); o.scale.copy(this.obj.scale);
    if (parent) { parent.remove(this.obj); parent.add(o); }
    if (this.collider) this.collider.object = o;
    this.obj = o; this.md = md;
  }
  remove() {
    if (this.obj.parent) this.obj.parent.remove(this.obj);
    if (this.collider) this.game.collision.removeDynamic(this.collider);
    this.removed = true;
  }
}

// --------------------------------------------------------------- game
class Game {
  constructor() {
    this.sound = sound;
    this.input = new PlayerInput();
    this.cam = new TravelingCamera(camera);
    this.cam.sync = () => this.syncVisuals(1);
    this.state = 'menu';
    this.messages = [];
    this.random = Math;
  }

  // ------------------------------------------------ level loading
  // mode 'race', or 'mission' (campaign mission number `missionNo`, or an extra mode definition `def`)
  async load(levelName, mode = 'race', missionNo = 0, def = null) {
    this.state = 'loading';
    this.mode = mode; this.missionNo = missionNo; this.extra = def;
    showOnly('loading');
    const progress = (x, msg) => { $('loadbar').style.width = (x * 100) + '%'; if (msg) $('loadmsg').textContent = msg; };
    progress(0.05, 'Loading ' + (def ? def.title : mode === 'mission' ? missionTitle(missionNo) : prettyLevel(levelName)) + '…');
    await initMaterials();
    await initStrings();
    const lev = await loadJSON('levels/' + levelName + '.json');
    this.level = lev;
    this.difficulty = settings.difficulty;
    progress(0.2, 'Building world…');
    const world = await buildWorld(lev.world, settings.vision, lev.world ? null : lev.atmosphere);
    progress(0.6, 'Indexing collisions…');
    await new Promise(r => setTimeout(r, 0));
    this.collision = new CollisionWorld(world.tris);
    this.cam.collision = this.collision;
    let minY = Infinity;
    for (let i = 1; i < world.tris.length; i += 3) minY = Math.min(minY, world.tris[i]);
    this.killY = Math.min(-35.0, minY - 8);

    this.pushers = null;
    const scene = this.scene = new THREE.Scene();
    scene.fog = world.fog;
    scene.background = world.fog.color.clone();
    scene.add(world.group);
    this.sky = world.sky; scene.add(this.sky);
    camera.far = Math.max(150, world.far * 1.5);
    camera.updateProjectionMatrix();
    this.fx = new FX(scene);
    this.props = []; this.updaters = []; this.tasks = []; this.widgets = []; this.scripts = [];
    this.paused = null; this.fadeLevel = -1; this.completed = false; this.ended = false; this.doorOpened = false; this.blackbands = false; this.bossBar = null; this.minimap = null;
    this.named = new Map();
    for (const n of world.named) {  // movable named world bodies (palace doors)
      const p = new Prop(this, n.md);
      n.matrix.decompose(p.obj.position, p.obj.quaternion, p.obj.scale);
      this.named.set(n.name, p); this.props.push(p);
    }
    for (const l of lev.lights) {
      const m = mat4(l.matrix), c = new THREE.Color(...l.diffuse.slice(0, 3));
      const dl = new THREE.DirectionalLight(c, Math.PI);
      dl.position.copy(new THREE.Vector3(0, 0, 1).transformDirection(m)).multiplyScalar(100);
      scene.add(dl);
    }

    progress(0.75, 'Placing objects…');
    this.flags = lev.flags.map(f => {
      const pos = new THREE.Vector3().setFromMatrixPosition(mat4(f.matrix));
      const s = this.bonusSprite('flag1', [1, 1, 0.2], 1.6);
      s.position.copy(pos); scene.add(s);
      return { pos, obj: s };
    });
    this.bonuses = lev.bonuses.map(b => this.makeBonus(b.kind, new THREE.Vector3().setFromMatrixPosition(mat4(b.matrix)), true));
    this.pushables = [];
    for (const p of lev.pushables) {
      if (!p.model) continue;
      const md = await loadModel(p.model);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
      mat4(p.matrix).decompose(pos, quat, new THREE.Vector3());
      this.spawnPushable(p, md, pos, quat, p.name);
    }
    this.takeables = [];
    for (const v of lev.vehicles) {
      const md = await loadModel('vehicle' + v.vehicle);
      const obj = instantiate(md); obj.matrixAutoUpdate = false; obj.matrix.copy(mat4(v.matrix));
      scene.add(obj);
      this.takeables.push({ vehicle: v.vehicle, pos: new THREE.Vector3().setFromMatrixPosition(obj.matrix), obj, md, disabled: false });
    }
    for (const v of lev.volumes) {  // static props from the level file (secret passages, doors)
      if (!v.model) continue;
      const p = new Prop(this, await loadModel(v.model));
      mat4(v.matrix).decompose(p.obj.position, p.obj.quaternion, p.obj.scale);
      this.props.push(p);
      if (v.name) this.named.set(v.name, p);
    }
    // level.SphericalScript: code triggered when a character enters a sphere.
    const mission = def || (mode === 'mission' ? MISSIONS[missionNo] : null);
    this.mission = mission;
    for (const s of lev.scripts) {
      const fn = mission && mission.scripts && mission.scripts[s.index];
      this.scripts.push({ pos: new THREE.Vector3().setFromMatrixPosition(mat4(s.matrix)), radius: s.radius, disabled: 0, removed: !fn, fn, data: {} });
    }

    progress(0.85, 'Characters…');
    for (const n of PRELOAD) await loadModel(n);
    this.characters = [];
    const forced = lev.start.force_vehicle;
    const perso = mode === 'mission' && !def ? 'tux' : settings.perso;  // player.py: missions are always played by Tux
    const player = this.addCharacter(perso, forced != null ? forced : settings.vehicle, true);
    this.player = player;
    if (mode === 'race') {
      const others = PERSOS.filter(p => p !== settings.perso);
      for (let i = 0; i < settings.opponents; i++) {
        const v = forced != null ? forced : (lev.name.includes('deserticsorry') && Math.random() < 0.7 ? 3 : Math.floor(Math.random() * 5));
        const o = this.addCharacter(others[i % others.length], v, false);
        o.controler = new StackControler([opponentBrain(o)]);
        o.isCompetitor = true;
      }
    }
    if (lev.start.headlight) this.addHeadlight(player);
    this.pushers = [...this.characters, ...this.pushables];
    this.nbLaps = settings.laps; this.nbOpponents = settings.opponents;
    this.showFlags = !!(mission && mission.showFlags);
    this.ranks = [];
    this.roundNo = 0;
    this.acc = 0;
    this.startTime = null;
    this.cam.reset();
    this.chase = new ThirdPersonTraveling(player);
    this.chase.offsetY = 0.9;
    this.cam.add(this.chase);
    this.cam.zap();
    this.input.reset();
    if (mission && mission.initCharacter) await mission.initCharacter(this, player);
    progress(0.95, 'Loading textures…');
    await texturesReady();
    progress(1, '');
    this.flags.forEach((f, i) => (f.obj.visible = i === 0));
    this.state = 'ready';
    showOnly(null);
    this.message(mode === 'mission' ? `${def ? def.title : missionTitle(missionNo)}\nPress any key or click to start.` : 'Ready. Press any key or click to start.', 1e9);
    this.music = lev.music;
    sound.listener = camera.position;
  }

  bonusSprite(mat, color, size) {
    const g = new THREE.Group();
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture(mat), color: new THREE.Color(...color), transparent: true, alphaTest: 0.05 }));
    s.scale.set(size, size, 1);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture('halo'), color: new THREE.Color(...color), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    halo.scale.set(size * 2.4, size * 2.4, 1);
    g.add(halo); g.add(s);
    return g;
  }
  spawnPushable(p, md, pos, quat, name) {
    const body = new Pushable(this, p);
    body.name = name; body.md = md;
    body.pos.copy(pos); body.quat.copy(quat);
    body.nextPos.copy(body.pos); body.prevPos.copy(body.pos); body.prevQuat.copy(body.quat);
    body.obj = instantiate(md);
    const h = Math.random();
    if (h < 0.15) body.bonusType = 1; else if (h < 0.3) body.bonusType = 2;  // Level.start_game
    this.scene.add(body.obj);
    this.pushables.push(body);
    if (this.pushers) this.pushers.push(body);
    return body;
  }
  makeBonus(kind, pos, comeBack) {
    const obj = kind === 'life' ? this.bonusSprite('life1', [1, 0.4, 0.2], 1.2) : this.bonusSprite('bonus2', [0.5, 1, 0.5], 1.2);
    obj.position.copy(pos);
    this.scene.add(obj);
    return { kind, pos, obj, comeBack, disabled: 0, get visible() { return obj.visible; } };
  }

  // ------------------------------------------------ characters
  addCharacter(perso, vehicle, isPlayer, { grid = true } = {}) {
    const ch = new Character(this);
    ch.perso = perso; ch.isPlayer = isPlayer; ch.name = perso;
    ch.clan = isPlayer ? 1 : 0;
    ch.isCompetitor = isPlayer;
    ch.setVehicle(vehicle);
    ch.random = Math;
    ch.rank = this.characters.length;
    if (isPlayer) { ch.hurtScale = () => [0.6, 0.9, 1.0][this.difficulty]; ch.controler = this.input; }
    else ch.controler = new StackControler([(function* () { while (true) yield act(); })()]);
    ch.defaultMouseX = () => isPlayer ? this.input.mouseX : 0;
    ch.animate = gen => ch.controler.push ? ch.controler.push(gen, true) : ch.controler.animate(gen);
    if (grid) {
      const rank = this.characters.length;
      const g = this.level.start.grid[Math.min(rank, this.level.start.grid.length - 1)];
      const pos = g.pos ? new THREE.Vector3(...g.pos) : new THREE.Vector3();  // arena levels place characters themselves
      // The original grid is 2 units apart, which overlaps wide vehicles (truck,
      // tanker) and makes them push each other at the start: spread it out.
      const gr = this.level.start.grid;
      const step = gr.length > 1 && gr[0].pos && gr[1].pos ? new THREE.Vector3(...gr[1].pos).sub(new THREE.Vector3(...gr[0].pos)) : new THREE.Vector3(2, 0, 0);
      if (step.lengthSq() < 1e-6) step.set(2, 0, 0);
      step.normalize();
      for (let k = 0; k < 20 && this.characters.some(o => o.pos.distanceTo(pos) < o.radius + ch.radius + 0.4); k++) pos.addScaledVector(step, 0.5);
      ch.teleport(pos);
      if (g.look) ch.lookAt(new THREE.Vector3(...g.look));
      if (g.rotate_lateral) ch.rotateAxe(g.rotate_lateral, UP);
      ch.pos.y += ch.floating;
      // The grid scripts use one height for every slot; on sloped starts a slot can end
      // up under the terrain, so settle each racer onto the ground below/above it.
      const ground = this.collision.raypick(ch.pos.clone().add(new THREE.Vector3(0, 4, 0)), new THREE.Vector3(0, -1, 0), 12, true, true);
      if (ground) ch.pos.y = ground.point.y + ch.floating;
      ch.nextPos.copy(ch.pos); ch.prevPos.copy(ch.pos); ch.prevQuat.copy(ch.quat);
    }
    this.buildCharacterVisual(ch);
    this.characters.push(ch);
    if (this.pushers && !this.pushers.includes(ch)) this.pushers.push(ch);
    return ch;
  }
  buildCharacterVisual(ch) {
    const root = ch.obj || new THREE.Group();
    if (ch.internal) root.remove(ch.internal);
    const internal = new THREE.Group();
    internal.add(instantiate(modelSync('vehicle' + ch.vehicle)));
    const perso = instantiate(modelSync(ch.persoModel || ch.perso + '1'));
    // `persoBase` is what scripts move (Soya's character.perso); the drawn model adds the steering lean.
    if (!ch.persoBase) ch.persoBase = new THREE.Object3D();
    ch.persoBase.position.set(...VEHICLE_PERSO_COORDS[ch.vehicle]);
    internal.add(perso);
    for (const extra of ch.internalExtras || []) internal.add(extra);
    root.add(internal);
    ch.obj = root; ch.internal = internal; ch.persoObj = perso;
    if (!root.parent) this.scene.add(root);
    perso.visible = ch.persoVisible !== false;
  }
  setPerso(ch, name) { ch.perso = name; this.setPersoModel(ch, name + '1'); }
  setPersoModel(ch, modelName) {
    ch.persoModel = modelName;
    const p = instantiate(modelSync(modelName));
    p.visible = ch.persoObj.visible;
    ch.internal.remove(ch.persoObj); ch.internal.add(p); ch.persoObj = p;
  }
  changeVehicle(ch, v) { ch.setVehicle(v); this.buildCharacterVisual(ch); }
  addHeadlight(ch) {
    const l = new THREE.SpotLight(0x8099ff, 6, 40, Math.PI / 4, 0.5, 1.2);
    l.position.set(0, 1.2, -0.5);
    const tgt = new THREE.Object3D(); tgt.position.set(0, 0, -10);
    ch.obj.add(l); ch.obj.add(tgt); l.target = tgt;
    ch.light = { remove: () => { ch.obj.remove(l); ch.obj.remove(tgt); } };
  }
  removeCharacter(ch) {
    ch.alive = false; ch.removed = true;
    if (ch.obj) this.scene.remove(ch.obj);
    this.characters = this.characters.filter(c => c !== ch);
    if (this.pushers) this.pushers = this.pushers.filter(c => c !== ch);
  }
  named_(name) { return this.named.get(name); }

  // ------------------------------------------------ idler services used by scripts
  message(text, duration = 7) {
    this.messages.push({ text, until: performance.now() + duration * 1000 });
    if (this.messages.length > 3) this.messages.shift();
    this.renderMessages();
  }
  clearMessages() { this.messages.length = 0; this.renderMessages(); }
  renderMessages() { $('messages').textContent = this.messages.map(m => m.text).join('\n'); }
  nextRound(fn) { this.tasks.push(fn); }
  addUpdater(u) { this.updaters.push(u); return u; }
  // Idler.pause: every controller waits until a click / key (or max rounds).
  pause(maxDuration = -1) { this.nextRound(() => { if (!this.paused) this.paused = { duration: maxDuration }; }); }
  unpause() { this.nextRound(() => { this.paused = null; }); }
  *Pause(maxDuration = -1) { this.pause(maxDuration); yield act(); }
  // videosequence.Fader: 20 rounds to black, 20 back.
  *Fade() { if (this.fadeLevel < 0) this.fadeLevel = 0; for (let i = 0; i < 20; i++) yield act(); }
  prop(modelName, parent = null, opts) { return this.trackProp(new Prop(this, modelName ? modelSync(modelName) : null, parent, opts)); }
  trackProp(p) { this.props.push(p); return p; }
  light(pos, color = [1, 1, 1]) {
    const l = new THREE.PointLight(new THREE.Color(...color), 2 * Math.PI, 0, 0);
    l.position.copy(pos); this.scene.add(l);
    return { remove: () => this.scene.remove(l), obj: l };
  }
  levelCompleted(ch, winner, message) {
    if (this.completed) return;
    this.completed = true;
    MissionCompleted(this, winner, message).start({ tux: ch });
  }

  // ------------------------------------------------ flow
  start() {
    if (this.state !== 'ready') return;
    this.clearMessages();
    this.state = this.mode === 'mission' ? 'play' : 'race';
    this.startTime = this.roundNo;
    for (const c of this.characters) c.lapStart = this.roundNo;
    sound.unlock();
    if (this.music) sound.playMusic(this.music);
    if (this.mission) this.mission.start(this);
  }
  get playing() { return this.state === 'race' || this.state === 'play' || this.state === 'done'; }
  raceTime() { return this.startTime == null ? null : (this.roundNo - this.startTime) * ROUND; }
  progress(c) { const f = this.flags[c.nextFlag]; return c.laps * this.flags.length + c.nextFlag - (f ? c.pos.distanceTo(f.pos) / 10000 : 0) + (c.finished ? 1e6 - c.finishOrder : 0); }
  rankOf(c) { return this.characters.filter(o => o.alive || o.finished).sort((a, b) => this.progress(b) - this.progress(a)).indexOf(c) + 1 || this.characters.length; }

  // One Soya round.
  round() {
    this.roundNo++;
    for (const t of this.tasks.splice(0)) t();
    if (this.paused && this.paused.duration > 0 && --this.paused.duration === 0) this.unpause();
    for (const b of this.pushers) { b.startRound(); b.applyPending(); }
    const wait = { action: A.WAIT, mx: 0, my: 1 };
    for (const c of [...this.characters]) {
      if (!c.alive) continue;
      let a;
      if (!this.playing || this.paused) a = wait;  // WaitUntilReady / WaitClick
      else if (c.isPlayer && c.finished) a = wait;
      else a = c.controler.next(c) || wait;
      c.round = this.roundNo;
      c.beginAction(a);
      if (c.nitroOn) this.fx.nitro(c);
      c.visualRound();
    }
    for (const p of this.pushables) if (p.alive) p.update();
    for (const u of [...this.updaters]) { if (!u.removed) u.round(this); }
    this.updaters = this.updaters.filter(u => !u.removed);
    if (this.playing) {
      if (this.mode === 'race') this.checker();
      this.scriptRound(); this.bonusRound(); this.flameRound(); this.takeableRound();
    }
    this.fx.round();
    for (const b of this.pushers) if (b.alive) b.endRound();
    this.blackbands = !!(this.input.stack.uncancelable && this.player.alive);
    this.cam.round();
    if (this.fadeLevel >= 0) { this.fadeLevel += 0.05; if (this.fadeLevel >= 2) this.fadeLevel = -1; }
    this.sky.position.copy(camera.position);
    if (this.sky.userData.clouds) this.sky.userData.clouds.offset.x += 0.0004;
  }

  scriptRound() {
    for (const s of this.scripts) {
      if (s.removed) continue;
      if (s.disabled) { s.disabled--; continue; }
      for (const c of [...this.characters]) {
        if (!c.alive || c.pos.distanceTo(s.pos) > s.radius) continue;
        s.fn(this, s, c);
        if (s.removed || s.disabled) break;
      }
    }
  }
  // race.Checker.begin_round
  checker() {
    const n = this.flags.length;
    for (const c of this.characters) {
      if (!c.alive || c.finished || !c.isCompetitor) continue;
      const flag = this.flags[c.nextFlag];
      if (c.pos.distanceTo(flag.pos) < FLAG_RADIUS + c.radius) {
        let next = c.nextFlag + 1;
        if (next >= n) {
          next = 0; c.laps++;
          const lap = (this.roundNo - c.lapStart) * ROUND;
          if (lap < c.bestLap) c.bestLap = lap;
          c.lapStart = this.roundNo;
          if (c.laps >= this.nbLaps) { this.finish(c); continue; }
        }
        c.nextFlag = next;
        if (c.isPlayer) {
          sound.play('flag-1.wav', c.pos);
          flag.obj.visible = false;
          this.flags[next].obj.visible = true;
          this.fx.smoke(flag.pos);
        }
      }
    }
    const alive = this.characters.filter(c => c.alive && !c.finished);
    if (this.state === 'race' && this.characters.length > 1 && this.player.alive && !this.player.finished && alive.length === 1 && this.ranks.length === 0) this.finish(this.player);
  }
  finish(c) {
    c.finished = true;
    c.finishOrder = this.ranks.length;
    c.finishTime = this.raceTime();
    this.ranks.push(c);
    this.fx.explosion(c.pos, 20, 1.0);
    if (c.isPlayer) {
      this.message(this.ranks.length === 1 ? tr('__race_winner__') : tr('__race_looser__').replace('%s', this.ranks.length));
      this.state = 'done';
      setTimeout(() => this.showResults(), 2500);
    } else this.message(tr('__race_arrival__').replace('%s', title(c.perso)).replace('%s', this.ranks.length));
  }
  bonusRound() {
    for (const b of this.bonuses) {
      if (b.disabled) { if (--b.disabled === 0) b.obj.visible = true; continue; }
      if (!b.obj.visible) continue;
      for (const c of this.characters) {
        if (!c.alive || c.pos.distanceTo(b.pos) >= BONUS_RADIUS) continue;
        if (b.kind === 'life') c.life = 1.0; else c.flameThrower += 2;
        sound.play('bonus-1.wav', c.pos);
        this.fx.lifeBonus(b.pos.clone().add(new THREE.Vector3(0, 0.3, 0)));
        b.obj.visible = false;
        if (b.comeBack) b.disabled = 150;
        else { this.scene.remove(b.obj); b.dead = true; }
        break;
      }
    }
    this.bonuses = this.bonuses.filter(b => !b.dead);
  }
  // character.FlameThrower.begin_round damage cone
  flameRound() {
    for (const e of this.fx.emitters) {
      if (e.kind !== 'flame' || !e.owner.alive) continue;
      const o = e.owner;
      for (const t of this.pushers) {
        if (t === o || !t.alive) continue;
        const f = o.toLocal(t.pos.clone().sub(o.pos));
        if (-20 < f.z && f.z < -0.2 && Math.abs(f.y / f.z) < 0.5 && Math.abs(f.x / f.z) < 0.5) {
          t.hurt(-0.1 / (f.z - 1.0));
          t.pushedBy = o;
          const V = t.pos.clone().sub(o.pos).setLength(-1.0 / (f.z - 1.0) / t.weight);
          t.push(V.x, V.y + 0.04, V.z, o);
        }
      }
    }
  }
  takeableRound() {
    const p = this.player;
    if (!p.alive) return;
    for (const t of this.takeables) {
      const d = p.pos.distanceTo(t.pos);
      if (t.disabled) { if (d > 10) t.disabled = false; continue; }
      if (d < 5.0) {
        // ChangeVehicle: swap with the parked vehicle.
        const old = p.vehicle;
        p.setVehicle(t.vehicle);
        this.buildCharacterVisual(p);
        t.vehicle = old; t.disabled = true;
        this.scene.remove(t.obj);
        loadModel('vehicle' + old).then(md => {
          const obj = instantiate(md); obj.matrixAutoUpdate = false; obj.matrix.copy(t.obj.matrix);
          t.obj = obj; this.scene.add(obj);
        });
        this.message(`You take the ${VEHICLES[p.vehicle].name.toLowerCase()}.`, 3);
      }
    }
  }
  onDeath(c) {
    if (c.onRespawn) { c.alive = true; c.onRespawn(c); return; }  // arena: respawn instead of dying
    if (c.onDie) { const f = c.onDie; c.onDie = null; this.removeCharacter(c); f(c); return; }
    this.removeCharacter(c);
    if (c.isPlayer) {
      this.message(tr('__gameover__'), 1e9);
      this.state = this.mode === 'mission' ? 'failed' : 'dead';
      setTimeout(() => this.mode === 'mission' ? this.endMission(false) : this.showResults(), 2500);
    }
  }
  onPushableDeath(p) {
    this.scene.remove(p.obj);
    this.pushables = this.pushables.filter(x => x !== p);
    this.pushers = this.pushers.filter(x => x !== p);
    if (p.bonusType) this.bonuses.push(this.makeBonus(p.bonusType === 1 ? 'life' : 'flame', p.pos.clone(), false));
  }

  // MissionCompleted -> IDLER.end_game("mission-N+1"), or back to the menu.
  endMission(winner) {
    if (this.state === 'menu' || this.ended) return;
    this.ended = true;
    sound.stopMusic();
    if (this.extra) {
      $('restitle').textContent = winner ? 'You have won!' : 'You lost';
      $('ranking').innerHTML = '';
      $('again').textContent = 'Play again';
      $('again').onclick = () => this.lastStart();
      showOnly('results');
      return;
    }
    const n = this.missionNo;
    if (winner && n >= settings.nextMission) { settings.nextMission = Math.min(15, n + 1); if (n === 15) settings.campaignDone = true; save(); }
    $('restitle').textContent = winner ? (n === 15 ? 'The end!' : `Mission ${n} complete`) : `Mission ${n} failed`;
    $('ranking').innerHTML = '';
    const li = document.createElement('li');
    li.textContent = winner ? (n < 15 ? `Next: ${missionTitle(n + 1)}` : 'You finished the Slune campaign.') : 'Try again?';
    $('ranking').appendChild(li);
    $('again').textContent = winner && n < 15 ? 'Next mission' : 'Retry';
    $('again').onclick = () => startMission(winner && n < 15 ? n + 1 : n);
    showOnly('results');
  }
  showResults() {
    if (this.state === 'menu') return;
    const list = $('ranking');
    list.innerHTML = '';
    const order = [...this.ranks, ...this.characters.filter(c => !c.finished).sort((a, b) => this.progress(b) - this.progress(a))];
    for (const c of order) {
      const li = document.createElement('li');
      li.textContent = `${title(c.perso)}${c.isPlayer ? ' (you)' : ''} — ${c.finished ? fmt(c.finishTime) : c.alive ? 'still racing' : 'destroyed'}${c.bestLap < Infinity ? `, best lap ${fmt(c.bestLap)}` : ''}`;
      if (c.isPlayer) li.className = 'you';
      list.appendChild(li);
    }
    $('restitle').textContent = this.state === 'dead' ? 'Game over' : (this.ranks[0] === this.player ? 'You have won!' : `You finished #${this.ranks.indexOf(this.player) + 1}`);
    $('again').textContent = 'Race again';
    $('again').onclick = () => startRace(lastLevel);
    showOnly('results');
  }

  frame(dt) {
    if (!this.scene || !this.pushers || this.state === 'loading') return;
    if (this.state !== 'paused' && this.state !== 'menu') {
      this.acc += Math.min(dt, 0.25);
      while (this.acc >= ROUND && this.scene) { this.round(); this.acc -= ROUND; }
      if (!this.scene) return;
    }
    const alpha = this.acc / ROUND;
    this.syncVisuals(alpha);
    const t = performance.now() / 1000;
    for (const f of [...this.flags, ...this.bonuses]) f.obj.children[1].material.rotation = Math.sin(t * 2 + f.pos.x) * 0.15;
    for (const p of this.props) if (p.frame) p.frame(dt);
    this.fx.render();
    this.cam.apply(alpha);
    const now = performance.now();
    if (this.messages.some(m => m.until < now)) { this.messages = this.messages.filter(m => m.until >= now); this.renderMessages(); }
    // Messages may use the full width unless a minimap occupies the top right corner.
    document.body.classList.toggle('wide-msg', this.mode === 'mission' && !this.widgets.some(w => w.minimap));
    renderer.render(this.scene, camera);
    hud.draw(this, camera);
  }
  // Puts the 3D models where the physics says (interpolated by alpha between rounds).
  syncVisuals(alpha) {
    if (!this.pushers) return;
    for (const b of this.pushers) {
      if (!b.alive || !b.obj) continue;
      b.obj.position.lerpVectors(b.prevPos, b.pos, alpha);
      b.obj.quaternion.slerpQuaternions(b.prevQuat, b.quat, alpha);
      if (b.internal) {
        b.internal.position.y = b.bounce;
        b.internal.rotation.z = b.roll * Math.PI / 180;
        b.persoObj.position.copy(b.persoBase.position);
        b.persoObj.quaternion.copy(b.persoBase.quaternion);
        b.persoObj.rotateY(b.yawVis * Math.PI / 180);
        b.obj.visible = b.visible !== false;
      }
    }
  }
  dispose() {
    sound.stopMusic();
    this.scene = null; this.pushers = null; this.ended = false;
    this.clearMessages();
    hud.clear();
  }
}

const title = s => s[0].toUpperCase() + s.slice(1);
function prettyLevel(name) {
  const names = { airport: 'Airport', 'at-the-mountain': 'At the Mountain', 'at-the-mountain-night': 'At the Mountain (night)', canion: 'Canion', chapakalake: 'Chapakalake',
    crashfunkel: 'Crashfunkel', cyberbombay: 'Cyberbombay', deserticsorry: 'Desertic Sorry', indusmeeting: 'Indus Meeting', raceinde: 'Race Inde', urbancall: 'Urban Call' };
  const m = name.match(/^level-(.*)-race-(\d+)$/);
  if (!m) return name;
  return (names[m[1]] || m[1]) + (['canion', 'crashfunkel', 'raceinde'].includes(m[1]) ? ' ' + m[2] : '');
}
const missionTitle = n => `Mission ${n}: ${(MISSIONS[n] && MISSIONS[n].title) || ''}`;

// --------------------------------------------------------------- UI wiring
const game = new Game();
let lastLevel = null;

function showOnly(id) {
  for (const o of ['menu', 'loading', 'pause', 'results']) $(o).classList.toggle('hidden', o !== id);
}
function seg(el, items, key, render = x => x.label, onChange) {
  el.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.innerHTML = render(it);
    b.classList.toggle('on', settings[key] === it.value);
    b.onclick = () => { settings[key] = it.value; save(); seg(el, items, key, render, onChange); if (onChange) onChange(); };
    el.appendChild(b);
  }
}
async function buildMenu() {
  const idx = await loadJSON('index.json');
  const drawMode = () => {
    const m = settings.mode;
    $('campaign').classList.toggle('hidden', m !== 'campaign');
    $('racing').classList.toggle('hidden', m === 'campaign');
    $('tracksbox').classList.toggle('hidden', m !== 'race');
    $('extrasbox').classList.toggle('hidden', m !== 'extras');
    const ex = EXTRAS[settings.extra];
    $('lapslabel').textContent = m === 'extras' ? 'Laps / arena frags' : 'Laps';
    $('go').textContent = m === 'campaign' ? `Play ${missionTitle(settings.mission || settings.nextMission)}` : m === 'race' ? 'Race' : `Play ${ex ? ex.title : ''}`;
  };
  seg($('modes'), [['campaign', 'Campaign'], ['race', 'Single race'], ['extras', 'Other modes']].map(([v, l]) => ({ value: v, label: l })), 'mode', undefined, drawMode);
  const xl = $('extras');
  const drawExtras = () => {
    xl.innerHTML = '';
    if (!EXTRAS[settings.extra]) settings.extra = Object.keys(EXTRAS)[0];
    for (const [key, x] of Object.entries(EXTRAS)) {
      const b = document.createElement('button');
      b.innerHTML = `${x.title}<small>${x.where}</small>`;
      b.classList.toggle('on', settings.extra === key);
      b.onclick = () => { settings.extra = key; save(); drawExtras(); drawMode(); };
      xl.appendChild(b);
    }
  };
  drawExtras();
  const ml = $('missions');
  const drawMissions = () => {
    ml.innerHTML = '';
    if (!settings.mission) settings.mission = settings.nextMission;
    // gui_gl.py had its "only unlocked missions" filter commented out: every mission is playable.
    const done = settings.campaignDone ? 16 : settings.nextMission;
    for (let n = 1; n <= 15; n++) {
      const b = document.createElement('button');
      b.innerHTML = `${n < done ? '✓ ' : ''}${n}. ${MISSIONS[n].title}<small>${MISSIONS[n].where}${n === settings.nextMission && !settings.campaignDone ? ' · next' : ''}</small>`;
      b.classList.toggle('on', settings.mission === n);
      b.onclick = () => { settings.mission = n; save(); drawMissions(); drawMode(); };
      ml.appendChild(b);
    }
  };
  drawMissions();
  const lv = $('levels');
  const draw = () => {
    lv.innerHTML = '';
    for (const l of idx.levels) {
      const b = document.createElement('button');
      b.innerHTML = `${prettyLevel(l.name)}<small>${l.flags} flags</small>`;
      b.classList.toggle('on', settings.level === l.name);
      b.onclick = () => { settings.level = l.name; save(); draw(); };
      lv.appendChild(b);
    }
  };
  if (!idx.levels.some(l => l.name === settings.level)) settings.level = idx.levels[0].name;
  draw();
  seg($('chars'), PERSOS.map(p => ({ value: p, label: title(p) })), 'perso', it => `<img src="assets/textures/head_${it.value}_1.png" alt="">${it.label}`);
  seg($('vehicles'), VEHICLES.map((v, i) => ({ value: i, label: v.name })), 'vehicle');
  seg($('difficulty'), DIFFS.map((d, i) => ({ value: i, label: d })), 'difficulty');
  seg($('laps'), [1, 2, 3, 5].map(n => ({ value: n, label: String(n) })), 'laps');
  seg($('opponents'), [0, 1, 2, 3].map(n => ({ value: n, label: String(n) })), 'opponents');
  seg($('vision'), [[1, 'Original'], [1.5, 'Far'], [2.5, 'Very far']].map(([v, l]) => ({ value: v, label: l })), 'vision');
  seg($('sound'), [[true, 'On'], [false, 'Off']].map(([v, l]) => ({ value: v, label: l })), 'sound');
  drawMode();
}

async function startRace(name) {
  sound.unlock();
  sound.enabled = settings.sound;
  if (game.scene) game.dispose();
  lastLevel = name; game.lastStart = () => startRace(name);
  try { await game.load(name, 'race'); }
  catch (e) { console.error(e); alert('Could not load level: ' + e.message); showOnly('menu'); game.state = 'menu'; }
}
async function startMission(n) {
  sound.unlock();
  sound.enabled = settings.sound;
  if (game.scene) game.dispose();
  settings.mission = n; save();
  game.lastStart = () => startMission(n);
  try { await game.load('level-mission-' + n, 'mission', n); }
  catch (e) { console.error(e); alert('Could not load mission: ' + e.message); showOnly('menu'); game.state = 'menu'; }
}
async function startExtra(key) {
  sound.unlock();
  sound.enabled = settings.sound;
  if (game.scene) game.dispose();
  const def = EXTRAS[key];
  game.lastStart = () => startExtra(key);
  try { await game.load(def.level, 'mission', 0, def); }
  catch (e) { console.error(e); alert('Could not load level: ' + e.message); showOnly('menu'); game.state = 'menu'; }
}
function toMenu() { game.dispose(); game.state = 'menu'; showOnly('menu'); buildMenu(); }

$('go').onclick = () => settings.mode === 'campaign' ? startMission(settings.mission || settings.nextMission)
  : settings.mode === 'extras' ? startExtra(settings.extra) : startRace(settings.level);
$('resume').onclick = () => { game.state = game.prevState || 'race'; showOnly(null); };
$('restart').onclick = () => game.lastStart && game.lastStart();
$('quit').onclick = toMenu;
$('menu2').onclick = toMenu;

// Input events, queued for the next round like SDL events in the original.
const view = $('view');
const inGame = () => game.state === 'race' || game.state === 'play' || game.state === 'ready';
// While the idler is paused any click or key continues (ACTION_STARTGAME -> IDLER.unpause).
const tryUnpause = () => { if (game.paused && game.playing) { game.unpause(); return true; } return false; };
addEventListener('mousemove', e => { if (game.state === 'race' || game.state === 'play') game.input.events.push({ type: 'move', x: e.clientX, y: e.clientY }); });
view.addEventListener('contextmenu', e => e.preventDefault());
view.addEventListener('mousedown', e => {
  if (game.state === 'ready') { game.start(); return; }
  if (!(game.state === 'race' || game.state === 'play')) return;
  e.preventDefault();
  if (tryUnpause()) return;
  game.input.events.push({ type: e.button === 0 ? 'jump' : e.button === 1 ? 'climb' : 'turbo' });
});
addEventListener('mouseup', e => { if ((game.state === 'race' || game.state === 'play') && (e.button === 0 || e.button === 2)) game.input.events.push({ type: 'release' }); });
view.addEventListener('wheel', e => { if (game.state === 'race' || game.state === 'play') { e.preventDefault(); game.input.events.push({ type: 'wheel', dy: e.deltaY }); } }, { passive: false });

const KEYMAP = {
  ArrowUp: ['dY', -0.15], KeyW: ['dY', -0.15], ArrowDown: ['dY', 0.15], KeyS: ['dY', 0.15],
  ArrowLeft: ['dX', -0.1], KeyA: ['dX', -0.1], ArrowRight: ['dX', 0.1], KeyD: ['dX', 0.1],
};
addEventListener('keydown', e => {
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (inGame()) { game.prevState = game.state; game.state = 'paused'; showOnly('pause'); }
    else if (game.state === 'paused') { game.state = game.prevState; showOnly(null); }
    return;
  }
  if (!inGame()) return;
  if (game.state === 'ready') { if (!KEYMAP[e.code]) game.start(); return; }
  const inp = game.input;
  if (e.repeat) { if (KEYMAP[e.code]) e.preventDefault(); return; }
  if (KEYMAP[e.code]) {
    e.preventDefault();
    const [k, v] = KEYMAP[e.code];
    inp.keyboardMode = true; inp[k] = v; inp.keys.add(e.code);
    return;
  }
  if (e.code === 'Space' || e.code.startsWith('Control') || e.code.startsWith('Alt')) e.preventDefault();
  if (tryUnpause()) return;
  if (e.code === 'Space' || e.code.startsWith('Control')) inp.events.push({ type: 'jump' });
  else if (e.code.startsWith('Shift')) inp.events.push({ type: 'climb' });
  else if (e.code.startsWith('Alt') || e.code === 'KeyX') inp.events.push({ type: 'turbo' });
  else if (e.code === 'Enter') tryUnpause();
});
addEventListener('keyup', e => {
  const inp = game.input;
  if (KEYMAP[e.code]) {
    inp.keys.delete(e.code);
    const [k, v] = KEYMAP[e.code];
    if (Math.sign(inp[k]) === Math.sign(v)) inp[k] = 0;
    if (k === 'dY' && v > 0 && inp.mouseY >= 1.0) inp.allowMoveBack = 10;
  } else if (e.code === 'Space' || e.code.startsWith('Control') || e.code.startsWith('Shift') || e.code.startsWith('Alt') || e.code === 'KeyX') {
    if (game.state === 'race' || game.state === 'play') inp.events.push({ type: 'release' });
  }
});
addEventListener('blur', () => { if (game.state === 'race' || game.state === 'play') { game.prevState = game.state; game.state = 'paused'; showOnly('pause'); } });

let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000; last = now;
  try { game.frame(dt); } catch (e) { console.error(e); }
  requestAnimationFrame(loop);
}
buildMenu().then(() => requestAnimationFrame(loop));
window.SLUNE = game;  // handy for debugging from the console
