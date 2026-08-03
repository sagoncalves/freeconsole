/**
 * Arena geometry.
 *
 * The map is a horizontal strip of fixed-size screens. Only one is ever visible - the camera
 * snaps between them and never zooms or free-scrolls (spec 3, 25). Screen indices run from
 * -SCREENS..+SCREENS with 0 as the centre; each player owns the far edge past the last screen
 * on their side.
 *
 * All geometry is in world units where 1 unit = 1 pixel at the reference resolution, so the
 * sim never has to know about the canvas size. The screen scales the whole thing at draw time.
 */

export const SCREEN_W = 960;
export const SCREEN_H = 540;

/** Screens either side of centre. 4 -> nine screens total, matching the spec's diagram. */
export const SCREENS = 4;

/** Index of the leftmost / rightmost playable screen. */
export const MIN_SCREEN = -SCREENS;
export const MAX_SCREEN = SCREENS;

/** Ground line for flat terrain. Platforms sit above it. */
export const GROUND_Y = 430;

/** World x of a screen's left edge. */
export function screenLeft(index) {
  return index * SCREEN_W;
}

/** The screen index containing a world x. */
export function screenAt(x) {
  return Math.floor(x / SCREEN_W);
}

/** Total playable width, from the left goal line to the right goal line. */
export const WORLD_LEFT = screenLeft(MIN_SCREEN);
export const WORLD_RIGHT = screenLeft(MAX_SCREEN) + SCREEN_W;

/**
 * Goal lines. Player 0 (left team) advances rightward and scores by crossing GOAL_RIGHT;
 * player 1 does the mirror. Reaching your opponent's edge is the only win condition (spec 2).
 */
export const GOAL_LEFT = WORLD_LEFT;
export const GOAL_RIGHT = WORLD_RIGHT;

/**
 * Solid boxes. Each is {x, y, w, h} in world units, with y measured downward from the top of
 * the screen band. Platforms are one-sided only in the sense that they are landable from any
 * direction - the controller resolves the shallowest axis, so walking off an edge falls.
 *
 * Layout notes per spec 34: each screen mixes open field, at least one platform, and a
 * vertical route, so there is always a way past a camper without a straight duel.
 */
function platform(x, y, w, h) {
  return { x, y, w, h };
}

/** Per-screen furniture, expressed relative to that screen's left edge. */
const SCREEN_LAYOUTS = {
  // Centre: symmetric, two raised ledges either side of a clear duelling floor.
  0: [
    platform(120, 320, 180, 20),
    platform(660, 320, 180, 20),
  ],
  // Inner screens: a single high catwalk, reachable by wall-jumping the pillar.
  //
  // The pillar hangs from above rather than reaching the floor. A floor-to-ceiling column
  // walls a screen in half - a player who respawns on the wrong side of it is fenced off from
  // the direction they are trying to advance, which is the opposite of a route. Ending it at
  // y=340 leaves a run-through gap underneath and still gives a face to wall-jump.
  1: [
    platform(80, 250, 240, 20),
    platform(560, 340, 200, 20),
    platform(600, 170, 24, 170),   // pillar - wall-jump route, clear of the floor
  ],
  "-1": [
    platform(640, 250, 240, 20),
    platform(200, 340, 200, 20),
    platform(336, 170, 24, 170),
  ],
  // Chokepoints: a low crawl gap under a thick slab.
  2: [
    platform(240, 300, 480, 26),
    platform(240, 326, 30, 104),
    platform(690, 326, 30, 104),
  ],
  "-2": [
    platform(240, 300, 480, 26),
    platform(240, 326, 30, 104),
    platform(690, 326, 30, 104),
  ],
  // Risky jump: a pit with two stepping platforms. Falling in is not lethal but costs tempo.
  3: [
    platform(140, 360, 130, 20),
    platform(400, 300, 130, 20),
    platform(680, 360, 130, 20),
  ],
  "-3": [
    platform(150, 360, 130, 20),
    platform(430, 300, 130, 20),
    platform(690, 360, 130, 20),
  ],
  // Last stand before the goal: open, so the defender has room but nowhere to hide.
  4: [platform(300, 300, 200, 20)],
  "-4": [platform(460, 300, 200, 20)],
};

/**
 * Build the full solid list in world coordinates: the floor of every screen, the side walls
 * at the extreme goal lines, plus each screen's furniture.
 */
export function buildSolids() {
  const solids = [];

  for (let i = MIN_SCREEN; i <= MAX_SCREEN; i++) {
    const left = screenLeft(i);
    // Floor. Screens 3 and -3 have a pit in the middle instead of a continuous floor.
    if (i === 3 || i === -3) {
      solids.push(platform(left, GROUND_Y, 120, SCREEN_H - GROUND_Y));
      solids.push(platform(left + SCREEN_W - 120, GROUND_Y, 120, SCREEN_H - GROUND_Y));
    } else {
      solids.push(platform(left, GROUND_Y, SCREEN_W, SCREEN_H - GROUND_Y));
    }

    const layout = SCREEN_LAYOUTS[String(i)] || [];
    for (const p of layout) solids.push(platform(left + p.x, p.y, p.w, p.h));
  }

  // Goal walls: the strip is closed at both ends so nobody walks out of the world. Crossing
  // into the goal is detected before the wall is reached, so these only matter as a backstop.
  solids.push(platform(WORLD_LEFT - 40, 0, 40, SCREEN_H));
  solids.push(platform(WORLD_RIGHT, 0, 40, SCREEN_H));

  return solids;
}

/**
 * Spawn points, in world units. Respawning picks the nearest one *ahead* of the attacker
 * (spec 5, 27), so they are dense enough that "ahead" always has a candidate but far enough
 * apart that a respawn is never in the attacker's lap.
 */
export function buildSpawnPoints() {
  const points = [];
  for (let i = MIN_SCREEN; i <= MAX_SCREEN; i++) {
    const left = screenLeft(i);
    // Two per screen. The default is the quarter marks, but screens whose furniture covers
    // those spots get their own pair - a spawn point has to have room for a standing body
    // above it, or the player arrives wedged and cannot walk out.
    if (i === 3 || i === -3) {
      // Pit screens: stay on the solid lips either side of the gap.
      points.push({ x: left + 60, y: GROUND_Y });
      points.push({ x: left + SCREEN_W - 60, y: GROUND_Y });
    } else if (i === 2 || i === -2) {
      // Chokepoint screens: outside the low slab, which spans local x 240..720.
      points.push({ x: left + 140, y: GROUND_Y });
      points.push({ x: left + SCREEN_W - 140, y: GROUND_Y });
    } else {
      points.push({ x: left + SCREEN_W * 0.25, y: GROUND_Y });
      points.push({ x: left + SCREEN_W * 0.75, y: GROUND_Y });
    }
  }
  return points;
}

/**
 * The pit floor. Falling below this is death by environment (spec 12) on the pit screens; on
 * every other screen the ground catches the player first.
 */
export const KILL_Y = SCREEN_H + 60;
