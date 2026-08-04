/**
 * Level definitions for Minefield Escape.
 *
 * A level is pure data: the field size, how thickly it is mined, how fast the killer walks,
 * how the sonar behaves, and how many survivors the gate lets through before it shuts. The
 * sim reads these and nothing else, so a new level is an entry in LEVELS and no new code.
 *
 * Coordinates are in TILES. The sim works in tile-space floats — 3.5 is the middle of tile 3
 * — so movement is smooth but the minefield stays a grid you can reason about.
 */

/** Every level shares the tile size; only the field dimensions change. */
export const TILE = 1;

/**
 * @typedef {object} Level
 * @property {string} name          Shown on the screen between rounds.
 * @property {string} tagline       One line of flavour under the name.
 * @property {number} cols          Field width in tiles.
 * @property {number} rows          Field height in tiles. Players start at the bottom.
 * @property {number} mineDensity   Fraction of eligible tiles that are mined.
 * @property {number} sonarPeriod   Seconds between pulses.
 * @property {number} sonarHold     Seconds a revealed mine stays visible after the ring passes.
 * @property {number} sonarSpeed    Tiles per second the ring expands. Far mines reveal late.
 * @property {number} killerSpeed   Tiles per second the killer advances.
 * @property {number} killerDelay   Seconds before the killer starts moving.
 * @property {number} exitCapacity  Survivors the gate admits before it closes for good.
 * @property {number} exitWidth     Gate width in tiles, centred on the top edge.
 * @property {number} safeRows      Rows at the bottom guaranteed clear, so nobody dies at spawn.
 */

/** @type {Level[]} */
export const LEVELS = [
  {
    name: "The Crossing",
    tagline: "Six hundred metres of tilled earth. Something is walking behind you.",
    cols: 19,
    rows: 24,
    mineDensity: 0.17,
    sonarPeriod: 2,
    sonarHold: 0.55,
    sonarSpeed: 26,
    killerSpeed: 0.62,
    killerDelay: 5,
    exitCapacity: 3,
    exitWidth: 3,
    safeRows: 2,
  },
];

/** Levels are addressed by index everywhere; clamp so a bad index cannot crash a round. */
export function getLevel(index) {
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, index | 0))];
}
