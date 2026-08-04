/**
 * Scene building for Beach Volley - everything that is geometry rather than gameplay.
 *
 * The look: late afternoon on a quiet beach. A warm low sun, a gradient sky, soft sand and
 * a sea that moves just enough to feel alive. Nothing here reads game state; the screen
 * drives it each frame.
 */

import * as THREE from "/vendor/three.js?v=5";
import { COURT, PLAYER, BALL } from "/games/beachvolley/sim.js?v=1";

/* ------------------------------------------------------------------ palette */

export const SUN = 0xffd9a0;
const SAND_NEAR = 0xf2d7a8;
const SAND_FAR = 0xe6c48d;
const SEA_NEAR = 0x2fa8b8;
const SEA_FAR = 0x1b6f8c;

/* -------------------------------------------------------------------- sky */

/**
 * A big inward-facing sphere with a vertical gradient painted into the vertex colours.
 * Cheaper than a shader and it never needs a texture download.
 */
function buildSky() {
  const geo = new THREE.SphereGeometry(220, 32, 24);
  const top = new THREE.Color(0x2b5c9e);
  const mid = new THREE.Color(0xffb56b);
  const low = new THREE.Color(0xffd9a0);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 220;             // -1 at the bottom, +1 at the top
    const t = Math.max(0, Math.min(1, (h + 0.15) / 0.9));
    if (t < 0.45) c.copy(low).lerp(mid, t / 0.45);
    else c.copy(mid).lerp(top, (t - 0.45) / 0.55);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false,
  }));
}

/* ------------------------------------------------------------------- sand */

function buildSand(shadows = true) {
  const g = new THREE.Group();

  // Wide, but not especially deep: the shoreline needs to be close enough that the sea is a
  // real band across the frame rather than a sliver at the horizon. Spans world z -95..+25.
  const geo = new THREE.PlaneGeometry(400, 120, 60, 24);
  geo.rotateX(-Math.PI / 2);
  // Gentle dunes, flattened to nothing near the court so play stays readable.
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // z here is the plane's own coordinate; the mesh sits at z=-60, so world z = z - 60.
    const x = pos.getX(i), z = pos.getZ(i);
    const worldZ = z - 35;
    const nearCourt = Math.max(0, 1 - Math.hypot(x / 16, worldZ / 12));
    // Flatten the dunes as they approach the waterline at z=-95, so the sand meets the sea
    // in a clean shore rather than a row of crests cut off by the water's edge.
    const shore = Math.min(1, Math.max(0, (worldZ + 95) / 30));
    const h = Math.sin(x * 0.09) * Math.cos(z * 0.11) * 0.55 + Math.sin(x * 0.21 + z * 0.13) * 0.22;
    pos.setY(i, h * (1 - nearCourt) * shore);
  }
  geo.computeVertexNormals();

  const sand = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: SAND_NEAR }));
  sand.receiveShadow = shadows;
  sand.position.z = -35;   // court sits on the near part; the beach runs back to the water
  g.add(sand);

  // The court itself: a slightly darker patch so the play area reads at a glance.
  const courtGeo = new THREE.PlaneGeometry(COURT.halfWidth * 2 + 1.2, COURT.halfDepth * 2);
  courtGeo.rotateX(-Math.PI / 2);
  const court = new THREE.Mesh(courtGeo, new THREE.MeshLambertMaterial({ color: SAND_FAR }));
  court.position.y = 0.012;
  court.receiveShadow = shadows;
  g.add(court);

  // Boundary tape.
  const tapeMat = new THREE.MeshBasicMaterial({ color: 0xfff6e0 });
  const w = COURT.halfWidth + 0.6, d = COURT.halfDepth;
  for (const [sx, sz, lx, lz] of [
    [0, -d, w * 2, 0.09], [0, d, w * 2, 0.09],
    [-w, 0, 0.09, d * 2], [w, 0, 0.09, d * 2],
  ]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(lx || 0.09, 0.02, lz || 0.09), tapeMat);
    t.position.set(sx, 0.025, sz);
    g.add(t);
  }

  return g;
}

