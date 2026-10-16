// Port of Slune's character.py physics (Character.begin_action, Pushable.begin_round).
// Everything runs in fixed "rounds" of 30 ms, like Soya's MainLoop; distances are
// in world units per round. Soya's Vector math across coordinate systems is done
// here explicitly with quaternions (local <-> world).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export const ROUND = 0.030;
export const A = { WAIT: 'w', JUMP: 'j', TURBO: 't', ROTUP: 'u', ROTDOWN: 'd', ROTLAT: 'l', STARTGAME: '!' };

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
const DEG = Math.PI / 180;

// ------------------------------------------------------------- raypicking
export function makeBVH(tris) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(tris, 3));
  return new MeshBVH(geo, { maxLeafTris: 8 });
}

export class CollisionWorld {
  constructor(tris) {
    this.bvh = makeBVH(tris.length ? tris : new Float32Array(9));
    this.ray = new THREE.Ray();
    this.tmp = new THREE.Vector3();
    // Moving solid bodies (doors, airplanes...): {bvh, object: THREE.Object3D, enabled}
    this.dynamic = new Set();
    this._inv = new THREE.Matrix4();
    this._nm = new THREE.Matrix3();
  }
  addDynamic(bvh, object) { const d = { bvh, object, enabled: true }; this.dynamic.add(d); return d; }
  removeDynamic(d) { this.dynamic.delete(d); }
  _cast(origin, dir, dist, cull) {
    const side = cull ? THREE.FrontSide : THREE.DoubleSide;
    this.ray.origin.copy(origin);
    this.ray.direction.copy(dir);
    let best = this.bvh.raycastFirst(this.ray, side);
    if (best && best.distance > dist) best = null;
    for (const d of this.dynamic) {
      if (!d.enabled || !d.object.parent) continue;
      d.object.updateWorldMatrix(true, false);
      const m = d.object.matrixWorld;
      this._inv.copy(m).invert();
      this.ray.origin.copy(origin).applyMatrix4(this._inv);
      this.ray.direction.copy(dir).transformDirection(this._inv);
      const h = d.bvh.raycastFirst(this.ray, side);
      if (!h) continue;
      const p = h.point.applyMatrix4(m);
      const distance = p.distanceTo(origin);
      if (distance > dist || (best && best.distance <= distance)) continue;
      const n = h.face.normal.clone().applyMatrix3(this._nm.getNormalMatrix(m)).normalize();
      best = { point: p, distance, face: { normal: n } };
    }
    return best;
  }
  // Soya's World.raypick(origin, direction, distance, half_line, cull_face):
  // returns {point, normal} of the nearest hit; half_line=false also looks backwards.
  raypick(origin, dir, dist, halfLine = true, cull = true) {
    const d = this.tmp.copy(dir).normalize();
    let best = this._cast(origin, d, dist, cull);
    if (!halfLine) {
      const back = this._cast(origin, d.clone().negate(), dist, cull);
      if (back && (!best || back.distance < best.distance)) best = back;
    }
    if (!best) return null;
    return { point: best.point.clone(), normal: best.face.normal.clone(), distance: best.distance };
  }
  raypickB(origin, dir, dist) { return !!this._cast(origin, this.tmp.copy(dir).normalize(), dist, false); }
}

