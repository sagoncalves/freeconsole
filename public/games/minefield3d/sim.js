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

import { getLevel, getArena, getStage, getRange } from "/games/minefield3d/levels.js?v=9";

/* ------------------------------------------------------------------ constants */

const MINE_TRIGGER_R = 0.36;
const KILLER_CATCH_R = 0.55;

/* --------------------------------------------------------------------- modes */

/** The original game: cross a mined aisle to a gate, with a press grinding up behind you. */
export const MODE_ESCAPE = "escape";

/**
 * Survival: an open room, no gate, and saw-armed roombas ricocheting around it.
 *
 * Nothing in here hunts. The machines travel in straight lines and bounce — off the walls and
 * off each other — and never steer toward anybody. That is deliberate and it is the whole
 * mode: a machine that aims at you is a machine you can read, and an earlier version that
 * chased collapsed into one repeated dodge once players learned it overshoots. Unguided blades
 * have no intent to anticipate, so the floor never resolves into a pattern.
 *
 * Held as a field on the round rather than as a second sim module because the substrate is
 * genuinely shared — the legs economy, movement, collision, the roster and the round
 * lifecycle. What differs is what is trying to kill you and what counts as winning. The mode
 * branches at exactly three places (createRound, startRound, step), plus two suppressions that
 * are cheaper as a check than as a fork: no mines are laid, and no sonar is emitted. An arena
 * floor is simply lit — there is nothing hidden on it to go looking for.
 */
export const MODE_SURVIVAL = "survival";

/**
 * Calls: a 6×4 grid of X/O tiles, a symbol called on the back wall, and a clock. When it hits
 * zero every tile bearing the other symbol drops into the crusher below.
 *
 * The reaction test of the three. Escape is solved by reading the ground and survival by
 * reading movement; here the answer is on the wall in letters a metre high and the only
 * question is whether you can get your body onto it in time. Nothing is hidden, so nothing
 * needs sonar, mines or machines — the mode is a timer and a floor that goes away.
 */
export const MODE_CALLS = "calls";

/**
 * Sniper: one player per round in a nest above the far end, everyone else running the aisle
 * beneath them toward a gate.
 *
 * The first asymmetric mode. Everything that makes it work follows from the sniper being a
 * *player* rather than a hazard: the rifle is slow and single-shot so a miss is a real gift,
 * the laser announces where they are looking so runners can read and break, and the nest is
 * awarded to whoever won last round so the best player is the one everybody is hunting.
 *
 * Cover is the level. The runners' entire game is the gap between one block and the next.
 */
export const MODE_SNIPER = "sniper";

export const MODES = [MODE_ESCAPE, MODE_SURVIVAL, MODE_CALLS, MODE_SNIPER];

/* ------------------------------------------------------------------- sniper */

/** How close a shot has to land to a runner to count as a hit, in tiles. */
const SHOT_HIT_R = 0.55;

/**
 * How far above the floor the rifle sits relative to the nest, and how tall a runner is for
 * line-of-sight purposes.
 *
 * The chest height matters more than it looks: cover is 1.5–1.6 tiles tall, so a shot is
 * blocked when the line from the muzzle to a runner's chest passes through a block. Aiming at
 * the feet would make every block useless and aiming at the head would make them all perfect.
 */
const MUZZLE_DROP = 0.35;
const RUNNER_CHEST = 1.1;

/** Steps taken along a shot when tracing it against cover. Finer than a block is wide. */
const TRACE_STEP = 0.22;

/* -------------------------------------------------------------------- calls */

/** The two symbols a tile can carry. Stored on the round as a Uint8Array of these. */
export const SYM_X = 0;
export const SYM_O = 1;

/**
 * Where a tile is in its drop cycle.
 *
 * SOLID is the only state you can stand on. FALLING and GONE both kill, and RISING is the
 * grace window where a tile is on its way back but not yet safe to be caught on — a player
 * standing in that column as it returns is simply lifted with it, which is why RISING must be
 * distinguishable from SOLID rather than folded into it.
 */
export const TILE_SOLID = 0;
export const TILE_FALLING = 1;
export const TILE_GONE = 2;
export const TILE_RISING = 3;

/**
 * Phases of a single call, in order.
 *
 * SHOWING is the thinking time — the symbol is up and the clock is visible. DROPPING is the
 * moment of truth. HANGING is the empty floor. RISING brings it back. Each is a fixed duration
 * from the Stage except SHOWING, which shortens every round and is the entire escalation.
 */
export const CALL_SHOWING = "showing";
export const CALL_DROPPING = "dropping";
export const CALL_HANGING = "hanging";
export const CALL_RISING = "rising";

/* ------------------------------------------------------------------ roombas */

/**
 * How close a blade has to get before it takes a leg. Comfortably larger than the chassis, so
 * a near miss at these speeds still costs you — the machines cross a tile in under a third of
 * a second, and a hitbox tight to the body would make survival a matter of frame timing rather
 * than of where you chose to stand.
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

/** Radius used for wall bounces and machine-on-machine contact. */
const ROOMBA_R = 0.5;

/**
 * Blade rotation, radians per second. Absurdly fast on purpose — these read as out of control.
 *
 * The exact value is chosen against the tooth count, not picked for feel. The blade has 8
 * teeth, so it is rotationally symmetric every 45°, and any rate that advances it close to a
 * whole number of teeth per rendered frame strobes: at 26 rad/s it steps 1.10 teeth/frame on
 * the low tier's 30fps cap and the saw appears to hang almost motionless — the exact opposite
 * of the intent, on the TVs this tier exists for. 34 lands at 0.72 and 1.44 teeth/frame at 60
 * and 30fps respectively, far from whole in both.
 */
const ROOMBA_SPIN = 34;

/**
 * Radians of noise added on a wall bounce and on a machine-to-machine hit.
 *
 * Without these the room is deterministic: perfectly elastic bounces put the machines into
 * stable repeating orbits within about twenty seconds, and a stable orbit is a pattern players
 * can stand still inside. The hit scatter is larger than the wall scatter because a collision
 * is meant to be the moment everything goes wrong.
 */
const WALL_SCATTER = 0.5;
const HIT_SCATTER = 0.9;

/**
 * How much faster both machines get when they hit each other, and the ceiling on it.
 *
 * Collisions are the only thing in the room that adds energy, so a crowded floor winds itself
 * up — which is exactly the escalation this mode wants, and it comes from the machines rather
 * than from a timer. The cap is what stops a late round from becoming a blur nobody can react
 * to at all.
 */
const COLLIDE_BOOST = 1.05;
const TEMPO_MAX = 1.9;

/* --------------------------------------------------------------------- push */

/**
 * Shoving another player.
 *
 * Available in every mode, because it is a verb about the people in the room rather than about
 * any one game's hazard — and in all three the interesting thing to do with a shove is the
 * same: put somebody where they did not want to be. In calls that is off a called tile; in
 * survival it is into a blade; in escape it is onto ground nobody has lit.
 *
 * The reach is deliberately short. A long grab would let a player farm shoves from safety;
 * at under two tiles you have to close, which means putting yourself in the same danger you
 * are trying to inflict.
 *
 * It is nevertheless generous, and that is the point: players pass through each other, so
 * there is no contact, no blocked step, nothing that tells a thumb "you are close enough
 * now". The only feedback is whether the shove lands. Tuned tight, the button reads as
 * broken rather than as missed — you cannot tell being out of range from a dead control.
 */
const PUSH_REACH = 1.9;

/**
 * How wide the arc in front of you counts as a shove — a cone, not a full circle.
 *
 * Just over a right angle each side. Wide enough that "roughly towards them" connects, since
 * heading comes from a thumb on glass and is never precise, but short of the full circle
 * that would make facing irrelevant and turn the shove into a proximity aura.
 */
const PUSH_ARC = Math.PI * 1.1;

/** Seconds between shoves, so it cannot be spammed into a stunlock. */
const PUSH_COOLDOWN = 1.1;

