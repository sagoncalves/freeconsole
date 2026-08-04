/**
 * Graphics quality tiers for Rope Raid.
 *
 * Deliberately NOT a copy of the chess3d tiers. That game's problem was draw calls from
 * pieces lathed into bands, and shadows re-rendering all of them; this game already runs
 * with shadows off, so those levers do nothing here. Rope Raid's costs are its own:
 *
 *   1. The avatar texture. ninja-jump.glb carries a single 2048x2048 PNG on a 996-vertex
 *      model — about 21MB of VRAM once mipmapped, for a character a few hundred pixels
 *      tall on screen. On a TV with memory shared between CPU and GPU this is the single
 *      most expensive thing in the game, and it buys detail nobody can see.
 *   2. The city. 32 buildings per tile x 4 tiles = 128 instances, each a cloned model of
 *      3-8 primitives, and each with its own cloned materials so nothing batches. All
 *      visible at once that is ~564 draw calls; the depth-row culling in buildCity()
 *      already trims it, and dropping the back rows trims it much further.
 *   3. Fill rate. Antialiasing and device pixel ratio, which scale with the panel — the
 *      one cost shared with chess, and the reason a 4K TV struggles regardless.
 *   4. Physics. Rapier steps at a fixed 1/60; the substep count is where its cost lives.
 *
 * `auto` probes the device once, because the common case is nobody opening the settings.
 */

/** @typedef {"low"|"medium"|"high"} Tier */

export const TIERS = {
  high: {
    label: "High",
    note: "Full city depth, sharp textures",
    antialias: true,
    maxPixelRatio: 2,
    // How many of the city's four depth rows to build, front to back. The back rows are
    // the haziest and the furthest, so they are the cheapest detail to lose.
    cityRows: 4,
    // Longest edge the avatar texture is resized to at load. 0 keeps it untouched.
    maxTextureSize: 0,
    anisotropy: 4,
    // Rope segments. They are laid in a straight line, so this is pure cost until the day
    // the rope actually curves.
    ropeSegments: 10,
    // Trampoline legs and other small scenery trim.
    sceneryDetail: true,
    targetFps: 0,          // 0 = uncapped
  },
  medium: {
    label: "Medium",
    note: "Slightly shallower city",
    antialias: true,
    maxPixelRatio: 1.5,
    cityRows: 3,
    maxTextureSize: 1024,
    anisotropy: 2,
    ropeSegments: 6,
    sceneryDetail: true,
    targetFps: 0,
  },
  low: {
    label: "Low",
    note: "For TVs — flatter city, smaller textures",
    antialias: false,
    maxPixelRatio: 1,
    cityRows: 2,
    // 512 is still more than the avatar covers on screen at this size, and takes it from
    // ~21MB of VRAM to well under 2MB.
    maxTextureSize: 512,
    anisotropy: 0,
    ropeSegments: 4,
    sceneryDetail: false,
    // A steady 30 beats an unstable 45, and halves the GPU load outright.
    targetFps: 30,
  },
};

export const DEFAULT_QUALITY = "auto";

/** Every value the admin can choose, in the order the UI should show them. */
export const QUALITY_CHOICES = ["auto", "high", "medium", "low"];

/**
 * Guess a tier for this device.
 *
 * Crude on purpose: there is no reliable way to ask a browser how fast its GPU is, so this
 * reads the signals that correlate with the failure actually seen — TV browsers and
 * low-core chips — and errs cheap. Being wrong is recoverable, via the admin override and
 * the runtime watchdog below.
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
 * Shrink a loaded texture to `maxSize` on its longest edge.
 *
 * Done after load rather than by shipping a smaller asset, so the .glb stays a single
 * source of truth and High still gets the full-resolution artwork. The download is
 * unchanged — this is about VRAM and sampling cost, which is what the GPU actually feels.
 *
 * Returns true if it resized, so the caller can log what happened.
 */
export function shrinkTexture(THREE, texture, maxSize) {
  if (!maxSize || !texture || !texture.image) return false;
  const img = texture.image;
  const w = img.width, h = img.height;
  if (!w || !h || Math.max(w, h) <= maxSize) return false;

  const scale = maxSize / Math.max(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  texture.image = canvas;
  texture.needsUpdate = true;
  return true;
}

/**
 * Walks a loaded model and applies the tier's texture budget to every map it finds.
 *
 * Textures are shared between cloned materials, so this must run on the SOURCE model once,
 * before any per-player clone is taken — resizing after cloning would do the work several
 * times over on the same underlying image.
 */
export function applyTextureBudget(THREE, root, config) {
  const seen = new Set();
  let resized = 0;
  root.traverse((child) => {
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const key of ["map", "emissiveMap", "normalMap", "roughnessMap", "metalnessMap"]) {
        const tex = mat[key];
        if (!tex || seen.has(tex)) continue;
        seen.add(tex);
        if (shrinkTexture(THREE, tex, config.maxTextureSize)) resized++;
        tex.anisotropy = config.anisotropy;
        // A normal map carries direction, not colour, so mipmaps are still wanted; but
        // dropping them entirely on the cheap tier saves the 33% mipmap overhead.
        if (config.maxTextureSize && config.maxTextureSize <= 512) {
          tex.generateMipmaps = true;   // keep: without them, minified textures shimmer
          tex.minFilter = THREE.LinearMipmapLinearFilter;
        }
      }
    }
  });
  return resized;
}

/**
 * Watches the real frame rate and reports when it is persistently bad.
 *
 * Only fires after a sustained bad stretch, so the hitch from a course rebuild or a
 * respawn never trips it. Only ever steps down, and only while the choice is "auto": an
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
