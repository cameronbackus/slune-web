// 2D overlay: LifeBar, LapsLabel, MiniMap and next-flag arrow from slune (character.py / race.py).
import * as THREE from 'three';

export class HUD {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.heads = new Map();
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.dpr = dpr;
    this.c.width = innerWidth * dpr; this.c.height = innerHeight * dpr;
  }
  head(perso) {
    if (!this.heads.has(perso)) {
      const img = new Image();
      img.src = 'assets/textures/head_' + perso + '_1.png';
      this.heads.set(perso, img);
    }
    return this.heads.get(perso);
  }
  clear() { this.g.setTransform(1, 0, 0, 1, 0, 0); this.g.clearRect(0, 0, this.c.width, this.c.height); }

  draw(game, camera) {
    const g = this.g, W = innerWidth, H = innerHeight;
    this.clear();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const p = game.player;
    if (!p) return;
    const small = W < 600;

    // LifeBar: right edge, red background, orange life.
    const lw = small ? 14 : 20, lx = W - lw - 10, ly = 10, lh = H - 20;
    g.fillStyle = 'rgb(178,0,0)'; g.fillRect(lx, ly, lw, lh);
    const top = ly + (1 - Math.max(0, p.life)) * lh;
    const grad = g.createLinearGradient(0, top, 0, ly + lh);
    grad.addColorStop(0, 'rgb(255,178,0)'); grad.addColorStop(1, 'rgb(178,0,0)');
    g.fillStyle = grad; g.fillRect(lx, top, lw, ly + lh - top);
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2; g.strokeRect(lx, ly, lw, lh);

    // BossLifeBar (fight.AlienBoss): left edge, green.
    if (game.bossBar && game.bossBar.alive) {
      const bx = 10;
      g.fillStyle = 'rgb(0,128,0)'; g.fillRect(bx, ly, lw, lh);
      const bt = ly + (1 - Math.max(0, Math.min(1, game.bossBar.life))) * lh;
      g.fillStyle = 'rgb(178,255,0)'; g.fillRect(bx, bt, lw, ly + lh - bt);
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeRect(bx, ly, lw, lh);
    }
    for (const w of game.widgets) w.draw(this, g, W, H, game);
    if (game.mode === 'mission' && !game.showFlags) { this.cursor(game, g); this.overlays(game, g, W, H); return; }

    // Laps / position label, bottom left.
    g.font = `bold ${small ? 18 : 26}px "Trebuchet MS", sans-serif`;
    g.textBaseline = 'bottom';
    if (game.mode === 'race') {
    const lapTxt = `Lap ${Math.min(p.laps + 1, game.nbLaps)}/${game.nbLaps}`;
    const posTxt = `Pos ${game.rankOf(p)}/${game.characters.length}`;
    const t = game.raceTime();
    const timeTxt = t != null ? fmt(t) + (p.bestLap < Infinity ? `   best ${fmt(p.bestLap)}` : '') : '';
    this.text(lapTxt + '    ' + posTxt, 12, H - 12);
    g.font = `bold ${small ? 13 : 16}px "Trebuchet MS", sans-serif`;
    this.text(timeTxt, 12, H - (small ? 36 : 44));
    if (p.flameThrower) this.text(`Flame-thrower ×${p.flameThrower}`, 12, H - (small ? 54 : 66));
    }

    // MiniMap: flags polyline + character heads, top right.
    const flags = game.flags;
    if (flags.length > 1) {
      const size = small ? 110 : 200, left = W - size - lw - 30, mtop = 10;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const f of flags) { minX = Math.min(minX, f.pos.x); maxX = Math.max(maxX, f.pos.x); minZ = Math.min(minZ, f.pos.z); maxZ = Math.max(maxZ, f.pos.z); }
      const f = Math.min(size / (maxX - minX || 1), size / (maxZ - minZ || 1));
      const ox = left + (size - (maxX - minX) * f) / 2, oy = mtop + (size - (maxZ - minZ) * f) / 2;
      const mp = v => [ox + f * (v.x - minX), oy + f * (v.z - minZ)];
      g.lineWidth = 2; g.strokeStyle = 'rgba(0,0,0,0.5)';
      for (const off of [2, 0]) {
        g.beginPath();
        flags.forEach((fl, i) => { const [x, y] = mp(fl.pos); i ? g.lineTo(x + off, y + off) : g.moveTo(x + off, y + off); });
        g.closePath(); g.strokeStyle = off ? 'rgba(0,0,0,0.5)' : '#fff'; g.stroke();
      }
      const [sx, sy] = mp(flags[flags.length - 1].pos);
      g.fillStyle = '#fff'; g.fillRect(sx - 4, sy - 4, 8, 8);
      const nf = flags[p.nextFlag];
      if (nf) { const [nx, ny] = mp(nf.pos); g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(nx, ny, 4, 0, 7); g.fill(); }
      const hs = small ? 12 : 20;
      for (const ch of game.characters) {
        if (!ch.alive) continue;
        const [x, y] = mp(ch.pos);
        const img = this.head(ch.perso);
        if (img.complete && img.naturalWidth) g.drawImage(img, x - hs, y - hs, hs * 2, hs * 2);
        else { g.fillStyle = ch === p ? '#ffd23f' : '#fff'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); }
      }
    }

    // Arrow at the screen border toward the next flag (MiniMap.render in race.py).
    const nf = flags[p.nextFlag];
    if (nf && game.playing) {
      const v = nf.pos.clone().applyMatrix4(camera.matrixWorldInverse);
      const ang = Math.atan2(v.x, -v.z);
      let vx = Math.sin(ang), vy = -Math.cos(ang);
      // Project onto the screen rectangle.
      const r = W / H;
      let mx, my;
      if (r > Math.abs(vx / vy)) { my = (vy < 0 ? -H : H) / 2; mx = vx * (my / vy); }
      else { mx = (vx < 0 ? -W : W) / 2; my = vy * (mx / vx); }
      const inFront = v.z < 0 && Math.abs(v.x / -v.z) < 0.5;
      if (!inFront) {
        const x = Math.min(W - 40, Math.max(20, mx + W / 2)), y = Math.min(H - 20, Math.max(20, -my + H / 2));
        const s = 0.06, x1 = x + (my - mx) * s, x2 = x + (-my - mx) * s, y1 = y + (mx + my) * s, y2 = y + (-mx + my) * s;
        g.fillStyle = 'rgba(0,0,0,0.5)'; this.tri(x - 4, y + 4, x1 - 4, y1 + 4, x2 - 4, y2 + 4);
        g.fillStyle = '#fff'; this.tri(x, y, x1, y1, x2, y2);
      }
    }

    this.cursor(game, g);
    if (game.mode === 'mission') this.overlays(game, g, W, H);
  }
  // Steering cursor (KeyboardMouseControler.render), mouse mode only.
  cursor(game, g) {
    const ctl = game.input;
    if (ctl && !ctl.keyboardMode && ctl.pixel && (game.state === 'race' || game.state === 'play') && !game.blackbands) {
      const ang = Math.atan(ctl.mouseX / (ctl.mouseY - 1.01));
      const back = ctl.allowMoveBack >= 10;
      const size = back ? 10 + ctl.mouseY * 10 : 30 - ctl.mouseY * 10;
      const [px, py] = ctl.pixel, c = Math.cos(ang), s = Math.sin(ang), k = back ? -1 : 1;
      g.fillStyle = 'rgba(0,0,0,0.5)';
      this.tri(px - 9, py + 9, px - 9 - k * size * c + size * s, py + 9 + k * size * c + size * s, px - 9 + k * size * c + size * s, py + 9 + k * size * c - size * s);
      g.fillStyle = '#fff';
      this.tri(px, py, px - k * size * c + size * s, py + k * size * c + size * s, px + k * size * c + size * s, py + k * size * c - size * s);
    }
  }
  // Black bands while a video sequence runs, the Fader, and a hint while the idler is paused.
  overlays(game, g, W, H) {
    if (game.blackbands) { g.fillStyle = '#000'; g.fillRect(0, 0, W, H / 10); g.fillRect(0, H - H / 10, W, H / 10); }
    if (game.fadeLevel >= 0) {
      const a = game.fadeLevel <= 1 ? game.fadeLevel : 2 - game.fadeLevel;
      g.fillStyle = `rgba(0,0,0,${Math.max(0, Math.min(1, a))})`; g.fillRect(0, 0, W, H);
    }
    if (game.paused && game.playing) {
      g.font = 'bold 15px "Trebuchet MS", sans-serif'; g.textBaseline = 'bottom';
      const s = 'click or press a key to continue ▶';
      const tw = g.measureText(s).width;
      this.text(s, W - tw - 50, H - (game.blackbands ? H / 10 + 8 : 14));
    }
  }
  // A minimap of arbitrary points plus character heads (race.MiniMap, medoc.MiniMap, arena.MiniMap).
  minimap(game, points, opts = {}) {
    const g = this.g, W = innerWidth, small = W < 600;
    const size = small ? 110 : 200, left = W - size - (small ? 14 : 20) - 30, mtop = 10;
    if (!points.length) return;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    const f = Math.min(size / (maxX - minX || 1), size / (maxZ - minZ || 1));
    const ox = left + (size - (maxX - minX) * f) / 2, oy = mtop + (size - (maxZ - minZ) * f) / 2;
    const mp = v => [ox + f * (v.x - minX), oy + f * (v.z - minZ)];
    g.fillStyle = '#fff';
    for (const p of (opts.squares || points)) { const [x, y] = mp(p); g.fillRect(x - 4, y - 4, 8, 8); }
    const hs = small ? 12 : 20;
    for (const ch of game.characters) {
      if (!ch.alive || !(ch.isCompetitor)) continue;
      const [x, y] = mp(ch.pos);
      const fwd = ch.localPoint(0, 0, -25);
      const [x2, y2] = mp(fwd);
      g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      const img = this.head(ch.perso);
      if (img.complete && img.naturalWidth) g.drawImage(img, x - hs, y - hs, hs * 2, hs * 2);
      else { g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); }
    }
  }
  tri(a, b, c, d, e, f) { const g = this.g; g.beginPath(); g.moveTo(a, b); g.lineTo(c, d); g.lineTo(e, f); g.closePath(); g.fill(); }
  text(s, x, y) { const g = this.g; g.fillStyle = '#000'; g.fillText(s, x + 2, y + 2); g.fillStyle = '#fff'; g.fillText(s, x, y); }
}

