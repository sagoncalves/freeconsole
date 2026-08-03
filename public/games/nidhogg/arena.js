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
 *
 * ---------------------------------------------------------------------------------------
 * REACHABILITY BUDGET - every layout below is built against these numbers.
 *
 * The whole game is territorial: if a screen cannot be crossed on foot, the match is not
 * merely awkward, it is unwinnable, because the goal sits behind it. So obstacles are sized
 * from the measured character controller, not by eye.
 *
 *   JUMP_RISE      103   feet clear this far above the surface jumped from
 *   BODY_H          68   standing height
 *   DUCK_H          42   ducking
 *   CRAWL_H         26   crawling
 *
 * Rules:
 *   - A platform meant to be JUMPED ONTO must have its top <= ~95 above the floor it is
 *     reached from. Anything in 96..103 is a coin flip and reads as a bug; above that it is
 *     simply unreachable.
 *   - A gap meant to be CRAWLED THROUGH needs >= 30 clear under it (CRAWL_H + slack).
 *   - A gap meant to be WALKED through needs >= 74 (BODY_H + slack).
 *   - Nothing may span the full height of a screen. A floor-to-ceiling column is a wall, and
 *     a wall across the strip makes the goal behind it unreachable.
 *
 * `assertTraversable()` at the bottom of this file checks the first and last of these at
 * module load, so a bad edit fails loudly instead of shipping an unwinnable arena.
 * ---------------------------------------------------------------------------------------
 */
function platform(x, y, w, h) {
  return { x, y, w, h };
}

/** Measured apex of a jump, in world units. See the reachability budget above. */
export const JUMP_RISE = 103;
/** Highest surface top (above the floor it is reached from) that is comfortably jumpable. */
export const MAX_STEP_UP = 95;

/** Per-screen furniture, expressed relative to that screen's left edge. */
const SCREEN_LAYOUTS = {
  // Centre: symmetric, two low ledges either side of a clear duelling floor. Tops at y=350
  // are 80 above the floor, well inside the jump budget, so either fencer can take the high
  // ground in one hop and the middle stays open for the opening exchange.
  0: [
    platform(120, 350, 180, 18),
    platform(660, 350, 180, 18),
  ],
  // Inner screens: a low ledge into a higher catwalk, so the top is reached in two hops
  // rather than one impossible one. The hanging pillar gives a wall-jump face and never
  // reaches the floor - a floor-to-ceiling column is a wall, and a wall across the strip makes
  // the goal behind it unreachable.
  //
  // The pillar is also kept clear of the step ledge's span. Hanging it directly over the ledge
  // left a 14px slot between the two, which is a wall for anyone standing on the step even
  // though the pillar looks like it clears the floor by miles - headroom has to be measured
  // from the surface actually walked on, not from y=GROUND_Y.
  1: [
    platform(560, 350, 200, 18),   // step: 80 above the floor
    platform(140, 262, 220, 18),   // catwalk: 88 above the step's top
    platform(400, 214, 24, 120),   // pillar - wall-jump face, over open floor
  ],
  "-1": [
    platform(200, 350, 200, 18),
    platform(600, 262, 220, 18),
    platform(536, 214, 24, 120),
  ],
  // Chokepoints: a genuine low crawl gap under a thick slab, plus a route over the top.
  //
  // The previous version put pillars from the slab down to the floor, which sealed the gap
  // completely and made these screens - and therefore both goals behind them - impassable.
  // The slab now floats: 44 clear underneath (crawl needs 26) and its top is 62 above the
  // side ledges, so you may go under it or over it, but never through.
  2: [
    platform(300, 360, 360, 26),   // the slab, 44 clear beneath for a crawl
    platform(120, 352, 120, 18),   // approach ledge, 78 up
    platform(720, 352, 120, 18),
  ],
  "-2": [
    platform(300, 360, 360, 26),
    platform(120, 352, 120, 18),
    platform(720, 352, 120, 18),
  ],
  // Risky jump: a pit with stepping platforms. Falling in is lethal and this screen sits
  // between the players and a goal, so the gaps are sized with real margin rather than to the
  // limit - a running jump covers ~200px horizontally, and the widest gap here is 110. The
  // risk is meant to come from fighting on narrow footing, not from a jump you can just miss.
  3: [
    platform(130, 372, 180, 18),
    platform(420, 344, 180, 18),
    platform(710, 372, 180, 18),
  ],
  "-3": [
    platform(130, 372, 180, 18),
    platform(420, 344, 180, 18),
    platform(710, 372, 180, 18),
  ],
  // Last stand before the goal: open, so the defender has room but nowhere to hide.
  4: [platform(300, 350, 200, 18)],
  "-4": [platform(460, 350, 200, 18)],
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
  const solids = buildSolids();

  /** Room for a standing body here, with solid floor directly beneath? */
  function usable(x) {
    const bodyLeft = x - 13;
    const bodyTop = GROUND_Y - 68;
    for (const s of solids) {
      if (s.y >= GROUND_Y) continue;   // ground itself is the floor, not an obstruction
      if (bodyLeft < s.x + s.w && bodyLeft + 26 > s.x && bodyTop < s.y + s.h && bodyTop + 68 > s.y) {
        return false;
      }
    }
    // Must actually have floor under the feet - never spawn over a pit.
    return solids.some((s) => s.y >= GROUND_Y && x >= s.x && x < s.x + s.w);
  }

  const points = [];
  for (let i = MIN_SCREEN; i <= MAX_SCREEN; i++) {
    const left = screenLeft(i);

    // Two spawns per screen, searched outward from the quarter marks rather than hardcoded.
    //
    // Fixed coordinates are what kept breaking here: every time a layout was retuned the
    // ledges moved under the spawn points and players started arriving wedged inside them.
    // Deriving the position from the geometry means a spawn cannot go stale when furniture
    // moves - the worst case is that it slides a little along the floor.
    for (const target of [SCREEN_W * 0.25, SCREEN_W * 0.75]) {
      let chosen = null;
      for (let offset = 0; offset <= SCREEN_W * 0.4 && chosen === null; offset += 10) {
        for (const candidate of [target - offset, target + offset]) {
          if (candidate < 40 || candidate > SCREEN_W - 40) continue;
          if (usable(left + candidate)) { chosen = candidate; break; }
        }
      }
      if (chosen !== null) points.push({ x: left + chosen, y: GROUND_Y });
    }
  }
  return points;
}

