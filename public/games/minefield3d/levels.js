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
