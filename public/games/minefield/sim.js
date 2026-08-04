/**
 * Minefield Escape — headless simulation.
 *
 * The screen owns this. Controllers send held directions and nothing else; no phone ever
 * asserts a position, a step, or a death. Everything here is deterministic given the same
 * seed and the same input stream, which is what makes the sim reloadable under ?test=1.
 *
 * Units: tiles for space, seconds for time. The origin is the top-left of the field, y grows
 * downward, and players walk from the bottom edge toward the gate at the top.
 */

import { getLevel } from "/games/minefield/levels.js?v=1";

/* ------------------------------------------------------------------ constants */

/** How close two things must be, in tiles, to count as touching. */
const MINE_TRIGGER_R = 0.36;
const KILLER_CATCH_R = 0.55;

/** Movement, in tiles per second. Losing legs is a heavy tax — that is the whole tension. */
export const SPEED_WALK = 3.1;
export const SPEED_LIMP = 1.65;   // one leg
export const SPEED_CRAWL = 0.78;  // no legs

/** Seconds a player is stunned after an explosion, unable to move at all. */
const BLAST_STUN = 1.1;

/** Footprints older than this fade out entirely. Long enough to follow, short enough to lie. */
export const PRINT_LIFE = 26;

/** Distance a player must travel before dropping the next footprint. */
const PRINT_SPACING = 0.55;

export const ALIVE = "alive";
export const DEAD = "dead";
export const ESCAPED = "escaped";

/* ----------------------------------------------------------------------- rng */

/**
 * Mulberry32. The field must be identical on every device that draws it, and the screen is
 * the only one that generates it, but a seeded rng also means a round can be reproduced
 * exactly from its seed when something goes wrong.
 */
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

/**
 * Build a round. Players are added separately, because the roster is whatever walked into
 * the room and the field has to exist before anyone stands on it.
 */
export function createRound(levelIndex, seed) {
  const level = getLevel(levelIndex);
  const round = {
    level,
    levelIndex: levelIndex | 0,
    seed: seed >>> 0,
    phase: "briefing",       // briefing -> running -> over
    t: 0,                    // seconds since the round started running
    players: new Map(),      // deviceId -> player
    prints: [],              // footprints, oldest first
    events: [],              // drained by the renderer each frame
    mines: null,             // Uint8Array, cols * rows
    exploded: null,          // Uint8Array — a blown mine leaves a crater and never re-arms
    cols: level.cols,
    rows: level.rows,
    exitFrom: 0,
    exitTo: 0,
    exitUsed: 0,
    exitOpen: true,
    killerY: -1.5,
    killerX: 0,
    sonar: null,             // { r, age } while a ring is expanding, else null
    nextSonarAt: 0,
    pulseCount: 0,
    escapedOrder: [],        // deviceIds in the order they made it through
    winner: null,
  };

  generateField(round);
  return round;
}

/**
 * Lay the mines. The bottom `safeRows` are clear so nobody dies on spawn, and the gate mouth
 * itself is clear so the last step is a decision rather than a coin flip.
 */
function generateField(round) {
  const { level } = round;
  const n = level.cols * level.rows;
  round.mines = new Uint8Array(n);
  round.exploded = new Uint8Array(n);

  const rng = makeRng(round.seed);

  // Gate: a run of tiles centred on the top edge.
  const halfGate = Math.floor(level.exitWidth / 2);
  const centre = Math.floor(level.cols / 2);
  round.exitFrom = Math.max(0, centre - halfGate);
  round.exitTo = Math.min(level.cols - 1, round.exitFrom + level.exitWidth - 1);

  for (let y = 0; y < level.rows; y++) {
    // Spawn strip at the bottom stays clear.
    if (y >= level.rows - level.safeRows) continue;
    // The mouth of the gate stays clear.
    if (y === 0) continue;

    for (let x = 0; x < level.cols; x++) {
      if (rng() < level.mineDensity) round.mines[y * level.cols + x] = 1;
    }
  }

  // Guarantee at least one mine-free path exists. Without this a bad seed can wall the field
  // off completely and the round becomes unwinnable in a way that reads as a bug, not as
  // difficulty. Carve a wandering corridor from the gate down to the spawn strip.
  carveEscapeRoute(round, rng);
}