/**
 * How long the shove's arm-thrust plays for.
 *
 * Well under PUSH_COOLDOWN so the animation is always finished before the button comes back
 * — an action still visibly playing when it is ready again reads as input lag.
 */
const PUSH_ANIM_TIME = 0.34;

/** Seconds a shoved player spends on the floor before starting to get up. */
const PUSH_DOWN_TIME = 1.5;

/**
 * Opening speed of the slide, in tiles/second, and how fast it bleeds off.
 *
 * These two together set the distance: v²/2k, which is about 1.7 tiles over 0.6s. That is the
 * number that actually matters and it is tuned against the smallest board in the game — the
 * calls grid is only six tiles wide, and an earlier 6.5/4.2 pairing slid a target 5.1 tiles,
 * far enough that one shove cleared the entire platform regardless of where anyone stood.
 * A shove should cost you position, not the round.
 */
const PUSH_SLIDE = 5.5;
const PUSH_DRAG = 9;

/** Movement, in tiles per second. Losing legs is a heavy tax — that is the whole tension. */
export const SPEED_WALK = 3.0;
export const SPEED_LIMP = 1.6;
export const SPEED_CRAWL = 0.75;

/** Seconds a player is stunned after an explosion, unable to move at all. */
const BLAST_STUN = 1.1;

/**
 * Footprints older than this fade out entirely.
 *
 * Nothing drops prints any more (see dropPrint), so this only ever ages an empty list. Kept
 * because the renderer still imports it to fade any print it is given, and because the ageing
 * path is what guarantees the list stays empty rather than merely starting that way.
 */
export const PRINT_LIFE = 30;

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

/** The level table each mode draws from. Adding a mode means adding a row here, not a ternary. */
const LEVEL_SOURCE = {
  [MODE_ESCAPE]: getLevel,
  [MODE_SURVIVAL]: getArena,
  [MODE_CALLS]: getStage,
  [MODE_SNIPER]: getRange,
};

export function createRound(levelIndex, seed, mode = MODE_ESCAPE) {
  // An unknown mode falls back to escape rather than throwing: this arrives from a controller
  // message, and a bad string should cost the room a wrong game, not a dead screen.
  const resolved = LEVEL_SOURCE[mode] ? mode : MODE_ESCAPE;
  const level = LEVEL_SOURCE[resolved](levelIndex);
  const round = {
    level,
    mode: resolved,
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

    /* calls only — inert in the other two modes */

    /** One symbol per tile, SYM_X or SYM_O. Reshuffled every time the floor comes back. */
    tileSym: null,
    /** One TILE_* state per tile. Only TILE_SOLID holds weight. */
    tileState: null,
    /** How far each tile has fallen, in world units. Purely for the renderer. */
    tileDrop: null,
    /** Tiles removed from the board for good, once the clock can tighten no further. */
    tileRetired: null,
    /** Which symbol is currently called, or null before the first one. */
    called: null,
    /** Where we are in the call cycle, and how long is left in it. */
    callPhase: CALL_SHOWING,
    callLeft: 0,
    /** Seconds of thinking time this round — shrinks as the game goes on. */
    callTime: 0,
    /** How many calls have been survived. This is the score. */
    callRound: 0,

    /* sniper only — inert in the other three */

    /** Which device is in the nest this round, or null before one is chosen. */
    sniperId: null,
    /** Where the rifle is looking. Yaw sweeps the aisle, pitch tips down it. */
    aimYaw: 0,
    aimPitch: 0,
    /** Whether the scope is up. Zoomed aim is slower to swing — that is the trade. */
    scoped: false,
    /** Seconds until the next shot can be taken. */
    reload: 0,
    /** Where the laser currently lands, and whether it stops on cover or on a runner. */
    laser: null,
    /** Shots taken and runners dropped, for the end card. */
    shots: 0,
    hits: 0,
    /** One byte per tile: 1 where a cover block stands. */
    cover: null,
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

  if (round.mode === MODE_CALLS) {
    generateStageField(round);
    return;
  }

  if (round.mode === MODE_SNIPER) {
    generateRangeField(round, rng);
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
 * Prepare the arena. Deliberately empty ground.
 *
 * There are no mines in survival. They were tried and removed: a mine is a *static* hazard you
 * beat by reading the floor and remembering it, and the saws already fill the entire hazard
 * budget with something moving. Together they asked the player to watch the floor and the
 * machines at once, and since the machines are what actually kill you, the mines just added
 * deaths that felt arbitrary. The room is bare so that everything dangerous in it is visibly
 * dangerous, and the only thing to track is the machines.
 *
 * The `mines` and `exploded` arrays stay allocated and zeroed rather than being left null:
 * checkMine, tileReveal and the renderer's mine field all index them unconditionally, and a
 * null here would mean a branch in each of those hot paths for a mode that simply has none.
 */
function generateArenaField(round, rng) {
  // There is no gate in survival. Point the span off the board so nothing can stumble into an
  // escape: moveTo's gate check reads exitFrom/exitTo, and leaving them at 0 would make the
  // whole z = 0 edge an exit.
  round.exitFrom = -1;
  round.exitTo = -1;
  round.exitOpen = false;
}

/**
 * Scatter cover down the aisle.
 *
 * Blocks are placed per-row with a guaranteed minimum rather than by a flat dice roll on every
 * tile. A uniform roll produces runs of empty rows by chance, and an empty row on a sniper
 * level is not "a bit harder" — it is a stretch of aisle with no answer, where a runner's only
 * option is to walk into the open and hope. Every row past the spawn strip gets at least one
 * block, so there is always a next thing to run to.
 *
 * The gate mouth and the spawn strip stay clear: cover in the doorway would let a runner camp
 * the win, and cover on the spawn line would box people in before they had moved.
 */
function generateRangeField(round, rng) {
  const { level } = round;
  const { cols, rows } = level;
  round.cover = new Uint8Array(cols * rows);

  const halfGate = Math.floor(level.exitWidth / 2);
  const centre = Math.floor(cols / 2);
  round.exitFrom = Math.max(0, centre - halfGate);
  round.exitTo = Math.min(cols - 1, round.exitFrom + level.exitWidth - 1);
  round.exitOpen = true;

  const perRow = Math.max(1, Math.round(cols * level.coverDensity));

  for (let z = 0; z < rows; z++) {
    if (z >= rows - level.safeRows) continue;   // spawn strip
    if (z <= 1) continue;                       // gate mouth

    // Lay this row's guaranteed blocks at distinct columns.
    const taken = new Set();
    for (let k = 0; k < perRow; k++) {
      let x = Math.floor(rng() * cols);
      // Nudge off a duplicate rather than rejecting, so density is exact rather than expected.
      for (let tries = 0; tries < cols && taken.has(x); tries++) x = (x + 1) % cols;
      taken.add(x);
      round.cover[z * cols + x] = 1;
    }
  }

  // Stagger: knock out any block with a block directly in front of AND behind it, so the
  // aisle never grows a solid wall a runner cannot get around.
  for (let z = 2; z < rows - level.safeRows - 1; z++) {
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      if (!round.cover[i]) continue;
      if (round.cover[(z - 1) * cols + x] && round.cover[(z + 1) * cols + x]) {
        round.cover[i] = 0;
      }
    }
  }
}

/**
 * Prepare the call stage: a solid grid, no symbols yet.
 *
 * The symbols are deliberately NOT laid down here. They are dealt by shuffleTiles at the top of
 * every call, so a round that is reset and restarted does not replay the same board — the whole
 * mechanic depends on the grid being unmemorisable.
 */
function generateStageField(round) {
  const n = round.level.cols * round.level.rows;
  round.tileSym = new Uint8Array(n);
  round.tileState = new Uint8Array(n);      // all TILE_SOLID, which is 0
  round.tileDrop = new Float32Array(n);
  round.tileRetired = new Uint8Array(n);

  // No gate here either, for the same reason as the arena.
  round.exitFrom = -1;
  round.exitTo = -1;
  round.exitOpen = false;
}

/**
 * Deal a fresh X/O across every tile, and stand them all back up.
 *
 * Called once per cycle, as the floor returns. Deliberately unseeded — it uses Math.random
 * rather than the round's rng, because a seeded shuffle would make the whole game replay
 * identically for a given seed and the point is that the next board is never knowable.
 *
 * The split is forced to be roughly even rather than left to chance. Left alone, an unlucky
 * deal puts 22 of 24 tiles on one symbol, and calling the minority then kills almost everyone
 * at once through no fault of theirs — a coin flip dressed up as a reaction test.
 */
function shuffleTiles(round) {
  const n = round.level.cols * round.level.rows;

  // Retired tiles are gone for good and take no part in the deal — dealing them a symbol
  // would advertise safe ground that is not there.
  const live = [];
  for (let i = 0; i < n; i++) if (!round.tileRetired[i]) live.push(i);

  // Build a bag over the tiles that remain, then shuffle it.
  //
  // The invariant that matters is that BOTH symbols are always present: the screen calls one
  // of the two at random, and a board dealt all-X has no answer to a call of O — everybody
  // dies through no fault of their own. On a full board an even split gives that for free, but
  // on a shrunken one it does not. An earlier version assigned the odd tile randomly and
  // measured 69 unanswerable calls in 2689, all of them in the two-tile endgame where the
  // rounding could put both tiles on the same symbol.
  //
  // So the first two tiles are forced to be one of each, and only the remainder is split.
  // With the minimum board of two tiles that is the whole deal, and it is exactly right: one
  // X, one O, and the call decides which one you needed to be standing on.
  const half = Math.floor((live.length - 2) / 2);
  for (let k = 0; k < live.length; k++) {
    if (k === 0) round.tileSym[live[k]] = SYM_X;
    else if (k === 1) round.tileSym[live[k]] = SYM_O;
    else round.tileSym[live[k]] = (k - 2) < half ? SYM_X : SYM_O;
  }
  for (let k = live.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    const tmp = round.tileSym[live[k]];
    round.tileSym[live[k]] = round.tileSym[live[j]];
    round.tileSym[live[j]] = tmp;
  }

  // On a small board, force the two symbols apart.
  //
  // A shuffle alone will happily deal the last X and the last O side by side, and a player
  // who stands on the seam between them then wins every call forever without reacting to
  // anything — measured as rounds that never ended even after the board had shrunk all the
  // way down. Swapping so the nearest pair are the furthest-apart tiles restores the run that
  // is the whole point of the mode.
  if (live.length <= 6) spreadSymbols(round, live);

  for (let i = 0; i < n; i++) {
    if (round.tileRetired[i]) {
      round.tileState[i] = TILE_GONE;
      round.tileDrop[i] = round.level.crusherDepth;
      continue;
    }
    // Tiles come back UP from the pit rather than blinking into place.
    //
    // Snapping them straight to SOLID at zero depth was the original behaviour and it read as
    // the board flashing to a new state — the drop had weight and the return had none, so the
    // cycle felt like an edit rather than like machinery. Starting them deep and letting
    // animateTiles carry them home makes the floor rebuild itself in front of the players,
    // which is also the window in which they read the fresh symbols.
    round.tileState[i] = TILE_RISING;
    round.tileDrop[i] = round.level.crusherDepth;
  }
}

/**
 * Re-assign symbols on a small board so the two groups sit as far apart as possible.
 *
 * Finds the widest-separated pair of live tiles and puts one symbol on each, then assigns
 * every other tile to whichever of those two anchors it is nearer. On a two-tile board this is
 * simply "X here, O over there"; on a four- or six-tile one it splits the board into two
 * clusters at opposite ends, which is the same shape of problem at a larger scale.
 */
function spreadSymbols(round, live) {
  const { cols } = round.level;
  const xy = (i) => ({ x: (i % cols) + 0.5, z: Math.floor(i / cols) + 0.5 });

  let a = live[0];
  let b = live[live.length - 1];
  let far = -1;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const p = xy(live[i]);
      const q = xy(live[j]);
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d > far) { far = d; a = live[i]; b = live[j]; }
    }
  }

  // Which anchor gets which symbol is random, or the same corner would always be X and the
  // endgame would become something players could pre-position for.
  const aSym = Math.random() < 0.5 ? SYM_X : SYM_O;
  const bSym = aSym === SYM_X ? SYM_O : SYM_X;

  const pa = xy(a);
  const pb = xy(b);
  for (const i of live) {
    if (i === a) { round.tileSym[i] = aSym; continue; }
    if (i === b) { round.tileSym[i] = bSym; continue; }
    const p = xy(i);
    const da = Math.hypot(p.x - pa.x, p.z - pa.z);
    const db = Math.hypot(p.x - pb.x, p.z - pb.z);
    round.tileSym[i] = da <= db ? aSym : bSym;
  }
}

