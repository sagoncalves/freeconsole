/**
 * Minefield Escape 3D — headless simulation.
 *
 * The screen owns this. Controllers send held directions and nothing else; no phone ever
 * asserts a position, a step, or a death.
 *
 * The one structural difference from the 2D game: **sonar is per-player**. Each player
 * carries their own emitter, on their own clock, with a finite radius. There is no moment
 * when the whole room sees the same truth. That changes the social layer completely — the
 * only way to learn about ground you have not personally lit is to watch where someone else
 * walked and survived, which is exactly the trap the game is built around.
 *
 * Space is tiles, time is seconds. The aisle runs along z: players start at high z (the near
 * end, closest to the camera) and walk toward the gate at z = 0. x is the narrow axis.
 */

import { getLevel, getArena } from "/games/minefield3d/levels.js?v=4";

/* ------------------------------------------------------------------ constants */

const MINE_TRIGGER_R = 0.36;
const KILLER_CATCH_R = 0.55;

/* --------------------------------------------------------------------- modes */

/** The original game: cross a mined aisle to a gate, with a press grinding up behind you. */
export const MODE_ESCAPE = "escape";

/**
 * Survival: an open room, no gate, and saw-armed roombas that hunt you until you are gone.
 *
 * Held as a field on the round rather than as a second sim module because everything
 * underneath is genuinely shared — the mines, the per-player sonar, the legs economy, the
 * footprints. What changes is only what is trying to kill you and what counts as winning, so
 * the mode branches at exactly three places (createRound, startRound, step) and every other
 * function in this file is mode-blind.
 */
export const MODE_SURVIVAL = "survival";

export const MODES = [MODE_ESCAPE, MODE_SURVIVAL];

/* ------------------------------------------------------------------ roombas */

/**
 * How close a blade has to get before it takes a leg. Slightly larger than the mine's trigger
 * so a saw is meaningfully harder to skirt than a mine — you can shave past a mine you have
 * seen, but a machine that is actively turning toward you should not be beatable by pixels.
 */
const SAW_HIT_R = 0.62;

/**
 * Seconds a roomba cannot hurt the same player again, so one brush costs one leg, not three.
 *
 * Measured, not guessed: at 1.15s a headless run of forty four-player rounds took 415 legs to
 * land 141 deaths — about three hits per player per round, on a body that only has two legs to
 * give. The saws were touching people almost continuously, which made losing a leg
 * indistinguishable from dying and left the whole legs economy decorative. Long enough here
 * that a hit is an event you get to react to.
 */
const SAW_COOLDOWN = 2.4;

/** Seconds a roomba is stalled after eating a mine. The reward for kiting one across the field. */
const ROOMBA_STAGGER = 1.6;

/** How sharply a roomba can turn, in radians per second. This is the whole counter-play. */
const ROOMBA_TURN = 2.4;

/** Radius used for wall bounces and mine contact. */
const ROOMBA_R = 0.5;

/** Movement, in tiles per second. Losing legs is a heavy tax — that is the whole tension. */
export const SPEED_WALK = 3.0;
export const SPEED_LIMP = 1.6;
export const SPEED_CRAWL = 0.75;

/** Seconds a player is stunned after an explosion, unable to move at all. */
const BLAST_STUN = 1.1;

/** Footprints older than this fade out entirely. */
export const PRINT_LIFE = 30;

/** Distance a player must travel before dropping the next footprint. */
const PRINT_SPACING = 0.55;

export const ALIVE = "alive";
export const DEAD = "dead";
export const ESCAPED = "escaped";

/**
 * Seated but not in this round — a phone that joined or reloaded while a round was already
 * running. Distinct from ESCAPED on purpose: a spectator must not appear in the survivor
 * roll, and distinct from DEAD so the round does not treat them as a casualty. They are
 * seated normally by the next startRound.
 */
export const WAITING = "waiting";

/* ----------------------------------------------------------------------- rng */

/** Mulberry32 — a seeded field can be reproduced exactly when something goes wrong. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------- rounds */

export function createRound(levelIndex, seed, mode = MODE_ESCAPE) {
  const survival = mode === MODE_SURVIVAL;
  const level = survival ? getArena(levelIndex) : getLevel(levelIndex);
  const round = {
    level,
    mode: survival ? MODE_SURVIVAL : MODE_ESCAPE,
    levelIndex: levelIndex | 0,
    seed: seed >>> 0,
    phase: "briefing",
    t: 0,
    players: new Map(),
    prints: [],
    events: [],
    mines: null,
    exploded: null,
    cols: level.cols,
    rows: level.rows,
    exitFrom: 0,
    exitTo: 0,
    exitUsed: 0,
    exitOpen: true,
    killerZ: 0,
    killerX: 0,
    escapedOrder: [],
    winner: null,

    /* survival only — inert in escape, so every reader can check them unconditionally */

    /** Live machines. Rebuilt each startRound; the renderer keys its meshes off `id`. */
    roombas: [],
    nextRoombaId: 1,
    /** Which wave is due next, and when. */
    wave: 0,
    nextWaveAt: 0,
    /** Seconds the last player standing lasted, and the order people went down in. */
    lastStand: 0,
    downOrder: [],
  };

  generateField(round);
  return round;
}

