/**
 * Graphics quality tiers for Neon Pong.
 *
 * The fourth game to get tiers, and the first 2D one — so none of the levers from chess3d,
 * Rope Raid or Beach Volley apply. There are no draw calls to cut, no shadow map, no meshes
 * and no textures. Everything here is Canvas2D, and Canvas2D has its own expensive corners.
 *
 * What a frame here actually costs, worst first:
 *
 *   1. **`shadowBlur`.** By far the dominant cost. Canvas2D implements it as a real gaussian
 *      over the shape's bounding box, and on most TV browsers it is software-rasterised —
 *      it does not touch the GPU at all. Every wall, paddle, the ball, the trail and every
 *      effect asked for one, so a busy octagon frame was ~20 separate blurs. This is the
 *      single thing worth removing on a weak display, and removing it changes nothing about
 *      where anything is.
 *   2. **Gradients rebuilt per frame.** `createRadialGradient`/`createLinearGradient` are not
 *      free objects: each one allocates and re-rasterises its ramp. The arena backdrop built
 *      one every frame, and each damaged wall built another for its flash. On a 4K TV canvas
 *      the backdrop gradient alone fills 8M pixels per frame.
 *   3. **The ball trail.** 14 stacked translucent arcs, each with its own `shadowBlur` at the
 *      top tier. Overdraw on the most-repainted part of the screen.
 *   4. **Particles.** A destroyed wall spawns 14 shards, each an arc with a blur.
 *   5. **Fill rate.** Canvas backing-store size, which on a 4K set is enormous for artwork
 *      nobody can resolve from a sofa.
 *
 * The tiers below turn those off in cost order. Crucially **none of them touch the sim**: the
 * arena, the paddles, the ball and every collision are identical at every tier, so a TV on Low
 * and a laptop on High are playing exactly the same match and see the same result. What
 * changes is only how much decoration is painted on top.
 */

/** @typedef {"low"|"medium"|"high"} Tier */

export const TIERS = {
  high: {
    label: "High",
    note: "Full glow, trails and particles",
    /** Multiplier on every shadowBlur radius. 0 disables blur entirely. */
    glow: 1,
    /**
     * Which classes of object get a blur at all.
     *
     * The lever that actually matters. Blur cost scales with the *number* of blurred draws
     * per frame far more than with each one's radius, and the counts are lopsided: there is
     * one ball but up to eight walls, eight paddles and a dozen effects. Naming the classes
     * lets a tier keep the glow where there is one of a thing and drop it where there are
     * many.
     */
    glowParts: { walls: true, paddles: true, ball: true, fx: true },
    /** Radial gradient behind the arena. Falls back to a flat fill when off. */
    gradients: true,
    /** Length of the ball's motion trail, in samples. 0 disables it. */
    trail: 14,
    /** Blur the trail segments. The trail is the most overdrawn thing on screen. */
    trailGlow: true,
    /** Shards spawned when a wall is destroyed. */
    shards: 14,
    /** Expanding rings on paddle hits and damage. */
    rings: true,
    /** The inward wash of colour when a wall takes a hit. */
    wallFlash: true,
    /** Concentric grid rings inside the arena. */
    grid: true,
    maxPixelRatio: 2,
    targetFps: 0,          // 0 = uncapped
  },
  medium: {
    label: "Medium",
    note: "Glow on the ball and walls only",
    // A tighter radius, but the real saving is `glowParts` below: halving the radius alone
    // barely helps, because the cost is dominated by how *many* blurs are issued per frame,
    // not how wide each one is. A busy octagon issues one per wall, per paddle, per effect.
    glow: 0.6,
    // Walls carry the damage colour and the ball is what everyone tracks, so those keep their
    // glow. Paddles and effects are the numerous ones and lose it — that is ~14 of the ~24
    // blurs in a busy octagon frame, for the two things whose position is already obvious
    // from their solid fill.
    glowParts: { walls: true, paddles: false, ball: true, fx: false },
    gradients: true,
    trail: 7,
    trailGlow: false,
    shards: 8,
    rings: true,
    wallFlash: true,
    grid: true,
    maxPixelRatio: 1.5,
    targetFps: 0,
  },
  low: {
    label: "Low",
    note: "For TVs — flat colours, no blur",
    // No blur anywhere. This is the whole point of the tier: on a TV browser every
    // shadowBlur is a software gaussian, and a frame with twenty of them cannot hold 30fps
    // no matter what else is cut. The game is drawn in flat, fully-saturated neon instead,
    // which at TV distance reads as bright rather than as missing.
    glow: 0,
    glowParts: { walls: false, paddles: false, ball: false, fx: false },
    // Flat fills. A radial gradient over a 4K canvas every frame is pure waste for a
    // backdrop nobody looks at.
    gradients: false,
    trail: 0,
    trailGlow: false,
    shards: 0,
    // Rings and the wall wash are the two effects that carry information — a hit landed,
    // and on whom. They are kept as cheap unblurred strokes rather than dropped, because
    // losing them would make the game harder to read, not just plainer.
    rings: true,
    wallFlash: true,
    grid: false,
    maxPixelRatio: 1,
    targetFps: 30,
  },
};

export const DEFAULT_QUALITY = "auto";

/** Every value the admin can choose, in the order the UI should show them. */
export const QUALITY_CHOICES = ["auto", "high", "medium", "low"];

/**
 * Guess a tier for this device.
 *
 * The same probe as the other three games, and deliberately so: it is the device that is
 * slow, not the game, and a TV that needs Low in chess needs it here too. Keeping the
 * heuristic identical means a room's hardware behaves consistently across the catalog.
 */
export function detectTier() {
  const ua = navigator.userAgent || "";
  if (/\b(SMART-TV|SmartTV|GoogleTV|AppleTV|HbbTV|NetCast|Web0S|webOS|Tizen|VIDAA|BRAVIA|AFT[A-Z]|CrKey|Roku)\b/i.test(ua)) {
    return "low";
  }

  const cores = navigator.hardwareConcurrency || 0;
  const memory = navigator.deviceMemory || 0;
  if ((cores && cores <= 2) || (memory && memory <= 2)) return "low";

  const pixels = window.screen.width * window.screen.height * (window.devicePixelRatio || 1) ** 2;
  if (pixels >= 3840 * 2160) return "medium";

  if ((cores && cores <= 4) || (memory && memory <= 4)) return "medium";
  return "high";
}

/** Resolve a stored choice ("auto" or a tier name) to a concrete tier config. */
export function resolveTier(choice) {
  const name = choice === "auto" || !TIERS[choice] ? detectTier() : choice;
  return { name, config: TIERS[name] };
}

/**
 * Watches the real frame rate and reports when it is persistently bad.
 *
 * Only fires after a sustained bad stretch, so the hitch from a wall shattering or a round
 * restarting never trips it. Only ever steps down, and only while the choice is "auto": an
 * admin who explicitly asked for High is telling us they want High.
 */
export function makeFpsWatchdog({ onDrop, sampleMs = 2000, threshold = 24, strikes = 3 }) {
  let frames = 0;
  let windowStart = performance.now();
  let bad = 0;
  let stopped = false;

  return {
    tick(now) {
      if (stopped) return;
      frames++;
      const elapsed = now - windowStart;
      if (elapsed < sampleMs) return;

      const fps = (frames * 1000) / elapsed;
      frames = 0;
      windowStart = now;

      if (fps < threshold) {
        bad++;
        if (bad >= strikes) {
          stopped = true;
          onDrop(fps);
        }
      } else {
        bad = 0;
      }
    },
    stop() { stopped = true; },
  };
}