/**
 * Permanently remove a tile or two from the board.
 *
 * The endgame escalation, once the clock can go no lower. Tiles are retired from the *edges*
 * inward rather than at random: a hole punched in the middle of the grid is a hazard you have
 * to path around under time pressure, which is a different and much fussier game, while a
 * board that closes in from its edges simply gets smaller and keeps the mode about speed.
 *
 * The floor is two tiles — one of each symbol. It cannot go lower without the deal becoming
 * impossible, and it must not stop higher: at four tiles the board stalls at two safe squares
 * within a step of each other and the game becomes unloseable, which measured as a permanent
 * stalemate from about call fifteen onward. At two, surviving means being on the right one of
 * a pair when the clock stops, which is still a choice rather than a coin flip — you pick
 * where to wait, and the run between them is the whole test.
 */
/** How many tiles are still part of the board. */
function liveTiles(round) {
  if (!round.tileRetired) return 0;
  let n = 0;
  for (let i = 0; i < round.tileRetired.length; i++) if (!round.tileRetired[i]) n++;
  return n;
}

function retireTiles(round) {
  const { cols, rows } = round.level;
  const n = cols * rows;

  const liveCount = liveTiles(round);
  if (liveCount <= 2) return;

  // Rank the survivors by how far out they sit, and take from the outside in.
  const cx = (cols - 1) / 2;
  const cz = (rows - 1) / 2;
  const candidates = [];
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      const i = z * cols + x;
      if (round.tileRetired[i]) continue;
      // A jitter on the distance so two runs never retire the identical sequence.
      candidates.push({ i, d: Math.hypot(x - cx, z - cz) + Math.random() * 0.4 });
    }
  }
  candidates.sort((a, b) => b.d - a.d);

  const take = Math.min(candidates.length - 2, 2);
  for (let k = 0; k < take; k++) round.tileRetired[candidates[k].i] = 1;

  round.events.push({ type: "retire", left: liveCount - take });
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

    /**
     * Knockdown, from being shoved by another player.
     *
     * `downFor` counts the seconds left on the floor and is the whole state machine: above
     * zero means flat and unable to steer, and it running out is what triggers standing up.
     * The slide is separate from `dx/dz` because it must survive the stun that stops those —
     * being pushed has to actually carry you, or the shove is a stun with a costume on.
     */
    downFor: 0,
    slideX: 0,
    slideZ: 0,
    /** Who did it, so the screen can credit a push that drops someone into the crusher. */
    pushedBy: null,
    /** Seconds before this player can shove again. */
    pushCooldown: 0,
    /** Seconds left of the shove's own arm-thrust, for the renderer to pose against. */
    shoveFor: 0,
    /** How far the last connecting shove had to reach, so the renderer can lunge that far. */
    shoveGap: 0,
    /** Seconds a knocked player waits before sliding, so the shove lands before they move. */
    slideDelay: 0,

    /**
     * Calls: how far this player has fallen through the floor, in world units.
     *
     * A player dropped into the crusher is DEAD the instant the tile goes, because the rules
     * have to resolve at the moment of the call — but they are still visibly in the air, and
     * the round must not be declared over while somebody is mid-fall. Null means "not falling",
     * which is every player in every other mode.
     */
    fallY: null,
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