/**
 * Walk a single-tile corridor from the gate to the spawn strip, clearing as it goes.
 *
 * It is carved from the bottom upward, starting at a random column rather than under the
 * gate, and wanders aggressively on the way. Both matter: a corridor that starts at the gate
 * column ends up directly under the spawn point — players spawn centred and the gate is
 * centred — which hands every player a straight, mine-free walk and makes the sonar
 * pointless. The route must exist; it must not be the route anyone is already standing on.
 */
function carveEscapeRoute(round, rng) {
  const { cols, rows } = round.level;
  let x = Math.floor(rng() * cols);

  for (let y = rows - 1; y >= 0; y--) {
    round.mines[y * cols + x] = 0;

    // Wander hard, and keep wandering: several sideways moves per row, each clearing the
    // tile it crosses so the corridor stays connected.
    const drift = 1 + Math.floor(rng() * 3);
    for (let d = 0; d < drift; d++) {
      if (rng() < 0.55) {
        const dir = rng() < 0.5 ? -1 : 1;
        const nx = Math.max(0, Math.min(cols - 1, x + dir));
        round.mines[y * cols + nx] = 0;
        x = nx;
      }
    }
  }

  // The corridor has to actually meet the gate, or the guarantee is void. Clear the last
  // stretch across row 0 from wherever the walk finished to the nearest gate tile.
  const gate = Math.max(round.exitFrom, Math.min(round.exitTo, x));
  for (let gx = Math.min(x, gate); gx <= Math.max(x, gate); gx++) {
    round.mines[gx] = 0;
    round.mines[cols + gx] = 0;   // and the row below it, so the approach is walkable
  }
}

/* -------------------------------------------------------------------- roster */

export function addPlayer(round, deviceId) {
  if (round.players.has(deviceId)) return round.players.get(deviceId);

  // A provisional spot on the bottom edge. startRound re-seats the whole line once the
  // roster is known, so this only has to be somewhere sane and inside the field.
  const p = {
    id: deviceId,
    x: 1.5 + (round.level.cols - 3) * 0.28,
    y: round.level.rows - 0.5,
    dx: 0,
    dy: 0,
    facing: -1,            // -1 up, 1 down; only used for drawing
    legs: 2,
    state: ALIVE,
    stun: 0,
    lastPrintX: 0,
    lastPrintY: 0,
    distance: 0,           // tiles travelled, for footprint spacing
    escapedAt: 0,
    input: { up: false, down: false, left: false, right: false },
  };
  round.players.set(deviceId, p);
  p.lastPrintX = p.x;
  p.lastPrintY = p.y;
  return p;
}

export function removePlayer(round, deviceId) {
  round.players.delete(deviceId);
}

/** Held direction from a controller. Never a position — phones do not move anyone directly. */
export function setInput(round, deviceId, key, value) {
  const p = round.players.get(deviceId);
  if (!p || !(key in p.input)) return;
  p.input[key] = !!value;
}

/** Drop everything a device is holding. Used on reconnect and on a backgrounded phone. */
export function clearInput(round, deviceId) {
  const p = round.players.get(deviceId);
  if (!p) return;
  p.input.up = p.input.down = p.input.left = p.input.right = false;
}

/* ------------------------------------------------------------------ lifecycle */

export function startRound(round) {
  round.phase = "running";
  round.t = 0;
  round.nextSonarAt = 0.35;      // a first pulse almost immediately, so nobody walks blind
  round.pulseCount = 0;
  round.sonar = null;
  // The killer comes from behind, below the spawn strip, and walks toward the gate. Players
  // move in -y; so does it, just slower.
  round.killerY = round.level.rows + 1.2;
  round.killerX = round.level.cols / 2;
  round.exitUsed = 0;
  round.exitOpen = true;
  round.escapedOrder.length = 0;
  round.winner = null;
  round.prints.length = 0;

  for (const p of round.players.values()) resetPlayer(round, p);
  round.events.push({ type: "start" });
}

