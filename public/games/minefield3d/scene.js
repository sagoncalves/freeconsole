/**
 * Minefield Escape 3D — scene construction and rendering helpers.
 *
 * Everything here is presentation. The sim never imports this file and never reads anything
 * it produces; the screen owns the sim and calls into here to draw it.
 *
 * The central trick is the floor. Per-player sonar means every tile's brightness changes
 * every frame, and there are up to ~350 tiles in an aisle. Giving each tile a mesh would be
 * ~350 draw calls; giving each a material would be ~350 uniform uploads. Instead the whole
 * floor is ONE mesh whose vertex colours are rewritten each frame from the sim — one buffer
 * upload, one draw call, regardless of aisle size. That is what makes this run on a TV.
 */

import * as THREE from "/vendor/three.js?v=5";

/** One tile is one world unit, so sim coordinates are world coordinates. */
export const TILE = 1;

/* ------------------------------------------------------------------ palette */

const COL = {
  ground: new THREE.Color("#0b0e18"),
  groundLit: new THREE.Color("#243a52"),
  mine: new THREE.Color("#ff2e88"),
  crater: new THREE.Color("#1b1012"),
  wall: new THREE.Color("#0a0d16"),
  gate: new THREE.Color("#9dff4f"),
  gateShut: new THREE.Color("#b81f61"),
};

/* -------------------------------------------------------------------- world */

/**
 * Build the static world: renderer, camera, lights, walls, gate, floor mesh.
 *
 * The camera looks down the aisle from above at an angle — high enough to read the grid as a
 * grid, shallow enough that distance still compresses and the far end genuinely disappears
 * into the dark. That framing is the whole reason to do this in 3D: in the top-down version
 * you could see the shape of the whole field at once, and here you cannot.
 */
export function createScene(canvas, level, Q) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: Q.antialias,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, Q.maxPixelRatio));
  renderer.shadowMap.enabled = Q.shadows;
  if (Q.shadows) renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x03040a, 1);

  const scene = new THREE.Scene();

  // Fog is doing real work here, not atmosphere for its own sake: it is what makes the far
  // end of the aisle unknowable even when a distant player's lamp lights it, so the sonar
  // radius stays the thing that matters.
  if (Q.fog) scene.fog = new THREE.Fog(0x03040a, level.rows * 0.35, level.rows * 0.95);

  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 400);

  // Ambient is deliberately almost nothing. The aisle is meant to be dark enough that the
  // sonar is the only real light source; anything more and players can simply see the mines.
  scene.add(new THREE.AmbientLight(0x2a3550, 0.22));

  // A cold key light from above the gate, so there is a sense of "out there" to walk toward
  // without it illuminating the ground you are standing on.
  const key = new THREE.DirectionalLight(0x88aaff, 0.35);
  key.position.set(level.cols * 0.5, 14, -6);
  key.target.position.set(level.cols * 0.5, 0, level.rows * 0.5);
  scene.add(key);
  scene.add(key.target);

  if (Q.shadows) {
    key.castShadow = true;
    key.shadow.mapSize.set(Q.shadowMapSize, Q.shadowMapSize);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 60;
    const span = Math.max(level.cols, level.rows) * 0.7;
    key.shadow.camera.left = -span;
    key.shadow.camera.right = span;
    key.shadow.camera.top = span;
    key.shadow.camera.bottom = -span;
    key.shadow.bias = -0.0015;
  }

  const world = new THREE.Group();
  scene.add(world);

  const floor = buildFloor(level, Q);
  world.add(floor.mesh);
  if (Q.shadows) floor.mesh.receiveShadow = true;

  world.add(buildWalls(level));
  const gate = buildGate(level);
  world.add(gate.group);

  return { renderer, scene, camera, world, floor, gate, level, Q };
}

/**
 * Position the camera to frame the aisle from above, at an angle, biased toward the players.
 *
 * It tracks the pack's centre rather than sitting still: the aisle is longer than one useful
 * view, and a fixed camera would either lose the players at the far end or render the whole
 * thing too small to read.
 */
export function updateCamera(ctx, lead, tail, dt, crusherZ) {
  const { camera, level } = ctx;

  // Frame the whole pack, not just whoever is winning. Following the leader alone puts every
  // slower player — which is to say everyone who just lost a leg, the people the game is
  // most about — behind the camera and off the screen entirely.
  const spread = Math.max(0, tail - lead);

  // Stand behind the straggler, far enough back that the leader is still comfortably in
  // frame, and rise with the spread so a strung-out group stays inside the view.
  let wantZ = tail + 8.5;
  const wantY = 10.5 + spread * 0.42;

  // Never sit behind the crusher — a camera further back than its face sees only the flat
  // unlit back of a slab that fills the frame. But the clamp must not drag the camera onto
  // the players either: pulled all the way to the crusher it ends up standing on whoever is
  // hindmost, who then fills the screen while everyone else is a speck. Keep a floor of a
  // few units behind the straggler, so the shot degrades to "tight" rather than "inside
  // someone's head".
  if (typeof crusherZ === "number" && isFinite(crusherZ)) {
    wantZ = Math.min(wantZ, Math.max(crusherZ - 1.6, tail + 4.5));
  }

  // Ease toward it. A camera that snaps to a player who just got thrown by a blast is
  // nauseating; a slow follow also sells the aisle as a long space you are moving through.
  const k = 1 - Math.exp(-dt * 2.2);
  camera.position.x += (level.cols / 2 - camera.position.x) * k;
  camera.position.y += (wantY - camera.position.y) * k;
  camera.position.z += (wantZ - camera.position.z) * k;

  // Look at the middle of the pack, biased forward toward the ground still to be crossed.
  const lookZ = (lead + tail) / 2 - 3.5;
  camera.lookAt(level.cols / 2, 0, lookZ);
}

/* -------------------------------------------------------------------- floor */

/**
 * One mesh for the entire aisle floor, with per-vertex colours.
 *
 * Each tile becomes `subdiv * subdiv` quads. Subdividing costs vertices but buys a smoother
 * sonar edge: with one quad per tile the expanding ring is visibly blocky, because the only
 * places brightness can change are tile corners.
 */
function buildFloor(level, Q) {
  const sub = Math.max(1, Q.floorSubdiv | 0);
  const nx = level.cols * sub;
  const nz = level.rows * sub;

  const geo = new THREE.PlaneGeometry(level.cols, level.rows, nx, nz);
  geo.rotateX(-Math.PI / 2);
  // PlaneGeometry is centred on the origin; the sim's aisle runs 0..cols, 0..rows.
  geo.translate(level.cols / 2, 0, level.rows / 2);

  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);

  // Precompute each vertex's tile coordinate once. Doing this per frame is the difference
  // between a floor update costing a multiply and costing a division per vertex.
  const pos = geo.attributes.position;
  const vertexTile = new Int32Array(count * 2);
  for (let i = 0; i < count; i++) {
    vertexTile[i * 2] = Math.min(level.cols - 1, Math.max(0, Math.floor(pos.getX(i))));
    vertexTile[i * 2 + 1] = Math.min(level.rows - 1, Math.max(0, Math.floor(pos.getZ(i))));
  }

  return { mesh, geo, colors, vertexTile, count, lastUpdate: 0 };
}