// ------------------------------------------------------------- base body
export class Body {
  constructor() {
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.nextPos = new THREE.Vector3();
    this.force = new THREE.Vector3();
    this.pendingForce = [];
    this.radius = 1.0;
    this.weight = 1.0;
    this.pushFly = 0.3;
    this.life = 1.0;
    this.alive = true;
  }
  toWorld(v) { return v.applyQuaternion(this.quat); }
  toLocal(v) { return v.applyQuaternion((this._inv || (this._inv = new THREE.Quaternion())).copy(this.quat).invert()); }
  localPoint(x, y, z) { return this.toWorld(new THREE.Vector3(x, y, z)).add(this.pos); }
  turn(axis, deg) { this.quat.multiply(new THREE.Quaternion().setFromAxisAngle(axis, deg * DEG)); }  // Soya turn_*: local axis
  rotateAxe(deg, axisWorld) { this.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(axisWorld.clone().normalize(), deg * DEG)); }
  lookAt(dir) {
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.clone().normalize(), UP);  // local -Z -> dir
    this.quat.setFromRotationMatrix(m);
  }
  distanceTo(o) { return this.pos.distanceTo(o.pos); }
  push(x, y, z, pusher = null) { this.pendingForce.push([x, y, z]); if (pusher) this.pushedBy = pusher; }  // Character.pushed_by
  applyPending() {
    for (const [x, y, z] of this.pendingForce) this.onPushed(x, y, z);
    this.pendingForce.length = 0;
  }
  onPushed(x, y, z) { this.force.x += x; this.force.y += y; this.force.z += z; }
  startRound() { this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat); }
  endRound() { this.pos.copy(this.nextPos); }
}

// ------------------------------------------------------------- vehicles
// Values from Character.set_vehicle.
export const VEHICLES = [
  { name: 'Biplane', radius: 0.7, floating: 0.5, weight: 1.3, maxspeedx: 0.8, maxspeedz: 0.98, rotup: 7.0, grip: 0 },
  { name: 'Car',     radius: 0.7, floating: 0.3, weight: 1.0, maxspeedx: 1.0, maxspeedz: 1.0,  rotup: 8.0, grip: 0 },
  { name: 'Truck',   radius: 0.8, floating: 0.3, weight: 1.6, maxspeedx: 0.9, maxspeedz: 0.95, rotup: 6.0, grip: 0 },
  { name: 'Scooter', radius: 0.7, floating: 0.3, weight: 0.6, maxspeedx: 1.0, maxspeedz: 1.0,  rotup: 9.0, grip: 1 },
  { name: 'Tanker',  radius: 1.0, floating: 0.5, weight: 2.2, maxspeedx: 0.7, maxspeedz: 0.8,  rotup: 4.0, grip: 0 },
];
export const VEHICLE_PERSO_COORDS = [[0, 0.1, 0.03], [0, 0.1, 0.03], [0, 0.4, -0.2], [0, 0.3, 0.35], [0, 0.48, 0]];

export class Character extends Body {
  constructor(game) {
    super();
    this.game = game;
    this.isCharacter = true;
    this.rotVert = 0;
    this.speedL = new THREE.Vector3();   // speed in local coordinates (Character.speed)
    this.speedW = new THREE.Vector3();   // the same, in world coordinates, after collisions
    this.oldSpeedX = 0;
    this.onGround = false; this.wasOnGround = false; this.gripped = false;
    this.verticalAngle = 0;
    this.scramble = 0; this.bounce = 0;
    this.nitroTime = 0; this.nitroOn = false;
    this.flameThrower = 0; this.flameThrowTime = 0;
    this.roll = 0; this.yawVis = 0;
    this.current = { action: A.WAIT, mx: 0, my: 1 };
    this.nitroEnabled = true;
    this.pushFly = 0.3;
    this.maxSpeed = 1.0;   // Character.max_speed (used by controler.goto)
    this.jumping = false;
    // race state
    this.nextFlag = 0; this.laps = 0; this.lapStart = 0; this.bestLap = Infinity; this.finished = false;
  }
  setVehicle(v) {
    const p = VEHICLES[v];
    this.vehicle = v;
    Object.assign(this, { radius: p.radius, floating: p.floating, weight: p.weight, maxspeedx: p.maxspeedx,
      maxspeedz: p.maxspeedz, rotupSpeed: p.rotup, modeGrip: p.grip });
  }
  teleport(p) { this.pos.copy(p); this.nextPos.copy(p); this.prevPos.copy(p); this.force.set(0, 0, 0); this.scramble = 0; }

  hurtScale() { return 1; }
  hurt(x) {
    this.life -= x * this.hurtScale();
    if (this.life < 0) { this.die(); return false; }
    return true;
  }
  die() {
    if (!this.alive) return;
    this.alive = false;
    this.game.fx.explosion(this.pos, 60, 0.7);
    this.game.sound.play('explose-3.wav', this.pos);
    this.game.onDeath(this);
  }