/**
 * Shove whoever is in front of you.
 *
 * Called straight from a controller tap. Everything is validated here rather than trusted:
 * this arrives off the wire, and the phone is never allowed to assert who got hit or how hard.
 *
 * Targets are chosen by a cone rather than by proximity alone. A radius-only check means a
 * shove hits whoever happens to be nearest regardless of which way you were facing, which
 * reads as random to everyone involved — with a cone you push who you were looking at, and
 * missing is your own fault. Only the single best target in the arc is hit, so one tap is one
 * shove no matter how many people are crowded on a tile.
 *
 * @return {boolean} whether it connected, so the caller can decide about feedback.
 */
export function push(round, deviceId) {
  if (round.phase !== "running") return false;
  const p = round.players.get(deviceId);
  if (!p || p.state !== ALIVE) return false;
  // No shoving while stunned, already on the floor, or still on cooldown.
  if (p.pushCooldown > 0 || p.downFor > 0 || p.stun > 0) return false;

  p.pushCooldown = PUSH_COOLDOWN;
  // Start the shove's own animation clock. Set on every tap, hit or miss: a shove that
  // misses still has to look like a shove, or the button feels dead exactly when a player
  // most needs to know it fired.
  p.shoveFor = PUSH_ANIM_TIME;
  // Cleared up front so a miss cannot inherit the lunge distance of the last shove that
  // connected; a hit sets it again below.
  p.shoveGap = 0;

  const fx = Math.sin(p.heading);
  const fz = Math.cos(p.heading);

  /**
   * Pick the target by how squarely it sits in front, not by distance alone.
   *
   * With a narrow cone the two agree often enough not to matter. With this one they do not:
   * somebody brushing past your shoulder can be nearer than the player you are walking
   * straight at, and picking on distance would shove the bystander while the phone was
   * pointed at someone else. Score is the facing dot scaled down by distance, so a target
   * dead ahead beats a closer one off to the side, and among equals the nearer wins.
   */
  const minDot = Math.cos(PUSH_ARC / 2);
  let best = null;
  let bestScore = -Infinity;
  for (const q of round.players.values()) {
    if (q === p || q.state !== ALIVE) continue;
    // Somebody already on the floor cannot be shoved again — that is the anti-stunlock rule,
    // and it is what stops two players pinning a third for a whole round.
    if (q.downFor > 0) continue;

    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > PUSH_REACH || d < 1e-4) continue;
    // Inside the forward arc?
    const dot = (dx / d) * fx + (dz / d) * fz;
    if (dot < minDot) continue;
    const score = dot - d / PUSH_REACH * 0.5;
    if (score <= bestScore) continue;
    bestScore = score;
    best = { q, dx, dz, d };
  }

  round.events.push({ type: "push", id: p.id, x: p.x, z: p.z, hit: !!best });
  if (!best) return false;

  /*
   * Turn to face whoever is actually being shoved, and record how far away they were.
   *
   * Both exist for the renderer. The reach is nearly two tiles but a pair of arms spans well
   * under one, so a shove thrown at the edge of range played out with the hands nowhere near
   * the target — it read as pushing thin air, which is exactly how it was reported. The
   * renderer uses `shoveGap` to lunge the body across the difference, and it can only do
   * that honestly if the shover is also turned to face the target rather than left pointing
   * wherever the stick happened to be.
   */
  p.heading = Math.atan2(best.dx, best.dz);
  p.shoveGap = best.d;

  knockDown(round, best.q, best.dx / best.d, best.dz / best.d, p.id);
  return true;
}

/**
 * Put a player on the floor, sliding away along `nx,nz`.
 *
 * Split out from push() because the direction is the caller's business: a shove sends someone
 * directly away from the shover, but the same knockdown is the natural response to anything
 * else that should floor a player later.
 */
function knockDown(round, q, nx, nz, byId) {
  q.downFor = PUSH_DOWN_TIME;
  /*
   * Hold the target still until the shove has actually landed on them.
   *
   * The thrust peaks a quarter of the way through PUSH_ANIM_TIME. Sliding from frame one
   * means the target is already travelling before the hands arrive, so the gap between the
   * two only ever grows and the shove visibly touches nothing — the arms reach for a body
   * that has left. Waiting for contact costs under a tenth of a second and is what makes the
   * hit read as a hit. The stagger applies to the slide only; downFor runs immediately, so
   * they are off their feet the whole time.
   */
  q.slideDelay = PUSH_ANIM_TIME * 0.25;
  q.slideX = nx * PUSH_SLIDE;
  q.slideZ = nz * PUSH_SLIDE;
  q.pushedBy = byId ?? null;
  // Face the way they are travelling, so the fall reads as being sent that direction.
  q.heading = Math.atan2(nx, nz);
  q.dx = 0;
  q.dz = 0;
  q.axis = null;
  q.input.up = q.input.down = q.input.left = q.input.right = false;

  round.events.push({ type: "knocked", id: q.id, by: byId ?? null, x: q.x, z: q.z });
}

/** Is this player on the floor from a shove? Read by the renderer and the controller. */
export function isDown(p) {
  return p.downFor > 0;
}

/**
 * How far through their own shove this player is, 0 to 1, or 0 when not shoving.
 *
 * Exposed as normalised progress rather than as the raw countdown so the renderer never has
 * to know PUSH_ANIM_TIME — retuning the duration here cannot desynchronise the pose.
 */
export function shoveProgress(p) {
  if (!p.shoveFor || p.shoveFor <= 0) return 0;
  /*
   * Nudged off zero on the very first frame.
   *
   * Straight `1 - shoveFor/PUSH_ANIM_TIME` is exactly 0 before the first step, and 0 is the
   * value that means "not shoving" — so a shove read on the frame it was thrown looked like
   * no shove at all, and the renderer skipped its opening frame. The floor is far below the
   * first real sample, so it shifts nothing that is actually visible.
   */
  return Math.max(1e-4, 1 - p.shoveFor / PUSH_ANIM_TIME);
}

/**
 * How far the renderer should carry the shover forward, in world units.
 *
 * The arms alone cannot span the reach — it is nearly two tiles and a pair of arms is well
 * under one — so the body has to travel the remainder or the shove visibly touches nothing.
 * A body's own width is subtracted because the two never need to occupy the same point, and
 * the result is clamped so a shove at maximum range does not turn into a flying tackle.
 */
