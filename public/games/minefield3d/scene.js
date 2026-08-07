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
/**
 * @param {"escape"|"survival"|"calls"} mode Which game this scene is for. Was a boolean
 *   `survival` flag until a third mode arrived; a string keeps the call sites honest rather
 *   than growing a second boolean nobody can read at the call site.
 */
export function createScene(canvas, level, Q, mode = "escape") {
  const survival = mode === "survival";
  const calls = mode === "calls";
  const sniper = mode === "sniper";
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
  //
  // Survival pushes it back. That camera sits above the whole room rather than down a
  // corridor, so aisle-tuned fog closes over the far wall and hides the machines crossing
  // toward you — and a saw you cannot see coming is the one thing this mode must never have.
  //
  // Calls turns it off entirely. That stage is a small lit platform hanging in the dark with a
  // screen behind it; fog would grey out the screen — the one thing every player must be able
  // to read — and there is no hidden ground for it to protect.
  if (Q.fog && !calls) {
    const far = Math.max(level.cols, level.rows);
    // Sniper fog is pushed right back. The whole mode is a long sight-line, and aisle-tuned
    // fog would grey out the runners at exactly the range the rifle exists to reach — the
    // sniper would be shooting at a wall of haze and the runners would be safe by accident.
    scene.fog = sniper
      ? new THREE.Fog(0x03040a, level.rows * 0.8, level.rows * 2.4)
      : survival
        ? new THREE.Fog(0x03040a, far * 0.9, far * 2.1)
        : new THREE.Fog(0x03040a, level.rows * 0.35, level.rows * 0.95);
  }

  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 400);

  // Ambient is deliberately almost nothing. The aisle is meant to be dark enough that the
  // sonar is the only real light source; anything more and players can simply see the mines.
  //
  // Calls is the exception and needs real light: nothing is hidden there, and the entire mode
  // is reading a symbol on a tile and a symbol on a wall. At aisle ambient the stage renders as
  // a black rectangle with two glowing shapes floating on it.
  // The range is lit too: cover is what hides a runner, not darkness. At aisle ambient the
  // sniper would be firing at shapes they cannot resolve, which is a different game.
  scene.add(new THREE.AmbientLight(0x2a3550, calls ? 1.35 : sniper ? 0.95 : 0.22));

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

  // Calls builds its floor as 24 independent tiles instead of one vertex-coloured mesh, since
  // every tile moves on its own. That is only affordable because the grid is 6×4 — the same
  // approach on a 22×22 arena would be 484 draw calls.
  const floor = calls ? null : buildFloor(level, Q);
  if (floor) {
    world.add(floor.mesh);
    if (Q.shadows) floor.mesh.receiveShadow = true;
  }

  let tiles = null;
  let board = null;
  if (calls) {
    tiles = buildCallTiles(level, Q);
    world.add(tiles.group);
    board = buildCallBoard(level);
    world.add(board.group);
    world.add(buildCrusher(level));
  }

  // Survival is a sealed room: four walls, no doorway. The gate is still constructed so every
  // caller of setGateOpen keeps working, but it is left out of the scene entirely — a lit exit
  // in a mode with no exit is the single most misleading thing the screen could show.
  //
  // Calls gets no walls at all: the stage is a platform in the void, and the drop off its edge
  // has to be visibly a drop.
  const gate = buildGate(level);
  if (survival) {
    world.add(buildArenaWalls(level));
  } else if (!calls) {
    // Sniper reuses the aisle's walls and gate wholesale: it IS an aisle with a gate, just
    // with something in the rafters.
    world.add(buildWalls(level));
    world.add(gate.group);
  }

  // The sniper's own view. A second camera on the same scene rather than a second scene: the
  // two halves of the screen are looking at the same aisle from different places, and keeping
  // one scene means a runner and their cover can never disagree between the views.
  let sniperCam = null;
  let nest = null;
  let laser = null;
  if (sniper) {
    sniperCam = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 400);
    // The sniper sees the default layer and NOT the gantry they are standing on; the aisle
    // camera is opted in to both, so the runners still see the platform overhead.
    sniperCam.layers.set(0);
    camera.layers.enable(LAYER_NEST_STRUCT);
    nest = buildNest(level);
    world.add(nest.group);
    laser = buildLaser();
    world.add(laser.group);
  }

  return {
    renderer, scene, camera, world, floor, gate, level, Q,
    mode, survival, calls, sniper, tiles, board,
    sniperCam, nest, laser,
  };
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

  // Low does not light the floor at all: the aisle stays dark ground and the sonar is read
  // from the ping ring and the mines it uncovers. Painted flat exactly once — skipping the
  // work without this would leave whatever the previous tier had uploaded frozen on screen,
  // which is worse than either state. Checked before the interval gate so a tier switch
  // takes effect on the next frame rather than after floorHz has elapsed.
  //
  // Survival is exempt. Its floor has no sonar written into it — it is a static fill done
  // once per round, so it is already free, and blacking out an arena would take the room
  // away to save nothing. This gate is about the per-frame sonar sweep, which only escape has.
  if (!Q.floorLight && !ctx.survival) {
    if (floor.darkDone) return;
    floor.darkDone = true;
    const g = COL.ground;
    for (let i = 0; i < floor.count; i++) {
      floor.colors[i * 3] = g.r;
      floor.colors[i * 3 + 1] = g.g;
      floor.colors[i * 3 + 2] = g.b;
    }
    floor.geo.attributes.color.needsUpdate = true;
    return;
  }
  // Coming back up a tier has to redo the flat fill below.
  floor.darkDone = false;

  const minInterval = 1000 / Math.max(1, Q.floorHz);
  if (now - floor.lastUpdate < minInterval) return;
  floor.lastUpdate = now;

  const { colors, vertexTile, count } = floor;

  // Survival has no sonar and nothing hidden on the ground, so its floor is simply lit — and
  // lit ONCE, not every frame. Sweeping every tile's reveal is this renderer's largest
  // per-frame cost, and in an arena it would be computing zero over and over: the machines
  // are the only thing to look at, and they carry their own light.
  if (ctx.survival) {
    if (floor.flatDone) return;
    floor.flatDone = true;
    const base = COL.groundLit;
    for (let i = 0; i < count; i++) {
      // A gentle gradient rather than a flat fill, so the room still reads as a receding
      // surface with a near and a far end instead of as one painted rectangle.
      const tz = vertexTile[i * 2 + 1];
      const k = 0.55 + 0.45 * (1 - tz / Math.max(1, round.rows - 1));
      colors[i * 3] = base.r * k;
      colors[i * 3 + 1] = base.g * k;
      colors[i * 3 + 2] = base.b * k;
    }
    floor.geo.attributes.color.needsUpdate = true;
    return;
  }

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