/**
 * Rewrite the floor's vertex colours from the current sim state.
 *
 * Called at most `Q.floorHz` times a second — the light does not need to be recomputed at
 * 60fps to look continuous, and on a TV this is the single most expensive thing per frame.
 */
export function updateFloor(ctx, round, sim, now) {
  const { floor, Q } = ctx;
  const minInterval = 1000 / Math.max(1, Q.floorHz);
  if (now - floor.lastUpdate < minInterval) return;
  floor.lastUpdate = now;

  const { colors, vertexTile, count } = floor;

  // Cache one brightness per tile, then write it to that tile's vertices. Without the cache
  // the same tile's reveal is recomputed once per vertex — up to nine times over.
  const cols = round.cols;
  const rows = round.rows;
  const lit = ctx._litCache && ctx._litCache.length === cols * rows
    ? ctx._litCache
    : (ctx._litCache = new Float32Array(cols * rows));

  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) lit[z * cols + x] = sim.tileReveal(round, x, z);
  }

  // Mines are deliberately NOT tinted into the floor. Painting them onto tile vertices made
  // each one render as the blocky quad it sits on — a diffuse geometric smear rather than an
  // object. They are drawn as real discs instead; see buildMineField.
  const g = COL.ground, gl = COL.groundLit, cr = COL.crater;

  for (let i = 0; i < count; i++) {
    const tx = vertexTile[i * 2];
    const tz = vertexTile[i * 2 + 1];
    const idx = tz * cols + tx;
    const l = lit[idx];

    let r, gg, b;
    if (l <= 0.004) {
      // Unlit ground. Not pure black — a faint grid still has to be legible so players can
      // judge distance, or the aisle stops reading as a space at all.
      r = g.r; gg = g.g; b = g.b;
    } else if (sim.craterAt(round, tx, tz)) {
      r = g.r + (cr.r - g.r) * l;
      gg = g.g + (cr.g - g.g) * l;
      b = g.b + (cr.b - g.b) * l;
    } else {
      r = g.r + (gl.r - g.r) * l;
      gg = g.g + (gl.g - g.g) * l;
      b = g.b + (gl.b - g.b) * l;
    }

    colors[i * 3] = r;
    colors[i * 3 + 1] = gg;
    colors[i * 3 + 2] = b;
  }

  floor.geo.attributes.color.needsUpdate = true;
}

/* -------------------------------------------------------------------- mines */

/**
 * Every mine in the aisle as a single InstancedMesh.
 *
 * Mines used to be painted into the floor's vertex colours, which meant a mine was rendered
 * as the square tile it happened to occupy — the blocky, washed-out shape that made them read
 * as terrain rather than as objects. Here each one is a real disc with a hard rim, lit from
 * black to full colour by whatever sonar currently touches it.
 *
 * One instanced draw call covers the whole field, so this costs no more than the old approach
 * even with a hundred mines on screen.
 */
export function buildMineField(round, sim, Q) {
  // A ring rather than a filled circle: the bright rim is what makes a mine read as a machined
  // object at a glance, and the hole in the middle keeps it from becoming a glowing blob.
  const geo = new THREE.RingGeometry(0.17, 0.29, 20);
  geo.rotateX(-Math.PI / 2);

  // Plain white base: the per-instance colour multiplies into it. Setting `vertexColors`
  // here instead would look right but render black — the ring geometry carries no colour
  // attribute, so the shader would multiply by an undefined varying.
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Capacity is every tile that could ever hold a mine; the count shrinks as they detonate.
  const max = round.cols * round.rows;
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;

  const colors = new Float32Array(max * 3);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  return { mesh, colors, dummy: new THREE.Object3D(), tiles: new Int32Array(max * 2), lastUpdate: 0 };
}

/**
 * Re-place and re-light every live mine.
 *
 * Runs on the same budget as the floor: the reveal is a smooth fade, not an animation, and a
 * TV cannot afford to rebuild instance matrices at 60fps.
 */
export function updateMineField(field, round, sim, Q, now) {
  const minInterval = 1000 / Math.max(1, Q.floorHz);
  if (now - field.lastUpdate < minInterval) return;
  field.lastUpdate = now;

  const { mesh, colors, dummy } = field;
  const mine = COL.mine;
  let n = 0;

  for (let z = 0; z < round.rows; z++) {
    for (let x = 0; x < round.cols; x++) {
      if (!sim.mineAt(round, x, z)) continue;

      const lit = sim.tileReveal(round, x, z);
      // Unlit mines are not drawn at all. A mine nobody's light is touching must be perfectly
      // invisible — that is the entire game.
      if (lit <= 0.02) continue;

      dummy.position.set(x + 0.5, 0.045, z + 0.5);
      // Bloom slightly as the light hits, so a mine appearing reads as a discovery rather
      // than as a fade-in.
      const s = 0.85 + lit * 0.35;
      dummy.scale.set(s, 1, s);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);

      // Gamma-ish curve so a mine at the edge of someone's reach is a faint hint while one
      // squarely inside it is unmistakable.
      const k = Math.pow(lit, 0.65);
      colors[n * 3] = mine.r * k;
      colors[n * 3 + 1] = mine.g * k;
      colors[n * 3 + 2] = mine.b * k;
      n++;
    }
  }

  mesh.count = n;
  if (n > 0) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }
}

/* -------------------------------------------------------------------- walls */