export function shoveLunge(p) {
  if (!p.shoveGap) return 0;
  /*
   * Stop a body's width short rather than closing the whole gap.
   *
   * Travelling the full distance puts the shover exactly where the target was standing, and
   * since the target is briefly held in place for the contact they visibly interpenetrate —
   * the shove ends with one player standing inside the other. Leaving that width is what
   * makes it read as arms meeting a chest instead of two meshes overlapping.
   */
  return Math.max(0, Math.min(0.95, p.shoveGap - 0.85));
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

  // The nest is assigned BEFORE anyone is seated, because resetPlayer spreads the runners
  // across the aisle and needs to know how many there actually are — counting the sniper
  // among them leaves a gap on the spawn line where nobody is standing.
  if (round.mode === MODE_SNIPER) {
    if (!ids.length) round.sniperId = null;
    else if (!round.players.has(round.sniperId)) round.sniperId = ids[0];
  }

  const runners = round.mode === MODE_SNIPER
    ? ids.filter((id) => id !== round.sniperId)
    : ids;
  runners.forEach((id, i) => resetPlayer(round, round.players.get(id), i, runners.length));
  // The sniper still needs their per-round fields cleared, just not a place in the line.
  if (round.mode === MODE_SNIPER && round.players.has(round.sniperId)) {
    resetPlayer(round, round.players.get(round.sniperId), 0, 1);
  }

  if (survival) {
    // The opening pack. Spawned on the rim looking inward, so the first thing anybody sees is
    // the room closing on them — a saw that has to cross the floor to reach you reads as
    // hunting, where one that starts adjacent just reads as unfair.
    for (let i = 0; i < round.level.startRoombas; i++) spawnRoomba(round, i);
  }

  if (round.mode === MODE_SNIPER) {
    round.aimYaw = 0;
    // Start looking down the aisle rather than at the sky, so the first frame is useful.
    round.aimPitch = -0.32;
    round.scoped = false;
    round.reload = 0;
    round.laser = null;
    round.shots = 0;
    round.hits = 0;

    const sniper = round.players.get(round.sniperId);
    if (sniper) {
      // The sniper is seated in the nest and takes no part in the footrace. They are marked
      // ALIVE so the roster shows them playing, but nothing on the floor can reach them.
      sniper.x = round.level.cols / 2;
      sniper.z = -1.2;
      sniper.state = ALIVE;
      sniper.heading = 0;
    }
  }

  if (round.mode === MODE_CALLS) {
    round.callRound = 0;
    round.callTime = round.level.callTime;
    round.called = null;
    // A restart gets the whole board back — retirement is progress within one round, not a
    // permanent state of the stage.
    round.tileRetired.fill(0);
    shuffleTiles(round);
    // Open on the settle window rather than on a live call, so the first thing players get is
    // a moment to look at the board before anything is demanded of them.
    round.callPhase = CALL_RISING;
    round.callLeft = round.level.settleTime;
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
  } else if (round.mode === MODE_CALLS) {
    // Spread along the row nearest the camera, each on their own tile centre. Standing on a
    // centre rather than on a seam matters: the first call is resolved by which tile you are
    // over, and a player straddling two of them at t=0 would be at the mercy of a rounding
    // decision they never made.
    const col = total <= 1
      ? Math.floor(round.level.cols / 2)
      : Math.round((index / (total - 1)) * (round.level.cols - 1));
    p.x = col + 0.5;
    p.z = round.level.rows - 0.5;
    // Facing the wall screen, which is the thing they need to be looking at.
    p.heading = Math.PI;
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
  p.fallY = null;
  p.lastX = p.x;
  p.lastZ = p.z;
  p.downFor = 0;
  p.slideX = 0;
  p.slideZ = 0;
  p.pushedBy = null;
  p.pushCooldown = 0;
  p.shoveFor = 0;
  p.shoveGap = 0;
  p.slideDelay = 0;

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
  // floor with you; calls has a floor that goes away. Everything else — sonar, movement,
  // mines, prints — is identical.
  if (round.mode === MODE_SURVIVAL) {
    stepWaves(round);
    stepRoombas(round, dt);
    for (const p of round.players.values()) {
      if (p.state === ALIVE) p.survivedFor = round.t;
    }
  } else if (round.mode === MODE_SNIPER) {
    stepSniper(round, dt);
  } else if (round.mode === MODE_CALLS) {
    stepCalls(round, dt);
    for (const p of round.players.values()) {
      if (p.state === ALIVE) p.survivedFor = round.t;
    }
  } else {
    stepKiller(round, dt);
  }

  for (const p of round.players.values()) stepPlayer(round, p, dt);

  // Falling happens after movement, so a player who steps onto solid ground in the last
  // fraction of a second is genuinely safe. Resolved the other way round, the drop would read
  // the position they held at the top of the frame and kill people who had already made it.
  if (round.mode === MODE_CALLS) checkFooting(round);

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

  // No echolocation in survival. It exists to find things hidden on the floor, and an arena
  // hides nothing — the machines are lit, moving, and the only thing worth looking at. Leaving
  // it in meant a ring sweeping the room every 1.6 seconds that revealed bare ground.
  if (round.mode !== MODE_ESCAPE) { p.ping = null; return; }

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
    // Fired across the room on a slant, not straight at the middle. Aiming every machine at
    // the centre made the opening seconds identical every time and put them all through the
    // same point — where they promptly collided into a predictable starburst.
    heading: Math.atan2(level.cols / 2 - x, level.rows / 2 - z)
      + (Math.random() - 0.5) * 1.5,
    spin: Math.random() * Math.PI * 2,
    bornAt: round.t,
    // A little variation per unit so a pack never moves as one body.
    tempo: 0.88 + Math.random() * 0.28,
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
 * **Nothing here hunts.** An earlier version had each saw pick the nearest player and steer at
 * them, and it was the wrong game: a machine that aims at you is a machine you can read, and
 * once players learned it overshoots when you cut across its nose, the whole room resolved
 * into the same repeated dodge. Being chased is a puzzle with an answer.
 *
 * These are pinballs. They travel in straight lines at a speed nobody can outrun, ricochet off
 * the walls, and — the part that actually creates the mode — ricochet off *each other*. Two
 * machines meeting is the only event in the room that neither the players nor the machines can
 * predict, and with a dozen of them the floor is a shifting mess of vectors that no one is
 * steering. You are not being hunted. You are standing in a room full of loose blades and the
 * danger is that there is no intent behind any of it to anticipate.
 */
function stepRoombas(round, dt) {
  const { level } = round;

  for (const r of round.roombas) {
    // The blade is always screaming. There is no stalled state any more — nothing in the room
    // stops, which is most of why it feels out of control.
    r.spin += dt * ROOMBA_SPIN * r.tempo;

    const speed = level.roombaSpeed * r.tempo;
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
    if (nx < lo || nx > hiX) {
      nx = Math.max(lo, Math.min(hiX, nx));
      // heading is atan2(sin, cos) with x = sin, so mirroring x is negating the angle.
      r.heading = -r.heading;
      wallKick(r);
    }
    if (nz < lo || nz > hiZ) {
      nz = Math.max(lo, Math.min(hiZ, nz));
      r.heading = Math.PI - r.heading;
      wallKick(r);
    }

    r.x = nx;
    r.z = nz;
  }

  // Machine-on-machine collisions, resolved after everything has moved so the outcome does not
  // depend on which one happens to be first in the array.
  collideRoombas(round);

  for (const r of round.roombas) sawPlayers(round, r);
}

/**
 * Kick a machine off a wall with a little scatter.
 *
 * The randomness is the point. A perfectly elastic bounce is deterministic: a saw entering a
 * corner at a known angle leaves at a known angle, and a room of them settles into stable
 * repeating orbits that players simply memorise. A few degrees of noise on every bounce keeps
 * the floor from ever resolving into a pattern.
 *
 * Deliberately silent. This used to raise a soft `clang` event, but nothing consumes it: the
 * ring that once drew here is gone and only hard machine-on-machine hits kick the camera. With
 * a dozen machines it was pushing dead events onto the queue several times a second for the
 * drain loop to walk past.
 */
function wallKick(r) {
  r.heading += (Math.random() - 0.5) * WALL_SCATTER;
}

/**
 * Machines bouncing off each other — the heart of the mode.
 *
 * A real elastic exchange rather than "both turn around": they swap the components of their
 * velocity along the line between them and keep the perpendicular parts, which is what makes a
 * glancing hit deflect slightly and a head-on hit reverse both. That difference is what makes
 * the floor read as physical rather than as scripted, and it is where the genuine chaos comes
 * from — one collision changes two vectors, and each of those goes on to hit something else.
 */
function collideRoombas(round) {
  const list = round.roombas;
  const minDist = ROOMBA_R * 2;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];

      let dx = b.x - a.x;
      let dz = b.z - a.z;
      let d = Math.hypot(dx, dz);
      if (d >= minDist) continue;

      // Exactly coincident: shove them apart on an arbitrary axis, or the normal is NaN and
      // both machines' headings turn into NaN for the rest of the round.
      if (d < 1e-4) { dx = 1; dz = 0; d = 1; }

      const nxAxis = dx / d;
      const nzAxis = dz / d;

      // Separate them first. Without this they stay overlapped, collide again next frame, and
      // vibrate against each other in place instead of bouncing apart.
      const push = (minDist - d) / 2 + 0.01;
      a.x -= nxAxis * push;
      a.z -= nzAxis * push;
      b.x += nxAxis * push;
      b.z += nzAxis * push;

      // Swap the velocity components along the collision normal.
      const avx = Math.sin(a.heading);
      const avz = Math.cos(a.heading);
      const bvx = Math.sin(b.heading);
      const bvz = Math.cos(b.heading);

      const aAlong = avx * nxAxis + avz * nzAxis;
      const bAlong = bvx * nxAxis + bvz * nzAxis;
      // Already separating — resolve the overlap but do not flip them back together.
      if (aAlong - bAlong <= 0) continue;

      const anx = avx - (aAlong - bAlong) * nxAxis;
      const anz = avz - (aAlong - bAlong) * nzAxis;
      const bnx = bvx + (aAlong - bAlong) * nxAxis;
      const bnz = bvz + (aAlong - bAlong) * nzAxis;

      a.heading = Math.atan2(anx, anz) + (Math.random() - 0.5) * HIT_SCATTER;
      b.heading = Math.atan2(bnx, bnz) + (Math.random() - 0.5) * HIT_SCATTER;

      // Both come out of it faster. Collisions are the only thing that adds energy, so a busy
      // floor accelerates itself — and the cap keeps that from running away.
      a.tempo = Math.min(TEMPO_MAX, a.tempo * COLLIDE_BOOST);
      b.tempo = Math.min(TEMPO_MAX, b.tempo * COLLIDE_BOOST);

      round.events.push({
        type: "clang",
        x: (a.x + b.x) / 2,
        z: (a.z + b.z) / 2,
        hard: true,
      });
    }
  }
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
    //
    // Thrown along the machine's own heading as well as away from its centre. Purely radial
    // knockback shoves a player sideways out of a saw's path, which quietly turns a hit into
    // an escape; being batted *down-range* is both what a spinning blade would actually do and
    // what keeps a bad position bad.
    p.stun = 0.45;
    const away = Math.hypot(p.x - r.x, p.z - r.z) || 1;
    const kx = ((p.x - r.x) / away) * 0.55 + Math.sin(r.heading) * 0.55;
    const kz = ((p.z - r.z) / away) * 0.55 + Math.cos(r.heading) * 0.55;
    p.x = Math.max(0.32, Math.min(round.level.cols - 0.32, p.x + kx));
    p.z = Math.max(0.32, Math.min(round.level.rows - 0.32, p.z + kz));
  }
}