/**
 * The survival arena: four walls, no way out.
 *
 * All four are built the same way the aisle's back wall is — as glass rather than as solid
 * panel. In the aisle only the wall behind the spawn had to be see-through; here the camera
 * orbits nothing and sits above the room looking down at it, so whichever wall is nearest the
 * camera crosses the bottom of the shot. Solid, it would hide exactly the strip of floor the
 * player is most likely to be backed into.
 */
function buildArenaWalls(level) {
  const group = new THREE.Group();

  const h = 2.6;
  const t = 0.4;

  const glassMat = new THREE.MeshBasicMaterial({
    color: 0x1a2740, transparent: true, opacity: 0.16,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const lipMat = new THREE.MeshBasicMaterial({
    color: 0x2a4266, transparent: true, opacity: 0.55, depthWrite: false,
  });

  // A bright line where each wall meets the floor. This is what actually communicates the
  // boundary: the glass reads as haze from above, but the floor line is unambiguous, and
  // knowing exactly where the wall is is the difference between circling and being cornered.
  const baseMat = new THREE.MeshBasicMaterial({
    color: 0x35f0e0, transparent: true, opacity: 0.3,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });

  const sides = [
    { w: level.cols + t * 2, d: t, x: level.cols / 2, z: -t / 2 },
    { w: level.cols + t * 2, d: t, x: level.cols / 2, z: level.rows + t / 2 },
    { w: t, d: level.rows + t * 2, x: -t / 2, z: level.rows / 2 },
    { w: t, d: level.rows + t * 2, x: level.cols + t / 2, z: level.rows / 2 },
  ];

  for (const s of sides) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(s.w, h, s.d), glassMat);
    wall.position.set(s.x, h / 2, s.z);
    group.add(wall);

    const lip = new THREE.Mesh(new THREE.BoxGeometry(s.w, 0.02, s.d * 0.5), lipMat);
    lip.position.set(s.x, h, s.z);
    group.add(lip);

    const base = new THREE.Mesh(new THREE.BoxGeometry(s.w, 0.015, s.d * 0.6), baseMat);
    base.position.set(s.x, 0.03, s.z);
    group.add(base);
  }

  return group;
}

/**
 * Frame the whole arena from above.
 *
 * Deliberately a fixed shot, unlike the aisle's follow-cam. The mode is about reading the
 * positions of every machine at once and picking a gap; a camera that chases the pack would
 * swing whenever the pack moved and make the room impossible to hold in your head. It sits
 * still, high, tilted just enough that the avatars have a silhouette instead of being discs.
 */
export function updateArenaCamera(ctx, dt) {
  const { camera, level } = ctx;

  // Height and setback are derived from the vertical field of view rather than picked, so a
  // 20-tile room and a 24-tile room both fill the same fraction of the frame. Guessed
  // constants looked right on one arena and left the next one as a postage stamp with the
  // near wall cropped off the bottom.
  const fov = (camera.fov * Math.PI) / 180;

  // Fit the room to whichever axis actually binds. Sizing to the diagonal (the obvious first
  // guess) is wrong: the room is seen tilted, not corner-on, so its depth is foreshortened by
  // sin(tilt) and the diagonal overstates what has to fit — it rendered the arena noticeably
  // smaller than the aisle camera did.
  //
  // Horizontally the limit is the width against the horizontal fov; vertically it is the
  // *projected* depth plus the walls' height, which leans into frame at this angle.
  //
  // The wall term is the part that is easy to drop and the reason an earlier pass cropped the
  // near wall off the bottom of the shot: the floor fitted perfectly and the 2.6-unit walls
  // standing on it did not.
  const aspect = camera.aspect || 16 / 9;
  const tiltRad = (58 * Math.PI) / 180;
  const WALL_H = 2.6;
  const needV = (level.rows * Math.sin(tiltRad) + WALL_H * Math.cos(tiltRad)) * 0.5;
  const needH = (level.cols * 0.5) / aspect;
  // A little air on top of that, so the room never touches the edges of the frame.
  const dist = (Math.max(needV, needH) * 1.3) / Math.tan(fov / 2);

  // The tilt is fixed at 58°: steep enough to read the floor as a plane and judge gaps between
  // machines, shallow enough that the avatars keep a silhouette instead of becoming discs.
  const wantX = level.cols / 2;
  const wantY = Math.sin(tiltRad) * dist;
  const wantZ = level.rows / 2 + Math.cos(tiltRad) * dist;

  // Still eased rather than snapped, so a level change or a quality rebuild slides into place
  // instead of cutting.
  const k = 1 - Math.exp(-dt * 2.2);
  camera.position.x += (wantX - camera.position.x) * k;
  camera.position.y += (wantY - camera.position.y) * k;
  camera.position.z += (wantZ - camera.position.z) * k;

  // Aim at the middle of the floor. Biasing the look-at further down the room was tried and
  // reverted: it tilts the whole arena up in frame and takes the near wall — the one the
  // players are most often backed against — off the bottom of the screen.
  camera.lookAt(level.cols / 2, 0, level.rows / 2);
}

/* -------------------------------------------------------------------- calls */

const CALL_COL = {
  x: new THREE.Color("#35f0e0"),
  o: new THREE.Color("#ff2e88"),
  tile: new THREE.Color("#141a2c"),
  tileLit: new THREE.Color("#26314f"),
};

/**
 * A drawn X and a drawn O, as flat geometry on the tile's top face.
 *
 * Built from boxes rather than from a canvas texture: at 24 tiles a texture per symbol would
 * mean an atlas and UVs for a shape that is two crossed bars, and the bars read more crisply
 * from this camera angle than a low-res glyph would.
 */
function buildSymbol(sym, colorHex) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: colorHex });

  if (sym === 0) {
    for (const rot of [Math.PI / 4, -Math.PI / 4]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.11), mat);
      bar.rotation.y = rot;
      group.add(bar);
    }
  } else {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.055, 8, 20), mat);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
  }

  return { group, mat };
}

/**
 * The 6×4 grid, as independent tiles.
 *
 * Each tile is its own group so it can drop on its own clock. Both symbols are built onto every
 * tile up front and toggled with `.visible` — re-creating geometry on each shuffle would mean
 * 24 allocations and disposals every couple of seconds, which is exactly the kind of churn that
 * causes a GC hitch at the worst possible moment.
 */
