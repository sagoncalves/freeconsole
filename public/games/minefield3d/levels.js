/**
 * Level definitions for Minefield Escape 3D.
 *
 * A level is pure data: the aisle's dimensions, how thickly it is mined, how the personal
 * sonar behaves, how fast the killer walks, and how many survivors the gate lets through.
 *
 * The aisle is long and narrow rather than a wide field — the camera looks down it at an
 * angle, so depth is the axis you read best and width is the axis you can actually judge.
 * Players start at the near end (high z) and walk toward the gate at the far end (z = 0).
 *
 * Coordinates are in TILES throughout. The sim works in tile-space floats; the renderer
 * scales tiles to world units.
 */

/**
 * @typedef {object} Level
 * @property {string} name
 * @property {string} tagline
 * @property {number} cols          Aisle width in tiles.
 * @property {number} rows          Aisle length in tiles.
 * @property {number} mineDensity   Fraction of eligible tiles mined.
 * @property {number} sonarPeriod   Seconds between each player's own pings.
 * @property {number} sonarRadius   How far a ping reaches, in tiles.
 * @property {number} sonarHold     Seconds a revealed mine stays lit after the ring passes.
 * @property {number} sonarSpeed    Tiles/second the personal ring expands.
 * @property {number} killerSpeed   Tiles/second the killer advances.
 * @property {number} killerDelay   Seconds before it starts moving.
 * @property {number} exitCapacity  Survivors admitted before the gate shuts.
 * @property {number} exitWidth     Gate width in tiles, centred on the far end.
 * @property {number} safeRows      Rows at the near end guaranteed clear.
 */

/** @type {Level[]} */
export const LEVELS = [
  {
    name: "The Aisle",
    tagline: "Your light only reaches so far. Theirs reaches somewhere else.",
    // Narrow and long. The width is small enough that a personal sonar radius covers a real
    // fraction of it, which is what makes standing near someone else meaningful.
    cols: 11,
    rows: 30,
    // Roughly 0.8 mines per row. Denser than this and every single row contains a hazard,
    // which stops the field being something you read and turns it into a toll you pay —
    // measured at 0.15, only 13% of survivors still had both legs at the gate.
    mineDensity: 0.09,

    // The personal ping. Radius is the whole game: it must cover enough ground to plan a
    // couple of steps, and little enough that the far end of the aisle is always unknown.
    sonarPeriod: 2,
    sonarRadius: 4.2,
    sonarHold: 0.75,
    sonarSpeed: 9,

    // Tuned against the crossing times this aisle implies — see the balance section of
    // scripts/test-minefield3d.mjs, which fails if a careful player cannot get across.
    killerSpeed: 1.05,
    killerDelay: 5,

    exitCapacity: 3,
    exitWidth: 3,
    safeRows: 2,
  },

  // Later levels turn one or two dials each, so a room can feel what changed. The radius
  // itself is the most dramatic dial there is: shrinking it is the difference between
  // walking and groping.
  {
    name: "Dimmer",
    tagline: "The batteries are going. You can see about half as far.",
    cols: 11,
    rows: 30,
    mineDensity: 0.11,
    sonarPeriod: 2.2,
    sonarRadius: 3.0,
    sonarHold: 0.7,
    sonarSpeed: 9,
    killerSpeed: 1.1,
    killerDelay: 4,
    exitCapacity: 3,
    exitWidth: 3,
    safeRows: 2,
  },
  {
    name: "Slow Pulse",
    tagline: "One ping every four seconds. Count them.",
    cols: 11,
    rows: 32,
    mineDensity: 0.105,
    sonarPeriod: 4,            // the long gap between pings is the level
    sonarRadius: 4.0,
    sonarHold: 0.7,
    sonarSpeed: 9,
    killerSpeed: 1.05,
    killerDelay: 4,
    exitCapacity: 2,
    exitWidth: 3,
    safeRows: 2,
  },
  {
    name: "One Door",
    tagline: "It only opens once. Decide who that is on the way.",
    cols: 9,
    rows: 32,
    mineDensity: 0.12,
    sonarPeriod: 3,
    sonarRadius: 3.2,
    sonarHold: 0.6,
    sonarSpeed: 9,
    killerSpeed: 1.25,
    killerDelay: 3,
    exitCapacity: 1,           // exactly one survivor
    exitWidth: 2,
    safeRows: 2,
  },
];

/** Levels are addressed by index everywhere; clamp so a bad index cannot crash a round. */
export function getLevel(index) {
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, index | 0))];
}

/* ------------------------------------------------------------------- survival */

