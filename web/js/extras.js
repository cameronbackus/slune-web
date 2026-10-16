// Slune's other game modes, outside the campaign:
// bowling.py (3 lanes), fight.py's duel, arena.py (two deathmatch arenas),
// the Indus Meeting trunk-shooting level and the Ride Park time trial
// (freestyle.start_time_limit with its flag Checker).
import * as THREE from 'three';
import { A } from './physics.js';
import { act } from './ai.js';
import { tr, addPerso } from './campaign.js';
import { TimerLabel, arenaMiniMap } from './modes.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const PERSOS = ['tux', 'gnu', 'shark', 'python'];
const title = s => s[0].toUpperCase() + s.slice(1);

function label(text) {
  return { draw: (hud, g, W, H, game) => {
    g.font = `bold ${W < 600 ? 18 : 24}px "Trebuchet MS", sans-serif`; g.textBaseline = 'bottom';
    hud.text(typeof text === 'function' ? text(game) : text, 12, H - 12);
  } };
}

// ---------------------------------------------------------------- bowling.py
// bowling.GoBack: reverse the player behind the line before the next ball.
function* goBack(ch) {
  for (let i = 0; i < 20; i++) {
    if (ch.pos.z >= 10.5) break;
    const p = ch.toLocal(V3(10, 0.5, 12).sub(ch.pos));
    yield act(A.WAIT, p.x < -4 ? 0.7 : p.x > 4 ? -0.7 : 0, p.z > 0 ? 2.0 : 0.0);
  }
}
function startBowling(g) {
  const proto = g.pushables.find(p => p.name === 'ball');
  const st = { ball: proto, fired: false, extra: 3 - g.difficulty, quilles: 0, used: 1, waiting: 0 };
  const ballPos = proto.pos.clone(), ballQuat = proto.quat.clone();
  const params = { radius: proto.radius, radius_y: proto.radiusY, weight: proto.weight, life: 50.0 };
  const addBall = () => {
    st.extra--; st.used++;
    st.ball = g.spawnPushable(params, proto.md, ballPos, ballQuat, 'ball');
    st.ball.bonusType = 0;
    st.fired = false;
  };
  g.widgets.push(label(() => tr('__bowlingformat__').replace('%s', st.extra).replace('%s', st.quilles)));
  g.addUpdater({ round() {
    const player = g.player;
    if (!player.alive) { this.removed = true; return; }
    if (player.pos.z < -15) { g.levelCompleted(player, false, tr('__bowling_looser__')); this.removed = true; return; }
    st.quilles = g.pushables.filter(p => p.alive && p.name === 'quille').length;
    if (st.waiting) {
      if (--st.waiting === 0) {
        if (player.pos.z < 10) { player.controler.stack.push(goBack(player)); st.waiting = 10; }
        else addBall();
      }
    } else if (!st.fired) {
      if (st.ball.worthPlaying) st.fired = true;
    } else if (!g.pushables.some(p => p.alive && (p.name === 'ball' || p.name === 'quille') && p.worthPlaying)) {
      // The ball and every pin have stopped.
      if (st.quilles) {
        if (st.extra) st.waiting = 1;
        else { g.levelCompleted(player, false, tr('__bowling_looser__')); this.removed = true; }
      } else {
        g.levelCompleted(player, true, st.used === 1 ? tr('__bowling_winner_strike__') : undefined);
        this.removed = true;
      }
    }
  } });
}

// ---------------------------------------------------------------- arena.py
// Deathmatch: whoever last pushed you gets the frag; everyone respawns at the start points.
function arenaMode(points) {
  return {
    title: '', isArena: true,
    initCharacter: g => {
      const pos = points.map(p => V3(...p));
      for (let i = pos.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pos[i], pos[j]] = [pos[j], pos[i]]; }
      g.startPos = pos;
      g.arenaFrags = g.nbLaps;
      arenaPlace(g, g.player);
    },
    start: g => {
      const used = new Set([g.player.perso]);
      for (let i = 0; i < g.nbOpponents; i++) {
        const perso = PERSOS.find(p => !used.has(p)) || PERSOS[i % 4];
        used.add(perso);
        const o = addPerso(g, perso, 1, 'fighter');
        o.isCompetitor = true; o.targetAny = true;  // arena.Opponent targets the nearest character
        arenaPlace(g, o);
      }
      for (const c of g.characters) { c.nbFrags = 0; c.onRespawn = ch => arenaDie(g, ch); }
      g.widgets.push(label(game => `Frags : ${game.player.nbFrags}`));
      arenaMiniMap(g, g.startPos);
    },
  };
}
function arenaPlace(g, ch) {
  const p = g.startPos.shift(); g.startPos.push(p);
  ch.teleport(p.clone().add(V3(0, ch.floating, 0)));
}
// arena._die
function arenaDie(g, ch) {
  const by = ch.pushedBy;
  if (by && by.nbFrags !== undefined && by !== ch) {
    g.message(`${title(by.perso)} fragged ${title(ch.perso)}!`);
    by.nbFrags++;
    if (by.nbFrags >= g.arenaFrags) {
      const recap = [...g.characters].sort((a, b) => b.nbFrags - a.nbFrags).map(c => `${title(c.perso)} : ${c.nbFrags} frags`).join('\n');
      const won = by === g.player;
      g.levelCompleted(g.player, won, (won ? tr('You have won!') : tr('__gameover__')) + '\n' + recap);
    }
  }
  ch.pushedBy = null;
  arenaPlace(g, ch);
  ch.life = 2.0;
}