  // Character.begin_action, faithful to the original order of operations.
  beginAction(act) {
    const g = this.game, world = g.collision;
    const force = this.force;
    this.current = act;
    this.speedL.set(act.mx / 120.0 * this.maxspeedx, 0, (act.my * 0.2 - 0.2) * this.maxspeedz);
    const speed = this.speedL;

    // Cosmetic lean of the vehicle and driver when steering.
    // (internal.rotate_incline / perso.rotate_lateral by the change of speed.x add up
    // to -6000 * speed.x and -12000 * speed.x degrees; clamped here for the browser.)
    this.roll = Math.max(-35, Math.min(35, -6000.0 * speed.x));
    this.yawVis = Math.max(-40, Math.min(40, -12000.0 * speed.x));
    this.oldSpeedX = speed.x;
    this.turn(UP, -500.0 * speed.x);

    if (this.flameThrowTime) this.flameThrowTime--;
    if (this.nitroTime) { this.nitroTime--; if (!this.nitroTime) this.nitroOn = false; }
    this.life = Math.min(1.0, this.life + 0.0003);

    const a = act.action;
    if (a === A.ROTUP) this.turn(AXES[0], this.rotupSpeed);
    else if (a === A.ROTDOWN) this.turn(AXES[0], -this.rotupSpeed);
    else if (a === A.ROTLAT) this.rotateAxe(30.0, UP);
    else if (a === A.TURBO && this.flameThrowTime === 0) {
      if (this.flameThrower && !this.nitroOn) {
        this.flameThrower--;
        this.flameThrowTime = 50;
        g.fx.flameThrower(this);
      } else if (this.nitroEnabled) {
        const length = force.length();
        const d = 0.09 * Math.max(0, 1 - length);
        if (this.life > d) {
          force.add(this.toWorld(new THREE.Vector3(0, 0, -2)));
          force.setLength(Math.max(1.0, length));
          this.life -= 0.08 * Math.max(0, 1 - length);
          if (!this.nitroOn) g.sound.play('nitro-1.wav', this.pos);
          this.nitroOn = true;
          this.nitroTime = 10;
        }
      }
    } else if (a === A.JUMP && this.wasOnGround) {
      force.y += 0.4;
      this.rotVert += 0.4;
    }

    // Ground detection.
    this.wasOnGround = this.onGround;
    const center = this.localPoint(0, 0.3, 0);
    let hit = world.raypick(center, DOWN, this.floating + 0.45, true, true);
    if (hit) { this.onGround = true; this.gripped = false; }
    else if (this.modeGrip && (hit = world.raypick(center, this.toWorld(DOWN.clone()), 6.0 * speed.length() + 1e-4, true, true))) {
      this.onGround = this.gripped = true;
    } else this.onGround = this.gripped = false;

    if (this.onGround) {
      const P = hit.point;
      if (this.pos.y < P.y + this.floating - force.y) {
        if (!this.scramble) {
          const vy = this.toWorld(speed.clone()).y;
          this.scramble = Math.min(30, Math.pow((force.y + vy) * 7.0, 2));
          if (this.scramble > 6 && this.isPlayer) g.sound.play('push-1.wav', this.pos, 0.3);
        }
        force.y = this.gripped ? 0.0 : P.y + this.floating - this.pos.y;
      } else if (this.pos.y > P.y + this.floating + 0.1) force.y -= 0.03;

      if (force.y < 0.2 && a !== A.ROTUP && a !== A.ROTDOWN) {
        const V = this.toLocal(hit.normal.clone());
        if (V.y < -0.3) this.turn(new THREE.Vector3(0, 0, 1), 10.0);
        else if (V.y < 0.996 && V.y) {
          const axis = this.toWorld(V.clone().cross(UP));
          this.verticalAngle = -V.angleTo(UP) / DEG;
          this.rotateAxe(this.verticalAngle / 3.0, axis);
        }
      }
    } else {
      force.y -= 0.03;
      if (this.pos.y < g.killY) this.hurt(1.0);
      if (!this.alive) return;
    }
    force.multiplyScalar(0.95);

    if (this.rotVert > 0) { this.turn(AXES[0], this.rotVert * 14.0); this.rotVert -= 0.03; }

    speed.add(this.toLocal(force.clone()));
    if (speed.length() > 0.75) speed.setLength(0.75);
    const speedW = this.speedW.copy(speed); this.toWorld(speedW);

    // Pushing other characters and pushables.
    for (const o of g.pushers) {
      if (o === this || !o.alive) continue;
      if (this.distanceTo(o) < this.radius + o.radius) {
        const V = o.pos.clone().sub(this.pos);
        // (capped: the uncapped impulse can feed back between overlapping vehicles)
        const f = Math.min(1.5, 3.0 * Math.max(0, V.dot(speedW)) * this.weight / o.weight);
        if (f) {
          V.setLength(f);
          o.push(V.x, V.y + o.pushFly * f, V.z, this);
          const k = -0.3 * o.weight / this.weight;
          this.push(k * V.x, k * V.y, k * V.z, o);
          g.sound.play(o.isCharacter ? 'push-1.wav' : 'push-2.wav', o.pos, 0.6);
        }
      }
    }

    // Wall collisions: rays along world X and Z, both directions, radius long.
    const P2 = this.localPoint(0, 0.3, 0).add(speedW);
    let bouree = false;
    for (const vec of AXES) {
      const h = world.raypick(P2, vec, this.radius, false, false);
      if (!h) continue;
      const P = h.point, V = h.normal;
      const P3 = P2.clone().addScaledVector(vec, vec.dot(V) > 0 ? -this.radius : this.radius);
      if (force.dot(V) < 0) {
        if (Math.abs(force.x) + Math.abs(force.z) > 0.1) {
          force.addScaledVector(V, -2.0 * force.dot(V));
          force.multiplyScalar(0.5);
        }
        bouree = true;
      }
      const d = P.clone().sub(P2).dot(V) > 0 ? P.clone().sub(P2) : P.clone().sub(P3);
      P2.add(d); speedW.add(d);
    }
    // Floor / ceiling.
    P2.y += 0.2;
    const h = world.raypick(P2, DOWN, 0.7, false, true);
    if (h) {
      let P3;
      if (DOWN.dot(h.normal) > 0) P3 = P2.clone().addScaledVector(DOWN, -this.radius);
      else {
        if (force.y > 0) force.y = 0;  // stop and break a jump
        P3 = P2.clone().addScaledVector(DOWN, this.radius);
      }
      if (force.dot(h.normal) < -0.4) bouree = true;
      speedW.add(h.point.clone().sub(P3));
    }
    if (bouree) {
      const couic = Math.min(0.5, force.x * force.x + force.z * force.z) * 0.8;
      if (couic > 0.01) {
        if (this.hurt(couic) && g.fx.explosions < 4) {
          g.fx.explosion(this.pos, 25, 1.0);
          g.sound.play('explose-1.wav', this.pos);
        }
      }
    }
    this.nextPos.copy(this.pos).add(speedW);
  }