/** The aisle's sides. Solid, unlit, and tall enough to close the space in. */
function buildWalls(level) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: COL.wall, roughness: 0.95, metalness: 0,
  });

  const h = 2.6;
  const t = 0.4;
  for (const side of [-1, 1]) {
    const geo = new THREE.BoxGeometry(t, h, level.rows + 2);
    const wall = new THREE.Mesh(geo, mat);
    wall.position.set(side < 0 ? -t / 2 : level.cols + t / 2, h / 2, level.rows / 2);
    group.add(wall);
  }

  // The back wall behind the spawn line, so the aisle is a corridor rather than an open
  // plain — and so the killer visibly comes *out of* something.
  //
  // It has to be see-through. The camera sits behind the straggler, which at the start of a
  // round is behind this wall, so a solid back panel is the first thing the players ever see
  // and it hides the entire round from them. Rendering it as glass keeps the space closed
  // without ever blocking the shot.
  const backMat = new THREE.MeshBasicMaterial({
    color: 0x1a2740, transparent: true, opacity: 0.16,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const back = new THREE.Mesh(new THREE.BoxGeometry(level.cols + t * 2, h, t), backMat);
  back.position.set(level.cols / 2, h / 2, level.rows + t / 2);
  group.add(back);

  // A thin lip along the top edge, so the boundary still reads as a wall rather than as a
  // smudge. Kept genuinely hairline: seen from a camera that sits behind and above it, this
  // edge crosses the middle of the shot, and any real thickness becomes a beam lying across
  // the players.
  const lipMat = new THREE.MeshBasicMaterial({
    color: 0x2a4266, transparent: true, opacity: 0.5, depthWrite: false,
  });
  const lip = new THREE.Mesh(new THREE.BoxGeometry(level.cols + t * 2, 0.02, t * 0.5), lipMat);
  lip.position.set(level.cols / 2, h, level.rows + t / 2);
  group.add(lip);

  return group;
}

/* --------------------------------------------------------------------- gate */

/**
 * Which columns the gate occupies, derived from a Level exactly as the sim derives it.
 *
 * This duplicates three lines of the sim's generateField on purpose: the scene is built
 * before any round exists (a Level is all it has), and the two must agree or the doorway is
 * drawn somewhere the sim will not let anyone through.
 */
export function gateSpan(level) {
  const half = Math.floor(level.exitWidth / 2);
  const centre = Math.floor(level.cols / 2);
  const from = Math.max(0, centre - half);
  const to = Math.min(level.cols - 1, from + level.exitWidth - 1);
  return { from, to };
}

/**
 * The way out: a lit doorway at the far end, flanked by solid end-wall on either side.
 *
 * The gate is the only thing in the scene that emits its own light, because it is the only
 * thing a player should be able to navigate toward from any distance.
 */
function buildGate(level) {
  const group = new THREE.Group();

  const wallMat = new THREE.MeshStandardMaterial({
    color: COL.wall, roughness: 0.95, metalness: 0,
  });
  const h = 2.6;
  const t = 0.4;

  // The gate's span is derived exactly as the sim derives it, from exitWidth and the aisle's
  // centre. A Level carries exitWidth; exitFrom/exitTo live on the *round*, so reading them
  // off the level yields NaN and silently deletes the entire doorway.
  const { from: exitFrom, to: exitTo } = gateSpan(level);

  // End wall, in two pieces with the gate's gap between them.
  const leftW = exitFrom;
  const rightW = level.cols - (exitTo + 1);
  if (leftW > 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(leftW, h, t), wallMat);
    m.position.set(leftW / 2, h / 2, -t / 2);
    group.add(m);
  }
  if (rightW > 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(rightW, h, t), wallMat);
    m.position.set(exitTo + 1 + rightW / 2, h / 2, -t / 2);
    group.add(m);
  }

  const gateW = exitTo - exitFrom + 1;
  const cx = exitFrom + gateW / 2;

  // The lit threshold itself.
  const panelMat = new THREE.MeshBasicMaterial({
    color: COL.gate, transparent: true, opacity: 0.85,
  });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(gateW, h), panelMat);
  panel.position.set(cx, h / 2, -t);
  group.add(panel);

  // Light spilling onto the floor in front of the door, so the way out is visible from the
  // near end of the aisle even when nobody's sonar reaches it.
  const spillMat = new THREE.MeshBasicMaterial({
    color: COL.gate, transparent: true, opacity: 0.16,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const spill = new THREE.Mesh(new THREE.PlaneGeometry(gateW + 1, 6), spillMat);
  spill.rotation.x = -Math.PI / 2;
  spill.position.set(cx, 0.02, 2.6);
  group.add(spill);

  const lamp = new THREE.PointLight(0x9dff4f, 8, 14, 2);
  lamp.position.set(cx, 1.6, 0.6);
  group.add(lamp);

  return { group, panel, panelMat, spill, spillMat, lamp };
}

/** Switch the gate between open and shut. Shut is a wall, and must read as one instantly. */
export function setGateOpen(ctx, open) {
  const { gate } = ctx;
  gate.panelMat.color.copy(open ? COL.gate : COL.gateShut);
  gate.spillMat.opacity = open ? 0.16 : 0.03;
  gate.lamp.color.set(open ? 0x9dff4f : 0xb81f61);
  gate.lamp.intensity = open ? 8 : 3;
}

/* ------------------------------------------------------------------ players */

/* --------------------------------------------------------------- avatar model */

/**
 * The shared ninja model, loaded once and cloned per player.
 *
 * It ships **without a texture on purpose**. The source Meshy export was 7.01MB, of which
 * 6.93MB was a single 2048×2048 PNG — 21MB of VRAM once uploaded, for a flat-shaded low-poly
 * character with no detail that resolution could carry. Stripping the texture and the UVs
 * leaves 98KB and lets every player be tinted with their own SDK colour, which this game
 * needs anyway: on a dark aisle a player IS their colour, and a shared blue skin would make
 * six ninjas indistinguishable.
 *
 * The geometry itself was never the problem — 1,059 triangles is cheaper than one of the
 * capsules it replaces.
 */
/**
 * The bones the game drives by hand, by their names in the export's rig.
 *
 * Only these are looked up; the rest of the 24-joint skeleton is left to the clip. The two
 * UpLeg bones are the roots of each leg, so scaling one to nothing removes that whole limb —
 * thigh, shin, foot and toe — in a single write.
 */
/**
 * How tall a player stands, in world units (tiles).
 *
 * Deliberately far larger than life: two and a half tiles, in an aisle only nine to eleven
 * tiles wide. At a realistic ~1.0 the ninja rendered about twelve pixels tall from the game's
 * camera, which made the model, the run cycle and a missing leg all invisible — the avatar
 * was pure cost. Toy proportions are what make the character legible at the distance this
 * camera actually sits at, and legibility is the entire reason to have a model here.
 *
 * Chosen by eye from the ?sizes=1 ladder rather than derived, because the right answer
 * depends on the camera and nothing else predicts it.
 */
let AVATAR_HEIGHT = 2.5;

/**
 * How far a pitched-over body drifts forward, as a fraction of the avatar's height.
 *
 * The model pivots between its feet, so laying it flat rotates the torso out ahead of that
 * point. Measured at 1.59 world units on a 2.5-unit avatar; expressing it as a ratio keeps
 * the correction correct at any height.
 */
const CRAWL_PIVOT_SHIFT = 1.59 / 2.5;

/**
 * How far a pitched-over body must be lifted to sit ON the floor rather than through it.
 *
 * Same cause as the forward shift: rotating about the feet swings the torso downward too.
 * Measured at 0.65 units sunk below ground on a 2.5-unit avatar, plus a little clearance so
 * the chest rests on the surface instead of intersecting it.
 */
const CRAWL_LIFT = 0.73 / 2.5;

/** Override the avatar height. Used by the size-comparison harness (?sizes=1). */
export function setAvatarHeight(h) {
  if (h > 0) AVATAR_HEIGHT = h;
}
export function getAvatarHeight() { return AVATAR_HEIGHT; }

const BONES = {
  LeftUpLeg: 1, RightUpLeg: 1,
  LeftArm: 1, RightArm: 1,
  LeftForeArm: 1, RightForeArm: 1,
  Spine: 1, Spine01: 1, Spine02: 1,
  Head: 1, Hips: 1,
};

/**
 * Deep-clone a skinned hierarchy, rebinding each SkinnedMesh to the *cloned* bones.
 *
 * `Object3D.clone(true)` copies the meshes and the bones but leaves every copied
 * SkinnedMesh still bound to the ORIGINAL skeleton. The result is that all clones render at
 * whatever pose the first one is in, parked at the original's position — the symptom being a
 * single T-posed avatar at the world origin and nothing at any player. three.js ships a
 * SkeletonUtils addon for exactly this, but it is not in the vendored bundle, so the rebind
 * is done here.
 */
/**
 * The height a skinned hierarchy actually rasterises to, in its own local space.
 *
 * Walks the real vertices through their bone transforms. This is the number to scale
 * against; every bounding-box shortcut reports the bind pose and is wrong by whatever the
 * rig's own scale happens to be — here a factor of 95.
 *
 * Sampling a subset is enough: the extremes of a humanoid (head, feet) are hit long before
 * a few hundred vertices are consumed, and this runs once per model, not per frame.
 */
function measureSkinnedHeight(root) {
  const v = new THREE.Vector3();
  let minY = Infinity;
  let maxY = -Infinity;

  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const pos = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 400));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i);
      if (o.applyBoneTransform) o.applyBoneTransform(i, v);
      else if (o.boneTransform) o.boneTransform(i, v);   // older three
      // Apply the mesh's own world matrix, which is what carries the export's unit scale
      // (0.01 here, the model being authored in centimetres). Normalising back into the
      // root's local space would divide that straight back out and hand back the raw,
      // unscaled figure — the very number that is wrong.
      v.applyMatrix4(o.matrixWorld);
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
  });

  return isFinite(minY) ? maxY - minY : 0;
}