/** Record the order people go down in, so the results can rank by how long each lasted. */
function down(round, p, cause) {
  if (p.state !== ALIVE) return;
  p.survivedFor = round.t;
  round.downOrder.push(p.id);
  kill(round, p, cause);
}

/* ------------------------------------------------------------ sniper: the nest */

/** Where the rifle sits in world space. */
export function nestPos(round) {
  return {
    x: round.level.cols / 2,
    y: (round.level.nestHeight || 6.5) - MUZZLE_DROP,
    z: -1.2,
  };
}

/** Is this device the one in the nest? */
export function isSniper(round, deviceId) {
  return round.mode === MODE_SNIPER && round.sniperId === deviceId;
}

/** Whoever is in the nest, or null. */
export function sniperOf(round) {
  return round.sniperId === null ? null : round.players.get(round.sniperId) || null;
}

/** Is this player a runner — in the race rather than in the nest? */
export function isRunner(round, p) {
  if (round.mode !== MODE_SNIPER) return true;
  return p.id !== round.sniperId;
}

/**
 * Swing the rifle. The stick's x sweeps across the aisle, its z tips down it.
 *
 * Clamped so the sniper can never look behind themselves or at the sky: the nest overlooks
 * one aisle and nothing else, and an unbounded pitch mostly produces a view of empty space
 * that makes the split screen useless to watch.
 */
export function aim(round, deviceId, dx, dz, dt) {
  if (round.phase !== "running" || !isSniper(round, deviceId)) return;
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;

  const level = round.level;
  // Scoping trades swing speed for precision, which is the whole reason to ever un-scope.
  const rate = (level.turnSpeed || 1.15) * (round.scoped ? (level.zoomTurn || 0.38) : 1);

  /*
   * Both axes are negated, and the signs are not guesswork — they follow from the geometry.
   *
   * The nest looks down the aisle toward +z, so the camera's right-hand vector is -x. Raising
   * aimYaw therefore swings the muzzle toward the viewer's LEFT, which means a stick pushed
   * right has to lower it. That inversion is what made the rifle feel backwards.
   *
   * Pitch is already correct and is left alone: the pad's z grows downward, so subtracting it
   * sends the barrel down when the thumb goes down, which is the direct mapping.
   *
   * Getting either backwards is not subtly wrong, it is unusable — you chase the target away
   * from where you meant to go, on the one control that has to feel exact.
   */
  round.aimYaw -= dx * rate * dt;
  round.aimPitch -= dz * rate * dt;

  // Yaw: enough to cover the aisle's width from the nest, and no further.
  const halfSpan = Math.atan2(level.cols * 0.75, 6);
  round.aimYaw = Math.max(-halfSpan, Math.min(halfSpan, round.aimYaw));
  // Pitch: from steeply down at the gate mouth to nearly level at the far end.
  round.aimPitch = Math.max(-1.15, Math.min(-0.05, round.aimPitch));
}

/** Raise or drop the scope. */
export function setScoped(round, deviceId, on) {
  if (!isSniper(round, deviceId)) return;
  round.scoped = !!on;
}

/**
 * Trace where the rifle is pointing, stopping at whatever it meets first.
 *
 * This is both the laser dot and the shot — deliberately the same function, so what a runner
 * sees on the floor is exactly what a trigger pull would hit. Computing them separately is how
 * you end up with a laser that lies.
 *
 * Marched in short steps rather than solved analytically because the aisle is a heightfield of
 * unit blocks, and a march is simpler to reason about than a set of box intersections — at a
 * step finer than a block it cannot tunnel through one.
 */
export function traceShot(round) {
  const level = round.level;
  const from = nestPos(round);

  const cy = Math.cos(round.aimPitch);
  const dir = {
    x: Math.sin(round.aimYaw) * cy,
    y: Math.sin(round.aimPitch),
    z: Math.cos(round.aimYaw) * cy,
  };

  const maxDist = level.rows + 12;
  for (let d = 0.5; d < maxDist; d += TRACE_STEP) {
    const x = from.x + dir.x * d;
    const y = from.y + dir.y * d;
    const z = from.z + dir.z * d;

    // Left the aisle sideways or out the back — the shot is gone.
    if (x < -1 || x > level.cols + 1 || z > level.rows + 2) {
      return { x, y: Math.max(0, y), z, dist: d, hit: null, blocked: false };
    }

    const tx = Math.floor(x);
    const tz = Math.floor(z);
    const inside = tx >= 0 && tz >= 0 && tx < level.cols && tz < level.rows;

    // A runner, if the line passes through their chest.
    for (const p of round.players.values()) {
      if (p.state !== ALIVE || !isRunner(round, p)) continue;
      const chest = RUNNER_CHEST * 0.5;
      if (Math.abs(y - chest) > RUNNER_CHEST * 0.75) continue;
      if (Math.hypot(p.x - x, p.z - z) <= SHOT_HIT_R) {
        return { x, y, z, dist: d, hit: p.id, blocked: false };
      }
    }

    // Cover, if the line is below the top of a block standing here.
    if (inside && round.cover[tz * level.cols + tx] && y <= level.coverHeight) {
      return { x, y, z, dist: d, hit: null, blocked: true };
    }

    // The floor.
    if (y <= 0.02) {
      return { x, y: 0, z, dist: d, hit: null, blocked: false };
    }
  }

  return null;
}

/**
 * Pull the trigger.
 *
 * The shot is resolved from the same trace the laser draws, so a runner who could see the dot
 * on their own body was genuinely about to be hit. Everything is validated here — the phone
 * says "I fired" and never says what it hit.
 */
