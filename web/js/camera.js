// soya.TravelingCamera and its travelings (ThirdPersonTraveling, FixTraveling).
// The camera keeps a stack of travelings; the top one decides where the camera
// wants to be ("best position") and what it looks at. Each round the camera moves
// `speed` of the way there (smooth_move) or jumps there; zap() jumps immediately.
import * as THREE from 'three';

// A position that may be attached to something that moves, like Soya's Point(parent, x, y, z).
// `obj` may be null (world), a physics Body (has localPoint) or a THREE.Object3D.
export class Pos {
  constructor(obj, x = 0, y = 0, z = 0) { this.obj = obj; this.local = new THREE.Vector3(x, y, z); }
  world(out = new THREE.Vector3()) {
    const o = typeof this.obj === 'function' ? this.obj() : this.obj;  // e.g. () => character.persoObj
    if (!o) return out.copy(this.local);
    if (o.isObject3D) { o.updateWorldMatrix(true, false); return out.copy(this.local).applyMatrix4(o.matrixWorld); }
    if (o.localPoint) return out.copy(o.localPoint(this.local.x, this.local.y, this.local.z));
    if (o.pos) return out.copy(o.pos).add(this.local);
    return out.copy(this.local);
  }
}
// A direction attached to something (Soya's Vector(parent, x, y, z)).
export class Dir {
  constructor(obj, x = 0, y = 0, z = -1) { this.obj = obj; this.local = new THREE.Vector3(x, y, z); }
  world(out = new THREE.Vector3()) {
    const o = typeof this.obj === 'function' ? this.obj() : this.obj;
    out.copy(this.local);
    if (!o) return out;
    if (o.isObject3D) { o.updateWorldMatrix(true, false); return out.transformDirection(o.matrixWorld).multiplyScalar(this.local.length()); }
    if (o.quat) return out.applyQuaternion(o.quat);
    return out;
  }
}
const toPos = p => (p instanceof Pos ? p : p && p.isVector3 ? new Pos(null, p.x, p.y, p.z) : p && (p.pos || p.isObject3D) ? new Pos(p) : p);

export class ThirdPersonTraveling {
  constructor(target) {
    this.target = target;           // a Body (character) or Pos
    this.dir = new THREE.Vector3(0, 1, 2).normalize();
    this.distance = 5.0;
    this.offsetY = 1.5;
    this.smoothMove = true; this.smoothRotation = false;
  }
  _target() {
    const t = this.target;
    if (t && t.localPoint) return t.localPoint(0, this.offsetY, 0);
    return toPos(t).world().add(new THREE.Vector3(0, this.offsetY, 0));
  }
  zapDir() {
    const t = this.target;
    if (t && t.toWorld) this.dir.copy(t.toWorld(new THREE.Vector3(0, 0.6, 1))).normalize();
  }
  best(collision) {
    const t = this._target();
    const tgt = this.target;
    if (tgt && tgt.toWorld) {
      const want = tgt.toWorld(new THREE.Vector3(0, 0, 1));
      want.y = 0;
      if (want.lengthSq() < 1e-4) want.set(0, 0, 1);
      // Behind and about 3 units above at distance 5 (scaled with the distance).
      want.normalize().multiplyScalar(4).add(new THREE.Vector3(0, 3, 0)).normalize();
      this.dir.lerp(want, 0.12).normalize();
    }
    const h = collision && collision.raypick(t, this.dir, this.distance, true, false);
    const d = h ? Math.max(0.6, h.distance - 0.3) : this.distance;
    return { pos: t.clone().addScaledVector(this.dir, d), look: t };
  }
}

export class FixTraveling {
  // target: where the camera goes; direction: a Dir (look direction) or a Pos/point (look at).
  constructor(target, direction, smoothMove = true, smoothRotation = false) {
    this.target = toPos(target);
    this.direction = direction instanceof Dir ? direction : toPos(direction);
    this.smoothMove = smoothMove; this.smoothRotation = smoothRotation;
  }
  best() {
    const pos = this.target ? this.target.world() : null;
    let look;
    if (this.direction instanceof Dir) look = (pos || new THREE.Vector3()).clone().add(this.direction.world());
    else if (this.direction) look = this.direction.world();
    return { pos, look };
  }
}

export class TravelingCamera {
  constructor(camera) {
    this.camera = camera;
    this.travelings = [];
    this.speed = 0.3;
    this.pos = new THREE.Vector3(); this.prev = new THREE.Vector3();
    this.quat = new THREE.Quaternion(); this.prevQuat = new THREE.Quaternion();
    this.collision = null;
  }
  get traveling() { return this.travelings[this.travelings.length - 1]; }
  add(t) { this.travelings.push(t); }
  remove(t) { const i = this.travelings.lastIndexOf(t); if (i >= 0) this.travelings.splice(i, 1); }
  reset() { this.travelings.length = 0; this.speed = 0.3; }
  _look(pos, look) {
    const m = new THREE.Matrix4().lookAt(pos, look, new THREE.Vector3(0, 1, 0));
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }
  zap() {
    const t = this.traveling;
    if (!t) return;
    if (this.sync) this.sync();
    if (t.zapDir) t.zapDir();
    const b = t.best(this.collision);
    if (b.pos) this.pos.copy(b.pos);
    if (b.look && b.look.distanceToSquared(this.pos) > 1e-8) this.quat.copy(this._look(this.pos, b.look));
    this.prev.copy(this.pos); this.prevQuat.copy(this.quat);
  }
  round() {
    this.prev.copy(this.pos); this.prevQuat.copy(this.quat);
    const t = this.traveling;
    if (!t) return;
    if (this.sync) this.sync();
    const b = t.best(this.collision);
    if (b.pos) {
      if (t.smoothMove) this.pos.lerp(b.pos, this.speed);
      else this.pos.copy(b.pos);
    }
    if (b.look && b.look.distanceToSquared(this.pos) > 1e-8) {
      const q = this._look(this.pos, b.look);
      if (t.smoothRotation) this.quat.slerp(q, Math.min(1, 2 * this.speed));
      else this.quat.copy(q);
    }
  }
  apply(alpha) {
    this.camera.position.lerpVectors(this.prev, this.pos, alpha);
    this.camera.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }
}