export function buildCallTiles(level, Q) {
  const group = new THREE.Group();
  const list = [];

  for (let z = 0; z < level.rows; z++) {
    for (let x = 0; x < level.cols; x++) {
      const holder = new THREE.Group();
      holder.position.set(x + 0.5, 0, z + 0.5);

      const mat = new THREE.MeshStandardMaterial({
        color: CALL_COL.tile, roughness: 0.85, metalness: 0.1,
      });
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.22, 0.94), mat);
      slab.position.y = -0.11;
      if (Q.shadows) slab.receiveShadow = true;
      holder.add(slab);

      // A rim light around the top edge, so the grid reads as a grid of separate platforms
      // rather than as one painted surface with lines on it.
      const edgeMat = new THREE.MeshBasicMaterial({
        color: 0x2a4266, transparent: true, opacity: 0.5, depthWrite: false,
      });
      const edge = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.012, 4, 4), edgeMat);
      edge.rotation.x = -Math.PI / 2;
      edge.rotation.z = Math.PI / 4;
      edge.position.y = 0.005;
      holder.add(edge);

      const xSym = buildSymbol(0, CALL_COL.x.getHex());
      const oSym = buildSymbol(1, CALL_COL.o.getHex());
      xSym.group.position.y = 0.012;
      oSym.group.position.y = 0.012;
      holder.add(xSym.group);
      holder.add(oSym.group);

      group.add(holder);
      list.push({ holder, slab, mat, edgeMat, xSym, oSym, x, z });
    }
  }

  return { group, list, cols: level.cols };
}

/** Sync every tile to the sim: which symbol it shows, how far it has dropped, how lit it is. */
export function updateCallTiles(tiles, round, sim, dt) {
  for (const t of tiles.list) {
    const i = t.z * tiles.cols + t.x;
    const sym = round.tileSym[i];
    const state = round.tileState[i];

    t.xSym.group.visible = sym === sim.SYM_X;
    t.oSym.group.visible = sym === sim.SYM_O;

    t.holder.position.y = -round.tileDrop[i];

    // A tile bearing the called symbol lights up: that is the answer, and it must be readable
    // from the floor as well as off the wall screen — a player looking down at their own feet
    // should be able to tell whether they are safe.
    const safe = round.called !== null && sym === round.called &&
      (state === sim.TILE_SOLID || state === sim.TILE_RISING);
    const target = safe ? CALL_COL.tileLit : CALL_COL.tile;
    t.mat.color.lerp(target, Math.min(1, dt * 8));

    // Falling tiles tumble, so the drop reads as the floor giving way rather than as a lift
    // going down.
    if (state === sim.TILE_FALLING) {
      t.holder.rotation.x += dt * 1.6;
      t.holder.rotation.z += dt * 1.1;
    } else if (state === sim.TILE_SOLID) {
      t.holder.rotation.x = 0;
      t.holder.rotation.z = 0;
    }
  }
}

/**
 * The screen on the back wall — the thing every player is actually reading.
 *
 * Deliberately enormous and self-lit. This is the only source of information in the mode, it
 * has to be legible from the far row at a glance and while running, and it is the one object
 * on screen that must never be ambiguous.
 */
export function buildCallBoard(level) {
  const group = new THREE.Group();

  const w = level.cols * 0.82;
  const h = 3.6;
  const cx = level.cols / 2;
  const z = -1.4;

  // The bezel.
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x0a0d16, roughness: 0.9, metalness: 0.3,
  });
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.5, h + 0.5, 0.3), frameMat);
  frame.position.set(cx, h / 2 + 0.9, z - 0.16);
  group.add(frame);

  // The panel itself, dark until a symbol is called.
  const panelMat = new THREE.MeshBasicMaterial({ color: 0x05070f });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), panelMat);
  panel.position.set(cx, h / 2 + 0.9, z);
  group.add(panel);

  // Both symbols, huge, one shown at a time.
  const symX = buildSymbol(0, CALL_COL.x.getHex());
  const symO = buildSymbol(1, CALL_COL.o.getHex());
  for (const s of [symX, symO]) {
    // The symbol builders draw flat on the ground plane; stand them up to face the room.
    s.group.rotation.x = Math.PI / 2;
    s.group.scale.setScalar(4.2);
    s.group.position.set(cx, h / 2 + 0.9, z + 0.06);
    s.group.visible = false;
    group.add(s.group);
  }

  // A bar under the panel that drains as the clock runs down — the same information as the
  // number on the HUD, but where the players are already looking.
  const barMat = new THREE.MeshBasicMaterial({ color: 0x35f0e0 });
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.22), barMat);
  bar.position.set(cx, 0.72, z + 0.02);
  group.add(bar);

  const lamp = new THREE.PointLight(0xffffff, 0, 16, 2);
  lamp.position.set(cx, h / 2 + 0.9, z + 2.2);
  group.add(lamp);

  return { group, panel, panelMat, symX, symO, bar, barMat, lamp, width: w };
}

/** Show the called symbol and drain the timer bar. */
export function updateCallBoard(board, round, sim) {
  const called = round.called;
  const showing = called !== null && round.callPhase === sim.CALL_SHOWING;

  board.symX.group.visible = showing && called === sim.SYM_X;
  board.symO.group.visible = showing && called === sim.SYM_O;

  const hue = called === sim.SYM_O ? CALL_COL.o : CALL_COL.x;

  if (showing) {
    const frac = Math.max(0, Math.min(1, round.callLeft / Math.max(0.001, round.callTime)));
    board.bar.scale.x = frac;
    // The bar drains from both ends toward the middle, which reads faster than a bar that
    // empties from one side — the remaining time is a symmetric shape, not a length to measure.
    board.bar.visible = true;
    board.barMat.color.copy(hue);
    // Panic colour in the last stretch, so the deadline is felt without reading a number.
    if (frac < 0.28) board.barMat.color.copy(CALL_COL.o);

    board.panelMat.color.copy(hue).multiplyScalar(0.12);
    board.lamp.color.copy(hue);
    board.lamp.intensity = 1.6 + (1 - frac) * 2.2;
  } else {
    board.bar.visible = false;
    board.panelMat.color.setHex(0x05070f);
    board.lamp.intensity = 0;
  }
}

/**
 * The crusher under the stage.
 *
 * Never seen clearly and not meant to be — it is a glow and a set of turning teeth below the
 * grid, so that a hole in the floor reads as a drop into something rather than into nothing.
 */
function buildCrusher(level) {
  const group = new THREE.Group();
  const cx = level.cols / 2;
  const cz = level.rows / 2;
  const depth = (level.crusherDepth || 5) + 0.6;

  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xff2e88, transparent: true, opacity: 0.3,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(level.cols, level.rows), glowMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(cx, -depth, cz);
  group.add(pool);

  const toothMat = new THREE.MeshStandardMaterial({
    color: 0x2a3550, roughness: 0.5, metalness: 0.8,
  });
  // Two counter-turning rollers, suggested rather than modelled.
  for (let r = 0; r < 2; r++) {
    const roller = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, level.cols - 0.4, 8),
      toothMat
    );
    roller.rotation.z = Math.PI / 2;
    roller.position.set(cx, -depth + 0.5, cz + (r === 0 ? -1.1 : 1.1));
    group.add(roller);
  }

  const lamp = new THREE.PointLight(0xff2e88, 2.4, depth * 2.2, 2);
  lamp.position.set(cx, -depth + 1.4, cz);
  group.add(lamp);

  return group;
}

