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

  // Never sit behind the crusher. It spans the aisle, so a camera further back than its face
  // is looking at the flat unlit back of a slab that fills the frame — the players vanish
  // and the one thing chasing them becomes invisible. Staying in front keeps its lit face,
  // and the shrinking gap to it, permanently readable.
  if (typeof crusherZ === "number" && isFinite(crusherZ)) {
    wantZ = Math.min(wantZ, crusherZ - 1.6);
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

  const g = COL.ground, gl = COL.groundLit, m = COL.mine, cr = COL.crater;

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
    } else if (sim.mineAt(round, tx, tz)) {
      // A mine caught in someone's light.
      r = g.r + (m.r - g.r) * l;
      gg = g.g + (m.g - g.g) * l;
      b = g.b + (m.b - g.b) * l;
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

/**
 * One player's body: a capsule whose shape carries the injury, plus their personal lamp.
 *
 * Legs are the most important thing about a player and have to be readable from the camera's
 * distance, so injury changes the silhouette's height and tilt rather than adding detail.
 */
export function createPlayerMesh(colorHex, Q) {
  const group = new THREE.Group();

  const mat = new THREE.MeshStandardMaterial({
    color: colorHex, emissive: colorHex, emissiveIntensity: 0.55,
    roughness: 0.5, metalness: 0.1,
  });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.6, 4, 10), mat);
  body.position.y = 0.62;
  if (Q.shadows) body.castShadow = true;
  group.add(body);

  // The lamp each player carries. This is the object the entire game is about, so it is
  // visible as a thing on the body, not just as an effect on the floor.
  const lamp = new THREE.PointLight(colorHex, 1.6, 5.5, 2);
  lamp.position.set(0, 0.9, 0);
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

  return { group, body, mat, lamp, glow };
}

/** Pose a player's mesh for their current condition. */
export function posePlayer(mesh, p, states) {
  const { body, group, lamp } = mesh;

  group.position.set(p.x, 0, p.z);
  group.rotation.y = p.heading;

  if (p.state === states.DEAD) {
    // Flat on the ground, lamp out.
    body.rotation.z = Math.PI / 2;
    body.position.y = 0.22;
    body.scale.setScalar(1);
    lamp.intensity = 0;
    if (mesh.glow) mesh.glow.material.opacity = 0.05;
    return;
  }

  lamp.intensity = 1.6;
  if (mesh.glow) mesh.glow.material.opacity = 0.14;

  if (p.legs === 0) {
    // Crawling: prone, low, and slow.
    body.rotation.z = Math.PI / 2;
    body.position.y = 0.26;
    body.scale.setScalar(1);
  } else if (p.legs === 1) {
    // Limping: upright but listing, and shorter.
    body.rotation.z = 0.42;
    body.position.y = 0.5;
    body.scale.set(1, 0.78, 1);
  } else {
    body.rotation.z = 0;
    body.position.y = 0.62;
    body.scale.setScalar(1);
  }
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
