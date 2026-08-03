/**
 * Backdrop and lighting for Rope Raid.
 *
 * The city is laid out procedurally from a small set of .glb models: one line of buildings
 * along the course, with that same line repeated twice further back and offset sideways so
 * the skyline reads as having depth. Scale is derived from each model's measured height, so
 * a target height in metres is what gets specified rather than a magic scale factor.
 */

export const VIEW_H = 38;                  // metres of world height the game shows
export const VIEW_TOP = VIEW_H / 2;
export const VIEW_BOTTOM = -VIEW_H / 2;
export const ROPE_REACH = 22;
export const COURSE_LENGTH = 130;

/**
 * The models used as background scenery, with their measured world size.
 *
 * `unitH` is the model's own height before scaling, so a target height in metres can be
 * converted to a scale factor rather than guessed. Measured directly from the .glb files.
 */
export const CITY_MODELS = {
  // baseY is where the model's own geometry starts relative to its origin. It has to be
  // cancelled out when seating a building, or a model whose origin is above its base sinks
  // by baseY * scale - which at these scales is tens of metres.
  "skyscraper-a.glb":    { unitH: 3.15, unitW: 1.24, baseY: 0.00, rotY: 0 },
  "skyscraper-b.glb":    { unitH: 4.08, unitW: 1.24, baseY: 0.00, rotY: 0 },
  "distant-building.glb":{ unitH: 1.46, unitW: 0.38, baseY: -0.76, rotY: 0 },
  // The crane is modelled facing down z (21 units deep, 1.6 wide), so it has to be turned
  // a quarter turn to present its side to a camera looking down the z axis.
  "crane.glb":           { unitH: 14.61, unitW: 1.60, baseY: -0.02, rotY: Math.PI / 2 },
};

/**
 * City block layout.
 *
 * One tile is a 4 x 8 grid: 4 rows deep, 8 buildings wide. That tile is then repeated to
 * the right for as long as the course runs. Every building in the tile is generated once
 * from a seed, so the whole city is described by a single block that tiles - far simpler
 * than scattering buildings independently, and it guarantees an even skyline.
 *
 * Rows run back to front, each further away, higher and hazier, which is what gives depth.
 * Heights stay realistic on purpose: these models carry facade detail (windows, ledges) at
 * roughly 0.03 of their own height, so scaling one to 200m turns a window mullion into a
 * 4m stripe and the tower stops reading as a building.
 */
export const GRID = {
  cols: 8,               // buildings across one tile
  rows: 4,               // depth rows, front to back
  cellW: 30,             // metres between columns
  rowZ: [-95, -150, -215, -300],       // depth of each row
  rowHeight: [[52, 78], [64, 96], [78, 118], [92, 140]],   // height band per row
  rowTint: [0x9aa2ce, 0x757da9, 0x585f8d, 0x424872],       // haze per row, back = darker
  // Rows step sideways so buildings don't line up into columns between rows.
  rowOffset: [0, 11, 21, 7],
  craneChance: 0.08,
  models: ["skyscraper-b.glb", "skyscraper-a.glb", "distant-building.glb"],
};

/** Width of one tile: what the pattern repeats by. */
export const TILE_W = GRID.cols * GRID.cellW;

/**
 * Ground level for the city, below the -19 bottom of the view so building bases run off
 * the bottom of the frame rather than hovering in mid-air.
 */
export const CITY_BASE_Y = -60;

export const DEFAULT_MOOD = {
  background: 0x3b3560,
  ambient: 0xa8b0e0, ambientIntensity: 1.9,
  keyColor: 0xffd0a8, keyIntensity: 2.0, keyPosition: [-12, 8, 20],
  rimColor: 0x7b6cff, rimIntensity: 1.6, rimPosition: [10, 4, -14],
  fillColor: 0xff8fb0, fillIntensity: 0.9, fillPosition: [6, -8, 10],
  hemiSky: 0x8a90d8, hemiGround: 0x2e2545, hemiIntensity: 1.6,
  fogNear: 100, fogFar: 300, exposure: 1.2,
};

