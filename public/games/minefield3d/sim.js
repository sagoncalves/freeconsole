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

import { getLevel } from "/games/minefield3d/levels.js?v=2";

/* ------------------------------------------------------------------ constants */

const MINE_TRIGGER_R = 0.36;
const KILLER_CATCH_R = 0.55;

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

export function createRound(levelIndex, seed) {
  const level = getLevel(levelIndex);
  const round = {
    level,
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
  };

  generateField(round);
  return round;
}

function generateField(round) {
  const { level } = round;
  round.mines = new Uint8Array(level.cols * level.rows);
  round.exploded = new Uint8Array(level.cols * level.rows);

  const rng = makeRng(round.seed);

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

    /**
     * This player's own emitter. Each carries its own phase, so pings are staggered around
     * the room rather than synchronised — two players standing together still light the
     * ground at different moments, and the overlap is information both of them can use.
     */
    ping: null,            // { r, x, z } while a ring is expanding, else null
    nextPingAt: 0,
    pingCount: 0,

    input: { up: false, down: false, left: false, right: false },
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

export function clearInput(round, deviceId) {
  const p = round.players.get(deviceId);
  if (!p) return;
  p.input.up = p.input.down = p.input.left = p.input.right = false;
}

/* ------------------------------------------------------------------ lifecycle */

export function startRound(round) {
  round.phase = "running";
  round.t = 0;
  round.killerZ = round.level.rows + 1.2;
  round.killerX = round.level.cols / 2;
  round.exitUsed = 0;
  round.exitOpen = true;
  round.escapedOrder.length = 0;
  round.winner = null;
  round.prints.length = 0;

  const ids = [...round.players.keys()].sort((a, b) => a - b);
  ids.forEach((id, i) => resetPlayer(round, round.players.get(id), i, ids.length));
  round.events.push({ type: "start" });
}

function resetPlayer(round, p, index, total) {
  // Spread the line across the aisle's width. In a narrow aisle everyone is close to
  // everyone, which is the point: your neighbour's light is nearly as useful as your own.
  const margin = 1.2;
  const usable = round.level.cols - margin * 2;
  p.x = total <= 1 ? margin + usable * 0.35
    : margin + (usable * index) / (total - 1);
  p.z = round.level.rows - 0.5;
  p.legs = 2;
  p.state = ALIVE;
  p.stun = 0;
  p.distance = 0;
  p.heading = Math.PI;
  p.lastPrintX = p.x;
  p.lastPrintZ = p.z;
  p.ping = null;
  p.pingCount = 0;

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
  stepKiller(round, dt);
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

function stepPlayer(round, p, dt) {
  if (p.state !== ALIVE) return;

  if (p.stun > 0) {
    p.stun -= dt;
    p.dx = 0;
    p.dz = 0;
    return;
  }

  let vx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
  // "up" is toward the gate, which is toward *lower* z.
  let vz = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
  if (vx === 0 && vz === 0) { p.dx = 0; p.dz = 0; return; }

  const len = Math.hypot(vx, vz);
  vx /= len;
  vz /= len;

  const speed = speedOf(p);
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
    kill(round, p, "mine");
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
  for (const p of round.players.values()) if (p.state === ALIVE) stillPlaying++;
  if (stillPlaying > 0) return;

  round.phase = "over";
  round.winner = round.escapedOrder.length ? round.escapedOrder[0] : null;
  round.events.push({ type: "over", escaped: [...round.escapedOrder], winner: round.winner });
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