/**
 * Frame the stage and the screen together.
 *
 * Unlike the arena camera this must keep something *vertical* in shot — the board is the whole
 * point and it stands above the far edge — so the fit is computed against the board's top
 * rather than against the floor's extent, and the tilt is shallower so the screen faces the
 * camera rather than being seen edge-on from above.
 */
export function updateCallCamera(ctx, dt) {
  const { camera, level } = ctx;

  const fov = (camera.fov * Math.PI) / 180;
  // Steeper than the first pass. At 34° the board and the grid overlapped in frame and the
  // players stood *in front of* the screen rather than visibly on the squares — and which
  // square someone is on is the only fact this mode communicates.
  const tiltRad = (46 * Math.PI) / 180;

  // What has to fit vertically: the grid's projected depth plus the full height of the board
  // standing at the back of it.
  const boardTop = 5.4;
  const needV = (level.rows * Math.sin(tiltRad) + boardTop * Math.cos(tiltRad)) * 0.5;
  const needH = (level.cols * 0.5) / (camera.aspect || 16 / 9);
  // 1.35 rather than a tighter fit: some air is wanted around the stage so it reads as a
  // platform in a void, but at 1.75 the grid became a postage stamp in the middle of an
  // otherwise empty frame and the symbols stopped being readable at a glance.
  const dist = (Math.max(needV, needH) * 1.35) / Math.tan(fov / 2);

  const wantX = level.cols / 2;
  const wantY = Math.sin(tiltRad) * dist + 1.2;
  const wantZ = level.rows / 2 + Math.cos(tiltRad) * dist;

  const k = 1 - Math.exp(-dt * 2.2);
  camera.position.x += (wantX - camera.position.x) * k;
  camera.position.y += (wantY - camera.position.y) * k;
  camera.position.z += (wantZ - camera.position.z) * k;

  // Aim above the floor's midpoint so the board sits in the upper half of frame and the grid
  // in the lower — both fully readable, neither crowding the other.
  camera.lookAt(level.cols / 2, 1.5, level.rows / 2 - 1.0);
}

/* ------------------------------------------------------------------- sniper */

/**
 * The cover blocks runners hide behind.
 *
 * One InstancedMesh for the whole aisle. There can be sixty-odd of them and they never move,
 * so instancing costs one draw call instead of sixty — the same reasoning as the mine field.
 */
export function buildCover(round, sim, Q) {
  const { cols, rows } = round.level;
  const h = round.level.coverHeight || 1.6;
  const max = cols * rows;

  const geo = new THREE.BoxGeometry(0.92, h, 0.92);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1b2438, roughness: 0.9, metalness: 0.15,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.count = 0;
  if (Q.shadows) { mesh.castShadow = true; mesh.receiveShadow = true; }

  // A hot rim along each block's top edge, so from the nest the cover reads as a skyline of
  // things to shoot over rather than as flat shapes on a dark floor.
  const rimGeo = new THREE.BoxGeometry(0.96, 0.045, 0.96);
  const rimMat = new THREE.MeshBasicMaterial({
    color: 0x35f0e0, transparent: true, opacity: 0.34, depthWrite: false,
  });
  const rim = new THREE.InstancedMesh(rimGeo, rimMat, max);
  rim.count = 0;

  const dummy = new THREE.Object3D();
  let n = 0;
  for (let z = 0; z < rows; z++) {
    for (let x = 0; x < cols; x++) {
      if (!sim.coverAt(round, x, z)) continue;
      dummy.position.set(x + 0.5, h / 2, z + 0.5);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      dummy.position.set(x + 0.5, h, z + 0.5);
      dummy.updateMatrix();
      rim.setMatrixAt(n, dummy.matrix);
      n++;
    }
  }
  mesh.count = n;
  rim.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  rim.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.add(mesh);
  group.add(rim);
  return { group, mesh, rim, count: n };
}

/**
 * The nest: a platform over the gate with the rifle on it.
 *
 * Built as scenery rather than as an avatar. The sniper is a player, but from the aisle they
 * are a silhouette on a gantry — what the runners need to read is the *rifle's* bearing, and
 * that is carried by the laser rather than by a body they can barely see at that range.
 */
export function buildNest(level) {
  const group = new THREE.Group();
  const cx = level.cols / 2;
  const h = level.nestHeight || 6.5;

  const strutMat = new THREE.MeshStandardMaterial({
    color: 0x0d1018, roughness: 0.85, metalness: 0.5,
  });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(level.cols * 0.5, 0.3, 2.2), strutMat);
  deck.position.set(cx, h - 0.15, -1.2);
  group.add(deck);

  // Legs down to the floor either side of the gate, so the nest is visibly supported rather
  // than floating over the doorway everyone is running at.
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, h, 0.22), strutMat);
    leg.position.set(cx + side * level.cols * 0.22, h / 2, -1.2);
    group.add(leg);
  }

  // A rail, and a lamp so the nest is legible from the far end of the aisle.
  const railMat = new THREE.MeshBasicMaterial({
    color: 0xff2e88, transparent: true, opacity: 0.55, depthWrite: false,
  });
  const rail = new THREE.Mesh(new THREE.BoxGeometry(level.cols * 0.5, 0.05, 0.06), railMat);
  rail.position.set(cx, h + 0.42, -0.2);
  group.add(rail);

  const lamp = new THREE.PointLight(0xff2e88, 1.6, 10, 2);
  lamp.position.set(cx, h + 0.6, -1.0);
  group.add(lamp);

  // The rifle itself, parented so the whole thing can be swung by the sim's aim.
  const rifle = new THREE.Group();
  const barrelMat = new THREE.MeshStandardMaterial({
    color: 0x2a3550, roughness: 0.4, metalness: 0.85,
  });
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.5), barrelMat);
  barrel.position.z = 0.75;
  rifle.add(barrel);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.5), barrelMat);
  stock.position.z = -0.2;
  rifle.add(stock);
  rifle.position.set(cx, h + 0.35, -1.2);
  group.add(rifle);

  // Everything built above this point is the platform itself — deck, legs, rail. Move it to
  // the structure layer so the sniper's camera can skip it while the aisle still sees it.
  // Done by subtraction rather than by tagging each mesh: the rifle and the lamp are the
  // only two things that must stay in both views, and naming the exceptions here means a
  // strut added later is hidden correctly without anyone having to remember this.
  for (const child of group.children) {
    if (child === rifle || child === lamp) continue;
    child.layers.set(LAYER_NEST_STRUCT);
  }

  return { group, rifle, lamp, height: h };
}

/**
 * The laser: a thin beam from the muzzle plus a dot where it lands.
 *
 * This is the mode's single most important piece of feedback, and it is deliberately visible
 * to *everyone*. The sniper needs it to aim; the runners need it far more, because seeing the
 * dot crawl toward their block is the only warning they get. Hiding it would make every death
 * arbitrary.
 */