/**
 * The pit floor. Falling below this is death by environment (spec 12) on the pit screens; on
 * every other screen the ground catches the player first.
 */
export const KILL_Y = SCREEN_H + 60;

/* ------------------------------------------------------------------ sanity check */

/**
 * Reject any arena a player could not physically cross.
 *
 * This is a load-time assertion rather than a test because the failure it catches is silent
 * and total: a screen that cannot be traversed sits between a player and the opponent's goal,
 * so the match becomes unwinnable while everything still looks and plays fine up close. That
 * shipped once already - the chokepoint screens had pillars sealing the crawl gap, and the
 * only symptom was "I can't get past".
 *
 * It walks each screen in 4px columns and asks whether a standing or crawling body has any
 * clear band between the floor and the top of the screen. A column with no clear band is a
 * full-height wall, which means no route past it.
 */
function assertTraversable() {
  const solids = buildSolids();
  const problems = [];

  for (let i = MIN_SCREEN; i <= MAX_SCREEN; i++) {
    const left = screenLeft(i);
    let walled = null;
    let crushed = null;

    for (let x = left + 2; x < left + SCREEN_W; x += 4) {
      // Everything overlapping this column, as [top, bottom] bands.
      const spans = solids
        .filter((s) => x >= s.x && x < s.x + s.w && s.y < GROUND_Y)
        .map((s) => [s.y, s.y + s.h])
        .sort((a, b) => a[0] - b[0]);

      // Walk down from the top of the screen looking for a gap at least CRAWL-high that sits
      // on or above the floor. The floor itself bounds the search.
      let clear = false;
      let cursor = 0;
      for (const [top, bottom] of spans) {
        if (top - cursor >= 30) { clear = true; break; }
        cursor = Math.max(cursor, bottom);
      }
      if (!clear && GROUND_Y - cursor >= 30) clear = true;
      if (!clear && walled === null) walled = Math.round(x - left);

      // Headroom over every walkable surface in this column, not just over the floor. A slab
      // hanging low over a ledge is invisible to a floor-only check but is a wall to anyone
      // standing on that ledge.
      const surfaces = [GROUND_Y, ...spans.map(([top]) => top)];
      for (const surfaceTop of surfaces) {
        // The nearest solid whose bottom is above this surface.
        let ceiling = 0;
        for (const [top, bottom] of spans) {
          if (bottom <= surfaceTop && bottom > ceiling) ceiling = bottom;
        }
        const headroom = surfaceTop - ceiling;
        if (headroom > 0 && headroom < 30 && crushed === null) {
          crushed = `local x=${Math.round(x - left)} (only ${Math.round(headroom)} over a surface at y=${surfaceTop})`;
        }
      }
    }

    if (walled !== null) problems.push(`screen ${i} is walled at local x=${walled}`);
    if (crushed !== null) problems.push(`screen ${i} has an unpassable gap: ${crushed}`);

    // Horizontal gaps between landable surfaces. A running jump covers ~200px, so anything
    // beyond MAX_LEAP is a hole the player cannot get over - and on the pit screens, falling
    // in is fatal, which turns an over-wide gap into an impassable screen.
    const MAX_LEAP = 170;
    const tops = solids
      .filter((s) => s.x < left + SCREEN_W && s.x + s.w > left && s.y <= GROUND_Y)
      .map((s) => ({ from: s.x, to: s.x + s.w }))
      .sort((a, b) => a.from - b.from);
    let reach = left;
    for (const t of tops) {
      if (t.from > reach + MAX_LEAP) {
        problems.push(
          `screen ${i} has a ${Math.round(t.from - reach)}px gap at local x=${Math.round(reach - left)}, ` +
          `beyond the ~${MAX_LEAP}px a running jump clears`
        );
        break;
      }
      reach = Math.max(reach, t.to);
    }
  }

  if (problems.length) {
    throw new Error(
      "nidhogg arena is not traversable, so the match would be unwinnable:\n  " +
        problems.join("\n  ")
    );
  }
}

assertTraversable();
