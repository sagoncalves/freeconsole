/**
 * Graphics quality tiers.
 *
 * The screen renders the same scene on wildly different hardware: a desktop GPU, a laptop,
 * and — the case that actually matters here — a TV browser, where the GPU is weak, the
 * panel is 4K, and there is often no real driver behind the canvas. The same settings
 * cannot serve all three, so the scene is built from a tier instead of from constants.
 *
 * The tiers trade away, in order of what costs the most on a TV:
 *
 *   1. Shadows. A shadow map re-renders every casting mesh a second time each frame. This
 *      is the single biggest win and the first thing to go.
 *   2. Draw calls. Pieces are lathed in bands so shatter() has fracture lines (see
 *      pieces.js). Bands are a per-frame cost paid for an effect lasting a couple of
 *      seconds per capture, so lower tiers build each piece as one mesh and let captures
 *      fade the piece out instead of breaking it.
 *   3. Fill rate. Antialiasing and device pixel ratio scale with the panel, and a 4K TV
 *      makes both brutally expensive.
 *   4. Transient effects — fragments, motes, and the dust that lingers on a square.
 *
 * `auto` is the default and picks a tier by probing the device once, because the common
 * case is nobody ever opening the settings. The admin can override it from the master
 * controller when the guess is wrong, which on TV browsers it sometimes will be.
 */

/** @typedef {"low"|"medium"|"high"} Tier */

export const TIERS = {
  high: {
    label: "High",
    note: "Shadows, shattering pieces, full detail",
    shadows: true,
    shadowMapSize: 2048,
    antialias: true,
    maxPixelRatio: 2,
    // Segments around a lathed piece. 28 is smooth at any distance the camera reaches.
    latheSegments: 28,
    // Band the pieces so captures can shatter along the seams.
    bandPieces: true,
    shatter: true,
    puffCount: 26,
    dust: true,
    dustFadeMs: 52000,
    maxDustMarks: 24,
    // Rim lights are cheap per-light but every extra light multiplies the cost of every
    // lit fragment, which on a weak GPU is the whole screen.
    rimLights: true,
    // Square pulse and camera sway are trivial maths but force uniform uploads; kept on
    // where there is headroom because they are what stops the board looking like a still.
    squarePulse: true,
    cameraSway: true,
    targetFps: 0,          // 0 = uncapped, render every rAF
  },
  medium: {
    label: "Medium",
    note: "Softer shadows, lighter effects",
    shadows: true,
    shadowMapSize: 1024,
    antialias: true,
    maxPixelRatio: 1.5,
    latheSegments: 20,
    bandPieces: true,
    shatter: true,
    puffCount: 14,
    dust: true,
    dustFadeMs: 20000,
    maxDustMarks: 10,
    rimLights: true,
    squarePulse: true,
    cameraSway: true,
    targetFps: 0,
  },
  low: {
    label: "Low",
    note: "No shadows — for TVs and weak devices",
    shadows: false,
    shadowMapSize: 512,
    antialias: false,
    maxPixelRatio: 1,
    latheSegments: 12,
    // One mesh per piece: roughly an 8x cut in draw calls, at the cost of the shatter.
    bandPieces: false,
    shatter: false,
    puffCount: 0,
    dust: false,
    dustFadeMs: 0,
    maxDustMarks: 0,
    rimLights: false,
    squarePulse: false,
    cameraSway: false,
    // Half rate. A steady 30 beats a 45 that keeps hitching, and it halves GPU load
    // outright — the one lever that helps when the device is simply out of fill rate.
    targetFps: 30,
  },
};

export const DEFAULT_QUALITY = "auto";

/** Every value the admin can choose, in the order the UI should show them. */
export const QUALITY_CHOICES = ["auto", "high", "medium", "low"];

/**
 * Guess a tier for this device.
 *
 * Deliberately crude. There is no reliable way to ask a browser how fast its GPU is, so
 * this reads the signals that correlate with the failure we actually see — TV browsers and
 * low-core mobile chips — and errs toward the cheaper tier. Being wrong is recoverable:
 * the admin override exists precisely for that, and the runtime watchdog below catches the
 * rest.
 */
export function detectTier() {
  // A TV user agent is the strongest signal there is, and the whole reason this exists.
  const ua = navigator.userAgent || "";
  if (/\b(SMART-TV|SmartTV|GoogleTV|AppleTV|HbbTV|NetCast|Web0S|webOS|Tizen|VIDAA|BRAVIA|AFT[A-Z]|CrKey|Roku)\b/i.test(ua)) {
    return "low";
  }

  const cores = navigator.hardwareConcurrency || 0;
  const memory = navigator.deviceMemory || 0;
  if ((cores && cores <= 2) || (memory && memory <= 2)) return "low";

  // A 4K panel is a fill-rate problem regardless of the GPU behind it.
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
 * The detector above guesses from device metadata, which can be wrong in both directions —
 * a TV that renders fine, a "desktop" that is a thin client. This measures the thing we
 * actually care about, and only fires after a sustained bad stretch so that the hitch from
 * a shatter or a camera swing never trips it.
 *
 * Only ever steps down, and only while the choice is "auto": an admin who explicitly asked
 * for High is telling us they want High, and silently overriding that would make the
 * setting look broken.
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
        // Recovering resets the count, so only a sustained problem ever fires.
        bad = 0;
      }
    },
    stop() { stopped = true; },
  };
}