function resetPlayer(round, p) {
  const ids = [...round.players.keys()].sort((a, b) => a - b);
  const index = Math.max(0, ids.indexOf(p.id));

  // Spread the line across most of the field rather than bunching it at the centre. A single
  // player spawning dead-centre would start on the gate's own column, which is the shortest
  // and least interesting crossing on the board.
  const margin = 1.5;
  const usable = round.level.cols - margin * 2;
  p.x = ids.length === 1
    ? margin + usable * 0.28
    : margin + (usable * index) / (ids.length - 1);
  p.y = round.level.rows - 0.5;
  p.legs = 2;
  p.state = ALIVE;
  p.stun = 0;
  p.distance = 0;
  p.facing = -1;
  p.lastPrintX = p.x;
  p.lastPrintY = p.y;
  clearInput(round, p.id);
}

/** Speed for the legs a player still has. */
export function speedOf(p) {
  if (p.legs >= 2) return SPEED_WALK;
  if (p.legs === 1) return SPEED_LIMP;
  return SPEED_CRAWL;
}

/* ---------------------------------------------------------------------- step */

export function step(round, dt) {
  if (round.phase !== "running") return;

  round.t += dt;

  stepSonar(round, dt);
  stepKiller(round, dt);

  for (const p of round.players.values()) stepPlayer(round, p, dt);

  agePrints(round, dt);
  checkOver(round);
}

/**
 * The sonar is a ring, not a flash. It leaves the killer's edge and sweeps down the field, so
 * mines near you resolve first and the far end of the field is still dark when you have to
 * commit. Each mine remembers when the ring touched it and fades from there.
 */
function stepSonar(round, dt) {
  const { level } = round;

  if (round.sonar) {
    round.sonar.r += level.sonarSpeed * dt;
    round.sonar.age += dt;
    // The ring is done once it has crossed the far corner and the last mine it lit has faded.
    const reach = Math.hypot(level.cols, level.rows) + 1;
    if (round.sonar.r > reach + level.sonarSpeed * level.sonarHold) round.sonar = null;
  }

  if (round.t >= round.nextSonarAt) {
    round.nextSonarAt = round.t + level.sonarPeriod;
    round.pulseCount++;
    // The pulse originates from the killer — it is the thing sweeping the field, which is why
    // the field lights up from behind you and why the light itself is bad news.
    round.sonar = { r: 0, age: 0, x: round.killerX, y: round.killerY };
    round.events.push({ type: "pulse", x: round.killerX, y: round.killerY });
  }
}

/**
 * How lit a tile is right now, 0..1. The renderer uses this directly; the sim never does.
 * A tile is brightest as the ring crosses it and decays over sonarHold seconds after.
 */
export function tileReveal(round, x, y) {
  const s = round.sonar;
  if (!s) return 0;
  const d = Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y);
  const passed = s.r - d;
  if (passed < 0) return 0;                                   // ring has not arrived
  const held = passed / round.level.sonarSpeed;               // seconds since it crossed
  if (held > round.level.sonarHold) return 0;                 // faded again
  return 1 - held / round.level.sonarHold;
}