function generateField(round) {
  const { level } = round;
  round.mines = new Uint8Array(level.cols * level.rows);
  round.exploded = new Uint8Array(level.cols * level.rows);

  const rng = makeRng(round.seed);

  if (round.mode === MODE_SURVIVAL) {
    generateArenaField(round, rng);
    return;
  }

  const halfGate = Math.floor(level.exitWidth / 2);
  const centre = Math.floor(level.cols / 2);
  round.exitFrom = Math.max(0, centre - halfGate);
  round.exitTo = Math.min(level.cols - 1, round.exitFrom + level.exitWidth - 1);

  for (let z = 0; z < level.rows; z++) {
    if (z >= level.rows - level.safeRows) continue;   // spawn strip
    if (z === 0) continue;                            // gate mouth
    for (let x = 0; x < level.cols; x++) {
      if (rng() < level.mineDensity) round.mines[z * level.cols + x] = 1;
    }
  }

  carveEscapeRoute(round, rng);
}

/**
 * Mine the arena, leaving a clear circle in the middle.
 *
 * There is no route to carve here — the whole point is that there is nowhere in particular to
 * get to, so a guaranteed path would be guaranteeing nothing. What must be guaranteed instead
 * is the opening: players spawn in a ring at the centre and the saws come at them immediately,
 * so a mine under the spawn ring would kill somebody before they had touched the stick.
 */
function generateArenaField(round, rng) {
  const { level } = round;
  const cx = level.cols / 2;
  const cz = level.rows / 2;
  const safe = level.safeRadius * level.safeRadius;

  for (let z = 0; z < level.rows; z++) {
    for (let x = 0; x < level.cols; x++) {
      const dx = x + 0.5 - cx;
      const dz = z + 0.5 - cz;
      if (dx * dx + dz * dz < safe) continue;
      if (rng() < level.mineDensity) round.mines[z * level.cols + x] = 1;
    }
  }

  // There is no gate in survival. Point the span off the board so nothing can stumble into an
  // escape: moveTo's gate check reads exitFrom/exitTo, and leaving them at 0 would make the
  // whole z = 0 edge an exit.
  round.exitFrom = -1;
  round.exitTo = -1;
  round.exitOpen = false;
}

/**
 * Carve one guaranteed mine-free route, so a bad seed can never wall the aisle off entirely.
 *
 * It starts at a random column at the near end and wanders up to the gate — never straight
 * down the middle, and never anchored to the gate's own column. In a narrow aisle a lazy
 * corridor is most of the width, which would hand everyone a free walk and make the sonar
 * decoration; the wander is what keeps it a route you still have to *find*.
 */
function carveEscapeRoute(round, rng) {
  const { cols, rows } = round.level;
  let x = Math.floor(rng() * cols);

  for (let z = rows - 1; z >= 0; z--) {
    round.mines[z * cols + x] = 0;

    const drift = 1 + Math.floor(rng() * 3);
    for (let d = 0; d < drift; d++) {
      if (rng() < 0.5) {
        const nx = Math.max(0, Math.min(cols - 1, x + (rng() < 0.5 ? -1 : 1)));
        round.mines[z * cols + nx] = 0;
        x = nx;
      }
    }
  }

  // Meet the gate, or the guarantee is void.
  const gate = Math.max(round.exitFrom, Math.min(round.exitTo, x));
  for (let gx = Math.min(x, gate); gx <= Math.max(x, gate); gx++) {
    round.mines[gx] = 0;
    round.mines[cols + gx] = 0;
  }
}

/* -------------------------------------------------------------------- roster */

export function addPlayer(round, deviceId) {
  if (round.players.has(deviceId)) return round.players.get(deviceId);

  const p = {
    id: deviceId,
    x: round.level.cols / 2,
    z: round.level.rows - 0.5,
    dx: 0,
    dz: 0,
    heading: Math.PI,      // facing down the aisle, for the renderer
    legs: 2,
    state: ALIVE,
    stun: 0,
    lastPrintX: 0,
    lastPrintZ: 0,
    distance: 0,
    escapedAt: 0,

    /** Survival: when a saw last bit this player, so one brush cannot strip both legs. */
    sawHitAt: -99,
    /** Survival: seconds this player lasted. Frozen at the moment they go down. */
    survivedFor: 0,

    /**
     * This player's own emitter. Each carries its own phase, so pings are staggered around
     * the room rather than synchronised — two players standing together still light the
     * ground at different moments, and the overlap is information both of them can use.
     */
    ping: null,            // { r, x, z } while a ring is expanding, else null
    nextPingAt: 0,
    pingCount: 0,

    input: { up: false, down: false, left: false, right: false },

    /**
     * Analog stick, when the controller sends one. Held separately from the boolean input
     * rather than folded into it, because a stick carries a magnitude the four flags cannot
     * represent: pushing the thumb halfway must actually walk at half speed. `axis` is null
     * whenever no stick is engaged, which is what lets the two input styles coexist — see
     * the read in stepPlayer.
     */
    axis: null,            // { x, z } with hypot <= 1 while the stick is held, else null
  };
  round.players.set(deviceId, p);
  p.lastPrintX = p.x;
  p.lastPrintZ = p.z;
  return p;
}