/* -------------------------------------------------------------------- sea */

/**
 * The sea is a plane far behind the court. It is animated by `updateSea`, which rolls the
 * vertices - it is the only thing in the scene that moves on its own, and it does most of
 * the work of making the place feel calm rather than static.
 */
function buildSea(segments = [60, 24]) {
  // Wide and deep enough to reach the horizon from the play camera. The first version was
  // 300x120 at z=-78, which the sand plane (160 wide, centred at z=-6) completely enclosed -
  // the sea rendered as a lagoon sitting ON the beach instead of behind it. It has to start
  // beyond the far edge of the sand and run past the fog distance.
  //
  // The subdivision is tier-driven because it sets the cost of updateSea(): every vertex is
  // rewritten each tick and, worse, computeVertexNormals() re-derives every face normal
  // from them. Halving the grid quarters both.
  const geo = new THREE.PlaneGeometry(1200, 600, segments[0], segments[1]);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ color: SEA_NEAR });
  const sea = new THREE.Mesh(geo, mat);
  // Starts exactly where the sand ends (z=-95) and runs to the horizon. The two must not
  // overlap: an earlier version ran the sea plane forward underneath the dunes, and every
  // crest that rose above water level punched through as a teal patch on the beach.
  // 600 deep centred at z=-395 spans -695..-95.
  sea.position.set(0, -0.12, -395);
  sea.userData.base = Float32Array.from(geo.attributes.position.array);
  return sea;
}

/**
 * Rolls the sea's vertices.
 *
 * `withNormals` is the expensive half by a wide margin: computeVertexNormals() walks every
 * face, recomputes its normal, and re-accumulates it onto the vertices — far more work
 * than the sine loop above it. Skipping it leaves the waves moving with static lighting,
 * which at this distance (well past the fog's near plane, behind the whole court) is not a
 * difference anyone sees. The cheap tier stops calling this altogether.
 */
export function updateSea(sea, t, withNormals = true) {
  const pos = sea.geometry.attributes.position;
  const base = sea.userData.base;
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3], z = base[i * 3 + 2];
    pos.setY(i, Math.sin(x * 0.08 + t * 0.9) * 0.28 + Math.sin(z * 0.13 - t * 0.6) * 0.18);
  }
  pos.needsUpdate = true;
  if (withNormals) sea.geometry.computeVertexNormals();
}

/* -------------------------------------------------------------------- net */

function buildNet(shadows = true) {
  const g = new THREE.Group();
  const postMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });

  for (const z of [-COURT.halfDepth, COURT.halfDepth]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.11, COURT.netHeight + 0.35, 10), postMat);
    post.position.set(0, (COURT.netHeight + 0.35) / 2, z);
    post.castShadow = shadows;
    g.add(post);
  }

  // Mesh: a grid drawn as lines, so it reads as a net without any transparency sorting.
  const pts = [];
  const top = COURT.netHeight, bottom = COURT.netHeight - 0.95;
  const d = COURT.halfDepth;
  for (let i = 0; i <= 22; i++) {
    const z = -d + (i / 22) * d * 2;
    pts.push(0, bottom, z, 0, top, z);
  }
  for (let i = 0; i <= 6; i++) {
    const y = bottom + (i / 6) * (top - bottom);
    pts.push(0, y, -d, 0, y, d);
  }
  const netGeo = new THREE.BufferGeometry();
  netGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(netGeo, new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.75,
  })));

  // The white band along the top, which is what players actually aim over.
  const band = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.13, COURT.halfDepth * 2),
    new THREE.MeshBasicMaterial({ color: 0xfffaf0 }));
  band.position.y = COURT.netHeight + 0.06;
  g.add(band);

  return g;
}

/* ------------------------------------------------------------------- props */

