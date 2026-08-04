/**
 * Graphics quality tiers for Beach Volley.
 *
 * The third game to get tiers, and the third distinct cost profile — the levers here are
 * not the ones that mattered in chess3d or Rope Raid, and copying either would have
 * tuned mostly the wrong things.
 *
 * What this scene actually costs:
 *
 *   1. **The sea, every frame.** updateSea() rewrites all 1525 vertices of a 60x24 plane
 *      and then calls computeVertexNormals(), which re-derives 2880 face normals from
 *      scratch — then re-uploads 18KB of vertex data to the GPU. That is ~1MB/s of bus
 *      traffic and a large amount of CPU, spent on water in the far distance. It is the
 *      only thing in the game with a per-frame CPU cost of this size, and unlike a draw
 *      call it is not helped at all by a weaker GPU being asked to do less.
 *   2. **Shadows.** A 1024 map, with every palm, leaf, player and post drawn a second time
 *      to fill it. 151 meshes becomes ~272 draw calls.
 *   3. **Props.** 14 palms at 7 meshes each is 98 draw calls — around two thirds of the
 *      whole scene — for scenery ringing the court.
 *   4. **Fill rate.** Pixel ratio and antialiasing, the one cost shared with every game.
 *
 * Note the sim is fully dt-driven with a clamp (see sim.js step()), so capping the frame
 * rate here is safe and needs no fixed-timestep accumulator — unlike Rope Raid, where the
 * physics ran a fixed step per rendered frame.
 */

/** @typedef {"low"|"medium"|"high"} Tier */

export const TIERS = {
  high: {
    label: "High",
    note: "Rolling sea, full palm grove, shadows",
    antialias: true,
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 1024,
    // How often the sea's vertices are rewritten, in Hz. 0 means every frame.
    seaHz: 0,
    // Recompute lighting normals for the waves. This is the expensive half of updateSea.
    seaNormals: true,
    // Grid resolution of the sea plane, as [widthSegments, depthSegments].
    seaSegments: [60, 24],
    // How many of the 14 palms to place, nearest first.
    palms: 14,
    // Fronds per palm.
    fronds: 6,
    ballPanels: 4,
    targetFps: 0,          // 0 = uncapped
  },
  medium: {
    label: "Medium",
    note: "Calmer sea, lighter grove",
    antialias: true,
    maxPixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 512,
    seaHz: 20,
    seaNormals: true,
    seaSegments: [40, 16],
    palms: 10,
    fronds: 5,
    ballPanels: 4,
    targetFps: 0,
  },
  low: {
    label: "Low",
    note: "For TVs — still sea, no shadows",
    antialias: false,
    maxPixelRatio: 1,
    shadows: false,
    shadowMapSize: 512,
    // The sea stops moving entirely. It is the single biggest per-frame CPU saving
    // available, and at this distance — hazed by fog and a long way behind the court —
    // still water reads as calm rather than as broken.
    seaHz: -1,
    seaNormals: false,
    seaSegments: [24, 10],
    palms: 6,
    fronds: 4,
    ballPanels: 4,
    targetFps: 30,
  },
};

export const DEFAULT_QUALITY = "auto";

/** Every value the admin can choose, in the order the UI should show them. */
export const QUALITY_CHOICES = ["auto", "high", "medium", "low"];

/**
 * Guess a tier for this device.
 *
 * Same probe as the other games, and deliberately so: it is the device that is slow, not
 * the game, and a TV that needs Low in chess needs it here too.
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
 * Only fires after a sustained bad stretch, so the hitch from a point being scored or a
 * rally starting never trips it. Only ever steps down, and only while the choice is
 * "auto": an admin who explicitly asked for High is telling us they want High.
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