export function removePlayer(round, deviceId) {
  round.players.delete(deviceId);
}

export function setInput(round, deviceId, key, value) {
  const p = round.players.get(deviceId);
  if (!p || !(key in p.input)) return;
  p.input[key] = !!value;
}

/**
 * Analog movement from a stick controller. Clamped here rather than trusted, because this
 * arrives straight off the wire: a magnitude above 1 would otherwise be a speed hack, and a
 * non-finite one would poison p.x/p.z into NaN for the rest of the round with no way back.
 *
 * A zero-length vector is stored as "no stick" rather than as a zero axis. The distinction
 * matters on the read side — null means the boolean flags still govern, so a controller that
 * centres its stick falls back cleanly instead of pinning the player in place.
 */
export function setAxis(round, deviceId, x, z) {
  const p = round.players.get(deviceId);
  if (!p) return;
  if (!Number.isFinite(x) || !Number.isFinite(z)) { p.axis = null; return; }

  const len = Math.hypot(x, z);
  if (len < 1e-3) { p.axis = null; return; }
  const scale = len > 1 ? 1 / len : 1;
  p.axis = { x: x * scale, z: z * scale };
}

export function clearInput(round, deviceId) {
  const p = round.players.get(deviceId);
  if (!p) return;
  p.input.up = p.input.down = p.input.left = p.input.right = false;
  p.axis = null;
}

/* ------------------------------------------------------------------ lifecycle */

export function startRound(round) {
  const survival = round.mode === MODE_SURVIVAL;

  round.phase = "running";
  round.t = 0;
  round.killerZ = round.level.rows + 1.2;
  round.killerX = round.level.cols / 2;
  round.exitUsed = 0;
  // Survival has no gate; leaving it open would light a doorway that leads nowhere.
  round.exitOpen = !survival;
  round.escapedOrder.length = 0;
  round.winner = null;
  round.prints.length = 0;

  round.roombas.length = 0;
  round.nextRoombaId = 1;
  round.wave = 0;
  round.lastStand = 0;
  round.downOrder.length = 0;
  round.nextWaveAt = survival ? round.level.waveEvery : Infinity;

  const ids = [...round.players.keys()].sort((a, b) => a - b);
  ids.forEach((id, i) => resetPlayer(round, round.players.get(id), i, ids.length));

  if (survival) {
    // The opening pack. Spawned on the rim looking inward, so the first thing anybody sees is
    // the room closing on them — a saw that has to cross the floor to reach you reads as
    // hunting, where one that starts adjacent just reads as unfair.
    for (let i = 0; i < round.level.startRoombas; i++) spawnRoomba(round, i);
  }

  round.events.push({ type: "start" });
}

function resetPlayer(round, p, index, total) {
  if (round.mode === MODE_SURVIVAL) {
    // A ring at the centre of the room, inside the guaranteed-clear circle. Everyone starts
    // equidistant from every wall because no direction is better than another here — the
    // aisle's staggered line would hand whoever spawned nearest open floor a real advantage.
    const r = Math.min(1.5, round.level.safeRadius - 1.1);
    const a = total <= 1 ? 0 : (index / total) * Math.PI * 2;
    p.x = round.level.cols / 2 + Math.cos(a) * r;
    p.z = round.level.rows / 2 + Math.sin(a) * r;
    // Facing outward, at whatever is coming.
    p.heading = Math.atan2(Math.cos(a), Math.sin(a));
  } else {
    // Spread the line across the aisle's width. In a narrow aisle everyone is close to
    // everyone, which is the point: your neighbour's light is nearly as useful as your own.
    const margin = 1.2;
    const usable = round.level.cols - margin * 2;
    p.x = total <= 1 ? margin + usable * 0.35
      : margin + (usable * index) / (total - 1);
    p.z = round.level.rows - 0.5;
    p.heading = Math.PI;
  }
  p.legs = 2;
  p.state = ALIVE;
  p.stun = 0;
  p.distance = 0;
  p.lastPrintX = p.x;
  p.lastPrintZ = p.z;
  p.ping = null;
  p.pingCount = 0;
  p.sawHitAt = -99;
  p.survivedFor = 0;

  // Stagger the first ping across the roster so the aisle does not strobe in unison. Each
  // player then runs free on their own period.
  p.nextPingAt = 0.3 + (index / Math.max(1, total)) * round.level.sonarPeriod;

  clearInput(round, p.id);
}