/** The killer walks up the field at a constant rate and never stops. */
function stepKiller(round, dt) {
  const { level } = round;
  if (round.t < level.killerDelay) return;

  round.killerY -= level.killerSpeed * dt;

  // It drifts toward whoever is furthest behind — the straggler is always the one it reaches
  // first, which is what makes a lost leg terrifying rather than merely slow.
  let target = null;
  for (const p of round.players.values()) {
    if (p.state !== ALIVE) continue;
    if (!target || p.y > target.y) target = p;
  }
  if (target) {
    const dx = target.x - round.killerX;
    round.killerX += Math.sign(dx) * Math.min(Math.abs(dx), level.killerSpeed * 0.75 * dt);

    // It never gets ahead of the last living player. Without this it simply walks off the top
    // of the field and anyone who hangs back at the spawn line is safe forever — the round
    // can then never end. It is a line the field is being swept up to, not a racer.
    round.killerY = Math.max(round.killerY, target.y - 0.35);
  }

  for (const p of round.players.values()) {
    if (p.state !== ALIVE) continue;
    if (Math.hypot(p.x - round.killerX, p.y - round.killerY) < KILLER_CATCH_R) {
      kill(round, p, "killer");
    }
  }
}

function stepPlayer(round, p, dt) {
  if (p.state !== ALIVE) return;

  if (p.stun > 0) {
    p.stun -= dt;
    p.dx = 0;
    p.dy = 0;
    return;
  }

  let vx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
  let vy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
  if (vx === 0 && vy === 0) { p.dx = 0; p.dy = 0; return; }

  // Normalise so diagonals are not a free speed boost — crossing the field diagonally must
  // cost the same as crossing it in two moves.
  const len = Math.hypot(vx, vy);
  vx /= len;
  vy /= len;

  const speed = speedOf(p);
  p.dx = vx * speed;
  p.dy = vy * speed;
  if (vy !== 0) p.facing = Math.sign(vy);

  // Walk the movement in small steps and test each one, so a fast player cannot tunnel past
  // a mine between frames. At walk speed a single frame can cross a fifth of a tile; a mine
  // is smaller than that.
  //
  // The interpolation must run from the position held *before* the move, captured here:
  // moveTo writes p.x/p.y on every sub-step, so re-reading them each iteration would shrink
  // the remaining distance geometrically and leave the player short of where they were
  // going. That is what stopped players just inside the gate instead of through it.
  const fromX = p.x;
  const fromY = p.y;
  const nx = fromX + p.dx * dt;
  const ny = fromY + p.dy * dt;

  const dist = Math.hypot(nx - fromX, ny - fromY);
  const steps = Math.max(1, Math.ceil(dist / 0.12));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const sx = fromX + (nx - fromX) * t;
    const sy = fromY + (ny - fromY) * t;
    if (!moveTo(round, p, sx, sy)) return;   // died or lost legs; the rest of the move is void
  }

  dropPrint(round, p, dist);
}

/**
 * Place the player at one sub-step and resolve whatever is there. Returns false if the move
 * must stop — the player died, escaped, or was thrown by a blast.
 */
function moveTo(round, p, x, y) {
  const { cols, rows } = round.level;

  // The field edges are a fence. Only the gate at the top is a way out.
  p.x = Math.max(0.32, Math.min(cols - 0.32, x));

  // Stepping into the gate tile is the escape — the whole of row 0 between exitFrom and
  // exitTo counts, not a hairline at the very top of it. Requiring the player to reach some
  // exact y inside that tile is invisible on screen and leaves them jammed in the doorway.
  const tileX = Math.floor(p.x);
  const inGateColumn = tileX >= round.exitFrom && tileX <= round.exitTo;

  if (y < 1 && inGateColumn && round.exitOpen) {
    p.y = Math.max(0.2, y);
    escape(round, p);
    return false;
  }

  // Anywhere else along the top edge — including the gate once it has shut — is a wall.
  if (y < 0.32) {
    p.y = 0.32;
    return true;
  }
  p.y = Math.min(rows - 0.32, y);

  return !checkMine(round, p);
}

/** True if a mine went off under this player. */
function checkMine(round, p) {
  const { cols } = round.level;
  const tx = Math.floor(p.x);
  const ty = Math.floor(p.y);
  const i = ty * cols + tx;
  if (round.mines[i] !== 1) return false;

  // Only the centre of the tile is actually the pressure plate, so hugging the edge of a
  // known mine is a real, if nervous, option.
  if (Math.hypot(p.x - (tx + 0.5), p.y - (ty + 0.5)) > MINE_TRIGGER_R + 0.14) return false;

  round.mines[i] = 0;
  round.exploded[i] = 1;
  detonate(round, p, tx, ty);
  return true;
}