/** Partial overrides on DEFAULT_MOOD; anything omitted keeps its current value. */
export const MOOD_PRESETS = {
  midday: {
    background: 0x9ec4f0, ambient: 0xd6e6ff, ambientIntensity: 3.0,
    keyColor: 0xfffdf5, keyIntensity: 3.4, keyPosition: [-4, 20, 18],
    rimColor: 0xcfe8ff, rimIntensity: 0.9, fillColor: 0xffe3c0, fillIntensity: 0.9,
    hemiSky: 0xc4dcff, hemiGround: 0x7a7263, hemiIntensity: 2.4,
    fogNear: 180, fogFar: 480, exposure: 1.05,
  },
  sunrise: {
    background: 0x4a3a63, ambient: 0xffc9a8, ambientIntensity: 2.2,
    keyColor: 0xffd9a0, keyIntensity: 2.8, keyPosition: [-16, 6, 20],
    rimColor: 0x8fc4ff, rimIntensity: 1.5, fillColor: 0xff9ec4, fillIntensity: 1.0,
    hemiSky: 0xffb98f, hemiGround: 0x40305c, hemiIntensity: 1.9,
    fogNear: 110, fogFar: 340, exposure: 1.15,
  },
  evening: {
    background: 0x3b3560, ambient: 0xa8b0e0, ambientIntensity: 1.9,
    keyColor: 0xffd0a8, keyIntensity: 2.0, keyPosition: [-12, 8, 20],
    rimColor: 0x7b6cff, rimIntensity: 1.6, fillColor: 0xff8fb0, fillIntensity: 0.9,
    hemiSky: 0x8a90d8, hemiGround: 0x2e2545, hemiIntensity: 1.6,
    fogNear: 100, fogFar: 300, exposure: 1.2,
  },
  sunset: {
    background: 0x2d1b3d, ambient: 0xffb98f, ambientIntensity: 2.1,
    keyColor: 0xff9a4f, keyIntensity: 3.1, keyPosition: [-18, 4, 18],
    rimColor: 0xff5ec4, rimIntensity: 1.9, fillColor: 0x7b6cff, fillIntensity: 1.1,
    hemiSky: 0xff9d6b, hemiGround: 0x3b2352, hemiIntensity: 1.8,
    fogNear: 90, fogFar: 290, exposure: 1.22,
  },
  night: {
    background: 0x05060d, ambient: 0x5a6aa8, ambientIntensity: 1.6,
    keyColor: 0xc8d8ff, keyIntensity: 1.5, keyPosition: [-8, 16, 20],
    rimColor: 0x35f0e0, rimIntensity: 2.3, fillColor: 0xff2e88, fillIntensity: 1.3,
    hemiSky: 0x2a3a72, hemiGround: 0x140d24, hemiIntensity: 1.2,
    fogNear: 70, fogFar: 220, exposure: 1.3,
  },
  rainy: {
    background: 0x39424f, ambient: 0x9aa8bd, ambientIntensity: 2.4,
    keyColor: 0xcfd8e6, keyIntensity: 1.7, keyPosition: [-6, 18, 16],
    rimColor: 0x7fa8c9, rimIntensity: 1.1, fillColor: 0x6e7f96, fillIntensity: 0.7,
    hemiSky: 0x7c8aa0, hemiGround: 0x33383f, hemiIntensity: 2.0,
    fogNear: 60, fogFar: 190, exposure: 1.1,
  },
  foggy: {
    background: 0x8e97a3, ambient: 0xc6cfda, ambientIntensity: 3.0,
    keyColor: 0xe8eef5, keyIntensity: 1.4, keyPosition: [-4, 16, 18],
    rimColor: 0xaebcc9, rimIntensity: 0.8, fillColor: 0xb8c2cf, fillIntensity: 0.6,
    hemiSky: 0xc0c9d4, hemiGround: 0x6d737c, hemiIntensity: 2.6,
    fogNear: 25, fogFar: 110, exposure: 1.0,
  },
};

/** Deterministic PRNG, so a given course always generates the same skyline. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates one 4 x 8 tile as plain data - no Three.js, so it can be tested directly.
 *
 * Returns every building in the tile with its position relative to the tile's left edge,
 * so the tile can be dropped at any x by adding an offset.
 */
export function planTile(seed = 9137) {
  const rand = mulberry32(seed);
  const out = [];

  for (let row = 0; row < GRID.rows; row++) {
    const [minH, maxH] = GRID.rowHeight[row];

    for (let col = 0; col < GRID.cols; col++) {
      const useCrane = rand() < GRID.craneChance;
      const file = useCrane
        ? "crane.glb"
        : GRID.models[Math.floor(rand() * GRID.models.length)];
      const spec = CITY_MODELS[file];

      const h = minH + rand() * (maxH - minH);
      const scale = h / spec.unitH;

      // Jitter within the cell so the grid doesn't read as a grid, while still tiling.
      const jitter = (rand() - 0.5) * GRID.cellW * 0.35;

      out.push({
        file, row, col,
        x: GRID.rowOffset[row] + col * GRID.cellW + jitter,
        // baseY cancels the model's own base offset so it sits on the ground line.
        y: CITY_BASE_Y - spec.baseY * scale,
        z: GRID.rowZ[row],
        scale, h, w: spec.unitW * scale,
        tint: GRID.rowTint[row],
        rotY: spec.rotY + (rand() - 0.5) * 0.3,
      });
    }
  }

  return out;
}