function cloneSkinned(source) {
  const root = source.clone(true);

  // Map original bone -> cloned bone BY NAME.
  //
  // Pairing them by traverse index looks equivalent and is not: the clone's children can be
  // visited in a different order, so an index map silently pairs a bone with the wrong one.
  // The symptom is brutal and hard to read — the mesh sits at the player's feet while its
  // skeleton is somewhere else entirely (hips at z=98 in a 30-deep aisle), so bodies render
  // stacked on each other or vanish off the map. Bone names in this rig are unique.
  const boneByName = new Map();
  root.traverse((o) => { if (o.isBone) boneByName.set(o.name, o); });

  // Rebuild every skinned mesh's skeleton from the cloned bones, keeping the original
  // inverse bind matrices — those are bind-pose data and must not be recomputed.
  const srcSkinned = [];
  source.traverse((o) => { if (o.isSkinnedMesh) srcSkinned.push(o); });
  let k = 0;
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const original = srcSkinned[k++] || srcSkinned[0];
    const bones = original.skeleton.bones.map((b) => boneByName.get(b.name) || b);
    o.skeleton = new THREE.Skeleton(bones, original.skeleton.boneInverses);
    o.bind(o.skeleton, o.bindMatrix);
  });

  return root;
}

let avatarPromise = null;

export function loadAvatar(url = "/games/minefield3d/ninja.glb?v=3") {
  if (avatarPromise) return avatarPromise;
  avatarPromise = new Promise((resolve) => {
    if (!THREE.GLTFLoader) { resolve(null); return; }
    new THREE.GLTFLoader().load(
      url,
      (gltf) => resolve(gltf),
      undefined,
      // A missing or broken model must never take the game down: every caller falls back to
      // the capsule, which is fully playable.
      () => resolve(null)
    );
  });
  return avatarPromise;
}

/** The loaded avatar, or null while it is still in flight / if it failed. */
let avatarGltf = null;

/**
 * The source model's true rendered height, measured once when it loads.
 *
 * Measured on the pristine gltf.scene before anything has been scaled or parented, so it is
 * a constant property of the asset. Re-measuring per clone would fold in whatever scale that
 * clone's holder already had and compound the error every time a body is rebuilt.
 */
let avatarSourceHeight = 0;

export function setAvatar(gltf) {
  avatarGltf = gltf;
  if (gltf) {
    gltf.scene.updateWorldMatrix(true, true);
    avatarSourceHeight = measureSkinnedHeight(gltf.scene);
  }
}

/**
 * One player's body: the ninja model tinted to their colour, plus their personal lamp.
 *
 * Falls back to a capsule when the model has not arrived yet or failed to load. Legs are the
 * most important thing about a player and have to be readable at camera distance, so injury
 * changes the silhouette's height and tilt rather than adding detail.
 */