/** Palms, umbrellas and a few beach balls, scattered well clear of the court. */
function buildProps({ palms: palmCount = 14, fronds = 6, shadows = true } = {}) {
  const g = new THREE.Group();
  const rand = mulberry32(20260802);

  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x8a6141 });
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x3f9d52 });

  function palm(x, z, scale) {
    const p = new THREE.Group();
    const h = 4.2 * scale;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * scale, 0.2 * scale, h, 7), trunkMat);
    trunk.position.y = h / 2;
    trunk.rotation.z = (rand() - 0.5) * 0.24;
    trunk.castShadow = shadows;
    p.add(trunk);
    for (let i = 0; i < fronds; i++) {
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.42 * scale, 2.3 * scale, 5), leafMat);
      // Spread over the actual frond count, so a lighter palm is still a full crown rather
      // than a gap-toothed one.
      const a = (i / fronds) * Math.PI * 2 + rand();
      leaf.position.set(Math.cos(a) * 0.85 * scale, h, Math.sin(a) * 0.85 * scale);
      leaf.rotation.set(Math.PI / 2.4, 0, -a + Math.PI / 2);
      leaf.castShadow = shadows;
      p.add(leaf);
    }
    p.position.set(x, 0, z);
    return p;
  }

  // Ringed close around the court so the play area feels like a clearing in a grove rather
  // than a patch of open desert. Nothing sits inside x=±10.5 or in front of z=+7, which
  // keeps the sidelines clear and the camera's view of the court unobstructed.
  // The near pair sits behind the baseline (z <= -6) rather than beside it: at z=+5 they
  // filled the edges of the frame and one stood in front of the left sideline.
  // Listed roughly nearest-first, and taken in order, so a reduced count drops the far
  // palms — the ones deepest in the fog and smallest on screen. The near pairs that
  // actually frame the court survive every tier.
  const PALMS = [
    [-13.5, -6, 1.05], [13.8, -5.5, 1.0],
    [-15.5, -13, 1.15], [15.8, -12, 1.1], [-12.5, -20, 0.95], [12.8, -19, 1.0],
    [-22, -9, 1.2], [23, -10, 1.05], [-20, -26, 1.1], [21, -28, 1.15],
    [-31, -36, 1.15], [33, -40, 1.05], [-24, -54, 0.95], [26, -58, 1.1],
  ];
  for (const [x, z, s] of PALMS.slice(0, palmCount)) g.add(palm(x, z, s));

  // Umbrellas either side, angled slightly so the pair does not look stamped.
  function umbrella(x, z, color) {
    const u = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 2.3, 7),
      new THREE.MeshLambertMaterial({ color: 0xdedede }));
    pole.position.y = 1.15;
    u.add(pole);
    const top = new THREE.Mesh(
      new THREE.ConeGeometry(1.5, 0.75, 12),
      new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    top.position.y = 2.35;
    top.castShadow = shadows;
    u.add(top);
    u.position.set(x, 0, z);
    u.rotation.z = (rand() - 0.5) * 0.12;
    return u;
  }
  // Beside the court and slightly back, so they frame the play without standing between the
  // camera and the near sideline.
  g.add(umbrella(-11.5, -1.5, 0xff6b6b));
  g.add(umbrella(11.6, -1, 0x4fd2ff));

  return g;
}

/* ------------------------------------------------------------------ player */

/**
 * A blocky little beach character. Deliberately simple: at this camera distance the shape
 * and the colours are all that read, and simple geometry keeps 4 of them cheap.
 *
 * Returns a group with named parts so the screen can animate arms and legs.
 */
