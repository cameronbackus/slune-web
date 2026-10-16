// Minimal Web Audio wrapper standing in for slune/sound.py (OpenAL in the original).
export class Sound {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.buffers = new Map();
    this.listener = null;   // THREE.Vector3 of the camera
    this.music = null;
    this.last = new Map();
  }
  unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  load(name) {
    if (!this.buffers.has(name)) {
      this.buffers.set(name, fetch('assets/sounds/' + name).then(r => r.arrayBuffer())
        .then(b => new Promise((ok, ko) => this.ctx.decodeAudioData(b, ok, ko))).catch(() => null));
    }
    return this.buffers.get(name);
  }
  async play(name, pos, volume = 1) {
    if (!this.enabled || !this.ctx) return;
    const now = performance.now();
    if (now - (this.last.get(name) || 0) < 60) return;  // avoid stacking the same sample every round
    this.last.set(name, now);
    let v = volume;
    if (pos && this.listener) v *= 1 / (1 + Math.max(0, pos.distanceTo(this.listener) - 4) / 8);
    if (!Number.isFinite(v) || v < 0.03) return;
    const buf = await this.load(name);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = v;
    src.connect(g).connect(this.master);
    src.start();
  }
  async playMusic(name) {
    this.stopMusic();
    if (!this.enabled || !this.ctx || !name) return;
    const token = this.musicToken = {};
    const buf = await this.load(name);
    if (!buf || token !== this.musicToken) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = 0.45;
    src.connect(g).connect(this.master);
    src.start();
    this.music = src;
  }
  stopMusic() { this.musicToken = null; if (this.music) { try { this.music.stop(); } catch (e) {} this.music = null; } }
}