export function fmt(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

// soya.ThirdPersonTraveling: keeps a direction vector from the target, nudging it
// laterally / vertically each round so the camera ends up behind and above,
// shortening it when the view is blocked; the camera moves 30% of the way per round.
export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.dir = new THREE.Vector3(0, 1, 2).normalize();
    this.distance = 5.0;
    this.offsetY = 0.9;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.prevLook = new THREE.Vector3();
  }
  target(ch) { return ch.localPoint(0, this.offsetY, 0); }
  zap(ch, collision) {
    this.dir.copy(ch.toWorld(new THREE.Vector3(0, 0.6, 1))).normalize();
    this.pos.copy(this.best(ch, collision));
    this.prev.copy(this.pos);
    this.look.copy(this.target(ch)); this.prevLook.copy(this.look);
  }
  best(ch, collision) {
    const t = this.target(ch);
    // Desired: behind the character (its local +Z), about 3 units above it at distance 5.
    const want = ch.toWorld(new THREE.Vector3(0, 0, 1));
    want.y = 0;
    if (want.lengthSq() < 1e-4) want.set(0, 0, 1);
    want.normalize().multiplyScalar(4).add(new THREE.Vector3(0, 3, 0)).normalize();
    this.dir.lerp(want, 0.12).normalize();
    const h = collision.raypick(t, this.dir, this.distance, true, false);
    const d = h ? Math.max(0.6, h.distance - 0.3) : this.distance;
    return t.clone().addScaledVector(this.dir, d);
  }
  round(ch, collision) {
    this.prev.copy(this.pos);
    this.prevLook.copy(this.look);
    const b = this.best(ch, collision);
    this.pos.lerp(b, 0.3);
    this.look.copy(this.target(ch));
  }
  apply(alpha) {
    this.camera.position.lerpVectors(this.prev, this.pos, alpha);
    this.camera.lookAt(new THREE.Vector3().lerpVectors(this.prevLook, this.look, alpha));
  }
}