// ---------------------------------------------------------------- the modes
export const EXTRAS = {
  'bowling-1': { title: 'Bowling 1', where: 'Bombay bowling', level: 'level-bowling-1', start: startBowling },
  'bowling-2': { title: 'Bowling 2', where: 'Bombay bowling', level: 'level-bowling-2', start: startBowling },
  'bowling-3': { title: 'Bowling 3', where: 'Bombay bowling', level: 'level-bowling-3', start: startBowling },
  duel: { title: 'Duel', where: 'Crashfunkel', level: 'level-crashfunkel-duel',
    initCharacter: (g, ch) => { ch.teleport(V3(28.7, ch.floating, 3.8)); ch.lookAt(V3(0, 0, -1)); },
    start: g => {  // fight.start_fight_game with one Fighter, then CheckEveryoneIsKilled
      const perso = PERSOS.find(p => p !== g.player.perso);
      const f = addPerso(g, perso, 1, 'fighter');
      f.isCompetitor = true;
      f.teleport(V3(30.0681838989, -6.84864997864 + f.floating, -28.7615890503)); f.lookAt(V3(0, 0, 1));
      g.addUpdater({ round() { if (g.characters.length === 1 && g.player.alive) { g.levelCompleted(g.player, true); this.removed = true; } } });
    } },
  'arena-cyberbombay': { ...arenaMode([[71.5724029541, 14.1999998093, 99.3111724854], [154.390090942, 1.1486376524, 27.0871257782], [119.51259613, 3.73999977112, 134.943099976],
    [142.721694946, 1.52941226959, 131.976593018], [63.9906044006, 0.759919822216, 163.151519775], [31.5966415405, 1.03825521469, 26.9789466858],
    [89.9343338013, 0.00597488880157, 74.8757781982], [47.2083320618, 30.2599182129, 97.007522583]]),
    title: 'Arena: Cyberbombay', where: 'Deathmatch', level: 'level-cyberbombay-arena-1' },
  'arena-urbancall': { ...arenaMode([[93.8134689331, 20.5, 176.468032837], [59.1401290894, 0.0447608828545, 145.976882935], [62.5676956177, 0.215669393539, 34.6883010864],
    [150.363189697, 15.5, 151.846481323], [134.278747559, 0.0150852203369, 144.696670532], [105.774261475, 16.5, 85.4136428833]]),
    title: 'Arena: Urban Call', where: 'Deathmatch', level: 'level-urbancall-arena-1' },
  shoot: { title: 'Trunk shoot', where: 'Indus Meeting', level: 'level-indusmeeting-shoot-1',
    initCharacter: (g, ch) => { ch.nitroEnabled = false; },
    start: g => {
      g.message(tr('__indusmeeting-shoot-1-1__'), 15);
      // The original level has no end; the remake ends it when the ball (an eye on a pole) falls.
      const ball = g.pushables.find(p => p.md && p.md.name === 'gnu-eye');
      if (!ball) return;
      const y0 = ball.pos.y;
      g.addUpdater({ round() { if (!ball.alive || ball.pos.y < y0 - 4) { g.levelCompleted(g.player, true, 'Down it comes!'); this.removed = true; } } });
    } },
  clock: { title: 'Ride Park time trial', where: 'Ride Park', level: 'level-ridepark-clock-1', showFlags: true,
    start: g => {
      g.chase.distance = 5.0; g.cam.speed = 0.6;
      const timer = new TimerLabel(g, [g.player], [1000, 200, 100][g.difficulty]);
      g.widgets.push(timer); g.addUpdater(timer);
      g.addUpdater({ round() {  // freestyle.Checker: one lap through the flags wins
        const c = g.player, flag = g.flags[c.nextFlag];
        if (!c.alive || !flag || c.pos.distanceTo(flag.pos) >= 3.5 + c.radius) return;
        g.sound.play('flag-1.wav', c.pos);
        g.fx.smoke(flag.pos);
        flag.obj.visible = false;
        if (c.nextFlag + 1 < g.flags.length) { c.nextFlag++; g.flags[c.nextFlag].obj.visible = true; }
        else { g.levelCompleted(c, true, tr('__race_winner__')); this.removed = true; }
      } });
    } },
};