export function speedOf(p) {
  if (p.legs >= 2) return SPEED_WALK;
  if (p.legs === 1) return SPEED_LIMP;
  return SPEED_CRAWL;
}

/* ---------------------------------------------------------------------- step */

export function step(round, dt) {
  if (round.phase !== "running") return;

  round.t += dt;

  for (const p of round.players.values()) stepPing(round, p, dt);

  // The one branch in the loop. Escape has a press behind you; survival has machines on the
  // floor with you. Everything else — sonar, movement, mines, prints — is identical.
  if (round.mode === MODE_SURVIVAL) {
    stepWaves(round);
    stepRoombas(round, dt);
    for (const p of round.players.values()) {
      if (p.state === ALIVE) p.survivedFor = round.t;
    }
  } else {
    stepKiller(round, dt);
  }

  for (const p of round.players.values()) stepPlayer(round, p, dt);

  agePrints(round, dt);
  checkOver(round);
}

/**
 * Advance one player's personal ping.
 *
 * A dead or escaped player stops emitting — their light going out is how the rest of the
 * room finds out something happened to them, without the game ever saying so.
 */
function stepPing(round, p, dt) {
  const { level } = round;

  if (p.ping) {
    p.ping.r += level.sonarSpeed * dt;
    // Done once the ring has passed its radius and the last thing it lit has faded.
    if (p.ping.r > level.sonarRadius + level.sonarSpeed * level.sonarHold) p.ping = null;
  }

  if (p.state !== ALIVE) return;

  if (round.t >= p.nextPingAt) {
    p.nextPingAt = round.t + level.sonarPeriod;
    p.pingCount++;
    // The ring is emitted from where the player is standing *now* and stays anchored there,
    // so walking during a sweep does not drag the light along with you.
    p.ping = { r: 0, x: p.x, z: p.z };
    round.events.push({ type: "ping", id: p.id, x: p.x, z: p.z });
  }
}

/**
 * How lit a tile is right now, 0..1, considering every player's emitter.
 *
 * The renderer uses this; the sim never does. Brightness is the max over all pings rather
 * than a sum, so two overlapping lights do not blow out to white — but the union of their
 * coverage is strictly larger than either alone, which is the mechanical reason to walk near
 * someone else and the reason it is also the most dangerous place to be.
 */
export function tileReveal(round, x, z) {
  let best = 0;
  for (const p of round.players.values()) {
    const lit = tileRevealFor(round, p, x, z);
    if (lit > best) best = lit;
  }
  return best;
}

/** How lit a tile is by one specific player's emitter. */
export function tileRevealFor(round, p, x, z) {
  const ping = p.ping;
  if (!ping) return 0;

  const d = Math.hypot(x + 0.5 - ping.x, z + 0.5 - ping.z);
  if (d > round.level.sonarRadius) return 0;         // outside this lamp's reach, ever

  const passed = ping.r - d;
  if (passed < 0) return 0;                           // the ring has not arrived yet
  const held = passed / round.level.sonarSpeed;       // seconds since it crossed
  if (held > round.level.sonarHold) return 0;         // lit, and faded again

  // Fade toward the edge of the radius as well as over time, so the boundary of what you
  // can know is soft rather than a hard disc — a mine at the very limit is a hint, not a
  // fact, and that ambiguity is most of the dread.
  const edge = 1 - Math.pow(d / round.level.sonarRadius, 3);
  return (1 - held / round.level.sonarHold) * edge;
}

/**
 * The crusher: a full-width press that grinds up the aisle and never stops.
 *
 * It does not chase anybody. It spans the entire width of the aisle and kills whatever is at
 * its depth, so there is no dodging sideways and no benefit to being the least interesting
 * target in the room. The only defence is distance, which is exactly why losing legs is the
 * thing to be afraid of — a machine you cannot juke turns a limp into a countdown.
 *
 * Because it is a line rather than a pursuer, it is also completely predictable: players can
 * always know precisely how much time they have. The dread comes from the arithmetic, not
 * from wondering who it has picked.
 */