export function createPlayerMesh(colorHex, Q) {
  const group = new THREE.Group();

  // Unlit on purpose. The aisle's ambient is nearly zero because the darkness IS the game,
  // so anything that depends on scene lighting renders as a black smudge — a lit material
  // with a strong emissive was still invisible in play. A basic material draws the body at
  // full colour from every angle, which is what makes a player readable at distance and
  // unmistakably *their* colour.
  //
  // The cost of losing shading is that the model reads as a flat silhouette. That is the
  // right trade here: at this camera the silhouette is all the detail that survives anyway.
  const mat = new THREE.MeshBasicMaterial({ color: colorHex });

  let body;
  let mixer = null;
  let actions = null;
  let bones = null;
  let rest = null;
  let fitScale = 1;

  if (avatarGltf) {
    const root = cloneSkinned(avatarGltf.scene);

    root.traverse((o) => {
      if (!o.isMesh) return;
      // Tint per player. The model is white and untextured, so the colour is the whole look.
      o.material = mat;
      if (Q.shadows) o.castShadow = true;
      o.frustumCulled = false;   // skinned bounds go stale as the rig moves
    });

    // The model is authored in centimetres: its Armature node already carries a 0.01 scale,
    // so the fit has to MULTIPLY that rather than replace it. Setting an absolute scale here
    // makes the ninja 68x life size and shoves it off camera — which looks, confusingly,
    // like the model failed to load.
    //
    // Wrapping in a container keeps the model's own transform untouched and gives the pose
    // code something it can freely rotate and lift.
    const holder = new THREE.Group();
    holder.add(root);
    // Measure what the model actually RENDERS as.
    //
    // Box3.setFromObject cannot be used here: on a SkinnedMesh it reports the bind-pose
    // bounds and ignores the bone transforms, so it happily returns "1.35 units" for a body
    // that rasterises 128 units tall — a 95x error that reads on screen as flat slabs of
    // colour clipped by the near plane, and which no amount of tuning the target height can
    // fix. The skinned vertex positions are the only source of truth.
    const height = Math.max(0.0001, avatarSourceHeight);
    holder.scale.setScalar(AVATAR_HEIGHT / height);
    // The export's rest pose already faces down the aisle (toward -z, the gate). The player
    // group is turned by `heading`, which is atan2(vx, vz) — that is 0 when walking toward
    // -z, so adding a half turn here spun every ninja to run backwards up the aisle.
    holder.rotation.y = 0;

    body = holder;
    fitScale = holder.scale.x;
    group.add(holder);

    if (avatarGltf.animations && avatarGltf.animations.length) {
      mixer = new THREE.AnimationMixer(root);
      actions = {};
      for (const clip of avatarGltf.animations) {
        actions[clip.name] = mixer.clipAction(clip);
      }
      // Running is the only clip with real motion — the "idle" the exporter emitted is a
      // single frame, so it is used as a static pose rather than played.
      // Both locomotion clips run continuously and are blended by weight rather than being
      // started and stopped. Stopping and restarting a clip snaps it back to frame zero, so
      // a player who takes a single step gets a visible hitch every time they pause; leaving
      // both playing and crossfading the weights makes the transition invisible.
      for (const name of ["idle", "running"]) {
        if (!actions[name]) continue;
        actions[name].play();
        actions[name].setEffectiveWeight(name === "idle" ? 1 : 0);
      }
    }

    // Grab the bones the game needs to drive directly. The rig is a standard biped, so the
    // two leg roots under Hips are all that is needed to take a leg off, and the arms and
    // spine are enough to hand-animate a crawl.
    bones = {};
    root.traverse((o) => {
      if (!o.isBone) return;
      if (BONES[o.name] !== undefined) bones[o.name] = o;
    });
    // Remember each bone's rest pose, so procedural animation is always applied as an offset
    // from the bind pose rather than accumulating drift frame over frame.
    rest = {};
    for (const [name, bone] of Object.entries(bones)) {
      rest[name] = {
        rot: bone.rotation.clone(),
        scale: bone.scale.clone(),
        pos: bone.position.clone(),
      };
    }
  } else {
    body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.6, 4, 10), mat);
    body.position.y = 0.62;
    if (Q.shadows) body.castShadow = true;
    group.add(body);
  }

  // The lamp each player carries. This is the object the entire game is about, so it is
  // visible as a thing on the body, not just as an effect on the floor.
  const lamp = new THREE.PointLight(colorHex, 1.6, 5.5, 2);
  lamp.position.set(0, avatarGltf ? AVATAR_HEIGHT * 0.55 : 0.9, 0);
  group.add(lamp);

  let glow = null;
  if (Q.playerGlow) {
    // A small disc on the ground under the player, so someone standing still in unlit ground
    // is still findable between their own pings. Kept tight and dim on purpose: a wide pool
    // of permanent light around every player would do the sonar's job for it.
    const glowMat = new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.14,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    glow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.03;
    group.add(glow);
  }

  return {
    group, body, mat, lamp, glow, mixer, actions, bones, rest,
    isModel: !!avatarGltf,
    baseScale: fitScale,
    // Which leg a one-legged player loses. Fixed per body so it never flips mid-round; set
    // from the device id by the caller.
    dropSide: 0,
    phase: 0,
  };
}

/**
 * Pose a player's mesh for their current condition, and drive the run cycle.
 *
 * The same function serves the model and the capsule fallback, so every offset is expressed
 * relative to the body's own base scale rather than hardcoded to capsule dimensions.
 */
export function posePlayer(mesh, p, states, dt) {
  const { body, group, lamp, baseScale } = mesh;
  const s = baseScale;

  group.position.set(p.x, 0, p.z);
  group.rotation.y = p.heading;

  if (p.state === states.DEAD) {
    // Flat on the ground, lamp out. Toppling sideways swings the body out along x from the
    // foot pivot, the same way the crawl does along z, so it needs the same correction or
    // the corpse lies a body-length away from where the player actually fell.
    body.rotation.z = Math.PI / 2;
    body.rotation.x = 0;
    body.position.set(
      mesh.isModel ? CRAWL_PIVOT_SHIFT * AVATAR_HEIGHT : 0,
      mesh.isModel ? 0.1 : 0.22,
      0
    );
    body.scale.setScalar(s);
    lamp.intensity = 0;
    if (mesh.glow) mesh.glow.material.opacity = 0.05;
    // A body on the floor plays nothing at all.
    if (mesh.actions) {
      if (mesh.actions.idle) mesh.actions.idle.setEffectiveWeight(0);
      if (mesh.actions.running) mesh.actions.running.setEffectiveWeight(0);
    }
    return;
  }

  lamp.intensity = 1.6;
  if (mesh.glow) mesh.glow.material.opacity = 0.14;

  const speed = Math.hypot(p.dx || 0, p.dz || 0);
  const moving = speed > 0.05 && p.stun <= 0;

  if (!mesh.isModel) {
    // Capsule fallback: shape alone carries the injury.
    if (p.legs === 0) { body.rotation.z = Math.PI / 2; body.position.y = 0.26; body.scale.setScalar(s); }
    else if (p.legs === 1) { body.rotation.z = 0.42; body.position.y = 0.5; body.scale.set(s, s * 0.78, s); }
    else { body.rotation.z = 0; body.position.y = 0.62; body.scale.setScalar(s); }
    return;
  }

  // --- the rigged model ---

  // The clips drive the whole skeleton, so the mixer must be stepped BEFORE any bone is
  // overridden by hand — otherwise it writes the clip's pose back over the crawl on the
  // following frame and the limbs jitter between the two.
  if (mesh.mixer && mesh.actions) {
    const { idle, running } = mesh.actions;

    // A player with legs is either standing (idle) or moving (running); a crawler is
    // neither, and hands the body over to poseCrawl entirely.
    const animated = p.legs > 0;

    // Crossfade rather than switch. The target is binary but the weight is eased toward it,
    // so setting off from a standstill blends over a few frames instead of popping.
    const wantRun = animated && moving ? 1 : 0;
    const k = 1 - Math.exp(-(dt || 0) * 11);
    mesh.blend = (mesh.blend || 0) + (wantRun - (mesh.blend || 0)) * k;

    if (idle) idle.setEffectiveWeight(animated ? 1 - mesh.blend : 0);
    if (running) {
      running.setEffectiveWeight(animated ? mesh.blend : 0);
      // Tie the stride to how fast this player can actually move, so a limper's legs do not
      // windmill at full walking speed.
      running.timeScale = Math.max(0.4, speed / 3.0);
    }

    // Keep stepping while either clip still carries weight, so the fade itself plays out.
    if (animated) mesh.mixer.update(dt || 0);
  }

  // A crawler strokes at double rate. Without it the drag reads as laboured to the point of
  // looking stalled — a legless player covers ground so slowly that a stroke tied to their
  // speed barely animates, and the pose stops telling you they are still trying. The
  // multiplier is applied here rather than inside poseCrawl because `phase` is shared: the
  // limp's hitch reads it too, and scaling it at the source would speed that up as well.
  const stroke = p.legs === 0 ? 2 : 1;
  mesh.phase = (mesh.phase || 0)
    + (dt || 0) * stroke * (moving ? Math.max(2.2, speed * 3.4) : 0.9);

  if (p.legs === 0) {
    poseCrawl(mesh, p, moving, dt);
  } else {
    // Undo anything the crawl left behind.
    //
    // Legs are never regained mid-round — the sim only ever subtracts them, and restores
    // them at startRound — so this fires exactly once per body, when a mesh that crawled
    // last round is reused by a player who now has legs again. Rare, but without it that
    // player stands up still folded into the prone pose with their arms reaching.
    if (mesh.wasCrawling) { restoreBones(mesh); mesh.wasCrawling = false; }
    body.rotation.x = 0;
    body.rotation.z = p.legs === 1 ? 0.3 : 0;
    body.position.set(0, 0, 0);   // clear any pivot correction left by the crawl or death
    body.scale.setScalar(s);
    applyLegs(mesh, p.legs);
    if (p.legs === 1) poseLimp(mesh, moving);
  }
}