export function buildLaser() {
  const group = new THREE.Group();

  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xff2e88, transparent: true, opacity: 0.32,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  // A unit-length cylinder along +z, scaled to the trace distance each frame.
  const beamGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 5);
  beamGeo.rotateX(Math.PI / 2);
  beamGeo.translate(0, 0, 0.5);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  group.add(beam);

  const dotMat = new THREE.MeshBasicMaterial({
    color: 0xff5c9d, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), dotMat);
  group.add(dot);

  // A ring flat on the ground under the dot, which is what actually reads from a distance —
  // a sphere at forty tiles is two pixels, but a ring on the floor keeps its shape.
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xff2e88, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.34, 16), haloMat);
  halo.rotation.x = -Math.PI / 2;
  group.add(halo);

  return { group, beam, beamMat, dot, dotMat, halo, haloMat };
}

/** Point the rifle and draw the beam from the muzzle to wherever the sim says it lands. */
export function updateSniper(nest, laser, round, sim, dt) {
  const from = sim.nestPos(round);

  if (nest) {
    nest.rifle.rotation.order = "YXZ";
    nest.rifle.rotation.y = round.aimYaw;
    nest.rifle.rotation.x = round.aimPitch;
    // A red pulse on the nest lamp while the bolt is being worked, so the aisle can see the
    // window it has to move in.
    const reloading = round.reload > 0;
    nest.lamp.intensity = reloading ? 0.5 : 1.6 + Math.sin(round.t * 6) * 0.3;
  }

  if (!laser) return;
  const at = round.laser;
  if (!at) { laser.group.visible = false; return; }
  laser.group.visible = true;

  laser.beam.position.set(from.x, from.y, from.z);
  laser.beam.lookAt(at.x, at.y, at.z);
  laser.beam.scale.set(1, 1, at.dist);

  laser.dot.position.set(at.x, at.y + 0.02, at.z);
  laser.halo.position.set(at.x, 0.04, at.z);
  // The halo only means anything where the beam meets the ground.
  laser.halo.visible = at.y < 0.4;

  // Hot while loaded, dim while the bolt is out — the colour is the "can he shoot right now"
  // tell, and it is the difference between breaking cover and staying put.
  const ready = round.reload <= 0;
  laser.dotMat.opacity = ready ? 0.95 : 0.4;
  laser.beamMat.opacity = ready ? 0.32 : 0.12;
  laser.haloMat.opacity = ready ? 0.5 : 0.18;
}

/**
 * The sniper's own camera: third person, over the shoulder of the rifle.
 *
 * Pulled back and up from the muzzle so the nest and the rail are in shot, which is what makes
 * it read as a person on a gantry rather than as a floating gun. Scoping pushes it forward and
 * narrows the field of view — the same camera, so the transition is a move rather than a cut.
 */
export function updateSniperCamera(camera, round, sim, dt) {
  const from = sim.nestPos(round);
  const cy = Math.cos(round.aimPitch);
  const dir = {
    x: Math.sin(round.aimYaw) * cy,
    y: Math.sin(round.aimPitch),
    z: Math.cos(round.aimYaw) * cy,
  };

  const scoped = round.scoped;

  /*
   * Hip-fire and scoped want opposite things from the same rifle, so they are solved apart.
   *
   * Hip-fire pulls BACK along the flat ground bearing. Retreating along the aim vector was
   * tried and is wrong: the rifle points steeply down into the aisle, so that line lifts the
   * camera above the nest to stare across the gantry. It also has to rise a body's height —
   * level with the muzzle it looks straight into the deck it stands on and the rail in front
   * of it, and the gantry becomes a ceiling across the shot.
   *
   * Scoped pushes FORWARD along the aim vector instead, for the reason given below.
   */

  // Flat bearing and its perpendicular, both in the ground plane.
  const bx = Math.sin(round.aimYaw);
  const bz = Math.cos(round.aimYaw);
  const rx = Math.cos(round.aimYaw);
  const rz = -Math.sin(round.aimYaw);

  let wantX, wantY, wantZ;
  if (scoped) {
    /*
     * Scoped, the camera moves ONTO the sight line and past the muzzle.
     *
     * Held behind the breech it sat inside the stock — an opaque box centimetres from the
     * lens — and the magnified view went black while the laser was visibly on a target in
     * the other half. The advance is along the AIM vector, not the flat bearing: the barrel
     * pitches with the shot, so only the aim line is guaranteed to run out of the weapon at
     * every angle. A flat push clears the rifle level and buries the lens in it steeply down.
     */
    const clear = 1.9;
    wantX = from.x + dir.x * clear;
    wantY = from.y + dir.y * clear + 0.12;
    wantZ = from.z + dir.z * clear;
  } else {
    // Hip-fire sits behind and above the shoulder, where "behind" is the ground bearing —
    // see the note above about why this must not follow the aim vector.
    const back = 3.0;
    const up = 2.0;
    const side = 0.85;
    wantX = from.x - bx * back + rx * side;
    wantY = from.y + up;
    wantZ = from.z - bz * back + rz * side;
  }

  const k = 1 - Math.exp(-dt * (scoped ? 14 : 9));
  camera.position.x += (wantX - camera.position.x) * k;
  camera.position.y += (wantY - camera.position.y) * k;
  camera.position.z += (wantZ - camera.position.z) * k;

  /*
   * Aim the look at a point on the FLOOR down the aim line, not at a fixed distance along it.
   *
   * A fixed multiple of the aim vector drifts with pitch: tipped down it lands short and
   * under the deck, tipped up it lands in empty air above the aisle, so the framing changes
   * every time the rifle moves. Solving for where the line actually meets the ground keeps
   * the target on the range at every angle — which is the point the sniper is looking at
   * anyway. The fallback distance covers a barrel that is level or rising, where there is no
   * intersection to solve for.
   */
  /*
   * The centre of frame is the point the beam stopped at, raised to chest height when that
   * point is bare floor.
   *
   * traceShot already returns a runner's chest when the line reaches one, so lifting
   * unconditionally aims the camera a metre over the head of whoever is being tracked — the
   * scope goes empty at the exact moment it should hold a target. The lift is only right for
   * a floor hit, where centring literally on the ground would put the crosshair on a runner's
   * feet and leave them aiming by the shadow.
   */
  const hit = round.laser;
  let tx, ty, tz;
  if (hit) {
    tx = hit.x; ty = hit.hit ? hit.y : hit.y + 1.0; tz = hit.z;
  } else if (dir.y < -0.02) {
    const dist = Math.min(45, from.y / -dir.y);
    tx = from.x + dir.x * dist; ty = 1.0; tz = from.z + dir.z * dist;
  } else {
    tx = from.x + dir.x * 30; ty = from.y + dir.y * 30; tz = from.z + dir.z * 30;
  }
  camera.lookAt(tx, ty, tz);

  const wantFov = scoped ? 14 : 58;
  if (Math.abs(camera.fov - wantFov) > 0.01) {
    camera.fov += (wantFov - camera.fov) * k;
    camera.updateProjectionMatrix();
  }
}