export function fire(round, deviceId) {
  if (round.phase !== "running" || !isSniper(round, deviceId)) return false;
  if (round.reload > 0) return false;

  round.reload = round.level.reloadTime || 2;
  round.shots++;

  const shot = traceShot(round);
  const at = shot || { x: round.level.cols / 2, y: 0, z: round.level.rows, hit: null };

  round.events.push({
    type: "shot",
    x: at.x, y: at.y, z: at.z,
    hit: at.hit ?? null,
  });

  if (at.hit !== null && at.hit !== undefined) {
    const target = round.players.get(at.hit);
    if (target && target.state === ALIVE) {
      round.hits++;
      // One shot, one runner. Cover is the counter-play, not hit points.
      target.survivedFor = round.t;
      round.downOrder.push(target.id);
      kill(round, target, "shot");
    }
    return true;
  }
  return false;
}

/** Advance the rifle: reload clock and the live laser dot. */
function stepSniper(round, dt) {
  if (round.reload > 0) round.reload = Math.max(0, round.reload - dt);
  round.laser = traceShot(round);
}

/** Is there a cover block on this tile? Read by the renderer. */
export function coverAt(round, tx, tz) {
  if (!round.cover) return 0;
  if (tx < 0 || tz < 0 || tx >= round.level.cols || tz >= round.level.rows) return 0;
  return round.cover[tz * round.level.cols + tx];
}

/* -------------------------------------------------------------- calls: floor */

/**
 * Drive the call cycle: show a symbol, drop the losers, hang, bring the floor back shuffled.
 *
 * A four-state machine on a single countdown rather than a set of timers, so there is exactly
 * one place a phase can change and no way for two of them to be live at once.
 */
function stepCalls(round, dt) {
  const { level } = round;

  // Tiles that are on their way down or back up keep moving regardless of the phase clock —
  // their motion is what the renderer draws, and it must not stall between phases.
  animateTiles(round, dt);
  animateFallers(round, dt);

  round.callLeft -= dt;
  if (round.callLeft > 0) return;

  if (round.callPhase === CALL_RISING) {
    // The floor is back and settled. Call the next symbol.
    round.callRound++;
    round.called = Math.random() < 0.5 ? SYM_X : SYM_O;
    round.callPhase = CALL_SHOWING;
    round.callLeft = round.callTime;
    round.events.push({
      type: "call",
      symbol: round.called,
      seconds: round.callTime,
      round: round.callRound,
    });
    return;
  }

  if (round.callPhase === CALL_SHOWING) {
    // Time is up. Everything not bearing the called symbol lets go.
    let dropped = 0;
    const n = level.cols * level.rows;
    for (let i = 0; i < n; i++) {
      if (round.tileSym[i] === round.called) continue;
      round.tileState[i] = TILE_FALLING;
      dropped++;
    }
    round.callPhase = CALL_DROPPING;
    // Long enough for a tile to clear the crusher depth at its fall rate.
    round.callLeft = Math.max(0.35, level.crusherDepth / level.tileFall);
    round.events.push({ type: "drop", symbol: round.called, dropped });
    return;
  }

  if (round.callPhase === CALL_DROPPING) {
    // Everything that fell is now gone, and anyone who went with it is already dead — the
    // footing check killed them on the frame the tile started moving.
    const n = level.cols * level.rows;
    for (let i = 0; i < n; i++) {
      if (round.tileState[i] === TILE_FALLING) round.tileState[i] = TILE_GONE;
    }
    round.callPhase = CALL_HANGING;
    round.callLeft = level.hangTime;
    return;
  }

  // CALL_HANGING → the floor comes back, freshly shuffled, and the clock tightens.
  // The clock keeps tightening past its nominal floor once the board is down to its last few
  // tiles. callTimeMin is tuned for a full 6×4 grid, where it is already brutal; on two tiles
  // a player simply stands between them and makes every call, and a perfect player then never
  // loses — which measured as rounds that ran indefinitely even after the board had shrunk all
  // the way down. Past that point the only dial left is time.
  const floor = liveTiles(round) <= 4 ? level.callTimeMin * 0.55 : level.callTimeMin;
  round.callTime = Math.max(floor, round.callTime - level.callTimeStep);
  round.callPhase = CALL_RISING;
  round.callLeft = level.settleTime;
  round.events.push({ type: "rise", callTime: round.callTime });

  // The board starts shrinking well before the clock bottoms out, and the two escalations
  // then run together.
  //
  // Without this the mode never ends. A 6×4 grid is small enough that a competent player
  // crosses it inside even the minimum time, so once the clock floors out every round is
  // identical and survivable forever. Headless runs bore that out brutally: 25 of 25 rounds
  // ran past five minutes and 69–99 calls with nobody ever dying, on every stage and at every
  // player count. Waiting for the clock floor before retiring tiles only halved it.
  //
  // Retiring tiles is the escalation that actually bites, because it attacks what makes the
  // mode easy: how much safe ground there is to aim at. Fewer called tiles means further to
  // run and more people converging on the same square.
  //
  // Retirement happens BEFORE the deal, not after. Dealt first, the symbols are laid out over
  // a board that is about to lose two tiles, and retiring them can take away every tile of one
  // symbol — measured as exactly one unanswerable call per game, always on the step down to
  // the two-tile endgame. Shrinking first means shuffleTiles only ever deals over ground that
  // is really there.
  if (round.callRound >= level.shrinkAfter) retireTiles(round);
  shuffleTiles(round);
  round.called = null;
}

/**
 * Drop anybody who lost their footing, until they are out of sight in the crusher.
 *
 * Accelerating rather than linear, because a body and a tile falling at the same constant rate
 * read as one object — the player has to visibly come away from the platform they were
 * standing on. They keep falling a little past the crusher so nothing is left hanging in the
 * pit at the bottom of frame.
 */
function animateFallers(round, dt) {
  const floor = round.level.crusherDepth + 3;
  for (const p of round.players.values()) {
    if (p.fallY === null || p.fallY >= floor) continue;
    // v = g*t with g pinned to the tile fall rate, so the two are obviously the same gravity.
    p.fallVel = (p.fallVel || 0) + round.level.tileFall * 1.6 * dt;
    p.fallY = Math.min(floor, p.fallY + p.fallVel * dt);
  }
}

/** Is anybody still in the air? The round cannot end while there is. */
function anyoneFalling(round) {
  const floor = round.level.crusherDepth + 3;
  for (const p of round.players.values()) {
    if (p.fallY !== null && p.fallY < floor) return true;
  }
  return false;
}

/** How far this player has fallen through the floor, or 0. Read by the renderer. */
export function fallDepth(p) {
  return p.fallY === null ? 0 : p.fallY;
}

/** Move falling tiles down and returning tiles back up. Presentation only. */
function animateTiles(round, dt) {
  const { level } = round;
  const n = level.cols * level.rows;

  for (let i = 0; i < n; i++) {
    const s = round.tileState[i];
    if (s === TILE_FALLING) {
      round.tileDrop[i] += level.tileFall * dt;
    } else if (s === TILE_GONE) {
      round.tileDrop[i] = level.crusherDepth;
    } else if (s === TILE_RISING) {
      round.tileDrop[i] = Math.max(0, round.tileDrop[i] - level.tileFall * dt);
      if (round.tileDrop[i] <= 0) round.tileState[i] = TILE_SOLID;
    }
  }
}

/**
 * Kill anyone standing where the floor no longer is.
 *
 * Checked every frame rather than once at the moment of the drop, because a player can walk
 * off a solid tile onto a falling one during the drop phase — stepping into the hole after the
 * call has resolved has to be just as fatal as being caught on the wrong square.
 */
function checkFooting(round) {
  const { cols, rows } = round.level;

  for (const p of round.players.values()) {
    if (p.state !== ALIVE) continue;

    const tx = Math.floor(p.x);
    const tz = Math.floor(p.z);

    // Off the grid entirely — shoved past the edge. The stage is a platform in mid-air, so
    // there is nothing out there either, and going over the side has to look exactly like
    // dropping through a missing tile: the fall is started here for the same reason.
    if (tx < 0 || tz < 0 || tx >= cols || tz >= rows) {
      p.fallY = 0;
      down(round, p, "fell");
      continue;
    }

    const state = round.tileState[tz * cols + tx];
    if (state === TILE_FALLING || state === TILE_GONE) {
      // Begin the drop rather than merely dying. The rules resolve now — this player is out —
      // but they are still in the air, and both the renderer and checkOver read fallY to know
      // that the round is not finished being watched yet.
      p.fallY = 0;
      down(round, p, "fell");
    }
  }
}