/**
 * Take legs off the rig.
 *
 * A blast removes a limb, so the model must lose it too — a limping ninja with two intact
 * legs reads as a cosmetic wobble rather than as an injury. Scaling the UpLeg bone to
 * effectively nothing collapses the entire chain below it (thigh, shin, foot, toe) into the
 * hip, which removes the leg without touching the mesh's topology or its skinning weights.
 *
 * Which leg goes is derived from the player's device id, not randomly, so a given player
 * loses the same side every time and does not appear to swap legs between frames.
 */
function applyLegs(mesh, legs) {
  const { bones, rest } = mesh;
  if (!bones || !rest) return;

  const gone = 0.001;   // not 0: a zero scale makes the bone matrix non-invertible
  const left = bones.LeftUpLeg;
  const right = bones.RightUpLeg;
  if (!left || !right) return;

  if (legs >= 2) {
    left.scale.copy(rest.LeftUpLeg.scale);
    right.scale.copy(rest.RightUpLeg.scale);
  } else if (legs === 1) {
    // One leg: the side is fixed per player so it never flips.
    const dropLeft = mesh.dropSide === 0;
    (dropLeft ? left : right).scale.setScalar(gone);
    (dropLeft ? right : left).scale.copy(dropLeft ? rest.RightUpLeg.scale : rest.LeftUpLeg.scale);
  } else {
    left.scale.setScalar(gone);
    right.scale.setScalar(gone);
  }
}

/**
 * A legless player who has stopped: propped on both forearms, breathing.
 *
 * Deliberately not a slowed-down crawl. The stroke and this pose are different shapes, so a
 * glance across the aisle tells you whether a crawler is still making ground or has stalled —
 * which matters, because a stalled crawler is about to be caught by the crusher.
 */
function poseCrawlIdle(mesh) {
  const { bones, rest, body } = mesh;
  const t = mesh.phase;

  // Slow breathing, independent of the stroke's phase so it never inherits its speed. The
  // 0.5 undoes the double-rate advance a crawler's phase gets, keeping a resting crawler
  // breathing at the same pace as before the stroke was sped up — panting would read as
  // effort, and the whole point of this pose is that it reads as having stopped.
  const breath = Math.sin(t * 0.55 * 0.5);

  // Both arms tucked in under the chest, elbows bent, holding the upper body off the floor.
  if (bones.LeftArm) {
    bones.LeftArm.rotation.x = rest.LeftArm.rot.x - 0.55;
    bones.LeftArm.rotation.z = rest.LeftArm.rot.z - 0.3;
  }
  if (bones.RightArm) {
    bones.RightArm.rotation.x = rest.RightArm.rot.x - 0.55;
    bones.RightArm.rotation.z = rest.RightArm.rot.z + 0.3;
  }
  if (bones.LeftForeArm) bones.LeftForeArm.rotation.x = rest.LeftForeArm.rot.x - 1.15;
  if (bones.RightForeArm) bones.RightForeArm.rotation.x = rest.RightForeArm.rot.x - 1.15;

  // The chest rises and falls. Small — it has to read at distance without looking like a
  // twitch, and it is the only thing telling you this body is still alive.
  if (bones.Spine) bones.Spine.rotation.x = rest.Spine.rot.x + breath * 0.05;
  if (bones.Spine01) bones.Spine01.rotation.x = rest.Spine01.rot.x + breath * 0.04;
  if (bones.Spine02) bones.Spine02.rotation.x = rest.Spine02.rot.x + breath * 0.03;

  // Head down, lifting slightly with each breath rather than staring ahead.
  if (bones.Head) bones.Head.rotation.x = rest.Head.rot.x - 0.28 + breath * 0.06;

  // No side-to-side roll: the roll belongs to the stroke and reintroducing it here would
  // blur the distinction the pose exists to draw.
  if (bones.Spine) bones.Spine.rotation.y = rest.Spine.rot.y;
  if (bones.Spine01) bones.Spine01.rotation.y = rest.Spine01.rot.y;
  if (bones.Spine02) bones.Spine02.rotation.y = rest.Spine02.rot.y;

  // Relative to the lift set by poseCrawl, not an absolute height — hardcoding a value
  // here would sink the body back through the floor.
  body.position.y = CRAWL_LIFT * AVATAR_HEIGHT + breath * 0.012 * AVATAR_HEIGHT;
}

/** Put every hand-driven bone back to its bind pose, so the run clip owns the body again. */
function restoreBones(mesh) {
  const { bones, rest } = mesh;
  if (!bones || !rest) return;
  for (const [name, bone] of Object.entries(bones)) {
    bone.rotation.copy(rest[name].rot);
    bone.position.copy(rest[name].pos);
  }
}

/** A hitch in the stride for a one-legged player: the torso dips on the missing side. */
function poseLimp(mesh, moving) {
  const { bones, rest } = mesh;
  if (!bones || !rest || !bones.Spine) return;
  const hitch = moving ? Math.sin(mesh.phase * 2) * 0.12 : 0;
  bones.Spine.rotation.z = rest.Spine.rot.z + (mesh.dropSide === 0 ? -0.18 : 0.18) + hitch;
}

