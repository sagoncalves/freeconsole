/**
 * Graphics quality tiers for Minefield Escape 3D.
 *
 * The screen renders the same aisle on a desktop GPU, a laptop, and — the case that actually
 * matters — a TV browser with a weak GPU behind a 4K panel.
 *
 * What costs the most here is different from the other 3D games in this platform. Chess3d's
 * bottleneck was draw calls from banded pieces; Rope Raid's was a huge avatar texture. This
 * game's bottleneck is **the ground**: the aisle floor is a tile grid whose per-tile
 * brightness changes every frame as personal sonar rings sweep over it. Done naively that is
 * one draw call and one material per tile. It is done instead as a single mesh with a vertex
 * colour per tile corner, so lighting the floor costs one buffer upload per frame and no
 * extra draw calls at all — and the tiers below scale that upload rather than the geometry.
 *
 * The tiers trade away, in order:
 *   1. Shadows — a second render of every casting mesh, every frame.
 *   2. The floor's update rate — the vertex colour buffer is the per-frame cost that scales
 *      with aisle size, so low tiers refresh it less often and accept slightly steppy light.
 *   3. Fill rate — antialiasing and pixel ratio, brutal on a 4K panel.
 *   4. Transient effects — blast sparks, crater decals, fog.
 *
 * Low goes further than "cheaper": it removes two whole effects rather than scaling them.
 *
 *   - **The dread wash** (`dread`). The red gradient that closes in as something approaches.
 *     Cheap in principle — a DOM layer animating only opacity, which the compositor owns —
 *     but a full-screen translucent layer over a 4K panel still costs real fill rate on a TV,
 *     and it is off on Low by choice.
 *   - **Floor lighting** (`floorLight`). The sonar's reveal painted into the aisle's vertex
 *     colours. This is the single largest per-frame cost in the renderer, so dropping it is
 *     the biggest win available on a weak GPU.
 *
 * Turning the floor light off does *not* blind the player: the expanding ping ring and the
 * mine discs are separate meshes that read `tileReveal` themselves, so a lit mine still
 * appears exactly when someone's sonar touches it. What is lost is the lit *ground* — the
 * sense of safe floor between the mines — not the mines.
 */

/** @typedef {"low"|"medium"|"high"} Tier */

export const TIERS = {
  high: {
    label: "High",
    note: "Shadows, soft light falloff, full effects",
    shadows: true,
    shadowMapSize: 2048,
    antialias: true,
    maxPixelRatio: 2,
    fog: true,
    /** How many times a second the floor's vertex colours are re-uploaded. */
    floorHz: 60,
    /** Subdivisions per tile on the floor mesh. More = smoother sonar edges, more vertices. */
    floorSubdiv: 2,
    blastSparks: 24,
    craterDecals: true,
    /** A soft glow sprite under each player, so their own lamp is legible. */
    playerGlow: true,
    groundDetail: true,
    /** The sonar's reveal painted into the floor's vertex colours. Off on Low. */
    floorLight: true,
    /** The red gradient that closes in as a threat does. Off on Low. */
    dread: true,
    /**
     * How many steps the dread wash's opacity is quantised to. More steps = a smoother
     * ramp and more style writes; each write is compositor-only, so this is cheap
     * everywhere and the tiers differ only slightly.
     */
    dreadSteps: 24,
    targetFps: 0,
  },
  medium: {
    label: "Medium",
    note: "Lighter shadows, fewer effects",
    shadows: true,
    shadowMapSize: 1024,
    antialias: true,
    maxPixelRatio: 1.5,
    fog: true,
    floorHz: 40,
    floorSubdiv: 1,
    blastSparks: 12,
    craterDecals: true,
    playerGlow: true,
    groundDetail: false,
    floorLight: true,
    dread: true,
    dreadSteps: 16,
    targetFps: 0,
  },
  low: {
    label: "Low",
    note: "No shadows — for TVs and weak devices",
    shadows: false,
    shadowMapSize: 512,
    antialias: false,
    maxPixelRatio: 1,
    fog: true,               // fog is nearly free and hides the draw distance; always on
    floorHz: 20,
    floorSubdiv: 1,
    blastSparks: 6,
    craterDecals: false,
    playerGlow: true,        // the whole game is unreadable without it
    groundDetail: false,
    // The aisle stays dark. This is the renderer's biggest per-frame cost — a sweep of every
    // tile plus a vertex colour upload — and on a TV it is worth more than the lit ground is.
    // The ping ring and the mine discs are separate meshes and still light up normally.
    floorLight: false,
    // No red wash. A full-screen translucent layer is cheap to animate but not free to fill
    // on a 4K panel, and this is the tier that exists for panels like that.
    dread: false,
    dreadSteps: 12,
    targetFps: 30,
  },
};

/**
 * Low by default, not "auto".
 *
 * The usual argument for auto-detection is that most people never open the settings — but
 * that cuts the other way here. This game is played on whatever screen is in the room, and
 * being wrong toward "too expensive" costs a stuttering TV for the whole session, while being
 * wrong toward "too cheap" costs some shadows nobody was looking at. Low still carries the
 * entire game: the sonar, the mines, the crusher and every avatar are all legible on it.
 *
 * The master controller can raise it any time, and that choice is remembered per browser.
 */
export const DEFAULT_QUALITY = "low";

/** Every value the admin can choose, in the order the UI should show them. */
export const QUALITY_CHOICES = ["auto", "high", "medium", "low"];

/**
 * Guess a tier for this device. Deliberately crude — there is no reliable way to ask a
 * browser how fast its GPU is, so this reads the signals that correlate with the failure we
 * actually see and errs toward the cheaper tier.
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
 * Only ever steps down, and only while the choice is "auto": an admin who explicitly asked
 * for High is telling us they want High, and silently overriding that would make the setting
 * look broken. Fires only after a sustained bad stretch, so the hitch from a blast never
 * trips it.
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
        if (bad >= strikes) { stopped = true; onDrop(fps); }
      } else {
        bad = 0;
      }
    },
    stop() { stopped = true; },
  };
}