export function buildPlayerMesh(skin, shadows = true) {
  const g = new THREE.Group();

  const skinMat = new THREE.MeshLambertMaterial({ color: skin.skin });
  const suitMat = new THREE.MeshLambertMaterial({ color: skin.suit });
  const hairMat = new THREE.MeshLambertMaterial({ color: skin.hair });
  const trunkMat = new THREE.MeshLambertMaterial({ color: skin.trunks });

  const H = PLAYER.height;

  // Legs.
  const legs = new THREE.Group();
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, H * 0.34, 4, 8), skinMat);
    leg.position.set(side * 0.15, H * 0.24, 0);
    leg.castShadow = shadows;
    leg.userData.side = side;
    legs.add(leg);
  }
  g.add(legs);

  const shorts = new THREE.Mesh(
    new THREE.BoxGeometry(0.52, 0.3, 0.36), trunkMat);
  shorts.position.y = H * 0.45;
  shorts.castShadow = shadows;
  g.add(shorts);

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.235, H * 0.26, 4, 10), suitMat);
  torso.position.y = H * 0.63;
  torso.castShadow = shadows;
  g.add(torso);

  // Arms, kept as named references - the swing animation is the main feedback that a hit
  // landed, so they matter more than anything else on the model.
  const arms = new THREE.Group();
  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, H * 0.3, 4, 8), skinMat);
  const armR = armL.clone();
  armL.position.set(-0.33, H * 0.66, 0);
  armR.position.set(0.33, H * 0.66, 0);
  armL.castShadow = armR.castShadow = shadows;
  arms.add(armL, armR);
  g.add(arms);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 12), skinMat);
  head.position.y = H * 0.88;
  head.castShadow = shadows;
  g.add(head);

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.215, 14, 12,
    0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
  hair.position.y = H * 0.895;
  g.add(hair);

  g.userData = { armL, armR, legs, head, skin };
  return g;
}

/** A beach ball: coloured panels so its spin is visible. */
export function buildBall(shadows = true) {
  const g = new THREE.Group();
  const panels = [0xffffff, 0xff2e88, 0x35f0e0, 0xffc247];
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.radius, 14, 12, (i / 4) * Math.PI * 2, Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: panels[i] }));
    seg.castShadow = shadows;
    g.add(seg);
  }
  return g;
}

/** A soft blob that tracks the ball on the sand, so its height is readable. */
export function buildShadowBlob() {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(0.4, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }));
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/* ------------------------------------------------------------------ lights */

/**
 * Builds the whole beach.
 *
 * `q` is the active quality tier (see quality.js). Everything it controls is baked in at
 * build time — the sea's subdivision, how many palms stand, whether anything casts a
 * shadow — so a tier change rebuilds the world rather than re-flagging it.
 */
export function buildWorld(scene, q = {}) {
  const {
    shadows = true,
    shadowMapSize = 1024,
    seaSegments = [60, 24],
    palms = 14,
    fronds = 6,
  } = q;

  // Starts past the props and ends short of the sea, so distance hazes out without
  // swallowing the water - the horizon is most of what makes the place feel like a beach.
  scene.fog = new THREE.Fog(0xffc9a0, 55, 300);

  const sky = buildSky();
  const sand = buildSand(shadows);
  const sea = buildSea(seaSegments);
  const net = buildNet(shadows);
  const props = buildProps({ palms, fronds, shadows });
  scene.add(sky, sand, sea, net, props);

  // Warm low sun from behind the camera's left, plus a cool sky bounce. Two lights is
  // enough for this palette and keeps the shadow map single-pass.
  const sun = new THREE.DirectionalLight(SUN, 2.1);
  sun.position.set(-13, 17, 11);
  sun.castShadow = shadows;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  const s = sun.shadow.camera;
  s.left = -18; s.right = 18; s.top = 16; s.bottom = -10; s.near = 1; s.far = 60;
  scene.add(sun);

  // With shadows off the court loses its grounding, so lift the sky bounce a little —
  // otherwise the whole scene reads flatter rather than just shadowless.
  scene.add(new THREE.HemisphereLight(0xbfe4ff, 0xe8c894, shadows ? 1.15 : 1.45));

  return { sky, sand, sea, net, props, sun };
}

/* ----------------------------------------------------------------- utility */

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