/**
 * The aisle camera for sniper mode.
 *
 * Frames the runners from behind, looking toward the gate and the nest above it, so the half
 * of the screen the runners are watching shows them what they are running at.
 */
export function updateRangeCamera(ctx, lead, tail, dt) {
  const { camera, level } = ctx;
  const spread = Math.max(0, tail - lead);

  const wantZ = tail + 9;
  const wantY = 8.5 + spread * 0.3;

  const k = 1 - Math.exp(-dt * 2.2);
  camera.position.x += (level.cols / 2 - camera.position.x) * k;
  camera.position.y += (wantY - camera.position.y) * k;
  camera.position.z += (wantZ - camera.position.z) * k;

  // Look ahead of the pack toward the gate, and high enough that the nest is in frame.
  camera.lookAt(level.cols / 2, 1.8, Math.max(0, (lead + tail) / 2 - 8));
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

/**
 * The layer holding the parts of the nest the sniper is standing on and behind.
 *
 * The aisle camera has to see the gantry — it is what tells the runners where the shot is
 * coming from. The sniper's own camera must not: it sits on that structure, so the deck
 * becomes a ceiling across the top of the shot and the rail a bar through the middle of it,
 * hiding the range the view exists to show. Both cameras render one shared scene, so the
 * only way to show a thing to one and not the other is a layer.
 *
 * The rifle deliberately stays off this layer. It is the one piece of the nest that belongs
 * in both views, and it is what makes the sniper's half read as over-the-shoulder.
 */
const LAYER_NEST_STRUCT = 1;

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

export function loadAvatar(url = "/games/minefield3d/ninja.glb?v=4") {
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

      // The knockdown pair are one-shots, not loops: they play once on a trigger and hold
      // their last frame. `clampWhenFinished` is what keeps a floored player lying on the
      // floor rather than snapping back to a standing bind pose the instant the clip ends.
      for (const name of ["behit", "standup"]) {
        const act = actions[name];
        if (!act) continue;
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
        act.setEffectiveWeight(0);
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
export function posePlayer(mesh, p, states, dt, round) {
  const { body, group, lamp, baseScale } = mesh;
  const s = baseScale;

  // The sniper is not on the floor at all, so none of the walking logic below applies to
  // them. Handled first and returned early: falling through would place them at y=0 under
  // their own gantry, standing in the gate everyone else is running at, playing the idle
  // clip — which is exactly the T-posed body behind the door.
  if (round && states.isSniper && states.isSniper(round, p.id)) {
    poseSniper(mesh, p, states, dt, round);
    mesh.wasSniper = true;
    return;
  }

  // Whoever held the rifle last round is a runner again. poseSniper moves their whole body
  // onto the nest layer to keep it out of their own view, and that has to be undone or they
  // spend the next round invisible to the camera the rest of the room is watching.
  if (mesh.wasSniper) {
    mesh.wasSniper = false;
    group.traverse((o) => o.layers.set(0));
  }

  // A player dropped through the floor keeps falling. Their y is the only thing that moves —
  // x and z are frozen at the tile that vanished, because there is nothing to walk on.
  const fell = states.fallDepth ? states.fallDepth(p) : 0;
  group.position.set(p.x, -fell, p.z);
  group.rotation.y = p.heading;

  if (fell > 0) {
    // Tumbling, upright-ish, lamp out. Deliberately NOT the flat-on-the-ground death pose
    // below: that one is a body lying on a floor, and this one has no floor to lie on.
    mesh.spin = (mesh.spin || 0) + (dt || 0) * 4.5;
    body.rotation.z = Math.sin(mesh.spin) * 0.5;
    body.rotation.x = mesh.spin * 0.8;
    body.position.set(0, mesh.isModel ? 0 : 0.62, 0);
    body.scale.setScalar(s);
    lamp.intensity = 0;
    if (mesh.glow) mesh.glow.material.opacity = 0;
    if (mesh.actions) {
      if (mesh.actions.idle) mesh.actions.idle.setEffectiveWeight(0);
      if (mesh.actions.running) mesh.actions.running.setEffectiveWeight(0);
    }
    return;
  }

  // Knocked down by a shove: play the hit, then the stand-up as the timer runs out.
  //
  // Driven off the sim's `downFor` countdown rather than off events, so it is correct on the
  // frame a scene is rebuilt mid-knockdown — an event-driven trigger would leave a player who
  // was on the floor during a quality switch standing upright and unable to move.
  if (states.isDown && states.isDown(p)) {
    const acts = mesh.actions;
    if (acts && acts.behit && acts.standup) {
      // The stand-up is started so it finishes exactly as control returns, which is what makes
      // getting up feel like the reason you can move again rather than a delay after it.
      const standTime = Math.min(acts.standup.getClip().duration, 0.9);
      const rising = p.downFor <= standTime;

      if (rising && !mesh.standing) {
        mesh.standing = true;
        acts.behit.setEffectiveWeight(0);
        acts.standup.reset();
        acts.standup.setEffectiveWeight(1);
        // Scale the clip so it lands on its feet as downFor hits zero, however long it is.
        acts.standup.timeScale = acts.standup.getClip().duration / Math.max(0.15, standTime);
        acts.standup.play();
      } else if (!rising && !mesh.knocked) {
        mesh.knocked = true;
        mesh.standing = false;
        acts.standup.setEffectiveWeight(0);
        acts.behit.reset();
        acts.behit.setEffectiveWeight(1);
        acts.behit.timeScale = 1;
        acts.behit.play();
      }

      if (acts.idle) acts.idle.setEffectiveWeight(0);
      if (acts.running) acts.running.setEffectiveWeight(0);
      if (mesh.mixer) mesh.mixer.update(dt || 0);
    } else if (!mesh.isModel) {
      // Capsule fallback: just lie it down.
      body.rotation.z = Math.PI / 2;
      body.position.y = 0.26;
      body.scale.setScalar(s);
    }

    // Undo any leg damage posing — the clips own the whole skeleton while they play.
    restoreBones(mesh);
    lamp.intensity = 1.6;
    if (mesh.glow) mesh.glow.material.opacity = 0.14;
    return;
  }
  // Back on their feet: let the locomotion clips take over again.
  if (mesh.knocked || mesh.standing) {
    mesh.knocked = false;
    mesh.standing = false;
    if (mesh.actions) {
      if (mesh.actions.behit) mesh.actions.behit.setEffectiveWeight(0);
      if (mesh.actions.standup) mesh.actions.standup.setEffectiveWeight(0);
    }
    mesh.blend = 0;
  }

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
      //
      // The floor is well above 1 rather than at 0.4, because speed/3.0 is only "normal
      // rate" for a two-legged player at a dead sprint. Anything slower — a limp, a stick
      // pushed halfway, or any of the shoving that goes on in an arena — drove the clip down
      // toward a third rate and read as slow motion. Legs that turn over slightly too fast
      // are invisible; legs that turn over too slowly look broken.
      running.timeScale = Math.max(1.15, speed / 3.0);
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

/**
 * The sniper, kneeling on the nest deck behind the rifle.
 *
 * Built by hand rather than from a clip because there is no firing animation in the rig, and
 * the pose has to track `aimYaw` continuously — a canned clip would face one fixed direction
 * while the barrel swung somewhere else.
 *
 * The body is turned by yaw only. Pitch is left to the rifle: a kneeling shooter tips the
 * weapon far more than the torso, and rolling the whole body with the barrel makes them lean
 * off the platform at the steep angles this nest mostly shoots at.
 */
function poseSniper(mesh, p, states, dt, round) {
  const { body, group, lamp, baseScale, bones, rest } = mesh;
  const s = baseScale;
  const from = states.nestPos(round);

  /*
   * Stand them on the deck, a step behind the rifle so the barrel reads as coming from their
   * hands.
   *
   * The deck's top surface is the level's nestHeight — buildNest centres a 0.3-thick slab at
   * `h - 0.15`, so its top lands exactly on `h`. Taking the height from the level rather than
   * from the muzzle keeps this correct if the rifle's own offset is ever retuned; deriving it
   * from nestPos meant two unrelated constants had to agree for the feet to touch anything.
   */
  const deckY = round.level.nestHeight || 6.5;
  group.position.set(from.x - Math.sin(round.aimYaw) * 0.30, deckY,
                     from.z - Math.cos(round.aimYaw) * 0.30);
  group.rotation.y = round.aimYaw;

  lamp.intensity = 0.9;
  if (mesh.glow) mesh.glow.material.opacity = 0;

  /*
   * Hide the sniper's own body from the sniper's own camera.
   *
   * They are the nearest thing to that camera by a wide margin, so at hip level they fill
   * the right-hand view and at any downward pitch their shoulders sit across the aisle. The
   * aisle camera still sees them — the runners have to know somebody is up there — which is
   * exactly the split the structure layer already draws, so the body rides along on it.
   *
   * Re-applied every frame rather than once: a quality switch rebuilds these meshes, and a
   * body created after the swap would otherwise come back on the default layer.
   */
  group.traverse((o) => o.layers.set(LAYER_NEST_STRUCT));

  if (!mesh.isModel) {
    // Capsule fallback: just stand it on the deck. There is nothing to articulate.
    body.rotation.set(0, 0, 0);
    body.position.set(0, 0.62, 0);
    body.scale.setScalar(s);
    return;
  }

  // Every clip has to be silenced before the bones are written, or the mixer overwrites this
  // pose on the next frame and the sniper flickers between kneeling and standing.
  if (mesh.actions) {
    for (const name of ["idle", "running", "behit", "standup"]) {
      if (mesh.actions[name]) mesh.actions[name].setEffectiveWeight(0);
    }
  }

  body.rotation.set(0, 0, 0);
  body.position.set(0, 0, 0);
  body.scale.setScalar(s);

  if (!bones || !rest) return;
  restoreBones(mesh);

  /*
   * The signs here were measured on the rig, not inferred from the crawl.
   *
   * poseCrawl reaches with negative rotation.x, which looks like "negative is forward" — but
   * that pose has the torso horizontal, so its forward is this pose's up. Driving the arms
   * the same way stood the sniper up with both arms overhead. Rotating RightArm by -1.2 and
   * reading the forearm's world position back shows what actually happens: it rises 0.19 and
   * travels 0.10 BACKWARD. Positive is what brings a hand down and forward onto a weapon.
   */

  /*
   * The legs stay under the body rather than kneeling.
   *
   * A kneel needs the knee to bend as much as the hip, and this rig exposes no knee — BONES
   * carries the hip roots and nothing below them. Swinging the hips alone sends the whole
   * straight leg forward and it comes out through the front of the deck, which is the shape
   * that was poking through the platform. Held near the bind pose the body reads as crouched
   * behind the rail, and at this distance the legs are behind the deck anyway.
   */
  if (bones.LeftUpLeg) bones.LeftUpLeg.rotation.x = rest.LeftUpLeg.rot.x + 0.18;
  if (bones.RightUpLeg) bones.RightUpLeg.rotation.x = rest.RightUpLeg.rot.x + 0.10;

  // Fold over the stock. A settled shooter is hunched into the sight, not sitting upright.
  const breath = Math.sin((round.t || 0) * 1.6);
  if (bones.Spine) bones.Spine.rotation.x = rest.Spine.rot.x + 0.30 + breath * 0.02;
  if (bones.Spine01) bones.Spine01.rotation.x = rest.Spine01.rot.x + 0.16;
  // The head tips back the other way, so the eyeline comes up to the scope instead of
  // following the chest down into the deck.
  if (bones.Head) bones.Head.rotation.x = rest.Head.rot.x - 0.40;

  // Both arms down and forward onto the weapon, elbows bent — the trigger hand tighter than
  // the hand supporting the fore-end.
  if (bones.RightArm) {
    bones.RightArm.rotation.x = rest.RightArm.rot.x + 1.15;
    bones.RightArm.rotation.z = rest.RightArm.rot.z + 0.30;
  }
  if (bones.LeftArm) {
    bones.LeftArm.rotation.x = rest.LeftArm.rot.x + 1.32;
    bones.LeftArm.rotation.z = rest.LeftArm.rot.z - 0.20;
  }
  if (bones.RightForeArm) bones.RightForeArm.rotation.x = rest.RightForeArm.rot.x + 0.75;
  if (bones.LeftForeArm) bones.LeftForeArm.rotation.x = rest.LeftForeArm.rot.x + 0.55;

  // The bolt: a short shove of the trigger arm while the rifle is out of action, so the
  // aisle can read the reload off the body as well as off the lamp.
  if (round.reload > 0 && bones.RightForeArm) {
    const cycle = Math.sin((1 - round.reload / Math.max(0.01, round.level.reloadTime || 2)) * Math.PI);
    // Backward, i.e. negative, since the trigger hand comes off the grip to work the bolt.
    bones.RightForeArm.rotation.x -= cycle * 0.6;
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

/* ----------------------------------------------------------------- roombas */

/**
 * A saw roomba: a squat disc chassis with a blade spinning on top of it.
 *
 * The opposite design brief to the crusher. That thing is a wall and must read as impersonal;
 * this one picks a person and drives at them, so it needs a front — the eye and the two lamps
 * are there purely so you can tell at a glance which way it is pointing, which is the single
 * piece of information the counter-play depends on. You beat a roomba by cutting across its
 * nose, and you cannot do that if you cannot see the nose.
 *
 * The blade is a flat toothed disc rather than real geometry per tooth: at the distance this
 * camera sits, spinning eight boxes and spinning one notched cylinder look identical, and one
 * of them is a single draw call.
 */
export function createRoombaMesh(Q, colorHex = 0xff2e88) {
  const group = new THREE.Group();

  // Chassis.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x161b28, roughness: 0.7, metalness: 0.6,
  });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.5, 0.3, Q.groundDetail ? 20 : 12), bodyMat);
  body.position.y = 0.17;
  if (Q.shadows) body.castShadow = true;
  group.add(body);

  // A rim in the hazard colour, so the machine is legible as a threat even unlit.
  const rimMat = new THREE.MeshBasicMaterial({ color: colorHex });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.47, 0.035, 6, Q.groundDetail ? 20 : 12), rimMat);
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.31;
  group.add(rim);

  // The blade. Kept low and wide — it has to read as the dangerous part from directly above,
  // which is the angle this camera mostly sees it from.
  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0xc8d4e8, roughness: 0.25, metalness: 0.95,
    emissive: 0x223044, emissiveIntensity: 0.6,
  });
  const blade = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.035, Q.groundDetail ? 18 : 10), bladeMat);
  blade.add(disc);

  const teeth = Q.groundDetail ? 8 : 5;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.03, 0.1), bladeMat);
    tooth.position.set(Math.cos(a) * 0.38, 0, Math.sin(a) * 0.38);
    tooth.rotation.y = -a;
    blade.add(tooth);
  }
  blade.position.y = 0.4;
  if (Q.shadows) disc.castShadow = true;
  group.add(blade);

  // A bright bar across the leading edge — a bumper, not a face.
  //
  // This was an eye in an earlier pass, when the machines still chose a target. With nothing
  // steering, an eye actively lies: players read it as being looked at and try to break line of
  // sight from something that has no sight to break. A blunt bar says "this end hits things",
  // which is the whole truth about it.
  const eyeMat = new THREE.MeshBasicMaterial({ color: colorHex });
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.09, 0.07), eyeMat);
  eye.position.set(0, 0.2, -0.44);
  group.add(eye);

  // No trail streak on the floor ahead of the machine. One was tried and removed: the arena
  // floor is lit now, so a saw is plainly visible without a marker leading it, and a dozen
  // streaks sweeping the room read as clutter laid over the machines rather than as
  // information about them. The bumper bar above already says which way this one is pointing.

  // A pool of light under the machine, so it reads as an object sitting on the floor rather
  // than as a sprite hovering over it.
  const glowMat = new THREE.MeshBasicMaterial({
    color: colorHex, transparent: true, opacity: 0.22,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.8, 16), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.02;
  group.add(glow);

  // Only the higher tiers get a real light per machine — with a dozen on the floor this is the
  // per-unit cost that actually scales.
  let lamp = null;
  if (Q.playerGlow && Q.groundDetail) {
    lamp = new THREE.PointLight(colorHex, 1.6, 4.5, 2);
    lamp.position.set(0, 0.5, -0.3);
    group.add(lamp);
  }

  return { group, body, blade, rim, eye, glow, glowMat, lamp };
}