/**
 * An explosion takes legs, not lives — usually. One leg is a limp, both is a crawl, and a
 * third blast finishes the job. Losing a leg is worse than dying quickly, because the killer
 * is still walking and now you cannot outrun it.
 */
function detonate(round, p, tx, ty) {
  const both = Math.random() < 0.34;
  const lost = both ? 2 : 1;
  const before = p.legs;
  p.legs = Math.max(0, p.legs - lost);

  round.events.push({
    type: "blast",
    x: tx + 0.5,
    y: ty + 0.5,
    id: p.id,
    legsLost: Math.min(lost, before),
    legs: p.legs,
  });

  if (before === 0) {
    // Already crawling and stepped on another one. Nothing left to take.
    kill(round, p, "mine");
    return;
  }

  p.stun = BLAST_STUN;

  // Thrown clear of the crater, so the player is not left standing on the tile they just
  // triggered and cannot re-trigger the same spot on the next frame.
  const away = Math.hypot(p.x - (tx + 0.5), p.y - (ty + 0.5)) || 1;
  p.x = Math.max(0.32, Math.min(round.level.cols - 0.32, p.x + ((p.x - (tx + 0.5)) / away) * 0.55));
  p.y = Math.max(0.32, Math.min(round.level.rows - 0.32, p.y + ((p.y - (ty + 0.5)) / away) * 0.55));
}

function kill(round, p, cause) {
  if (p.state !== ALIVE) return;
  p.state = DEAD;
  p.dx = p.dy = 0;
  round.events.push({ type: "death", id: p.id, cause, x: p.x, y: p.y });
}

function escape(round, p) {
  p.state = ESCAPED;
  p.escapedAt = round.t;
  round.escapedOrder.push(p.id);
  round.exitUsed++;
  round.events.push({ type: "escape", id: p.id, place: round.escapedOrder.length });

  if (round.exitUsed >= round.level.exitCapacity) {
    round.exitOpen = false;
    round.events.push({ type: "gate-closed" });
  }
}

/* ---------------------------------------------------------------- footprints */

/**
 * Footprints are the only navigation aid that persists between pulses, and they are the whole
 * social mechanic: a trail means someone crossed here and lived — right up until it means
 * someone crossed here and did not. They are deliberately not marked safe or unsafe.
 */
function dropPrint(round, p, dist) {
  p.distance += dist;
  if (Math.hypot(p.x - p.lastPrintX, p.y - p.lastPrintY) < PRINT_SPACING) return;

  p.lastPrintX = p.x;
  p.lastPrintY = p.y;
  round.prints.push({
    x: p.x,
    y: p.y,
    id: p.id,
    age: 0,
    crawl: p.legs === 0,
  });

  // Hard cap. A long round with six players can otherwise accumulate thousands of prints and
  // the draw loop starts costing more than the sim.
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

  // A player who is alive but can never reach a closed gate is not playing any more; the
  // killer will resolve them shortly, and the round ending here would rob them of the run.
  if (stillPlaying > 0) return;

  round.phase = "over";
  round.winner = round.escapedOrder.length ? round.escapedOrder[0] : null;
  round.events.push({
    type: "over",
    escaped: [...round.escapedOrder],
    winner: round.winner,
  });
}

/** Everyone out or dead, used by the screen to decide when to offer the next level. */
export function survivors(round) {
  return round.escapedOrder.length;
}

/* --------------------------------------------------------------- inspection */

export function mineAt(round, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= round.level.cols || ty >= round.level.rows) return 0;
  return round.mines[ty * round.level.cols + tx];
}

export function craterAt(round, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= round.level.cols || ty >= round.level.rows) return 0;
  return round.exploded[ty * round.level.cols + tx];
}