function stepKiller(round, dt) {
  const { level } = round;
  if (round.t < level.killerDelay) return;

  round.killerZ -= level.killerSpeed * dt;

  // The press sits across the middle of the aisle for rendering purposes only; nothing reads
  // killerX to decide a death.
  round.killerX = level.cols / 2;

  // It never grinds past the last living player. Without this it leaves the aisle entirely
  // and anyone hanging back at the spawn line is safe forever — the round could never end.
  let hindmost = -Infinity;
  for (const p of round.players.values()) {
    if (p.state === ALIVE && p.z > hindmost) hindmost = p.z;
  }
  if (isFinite(hindmost)) round.killerZ = Math.max(round.killerZ, hindmost - 0.35);

  // Anything at or behind the face of the press is crushed, whatever its x.
  for (const p of round.players.values()) {
    if (p.state !== ALIVE) continue;
    if (p.z >= round.killerZ - KILLER_CATCH_R) kill(round, p, "crusher");
  }
}

/* --------------------------------------------------------- survival: roombas */

/**
 * Put another saw on the floor, at the rim, facing in.
 *
 * They always enter from an edge rather than appearing wherever there is room. A machine that
 * materialises next to you is a dice roll; one that drives in from the wall is a thing you
 * saw coming and chose to ignore, which is the only kind of death this mode should hand out.
 */
function spawnRoomba(round, index) {
  const { level } = round;
  if (round.roombas.length >= level.maxRoombas) return null;

  // Walk the perimeter rather than picking at random, so a wave of three never arrives from
  // the same corner and pins everyone against one wall.
  const per = (index * 0.37 + Math.random() * 0.18) % 1;
  const side = Math.floor(per * 4);
  const along = (per * 4) % 1;
  const inset = 0.9;

  let x;
  let z;
  if (side === 0)      { x = inset + along * (level.cols - inset * 2); z = inset; }
  else if (side === 1) { x = level.cols - inset; z = inset + along * (level.rows - inset * 2); }
  else if (side === 2) { x = inset + along * (level.cols - inset * 2); z = level.rows - inset; }
  else                 { x = inset; z = inset + along * (level.rows - inset * 2); }

  const r = {
    id: round.nextRoombaId++,
    x,
    z,
    // Aimed at the middle of the room, which is where the players start and where they tend
    // to be pushed back to.
    heading: Math.atan2(level.cols / 2 - x, level.rows / 2 - z),
    target: null,
    stagger: 0,
    spin: Math.random() * Math.PI * 2,
    bornAt: round.t,
    // A little variation per unit so a pack never moves as one body.
    tempo: 0.88 + Math.random() * 0.28,
    wanderAt: round.t + 1.5 + Math.random() * 2,
  };
  round.roombas.push(r);
  round.events.push({ type: "roomba-spawn", id: r.id, x: r.x, z: r.z });
  return r;
}

/** Reinforcements, on a fixed clock, until the arena's cap. */
function stepWaves(round) {
  if (round.t < round.nextWaveAt) return;
  round.wave++;
  round.nextWaveAt = round.t + round.level.waveEvery;

  // Waves grow. A flat drip means the tenth minute plays exactly like the first, and this mode
  // has to end — the escalation is what turns "survive" into a score rather than a stalemate.
  const n = Math.min(1 + Math.floor(round.wave / 2), 3);
  let added = 0;
  for (let i = 0; i < n; i++) if (spawnRoomba(round, round.wave * 3 + i)) added++;
  if (added > 0) round.events.push({ type: "wave", wave: round.wave, added });
}

/**
 * Drive every machine one tick.
 *
 * The behaviour is deliberately simple and completely legible: pick the nearest living player
 * inside the sense radius, turn toward them at a fixed rate, drive forward. All the difficulty
 * comes from the turn rate being finite — a saw at full chase overshoots anyone who cuts
 * across its nose, so the counter-play is to stay close and keep turning rather than to run,
 * which is exactly the wrong instinct and the reason the mode is interesting.
 */