/**
 * Pose one machine from its sim state.
 *
 * There is no "hunting" state to show any more — nothing targets anybody, so brightening a
 * machine that had locked on would be showing an intent that no longer exists. What the
 * lighting tracks instead is speed: a saw that has been knocked around a few times is genuinely
 * more dangerous than a fresh one, and that is worth reading across the room.
 */
export function updateRoombaMesh(mesh, r, dt) {
  mesh.group.position.set(r.x, 0, r.z);
  mesh.group.rotation.y = r.heading;
  mesh.blade.rotation.y = r.spin;

  // How wound-up this machine is, 0..1, from its accumulated tempo.
  const hot = Math.max(0, Math.min(1, (r.tempo - 0.9) / 1.0));

  mesh.glowMat.opacity += ((0.2 + hot * 0.2) - mesh.glowMat.opacity) * Math.min(1, dt * 6);
  if (mesh.lamp) mesh.lamp.intensity = 1.4 + hot * 1.4;

  // A slight wobble that rises with speed, so a fast machine visibly judders rather than
  // gliding. It sells "out of control" more cheaply than any amount of extra geometry.
  //
  // Driven off its own clock rather than off r.spin: the blade turns at 34 rad/s, and a wobble
  // riding that would oscillate several times per frame and alias into a static tilt.
  mesh.wobble = (mesh.wobble || 0) + dt * 9;
  mesh.group.rotation.z = Math.sin(mesh.wobble) * 0.05 * hot;
}