/** Which symbol a tile carries. Read by the renderer. */
export function tileSymbolAt(round, tx, tz) {
  if (!round.tileSym) return SYM_X;
  if (tx < 0 || tz < 0 || tx >= round.level.cols || tz >= round.level.rows) return SYM_X;
  return round.tileSym[tz * round.level.cols + tx];
}

/** A tile's drop state and how far it has fallen. Read by the renderer. */
export function tileStateAt(round, tx, tz) {
  if (!round.tileState) return TILE_SOLID;
  if (tx < 0 || tz < 0 || tx >= round.level.cols || tz >= round.level.rows) return TILE_GONE;
  return round.tileState[tz * round.level.cols + tx];
}

export function tileDropAt(round, tx, tz) {
  if (!round.tileDrop) return 0;
  if (tx < 0 || tz < 0 || tx >= round.level.cols || tz >= round.level.rows) return 0;
  return round.tileDrop[tz * round.level.cols + tx];
}

/** How many calls have been survived. This is the score in calls mode. */
export function callRound(round) {
  return round.callRound;
}

/** How many machines are on the floor. Read by the HUD. */
export function roombaCount(round) {
  return round.roombas.length;
}

function stepPlayer(round, p, dt) {
  if (p.state !== ALIVE) return;

  // Ahead of the sniper's early return, so a shove thrown on the last frame before taking
  // the rifle still runs its animation out instead of freezing mid-swing.
  if (p.shoveFor > 0) p.shoveFor = Math.max(0, p.shoveFor - dt);

  // The sniper is bolted into the nest. Their stick aims the rifle instead of walking, which
  // is handled by aim() straight off the wire.
  if (round.mode === MODE_SNIPER && p.id === round.sniperId) { p.dx = 0; p.dz = 0; return; }

  if (p.pushCooldown > 0) p.pushCooldown -= dt;

  // Knocked down: no steering, but the slide still carries you.
  //
  // The slide runs through moveTo rather than writing x/z directly, so everything that makes
  // ground dangerous still applies while you are travelling — a player shoved onto a mine sets
  // it off, and one shoved over a hole in the calls grid falls through it. That is the entire
  // point of the mechanic, and skipping the collision path would quietly turn a shove into a
  // free ride across hazards.
  if (p.downFor > 0) {
    p.downFor -= dt;

    // Wait for the shover's hands to arrive before travelling. See knockDown.
    if (p.slideDelay > 0) {
      p.slideDelay = Math.max(0, p.slideDelay - dt);
      p.dx = 0;
      p.dz = 0;
      return;
    }

    const speed = Math.hypot(p.slideX, p.slideZ);
    if (speed > 0.01) {
      const fromX = p.x;
      const fromZ = p.z;
      const nx = fromX + p.slideX * dt;
      const nz = fromZ + p.slideZ * dt;

      const dist = Math.hypot(nx - fromX, nz - fromZ);
      const steps = Math.max(1, Math.ceil(dist / 0.12));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        if (!moveTo(round, p, fromX + (nx - fromX) * t, fromZ + (nz - fromZ) * t)) return;
      }

      // Friction, so the slide is a shove rather than a launch.
      const decay = Math.max(0, 1 - (PUSH_DRAG * dt) / Math.max(speed, 0.001));
      p.slideX *= decay;
      p.slideZ *= decay;
    } else {
      p.slideX = 0;
      p.slideZ = 0;
    }

    p.dx = 0;
    p.dz = 0;

    if (p.downFor <= 0) {
      p.downFor = 0;
      p.pushedBy = null;
      round.events.push({ type: "stood-up", id: p.id, x: p.x, z: p.z });
    }
    return;
  }

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

  // The calls stage has no walls — it is a platform hanging over a crusher, and its edge is a
  // drop rather than a boundary. But only a player who is being *carried* may go over it:
  // clamping is what stops someone walking themselves off by holding a direction, while a
  // shove has to be able to send them past the edge or the most interesting thing the
  // mechanic can do is quietly cancelled by an invisible handrail.
  //
  // checkFooting picks an off-board player up on the next tick and starts the fall.
  if (round.mode === MODE_CALLS && p.downFor > 0) {
    p.x = x;
    p.z = z;
    return true;
  }

  // The aisle walls. Only the gate at the far end is a way out.
  p.x = Math.max(0.32, Math.min(cols - 0.32, x));

  // Cover is solid, and each axis is resolved separately.
  //
  // Per-axis is what makes running the aisle feel right: a runner pushing diagonally into the
  // face of a block keeps the component that is clear and loses only the one that is blocked,
  // so they slide along cover instead of sticking to it. Rejecting the whole move would pin
  // anyone who brushed a corner, exactly when they are trying to get out of a laser.
  if (round.mode === MODE_SNIPER && round.cover) {
    const solid = (wx, wz) => {
      const tx = Math.floor(wx);
      const tz = Math.floor(wz);
      if (tx < 0 || tz < 0 || tx >= cols || tz >= rows) return false;
      return round.cover[tz * cols + tx] === 1;
    };

    const fromX = p.lastX ?? p.x;
    const fromZ = p.lastZ ?? z;

    // Try the x move on its own, then the z move on its own.
    if (solid(p.x, fromZ)) p.x = fromX;
    if (solid(p.x, z)) z = fromZ;

    p.lastX = p.x;
    p.lastZ = z;
  }

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
 * Distance travelled. No trail is left behind, in either mode.
 *
 * Footprints used to persist here as a navigation aid — a dotted line marking ground somebody
 * had crossed without exploding. They were removed from the game: on a bare arena floor they
 * marked nothing at all, and in the aisle they cluttered the one surface the sonar is trying
 * to communicate through, competing with the lit ground for the player's attention.
 *
 * `round.prints` stays as an always-empty array rather than being deleted. The renderer's
 * syncPrints, the round reset and the tests all read it, and an empty array costs nothing
 * while a missing field would be a null check in each of them.
 */
function dropPrint(round, p, dist) {
  p.distance += dist;
  p.lastPrintX = p.x;
  p.lastPrintZ = p.z;
}

function agePrints(round, dt) {
  for (const print of round.prints) print.age += dt;
  while (round.prints.length && round.prints[0].age > PRINT_LIFE) round.prints.shift();
}

/* --------------------------------------------------------------------- over */

function checkOver(round) {
  if (round.phase !== "running") return;
  if (round.players.size === 0) return;

  // The sniper is deliberately excluded from the head count. They are ALIVE for the whole
  // round by construction — nothing on the floor can reach the nest — so counting them would
  // mean a sniper round could never end, however cleanly the aisle was cleared.
  let stillPlaying = 0;
  let lastAlive = null;
  for (const p of round.players.values()) {
    if (!isRunner(round, p)) continue;
    if (p.state === ALIVE) { stillPlaying++; lastAlive = p; }
  }

  // Survival and calls share a win condition: last one standing. It ends when there is nobody
  // left, or one person left with nobody to beat. A solo game is the exception — with one
  // player seated there is no "last one standing" to reach, so it runs until they are down.
  if (round.mode === MODE_SURVIVAL || round.mode === MODE_CALLS) {
    const contested = countContenders(round) > 1;
    if (stillPlaying > (contested ? 1 : 0)) return;

    // Let the last drop finish before calling it. The rules resolved the moment the tile went,
    // but ending here would cut to the results card with a body still in mid-air — the fall
    // is how a player learns they lost, and it has to be allowed to land.
    if (round.mode === MODE_CALLS && anyoneFalling(round)) return;

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
      // Calls scores in rounds survived rather than seconds; the screen picks which to show.
      calls: round.mode === MODE_CALLS ? round.callRound : 0,
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
  for (const p of round.players.values()) {
    if (p.state === WAITING || !isRunner(round, p)) continue;
    n++;
  }
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