function stepRoombas(round, dt) {
  const { level } = round;

  for (const r of round.roombas) {
    // The blade keeps spinning even while the chassis is stalled — it is the thing that is
    // dangerous, and a saw that visibly stops looks safe when it is not.
    r.spin += dt * (r.stagger > 0 ? 6 : 13) * r.tempo;

    if (r.stagger > 0) {
      r.stagger -= dt;
      continue;
    }

    // Reacquire every tick: a machine that keeps chasing someone who has died, or who has run
    // out of its range, leaves the rest of the room unattended.
    r.target = nearestTarget(round, r);

    let wantHeading;
    let speed;
    if (r.target) {
      wantHeading = Math.atan2(r.target.x - r.x, r.target.z - r.z);
      speed = level.roombaChase * r.tempo;

      // A machine chasing someone on the floor eases off.
      //
      // Without this the mode has no legs economy at all: a crawler moves at 0.75 tiles/s and
      // a saw at full chase does well over 2, so the first leg you lose is simply death with
      // extra steps and every arena measured the same — ~3 hits landed per player, on a body
      // with two legs. Backing off to something a crawler can still work with turns a lost leg
      // into a bad position you might survive, which is the whole point of having legs.
      if (r.target.legs === 0) speed = Math.min(speed, SPEED_CRAWL * 1.12);
      else if (r.target.legs === 1) speed = Math.min(speed, SPEED_LIMP * 1.05);
    } else {
      // Nobody in reach: patrol. It re-picks a direction every few seconds instead of holding
      // one forever, so an idle saw sweeps the room rather than parking in a corner.
      if (round.t >= r.wanderAt) {
        r.wanderAt = round.t + 2 + Math.random() * 3;
        r.heading += (Math.random() - 0.5) * 2.2;
      }
      wantHeading = r.heading;
      speed = level.roombaSpeed * r.tempo;
    }

    r.heading = turnToward(r.heading, wantHeading, ROOMBA_TURN * dt);

    const vx = Math.sin(r.heading);
    const vz = Math.cos(r.heading);
    let nx = r.x + vx * speed * dt;
    let nz = r.z + vz * speed * dt;

    // Bounce off the walls. Reflecting the heading rather than merely clamping matters: a
    // clamped machine grinds along the wall indefinitely and stops being a threat, and the
    // wall is exactly where a cornered player is.
    const lo = ROOMBA_R;
    const hiX = level.cols - ROOMBA_R;
    const hiZ = level.rows - ROOMBA_R;
    let bounced = false;
    if (nx < lo || nx > hiX) {
      nx = Math.max(lo, Math.min(hiX, nx));
      r.heading = -r.heading;
      bounced = true;
    }
    if (nz < lo || nz > hiZ) {
      nz = Math.max(lo, Math.min(hiZ, nz));
      r.heading = Math.PI - r.heading;
      bounced = true;
    }
    if (bounced) r.wanderAt = round.t + 1.2;

    r.x = nx;
    r.z = nz;

    roombaMine(round, r);
    sawPlayers(round, r);
  }
}

/** The nearest living player within this machine's sense radius, or null. */
function nearestTarget(round, r) {
  const reach = round.level.roombaSense;
  let best = null;
  let bestD = reach * reach;
  for (const p of round.players.values()) {
    if (p.state !== ALIVE) continue;
    const dx = p.x - r.x;
    const dz = p.z - r.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Rotate `from` toward `to` by at most `max` radians, the short way around. */
function turnToward(from, to, max) {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return from + Math.max(-max, Math.min(max, diff));
}

/**
 * A machine rolling over a mine sets it off, and is stalled by the blast.
 *
 * This is the mode's central bargain. The saws are the only thing that can clear the floor,
 * so the ground you want to be standing on later is ground you have to lead one of them
 * across now — and the stall is the reward for doing it, a second and a half of free room
 * bought by putting yourself in front of a saw on purpose.
 */
function roombaMine(round, r) {
  const { cols } = round.level;
  const tx = Math.floor(r.x);
  const tz = Math.floor(r.z);
  if (tx < 0 || tz < 0 || tx >= round.level.cols || tz >= round.level.rows) return;

  const i = tz * cols + tx;
  if (round.mines[i] !== 1) return;
  if (Math.hypot(r.x - (tx + 0.5), r.z - (tz + 0.5)) > MINE_TRIGGER_R + ROOMBA_R) return;

  round.mines[i] = 0;
  round.exploded[i] = 1;
  r.stagger = ROOMBA_STAGGER;
  // Thrown back the way it came, so the blast visibly costs it ground.
  r.x -= Math.sin(r.heading) * 0.7;
  r.z -= Math.cos(r.heading) * 0.7;
  r.heading += Math.PI + (Math.random() - 0.5) * 0.8;
  r.target = null;

  round.events.push({
    type: "blast", x: tx + 0.5, z: tz + 0.5, id: null, legsLost: 0, legs: 2, roomba: r.id,
  });
}

/** Anything alive touching the blade loses a leg — once per cooldown, per machine. */
function sawPlayers(round, r) {
  for (const p of round.players.values()) {
    if (p.state !== ALIVE) continue;
    if (round.t - p.sawHitAt < SAW_COOLDOWN) continue;
    if (Math.hypot(p.x - r.x, p.z - r.z) > SAW_HIT_R) continue;

    p.sawHitAt = round.t;
    const before = p.legs;
    p.legs = Math.max(0, p.legs - 1);
    round.events.push({
      type: "saw", id: p.id, roomba: r.id, x: p.x, z: p.z, legs: p.legs,
    });

    if (before === 0) {
      down(round, p, "saw");
      continue;
    }

    // Knocked clear, so a single contact cannot become a grind against a machine that is
    // still driving into you. Shorter than a mine's throw — this is a shove, not a blast.
    p.stun = 0.45;
    const away = Math.hypot(p.x - r.x, p.z - r.z) || 1;
    p.x = Math.max(0.32, Math.min(round.level.cols - 0.32, p.x + ((p.x - r.x) / away) * 0.85));
    p.z = Math.max(0.32, Math.min(round.level.rows - 0.32, p.z + ((p.z - r.z) / away) * 0.85));
  }
}

/** Record the order people go down in, so the results can rank by how long each lasted. */
function down(round, p, cause) {
  if (p.state !== ALIVE) return;
  p.survivedFor = round.t;
  round.downOrder.push(p.id);
  kill(round, p, cause);
}

/** How many machines are on the floor. Read by the HUD. */
export function roombaCount(round) {
  return round.roombas.length;
}

function stepPlayer(round, p, dt) {
  if (p.state !== ALIVE) return;

  if (p.stun > 0) {
    p.stun -= dt;
    p.dx = 0;
    p.dz = 0;
    return;
  }

  let vx;
  let vz;
  let throttle;

  if (p.axis) {
    // The stick already carries direction *and* magnitude, so it is used as-is. Normalising
    // it the way the buttons are normalised would quantise every partial push back up to
    // full speed and throw away the only thing the stick adds over four flags.
    vx = p.axis.x;
    vz = p.axis.z;
    throttle = Math.min(1, Math.hypot(vx, vz));
    if (throttle < 1e-3) { p.dx = 0; p.dz = 0; return; }
    vx /= throttle;
    vz /= throttle;
  } else {
    vx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    // "up" is toward the gate, which is toward *lower* z.
    vz = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
    if (vx === 0 && vz === 0) { p.dx = 0; p.dz = 0; return; }

    const len = Math.hypot(vx, vz);
    vx /= len;
    vz /= len;
    // A pressed button is always full commitment; only the stick can ask for less.
    throttle = 1;
  }

  const speed = speedOf(p) * throttle;
  p.dx = vx * speed;
  p.dz = vz * speed;
  p.heading = Math.atan2(vx, vz);

  // Interpolate from the position held *before* the move: moveTo writes p.x/p.z on every
  // sub-step, so re-reading them each iteration would shrink the remaining distance
  // geometrically and leave the player short of where they were going.
  const fromX = p.x;
  const fromZ = p.z;
  const nx = fromX + p.dx * dt;
  const nz = fromZ + p.dz * dt;

  // Sub-step so a fast player cannot tunnel past a mine between frames.
  const dist = Math.hypot(nx - fromX, nz - fromZ);
  const steps = Math.max(1, Math.ceil(dist / 0.12));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!moveTo(round, p, fromX + (nx - fromX) * t, fromZ + (nz - fromZ) * t)) return;
  }

  dropPrint(round, p, dist);
}