/*
 * Collisions used to throw an expanding shock ring here. It was removed: with a dozen machines
 * on a lit floor the rings fired constantly and became a layer of pulsing geometry sitting on
 * top of the thing they were annotating. The collision is already legible from the machines
 * themselves — two of them meet and both visibly change direction — and the camera still kicks
 * on a hard hit, so the event is felt rather than drawn.
 *
 * The sim's `clang` event is still emitted; screen.html reads it for that camera kick.
 */

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

/**
 * Draw the aisle and the sniper's view side by side.
 *
 * Two scissored viewports over one scene, not two renderers. A second WebGL context would
 * double the state and the memory for a scene that is identical in both halves — the only
 * difference is where the camera is standing.
 *
 * The split is vertical (left/right) rather than horizontal because both views are wide: the
 * aisle is a long corridor and the scope is a landscape shot, and stacking them would squash
 * each into a letterbox where neither is readable.
 */
export function renderSplit(ctx, canvas) {
  const { renderer, scene, camera, sniperCam } = ctx;
  if (!sniperCam) { renderer.render(scene, camera); return; }

  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  const half = Math.floor(w / 2);

  renderer.setScissorTest(true);

  // Left: the aisle, from behind the runners.
  renderer.setViewport(0, 0, half, h);
  renderer.setScissor(0, 0, half, h);
  if (camera.aspect !== half / h) {
    camera.aspect = half / h;
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);

  // Right: down the barrel.
  renderer.setViewport(half, 0, w - half, h);
  renderer.setScissor(half, 0, w - half, h);
  if (sniperCam.aspect !== (w - half) / h) {
    sniperCam.aspect = (w - half) / h;
    sniperCam.updateProjectionMatrix();
  }
  renderer.render(scene, sniperCam);

  // Hand the renderer back in the state everything else expects, or the next mode's single
  // full-frame render inherits a half-width scissor and draws into one side of the screen.
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.setScissor(0, 0, w, h);
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