/**
 * A hand-built crawl for a player with no legs left.
 *
 * There is no crawl clip in the export — the source only shipped running, jumping and rope
 * animations — so this drives the bones directly. It is deliberately a *drag*: the arms do
 * all the work, reaching forward alternately and hauling the body after them, while the
 * spine rolls with each pull. That asymmetry is what sells it as crawling rather than as
 * swimming, and it makes a legless player unmistakable from across the room.
 */
function poseCrawl(mesh, p, moving, dt) {
  const { bones, rest, body, baseScale } = mesh;
  mesh.wasCrawling = true;

  // Lie the whole body down and drop it to floor height. Rotating the root rather than the
  // hips keeps the skinning clean and costs one matrix.
  body.rotation.z = 0;
  // Tip FORWARD onto the front, not backward. The model faces -z, so a -90° pitch rotates
  // its forward axis up and behind it — the crawler ends up dragging itself head-first in
  // the direction it came from. +90° lays it on its front still pointing down the aisle.
  //
  // Go slightly PAST flat rather than stopping short of it. Seen from a camera that is
  // already looking down, a body held a few degrees above horizontal still presents its back
  // as an upright silhouette — it reads as someone standing, with whichever arm is forward
  // sticking out sideways. Overshooting pins the chest to the ground and makes the pose
  // unmistakably prone from this angle.
  body.rotation.x = Math.PI / 2 + 0.16;
  body.scale.setScalar(baseScale);

  // Pull the body back onto the player's actual position.
  //
  // The model's pivot is between its feet, so pitching it 90° about that point swings the
  // whole torso forward — measured at 1.59 tiles, nearly two. The sim, the sonar ping and
  // the mine test all use the player's position, so an uncorrected crawler is drawn well
  // ahead of the spot their own light is coming from: they appear to walk into mines their
  // ping just showed as clear, and the ring looks like it trails behind them.
  //
  // The shift is derived from the avatar's height rather than hardcoded, so it stays right
  // if AVATAR_HEIGHT changes.
  // Lift enough to clear the floor. Pitching about the foot pivot swings the torso DOWN as
  // well as forward, so a fixed nudge is not enough: measured, the body sank 0.65 units
  // through the ground and only the raised shoulder stayed visible — which reads as a lump
  // lying at an angle rather than as a person on their front. Both the lift and the forward
  // shift scale with the avatar so they stay right at any size.
  body.position.set(0, CRAWL_LIFT * AVATAR_HEIGHT, -CRAWL_PIVOT_SHIFT * AVATAR_HEIGHT);

  if (!bones || !rest) return;

  applyLegs(mesh, 0);

  // A stationary crawler gets its own pose rather than a shrunken version of the stroke.
  // Scaling the same cycle down just reads as swimming slowly on the spot; what a person
  // face-down on the ground actually does is stop, prop themselves on their forearms and
  // breathe. That contrast is also information — you can tell at a glance across the aisle
  // whether a crawler is still making progress or has given up.
  if (!moving) { poseCrawlIdle(mesh); return; }

  const t = mesh.phase;
  const amp = 1;

  // Arms alternate: one reaches ahead while the other pulls through, a half-cycle apart.
  const reachL = Math.sin(t);
  const reachR = Math.sin(t + Math.PI);

  // Arms stay tucked close to the body and reach along it, rather than out to the sides.
  // Splaying them wide was what made a crawler read as a standing figure with one arm
  // pointing off to the right: from overhead the outstretched limb is the most legible part
  // of the silhouette, and it dominates the shape.
  if (bones.LeftArm) {
    bones.LeftArm.rotation.x = rest.LeftArm.rot.x + (-0.9 + reachL * 0.75) * amp;
    bones.LeftArm.rotation.z = rest.LeftArm.rot.z - 0.22 * amp;
  }
  if (bones.RightArm) {
    bones.RightArm.rotation.x = rest.RightArm.rot.x + (-0.9 + reachR * 0.75) * amp;
    bones.RightArm.rotation.z = rest.RightArm.rot.z + 0.22 * amp;
  }
  // Forearms bend hardest at the end of the pull, where the hand is under the shoulder.
  if (bones.LeftForeArm) {
    bones.LeftForeArm.rotation.x = rest.LeftForeArm.rot.x - (0.5 + Math.max(0, -reachL) * 0.7) * amp;
  }
  if (bones.RightForeArm) {
    bones.RightForeArm.rotation.x = rest.RightForeArm.rot.x - (0.5 + Math.max(0, -reachR) * 0.7) * amp;
  }

  // The spine rolls toward whichever arm is currently pulling, and the torso inches forward
  // in time with it — the small surge that makes the drag read as effortful.
  if (bones.Spine) bones.Spine.rotation.y = rest.Spine.rot.y + reachL * 0.16 * amp;
  if (bones.Spine01) bones.Spine01.rotation.y = rest.Spine01.rot.y + reachL * 0.1 * amp;
  if (bones.Spine02) bones.Spine02.rotation.y = rest.Spine02.rot.y + reachL * 0.08 * amp;

  // Head stays up and forward — a crawler is still looking where they are going, and it
  // keeps the silhouette from reading as a corpse.
  if (bones.Head) bones.Head.rotation.x = rest.Head.rot.x - 0.45;

  // A slight bob as the body is hauled along.
  body.position.y = CRAWL_LIFT * AVATAR_HEIGHT
    + (moving ? Math.abs(Math.sin(t)) * 0.03 * AVATAR_HEIGHT : 0);
}

/* ------------------------------------------------------------------- killer */

/**
 * The crusher: a wall-to-wall press grinding up the aisle.
 *
 * It is deliberately not a creature. There is no face to read and nothing to make eye
 * contact with, because it is not choosing anybody — it spans the full width and takes
 * whatever is in front of it. A machine communicates "you cannot dodge this, you can only
 * outrun it", which is exactly the rule the sim enforces.
 */
