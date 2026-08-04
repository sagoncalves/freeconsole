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
    // Wider than it is deep, so a landscape TV is filled rather than letterboxed, and so
    // *where* to cross is a real decision instead of a corridor everyone walks single file.
    // The depth still has to be enough that losing legs is a sentence rather than an
    // inconvenience — see killerSpeed.
    cols: 30,
    rows: 20,
    // Level one. Thin enough that a player who watches the pulses gets across about three
    // times in four, while walking blind is close to hopeless — the density is the dial that
    // sets that gap, and later levels turn it up.
    mineDensity: 0.15,
    sonarPeriod: 2,
    sonarHold: 0.55,
    sonarSpeed: 26,
    // Tuned against the crossing times this field implies: walking it takes ~5.8s, limping
    // ~10.9s, crawling ~23s. At this speed the killer sweeps the field in ~19s, so a walker
    // is comfortably clear, a limper is racing it, and a crawler is almost certainly caught.
    // That is the entire point of taking legs instead of lives — the punishment for a mine
    // is that the thing behind you stops being survivable.
    killerSpeed: 1.15,
    killerDelay: 4,
    exitCapacity: 3,
    exitWidth: 4,
    safeRows: 2,
  },

  // Each level after the first turns exactly one or two dials, so a room can feel what
  // changed. Difficulty comes from the field and the clock, never from taking away the
  // sonar entirely — a player must always be able to earn their crossing.
  {
    name: "Thicker Ground",
    tagline: "More of it under the soil. The same two seconds of light.",
    cols: 30,
    rows: 20,
    mineDensity: 0.21,
    sonarPeriod: 2,
    sonarHold: 0.5,
    sonarSpeed: 26,
    killerSpeed: 1.2,
    killerDelay: 4,
    exitCapacity: 3,
    exitWidth: 3,
    safeRows: 2,
  },
  {
    name: "Long Dark",
    tagline: "The pulse comes slower out here. You will be walking on memory.",
    cols: 30,
    rows: 22,
    mineDensity: 0.20,
    sonarPeriod: 3.2,          // the long gap is the level
    sonarHold: 0.45,
    sonarSpeed: 26,
    killerSpeed: 1.15,
    killerDelay: 4,
    exitCapacity: 2,
    exitWidth: 3,
    safeRows: 2,
  },
  {
    name: "The Narrows",
    tagline: "One way out, and it only takes one of you.",
    cols: 26,
    rows: 22,
    mineDensity: 0.22,
    sonarPeriod: 2.6,
    sonarHold: 0.45,
    sonarSpeed: 26,
    killerSpeed: 1.35,
    killerDelay: 3,
    exitCapacity: 1,           // exactly one survivor; the rest is arithmetic
    exitWidth: 2,
    safeRows: 2,
  },
];

/** Levels are addressed by index everywhere; clamp so a bad index cannot crash a round. */
export function getLevel(index) {
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, index | 0))];
}