/** Returns false if the move must stop — died, escaped, or thrown by a blast. */
function moveTo(round, p, x, z) {
  const { cols, rows } = round.level;

  // The aisle walls. Only the gate at the far end is a way out.
  p.x = Math.max(0.32, Math.min(cols - 0.32, x));

  const tileX = Math.floor(p.x);
  const inGate = tileX >= round.exitFrom && tileX <= round.exitTo;

  // Stepping into the gate tile is the escape — not a hairline at the very edge of it.
  if (z < 1 && inGate && round.exitOpen) {
    p.z = Math.max(0.2, z);
    escape(round, p);
    return false;
  }

  if (z < 0.32) {
    p.z = 0.32;
    return true;
  }
  p.z = Math.min(rows - 0.32, z);

  return !checkMine(round, p);
}

function checkMine(round, p) {
  const { cols } = round.level;
  const tx = Math.floor(p.x);
  const tz = Math.floor(p.z);
  const i = tz * cols + tx;
  if (round.mines[i] !== 1) return false;

  // Only the centre of the tile is the pressure plate, so skirting a known mine is a real,
  // if nervous, option.
  if (Math.hypot(p.x - (tx + 0.5), p.z - (tz + 0.5)) > MINE_TRIGGER_R + 0.14) return false;

  round.mines[i] = 0;
  round.exploded[i] = 1;
  detonate(round, p, tx, tz);
  return true;
}

/**
 * An explosion takes legs, not lives — usually. One leg is a limp, both is a crawl, and a
 * blast while already crawling finishes the job. The punishment for a mine is that the thing
 * behind you stops being survivable.
 */
function detonate(round, p, tx, tz) {
  const both = Math.random() < 0.34;
  const lost = both ? 2 : 1;
  const before = p.legs;
  p.legs = Math.max(0, p.legs - lost);

  round.events.push({
    type: "blast",
    x: tx + 0.5,
    z: tz + 0.5,
    id: p.id,
    legsLost: Math.min(lost, before),
    legs: p.legs,
  });

  if (before === 0) {
    // In survival the order people go down in *is* the scoreboard, so a mine death has to be
    // recorded the same way a saw death is.
    if (round.mode === MODE_SURVIVAL) down(round, p, "mine");
    else kill(round, p, "mine");
    return;
  }

  p.stun = BLAST_STUN;

  // Thrown clear of the crater, so the player is not left standing on the tile they just
  // triggered.
  const away = Math.hypot(p.x - (tx + 0.5), p.z - (tz + 0.5)) || 1;
  p.x = Math.max(0.32, Math.min(round.level.cols - 0.32, p.x + ((p.x - (tx + 0.5)) / away) * 0.55));
  p.z = Math.max(0.32, Math.min(round.level.rows - 0.32, p.z + ((p.z - (tz + 0.5)) / away) * 0.55));
}