export function createKillerMesh(Q, level) {
  const group = new THREE.Group();

  const w = level.cols + 0.8;
  const h = 2.6;

  // The slab itself: heavy, matte, and completely featureless.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x0d1018, roughness: 0.85, metalness: 0.45,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, 1.1), bodyMat);
  body.position.y = h / 2;
  if (Q.shadows) body.castShadow = true;
  group.add(body);

  // The leading face, lit hot so the exact line of death is never ambiguous. Players must be
  // able to judge the gap to it precisely, because that measurement is the whole game once
  // somebody is limping.
  const faceMat = new THREE.MeshBasicMaterial({ color: 0xff2e88 });
  const face = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.92, 0.12), faceMat);
  face.position.set(0, h / 2, -0.58);
  group.add(face);

  // Teeth along the bottom edge of the face — the one piece of detail it gets, and the thing
  // that makes it read as a crusher rather than as a moving wall.
  const toothMat = new THREE.MeshStandardMaterial({
    color: 0x2a3550, roughness: 0.6, metalness: 0.7,
  });
  const teeth = Math.max(4, Math.round(level.cols));
  for (let i = 0; i < teeth; i++) {
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 4), toothMat);
    tooth.rotation.x = -Math.PI / 2;
    tooth.position.set(-w / 2 + (w / teeth) * (i + 0.5), 0.3, -0.75);
    group.add(tooth);
  }

  // A band of light thrown on the floor ahead of the face, so the press announces its reach
  // before it arrives.
  const auraMat = new THREE.MeshBasicMaterial({
    color: 0xff2e88, transparent: true, opacity: 0.16,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const aura = new THREE.Mesh(new THREE.PlaneGeometry(w, 5), auraMat);
  aura.rotation.x = -Math.PI / 2;
  aura.position.set(0, 0.04, -3.1);
  group.add(aura);

  const halo = new THREE.PointLight(0xff2e88, 3.2, 9, 2);
  halo.position.set(0, 1.4, -1.2);
  group.add(halo);

  return { group, body, face, halo, aura };
}

/* ------------------------------------------------------------------- sonar */

/**
 * The visible ring of one player's ping — a thin expanding annulus on the floor, in that
 * player's own colour, so you can always tell whose light just showed you something.
 */
export function createPingRing(colorHex) {
  const mat = new THREE.MeshBasicMaterial({
    color: colorHex, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.05;
  mesh.visible = false;
  return { mesh, mat };
}

/** Size and fade a ping ring for the current state of that player's emitter. */
export function updatePingRing(ring, ping, level) {
  if (!ping || ping.r <= 0) { ring.mesh.visible = false; return; }

  const r = Math.max(0.05, ping.r);
  ring.mesh.visible = true;
  ring.mesh.position.set(ping.x, 0.05, ping.z);
  ring.mesh.scale.setScalar(r);

  // Fade as it reaches the edge of its radius, so the ring dies where its usefulness does.
  const frac = r / level.sonarRadius;
  ring.mat.opacity = Math.max(0, 0.5 * (1 - frac * frac));
}

/* -------------------------------------------------------------------- decals */

/** A blast: an expanding flash on the ground plus a burst of sparks. */
export function createBlast(Q) {
  const group = new THREE.Group();

  // Deliberately small and short-lived. An explosion is the loudest thing that happens, but
  // it must not out-shine the sonar: a flash that floods the aisle erases everyone's lamps
  // for a second and takes the one mechanic the game is about with it.
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffb066, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flash = new THREE.Mesh(new THREE.CircleGeometry(0.55, 20), flashMat);
  flash.rotation.x = -Math.PI / 2;
  flash.position.y = 0.06;
  group.add(flash);

  const light = new THREE.PointLight(0xffa040, 6, 5.5, 2);
  light.position.y = 0.8;
  group.add(light);

  let sparks = null;
  if (Q.blastSparks > 0) {
    const n = Q.blastSparks;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = 2.2 + Math.random() * 3.4;
      const out = 1.4 + Math.random() * 3.2;
      vel[i * 3] = Math.cos(a) * out;
      vel[i * 3 + 1] = up;
      vel[i * 3 + 2] = Math.sin(a) * out;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffc247, size: 0.14, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    sparks = { points: new THREE.Points(geo, mat), geo, pos, vel, mat, n };
    group.add(sparks.points);
  }

  return { group, flash, flashMat, light, sparks, life: 1 };
}

/** Advance a blast effect. Returns false once it is finished and should be removed. */
export function stepBlast(fx, dt) {
  fx.life -= dt * 1.25;
  if (fx.life <= 0) return false;

  const a = fx.life;
  fx.flash.scale.setScalar(1 + (1 - a) * 2.2);
  fx.flashMat.opacity = a * a * 0.5;   // squared, so it is bright only at the very moment
  fx.light.intensity = a * a * 6;

  if (fx.sparks) {
    const { pos, vel, n, geo, mat } = fx.sparks;
    for (let i = 0; i < n; i++) {
      vel[i * 3 + 1] -= 9.8 * dt;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] = Math.max(0.02, pos[i * 3 + 1] + vel[i * 3 + 1] * dt);
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
    }
    geo.attributes.position.needsUpdate = true;
    mat.opacity = a;
  }

  return true;
}

/**
 * Blood on the floor where a mine took someone's legs.
 *
 * Unlike the blast itself this does not fade — the aisle accumulates the evidence of every
 * step that went wrong, so a field late in a round is legibly a place where things have been
 * happening. It doubles as information: a splatter marks a tile somebody already triggered,
 * which is the safest ground there is.
 *
 * Built as a ragged fan of overlapping blobs rather than a texture, so it costs one small
 * geometry and no image download.
 */
export function createBloodSplat(rng = Math.random) {
  const group = new THREE.Group();

  const mat = new THREE.MeshBasicMaterial({
    color: 0x8e0f2a, transparent: true, opacity: 0.72, depthWrite: false,
  });

  // A central pool plus a scatter of droplets thrown outward, biased into a lopsided spray
  // so no two look alike and none of them read as a printed circle.
  const blobs = 7 + Math.floor(rng() * 5);
  const dir = rng() * Math.PI * 2;
  for (let i = 0; i < blobs; i++) {
    const isCore = i < 2;
    const r = isCore ? 0.16 + rng() * 0.12 : 0.03 + rng() * 0.07;
    const spread = isCore ? rng() * 0.08 : 0.12 + rng() * 0.42;
    // Cluster the spray around one direction, the way a real splatter throws.
    const a = dir + (rng() - 0.5) * (isCore ? 6.28 : 2.4);

    const blob = new THREE.Mesh(new THREE.CircleGeometry(r, 9), mat);
    blob.rotation.x = -Math.PI / 2;
    blob.rotation.z = rng() * Math.PI;
    // Squash each blob slightly so they are irregular rather than perfect discs.
    blob.scale.set(1, 1, 0.6 + rng() * 0.7);
    blob.position.set(Math.cos(a) * spread, 0.012 + i * 0.0006, Math.sin(a) * spread);
    group.add(blob);
  }

  return { group, mat };
}

/**
 * A footprint on the ground. These are the game's memory and its central lie — they say
 * someone walked here, never that it was safe.
 */
export function createPrintMesh(colorHex, crawl) {
  const mat = new THREE.MeshBasicMaterial({
    color: colorHex, transparent: true, opacity: 0.45,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const geo = crawl
    ? new THREE.PlaneGeometry(0.42, 0.16)     // a drag mark
    : new THREE.CircleGeometry(0.1, 8);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.025;
  return { mesh, mat };
}

/** Resize the renderer and camera to the canvas's current size. */
export function resize(ctx, canvas) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  ctx.renderer.setSize(w, h, false);
  ctx.camera.aspect = w / h;
  ctx.camera.updateProjectionMatrix();
}