/**
 * Survival mode — "Sawfloor".
 *
 * The escape levels above are a crossing: a corridor, a gate, and a press behind you that
 * makes hesitating expensive. Survival throws all three away. There is no gate, nothing to
 * cross to, and no direction that counts as progress. You are in a room with machines, and
 * the only question is how long you last.
 *
 * That inversion is why it needs its own arenas rather than a flag on the ones above. A long
 * narrow aisle is exactly wrong for it: with walls that close on two sides, a saw that picks
 * you cannot be circled, and the whole mode is circling. These rooms are wide and roughly
 * square so there is always somewhere to go — the pressure has to come from the machines
 * choosing you, never from the geometry running out.
 *
 * The minefield stays, and it changes meaning completely. In the aisle a mine is a toll on
 * the way somewhere. Here it is terrain you kite across: the saws detonate what they roll
 * over, so the safest floor in the room is the ground a roomba has already cleared, and
 * getting it cleared means letting one chase you over it.
 *
 * @typedef {object} Arena
 * @property {string} name
 * @property {string} tagline
 * @property {number} cols          Room width in tiles.
 * @property {number} rows          Room depth in tiles.
 * @property {number} mineDensity   Fraction of eligible tiles mined.
 * @property {number} sonarPeriod   Seconds between each player's own pings.
 * @property {number} sonarRadius   How far a ping reaches, in tiles.
 * @property {number} sonarHold     Seconds a revealed mine stays lit after the ring passes.
 * @property {number} sonarSpeed    Tiles/second the personal ring expands.
 * @property {number} startRoombas  How many saws are on the floor at the opening bell.
 * @property {number} waveEvery     Seconds between reinforcements.
 * @property {number} maxRoombas    Hard cap, so a long round cannot become a slideshow.
 * @property {number} roombaSpeed   Tiles/second while wandering.
 * @property {number} roombaChase   Tiles/second while it has someone.
 * @property {number} roombaSense   How close you must be for one to notice you, in tiles.
 * @property {number} safeRadius    Mine-free circle around the spawn ring.
 */

/** @type {Arena[]} */
export const ARENAS = [
  {
    name: "Sawfloor",
    tagline: "Nothing to cross to. Just outlast the machines.",
    // Wide and square-ish. You must always be able to go around a saw rather than being
    // walled into a corner by the room itself.
    cols: 22,
    rows: 22,
    // Thinner than the aisle. The mines are a second hazard layered under the first here,
    // not the main event, and aisle density in an open room means every dodge is a coin flip.
    mineDensity: 0.055,

    // A shorter period than the aisle's. Survival is played in constant motion, and a
    // two-second blackout while something is actively hunting you is not a tense wait, it is
    // an unreadable one.
    sonarPeriod: 1.6,
    sonarRadius: 5.0,
    sonarHold: 0.8,
    sonarSpeed: 10,

    startRoombas: 2,
    waveEvery: 20,
    maxRoombas: 9,
    // Slower than a walking player (3.0) on purpose. A saw must never simply catch someone
    // in a straight line — it wins by cornering, by numbers, and by the mines you back into.
    roombaSpeed: 1.5,
    roombaChase: 2.35,
    roombaSense: 6.0,
    safeRadius: 3.2,
  },
  {
    name: "The Grinder",
    tagline: "More of them, sooner, and they can smell you further off.",
    cols: 24,
    rows: 22,
    mineDensity: 0.07,
    sonarPeriod: 1.8,
    sonarRadius: 4.4,
    sonarHold: 0.7,
    sonarSpeed: 10,
    startRoombas: 3,
    waveEvery: 16,
    maxRoombas: 12,
    roombaSpeed: 1.7,
    roombaChase: 2.6,
    roombaSense: 7.5,
    safeRadius: 3.0,
  },
  {
    name: "Lights Out",
    tagline: "They see you better than you see the floor.",
    cols: 20,
    rows: 20,
    // The dial this arena turns is the sonar, not the saw count: a radius this short means
    // you are reading the floor from the sparks off their blades as much as your own ping.
    mineDensity: 0.085,
    sonarPeriod: 2.2,
    sonarRadius: 3.2,
    sonarHold: 0.6,
    sonarSpeed: 10,
    startRoombas: 2,
    waveEvery: 15,
    maxRoombas: 10,
    roombaSpeed: 1.6,
    roombaChase: 2.5,
    // A long nose, on purpose: this is the arena where they find you before you find the
    // floor. It is affordable here only because the opening pack is small — headless runs with
    // three starters ended at a 29s median, before the first wave had even landed, so the
    // escalation this mode is built on never got to happen.
    roombaSense: 8.5,
    safeRadius: 3.0,
  },
];

/** Arenas are addressed by index exactly as levels are, and clamped the same way. */
export function getArena(index) {
  return ARENAS[Math.max(0, Math.min(ARENAS.length - 1, index | 0))];
}