function kill(round, p, cause) {
  if (p.state !== ALIVE) return;
  p.state = DEAD;
  p.dx = p.dz = 0;
  p.ping = null;         // the light goes out
  round.events.push({ type: "death", id: p.id, cause, x: p.x, z: p.z });
}

function escape(round, p) {
  p.state = ESCAPED;
  p.escapedAt = round.t;
  p.ping = null;
  round.escapedOrder.push(p.id);
  round.exitUsed++;
  round.events.push({ type: "escape", id: p.id, x: p.x, z: p.z, place: round.escapedOrder.length });

  if (round.exitUsed >= round.level.exitCapacity) {
    round.exitOpen = false;
    round.events.push({ type: "gate-closed" });
  }
}

/* ---------------------------------------------------------------- footprints */

/**
 * Footprints are the only navigation aid that persists between pings, and with per-player
 * sonar they are the whole social mechanic: they are the only way to learn about ground your
 * own light never reached. They are deliberately not marked safe or unsafe.
 */
function dropPrint(round, p, dist) {
  p.distance += dist;
  if (Math.hypot(p.x - p.lastPrintX, p.z - p.lastPrintZ) < PRINT_SPACING) return;

  p.lastPrintX = p.x;
  p.lastPrintZ = p.z;
  round.prints.push({ x: p.x, z: p.z, id: p.id, age: 0, crawl: p.legs === 0 });

  if (round.prints.length > 900) round.prints.splice(0, round.prints.length - 900);
}

function agePrints(round, dt) {
  for (const print of round.prints) print.age += dt;
  while (round.prints.length && round.prints[0].age > PRINT_LIFE) round.prints.shift();
}

/* --------------------------------------------------------------------- over */

function checkOver(round) {
  if (round.phase !== "running") return;
  if (round.players.size === 0) return;

  let stillPlaying = 0;
  let lastAlive = null;
  for (const p of round.players.values()) {
    if (p.state === ALIVE) { stillPlaying++; lastAlive = p; }
  }

  if (round.mode === MODE_SURVIVAL) {
    // Survival ends when there is nobody left to hunt, or one person left to hunt with nobody
    // to hunt them for. A solo game is the exception: with one player seated there is no "last
    // one standing" to reach, so it runs until that player is down.
    const contested = countContenders(round) > 1;
    if (stillPlaying > (contested ? 1 : 0)) return;

    round.phase = "over";
    round.lastStand = round.t;
    if (lastAlive) {
      // Whoever is still standing when the music stops. Their clock keeps running to the end.
      lastAlive.survivedFor = round.t;
      round.winner = lastAlive.id;
    } else {
      // Everybody died. The winner is whoever lasted longest — the last name pushed onto
      // downOrder, since that list is built in the order people went down.
      round.winner = round.downOrder.length
        ? round.downOrder[round.downOrder.length - 1] : null;
    }
    round.events.push({
      type: "over",
      survival: true,
      winner: round.winner,
      lastStand: round.lastStand,
      wave: round.wave,
    });
    return;
  }

  if (stillPlaying > 0) return;

  round.phase = "over";
  round.winner = round.escapedOrder.length ? round.escapedOrder[0] : null;
  round.events.push({ type: "over", escaped: [...round.escapedOrder], winner: round.winner });
}

/** Players who actually took part this round — spectators do not count toward "last standing". */
function countContenders(round) {
  let n = 0;
  for (const p of round.players.values()) if (p.state !== WAITING) n++;
  return n;
}

/**
 * Everyone who took part, ranked by how long they lasted. The survivor first, then the fallen
 * in reverse order of going down.
 */
export function survivalRanking(round) {
  const out = [];
  for (const p of round.players.values()) {
    if (p.state === WAITING) continue;
    out.push({ id: p.id, time: p.survivedFor, alive: p.state === ALIVE });
  }
  out.sort((a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0) || b.time - a.time);
  return out;
}

export function survivors(round) {
  return round.escapedOrder.length;
}

/* --------------------------------------------------------------- inspection */

export function mineAt(round, tx, tz) {
  if (tx < 0 || tz < 0 || tx >= round.level.cols || tz >= round.level.rows) return 0;
  return round.mines[tz * round.level.cols + tx];
}

export function craterAt(round, tx, tz) {
  if (tx < 0 || tz < 0 || tx >= round.level.cols || tz >= round.level.rows) return 0;
  return round.exploded[tz * round.level.cols + tx];
}