/**
 * Builds the city by repeating one tile along the course.
 *
 * Returns a handle whose update(cameraX, viewW) hides everything outside the camera's
 * span, so off-screen buildings cost nothing to draw.
 */
export function buildCity(THREE, group, length, loadedModels, seed = 9137) {
  const tile = planTile(seed);
  const items = [];

  // Start one tile before the course and run one past the end, so the city is already
  // there at the spawn and doesn't stop short at the finish.
  const firstTile = -1;
  const lastTile = Math.ceil((length + TILE_W) / TILE_W);

  for (let t = firstTile; t <= lastTile; t++) {
    const tileX = t * TILE_W;

    for (const b of tile) {
      const source = loadedModels.get(b.file);
      if (!source) continue;                 // still loading, or failed to load

      const mesh = source.clone(true);
      mesh.scale.setScalar(b.scale);
      mesh.position.set(tileX + b.x, b.y, b.z);
      mesh.rotation.y = b.rotY;

      // Tint toward the fog colour by row, so depth reads even where fog is thin.
      // Materials are cloned per building, never shared, or the tint leaks between rows.
      const tint = new THREE.Color(b.tint);
      const amount = 0.3 + b.row * 0.12;
      const recolour = (m) => {
        const c = m.clone();
        if (c.color) c.color.lerp(tint, amount);
        return c;
      };
      mesh.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        // Preserve array-ness: assigning a 1-element array to a single-material mesh makes
        // Three.js expect geometry groups it doesn't have, and the mesh renders nothing.
        child.material = Array.isArray(child.material)
          ? child.material.map(recolour)
          : recolour(child.material);
      });

      group.add(mesh);
      items.push({ x: tileX + b.x, halfW: b.w / 2, z: b.z, mesh });
    }
  }

  return {
    /**
     * Hides buildings outside the visible span.
     *
     * The span has to be computed per depth row, not once. `viewW` is measured at the play
     * plane, but a row at z=-300 is six times further from the camera and so covers roughly
     * six times the world width on screen - culling it against the play-plane span makes
     * buildings wink into existence right at the screen edge.
     *
     * `cameraZ` and `fovScale` let each row's visible width be derived from its own depth.
     * `extra` is a small buffer so a building is already on screen before it is shown.
     */
    update(cameraX, viewW, cameraZ = 55.2, aspect = 16 / 9, extra = 40) {
      // Half-width of the frustum at depth z, from the same fov the camera uses.
      const halfAt = (z) => (viewW / 2) * ((cameraZ - z) / cameraZ);

      for (const item of items) {
        const half = halfAt(item.z) + extra;
        item.mesh.visible =
          item.x + item.halfW > cameraX - half &&
          item.x - item.halfW < cameraX + half;
      }
    },
  };
}

/**
 * Applies a mood to a scene. `lights` is a registry created by createLights(), so the
 * same light objects are recoloured rather than replaced on every change.
 */
export function applyMoodTo(THREE, scene, renderer, lights, mood) {
  const m = { ...DEFAULT_MOOD, ...mood };
  scene.background = new THREE.Color(m.background);
  renderer.toneMappingExposure = m.exposure;

  lights.ambient.color.setHex(m.ambient);
  lights.ambient.intensity = m.ambientIntensity;

  lights.hemi.color.setHex(m.hemiSky);
  lights.hemi.groundColor.setHex(m.hemiGround);
  lights.hemi.intensity = m.hemiIntensity;

  lights.key.color.setHex(m.keyColor);
  lights.key.intensity = m.keyIntensity;
  lights.key.position.set(...m.keyPosition);

  lights.rim.color.setHex(m.rimColor);
  lights.rim.intensity = m.rimIntensity;
  lights.rim.position.set(...m.rimPosition);

  lights.fill.color.setHex(m.fillColor);
  lights.fill.intensity = m.fillIntensity;
  lights.fill.position.set(...m.fillPosition);

  scene.fog = new THREE.Fog(m.background, m.fogNear, m.fogFar);
}

/** Creates the five lights applyMoodTo() expects, and adds them to the scene. */
export function createLights(THREE, scene) {
  const lights = {
    ambient: new THREE.AmbientLight(0xffffff, 1),
    hemi: new THREE.HemisphereLight(0xffffff, 0x444444, 1),
    key: new THREE.DirectionalLight(0xffffff, 1),
    rim: new THREE.DirectionalLight(0xffffff, 1),
    fill: new THREE.DirectionalLight(0xffffff, 1),
  };
  scene.add(lights.ambient, lights.hemi, lights.key, lights.rim, lights.fill);
  return lights;
}