  onPushed(x, y, z) { super.onPushed(x, y, z); this.rotVert += Math.max(0, y); }

  // Character.end_round: also carried by a moving platform (airplane roof).
  endRound() {
    super.endRound();
    if (this.platformSpeed) { this.pos.add(this.platformSpeed); this.platformSpeed = null; }
  }

  // Visual-only state advanced per round (scramble = landing bounce).
  visualRound() {
    if (this.scramble) {
      if (this.scramble <= 1) { this.bounce = 0; this.scramble = 0; }
      else { this.bounce = Math.abs(Math.sin(this.scramble)) * this.scramble * 0.04; this.scramble -= 1 / 3; }
    }
  }
}

// ------------------------------------------------------------- pushables
export class Pushable extends Body {
  constructor(game, p) {
    super();
    this.game = game;
    this.radius = p.radius; this.radiusY = p.radius_y; this.weight = p.weight; this.life = p.life;
    this.worthPlaying = false;
    this.bonusType = 0;
    this.speedW = new THREE.Vector3();
    this.pushFly = 0.3;
  }
  hurt(x) { this.life -= x; if (this.life < 0) { this.die(); return false; } return true; }
  die() {
    if (!this.alive) return;
    this.alive = false;
    this.game.fx.explosion(this.pos, 30, 0.7, 20);
    this.game.sound.play('explose-2.wav', this.pos);
    this.game.onPushableDeath(this);
  }
  // Pushable.begin_round
  update() {
    const g = this.game, world = g.collision, force = this.force;
    if (!this.worthPlaying) {
      if (Math.abs(force.x) > 0.1 || Math.abs(force.y) > 0.1 || Math.abs(force.z) > 0.1) this.worthPlaying = true;
      else { this.nextPos.copy(this.pos); return; }
    }
    const speed = this.speedW.set(0, 0, 0);
    const center = this.localPoint(0, 0.3, 0);
    const hit = world.raypick(center, DOWN, this.radiusY / 2.0 + 0.45, true, true);
    if (hit) {
      const P = hit.point;
      if (this.pos.y < P.y + this.radiusY / 2.0 - force.y) {
        force.y = 0.0;
        force.y += P.y + this.radiusY / 2.0 - this.pos.y;
      } else if (this.pos.y > P.y + this.radiusY / 2.0 + 0.1) force.y -= 0.03;
      if (force.y < 0.05) {
        const V = this.toLocal(hit.normal.clone());
        if (V.y < 0) this.turn(new THREE.Vector3(0, 0, 1), 10.0);
        else if (V.y < 0.999) {
          const axis = this.toWorld(V.clone().cross(UP));
          this.rotateAxe(-V.angleTo(UP) / DEG / 4.0, axis);
        } else this.worthPlaying = false;
      }
    } else {
      force.y -= 0.03;
      if (this.pos.y < g.killY) { this.die(); return; }
    }
    force.multiplyScalar(0.95);
    if (force.y > 0) this.turn(AXES[0], force.y * 14.0);
    speed.add(force);
    if (speed.length() > 0.5) speed.setLength(0.5);

    for (const o of g.pushers) {
      if (o === this || !o.alive) continue;
      if (this.distanceTo(o) < this.radius + o.radius) {
        const V = o.pos.clone().sub(this.pos);
        V.y += o.pushFly;
        const f = 2.5 * Math.max(0, V.dot(speed));
        if (f) { V.setLength(f * this.weight / o.weight); o.push(V.x, V.y, V.z, this); }
      }
    }
    const P2 = this.localPoint(0, this.radiusY / 2.0, 0).add(speed);
    let bouree = false;
    for (const vec of AXES) {
      const h = world.raypick(P2, vec, this.radius, false, false);
      if (!h) continue;
      const P = h.point, V = h.normal;
      const P3 = P2.clone().addScaledVector(vec, vec.dot(V) > 0 ? -this.radius : this.radius);
      if (force.dot(V) < 0) { force.addScaledVector(V, -2.0 * force.dot(V)); bouree = true; }
      const d = P.clone().sub(P2).dot(V) > 0 ? P.clone().sub(P2) : P.clone().sub(P3);
      P2.add(d); speed.add(d);
    }
    P2.y += 0.2;
    const h = world.raypick(P2, DOWN, this.radiusY, false, true);
    if (h) {
      let P3;
      if (DOWN.dot(h.normal) > 0) P3 = P2.clone().addScaledVector(DOWN, -this.radiusY);
      else { if (force.y > 0) force.y = 0; P3 = P2.clone().addScaledVector(DOWN, this.radiusY); }
      if (force.dot(h.normal) < 0) bouree = true;
      speed.add(h.point.clone().sub(P3));
    }
    if (bouree) {
      const couic = Math.min(0.5, force.x * force.x + force.z * force.z);
      if (couic > 0.01 && this.hurt(couic) && g.fx.explosions < 4) {
        g.fx.explosion(this.pos, 25, 1.0, 15);
        g.sound.play('explose-1.wav', this.pos);
      }
    }
    this.nextPos.copy(this.pos).add(speed);
  }
}
