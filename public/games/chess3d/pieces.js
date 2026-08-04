/**
 * Procedural chess piece geometry.
 *
 * Every piece is lathed from a silhouette profile — the same way a real Staunton set is
 * turned on a lathe — with the knight and the bishop's mitre added on top as extra
 * geometry. Nothing here loads an asset, so the game has no model files to ship and the
 * pieces can be re-tuned by editing numbers.
 *
 * Profiles are lists of [radius, height] in piece-local units where 1 unit = one square.
 * LatheGeometry revolves them around Y, so the first point should sit at radius ~0 on the
 * base and the last should close the top.
 */

/** Shared silhouette for the bottom of every piece: base disc, bevel, and stem flare. */
function pedestal(scale = 1) {
  return [
    [0.00, 0.000], [0.30, 0.000], [0.32, 0.020], [0.32, 0.055],
    [0.29, 0.075], [0.24, 0.090], [0.20, 0.110], [0.17, 0.150],
  ].map(([r, h]) => [r * scale, h * scale]);
}

/**
 * Each profile continues from the pedestal. Heights are absolute, so a piece's total
 * height is simply its last point — pawns end around 0.62, the king at 1.10.
 */
const PROFILES = {
  p: (s) => [
    ...pedestal(0.84 * s),
    [0.11 * s, 0.26 * s], [0.10 * s, 0.40 * s],                        // slender stem
    [0.17 * s, 0.46 * s], [0.18 * s, 0.50 * s], [0.13 * s, 0.54 * s],  // collar
    [0.10 * s, 0.58 * s],
    [0.15 * s, 0.66 * s], [0.16 * s, 0.72 * s], [0.13 * s, 0.79 * s],  // head
    [0.08 * s, 0.83 * s], [0.00 * s, 0.85 * s],
  ],
  r: (s) => [
    ...pedestal(s),
    [0.16 * s, 0.26 * s], [0.15 * s, 0.50 * s],
    [0.20 * s, 0.56 * s], [0.24 * s, 0.62 * s], [0.25 * s, 0.66 * s],  // flared top
    [0.25 * s, 0.80 * s], [0.20 * s, 0.80 * s], [0.20 * s, 0.70 * s],  // hollow crown
    [0.00 * s, 0.68 * s],
  ],
  n: (s) => [
    // The knight's head is separate geometry; the lathe only makes its plinth.
    ...pedestal(s),
    [0.17 * s, 0.26 * s], [0.16 * s, 0.36 * s], [0.19 * s, 0.42 * s], [0.00 * s, 0.44 * s],
  ],
  b: (s) => [
    ...pedestal(s),
    [0.14 * s, 0.26 * s], [0.13 * s, 0.34 * s],
    [0.21 * s, 0.40 * s], [0.22 * s, 0.44 * s], [0.16 * s, 0.48 * s],  // collar
    [0.13 * s, 0.52 * s],
    [0.19 * s, 0.62 * s], [0.19 * s, 0.72 * s], [0.14 * s, 0.82 * s],  // mitre body
    [0.07 * s, 0.88 * s], [0.05 * s, 0.92 * s],
    [0.08 * s, 0.95 * s], [0.00 * s, 1.00 * s],                        // finial
  ],
  q: (s) => [
    ...pedestal(1.08 * s),
    [0.18 * s, 0.28 * s], [0.16 * s, 0.44 * s],
    [0.24 * s, 0.52 * s], [0.26 * s, 0.58 * s], [0.20 * s, 0.64 * s],  // collar
    [0.24 * s, 0.74 * s], [0.27 * s, 0.86 * s],                        // crown flare
    [0.27 * s, 0.92 * s], [0.22 * s, 0.92 * s], [0.21 * s, 0.86 * s],  // hollow rim
    [0.10 * s, 0.90 * s],
    [0.09 * s, 0.98 * s], [0.13 * s, 1.01 * s], [0.00 * s, 1.06 * s],  // orb
  ],
  k: (s) => [
    ...pedestal(1.12 * s),
    [0.19 * s, 0.30 * s], [0.17 * s, 0.48 * s],
    [0.25 * s, 0.56 * s], [0.27 * s, 0.62 * s], [0.21 * s, 0.68 * s],  // collar
    [0.25 * s, 0.80 * s], [0.28 * s, 0.92 * s],
    [0.28 * s, 0.98 * s], [0.23 * s, 0.98 * s], [0.22 * s, 0.92 * s],  // hollow rim
    [0.11 * s, 0.96 * s], [0.10 * s, 1.02 * s], [0.00 * s, 1.03 * s],
  ],
};

/** Approximate standing height per kind, used to place labels and aim the camera. */
export const PIECE_HEIGHT = { p: 0.85, r: 0.84, n: 1.03, b: 1.00, q: 1.06, k: 1.20 };

/**
 * Builds one piece as a Group of meshes sharing `material`.
 *
 * Returned as a Group rather than a single merged mesh because the shatter effect needs
 * to break it into independently moving parts, and a group of real meshes gives it
 * natural seams to break along.
 *
 * `opts` comes from the active quality tier (see quality.js):
 *   - `segments`    how many sides the lathe is revolved into
 *   - `bandPieces`  false builds the body as one mesh instead of stacked bands
 *   - `shadows`     false skips the shadow flags entirely
 *   - `detail`      false drops the small ornaments — crown spikes, battlements, ears
 *
 * The banding is the expensive choice: it exists only so shatter() has fracture lines, but
 * it costs a draw call per band on every frame of the game. Tiers that cannot afford that
 * turn it off and lose the shatter, which is the right trade — a capture lasts two seconds
 * and the frame rate lasts the whole match.
 */
export function buildPiece(THREE, kind, material, scale = 1, opts = {}) {
  const {
    segments = 28,
    bandPieces = true,
    shadows = true,
    detail = true,
  } = opts;

  const group = new THREE.Group();

  const raw = PROFILES[kind](scale);
  const points = raw.map(([r, h]) => new THREE.Vector2(Math.max(r, 0.0001), h));

  const addMesh = (geo) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    group.add(mesh);
    return mesh;
  };

  if (bandPieces) {
    // The body is lathed in horizontal bands rather than as one mesh.
    //
    // Visually a band is seamless — consecutive bands share their boundary profile point,
    // so the silhouette is identical to a single lathe. The reason to split is the death
    // animation: shatter() breaks a piece along its existing meshes, and a one-mesh pawn
    // would "shatter" into a single lump. Banding gives every piece natural fracture lines
    // to come apart along, like a turned piece splitting along its grain.
    const BAND_HEIGHT = 0.16 * scale;
    let bandStart = 0;
    for (let i = 1; i < points.length; i++) {
      const spanned = points[i].y - points[bandStart].y;
      const isLast = i === points.length - 1;
      if (spanned >= BAND_HEIGHT || isLast) {
        // Bands overlap by one point so there is no gap in the surface.
        const slice = points.slice(bandStart, i + 1);
        if (slice.length >= 2) {
          const geo = new THREE.LatheGeometry(slice, segments);
          geo.computeVertexNormals();
          addMesh(geo);
        }
        bandStart = i;
      }
    }
  } else {
    // One lathe for the whole silhouette. Identical shape, a single draw call.
    const geo = new THREE.LatheGeometry(points, segments);
    geo.computeVertexNormals();
    addMesh(geo);
  }

  if (kind === "n") group.add(...knightHead(THREE, material, scale, { shadows, detail }));
  if (kind === "b") group.add(mitreSlit(THREE, material, scale, { shadows }));
  if (kind === "k") group.add(...crossFinial(THREE, material, scale, { shadows }));
  // The queen's spikes and the rook's battlements are 7 and 5 extra draw calls each, for
  // ornaments a few pixels wide from a seated camera. They are the cheapest detail to lose.
  if (kind === "q" && detail) group.add(...crownSpikes(THREE, material, scale, { shadows }));
  if (kind === "r" && detail) group.add(...battlements(THREE, material, scale, { shadows }));

  group.userData.kind = kind;
  return group;
}

/**
 * The knight, built from boxes rather than a lathe because it is the one piece that is
 * not rotationally symmetric. Deliberately blocky — it reads clearly at a distance and
 * shatters into convincing chunks.
 */
function knightHead(THREE, material, s, { shadows = true, detail = true } = {}) {
  const parts = [];
  const add = (geo, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x * s, y * s, z * s);
    if (rx) m.rotation.x = rx;
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    parts.push(m);
    return m;
  };

  // The horse faces +Z; the caller yaws the whole group so it faces down the board.
  //
  // Built as an extruded slab rather than stacked boxes: a knight is defined entirely by
  // its side-on silhouette, so drawing that profile once and giving it thickness reads as
  // a horse from every angle that matters. Stacked boxes never do — they just read as a
  // pile of boxes, which is what the first attempt at this looked like.
  // Deeper notches than look necessary on paper: the bevel rounds every corner off, so a
  // subtle profile comes out as a smooth lump. The jaw undercut and the gap between muzzle
  // and mane have to be exaggerated to survive it.
  const profile = new THREE.Shape();
  profile.moveTo(-0.13, 0.00);   // back of the neck, at the plinth
  profile.lineTo(-0.19, 0.22);
  profile.lineTo(-0.22, 0.40);   // mane, swept back
  profile.lineTo(-0.15, 0.50);
  profile.lineTo(-0.06, 0.54);   // poll, between the ears
  profile.lineTo(0.02, 0.52);
  profile.lineTo(0.06, 0.44);    // dip between the ears and the brow
  profile.lineTo(0.14, 0.42);    // brow
  profile.lineTo(0.26, 0.34);
  profile.lineTo(0.34, 0.24);    // tip of the muzzle
  profile.lineTo(0.33, 0.15);
  profile.lineTo(0.22, 0.19);    // underside of the jaw, cut well in
  profile.lineTo(0.12, 0.14);
  profile.lineTo(0.10, 0.04);    // throat
  profile.lineTo(0.05, 0.00);
  profile.closePath();

  const slab = new THREE.ExtrudeGeometry(profile, {
    depth: 0.22 * s,
    // The bevel roughly doubles the slab's triangle count for a rounding that is invisible
    // from a seated camera, so the cheap tier extrudes the profile flat.
    bevelEnabled: detail,
    bevelThickness: 0.010 * s,
    bevelSize: 0.010 * s,
    bevelSegments: 1,
    curveSegments: 2,
  });
  // ExtrudeGeometry draws the profile on the XY plane and extrudes along +Z, so the
  // silhouette already faces the camera side-on and the slab's thickness runs across the
  // board. That is the orientation we want: rotating it here is what turned the knight
  // into a featureless white slab. Only centre the thickness and lift it onto the plinth.
  slab.scale(s, s, s);
  // Sit the neck's base just inside the plinth top (0.44) so there is no seam, and centre
  // the slab's thickness on the piece's axis.
  slab.translate(0, 0.40 * s, -0.11 * s);
  slab.computeVertexNormals();
  const head = new THREE.Mesh(slab, material);
  head.castShadow = shadows;
  head.receiveShadow = shadows;
  parts.push(head);

  // Ears, one either side of the slab's thickness (which runs along Z), standing on the
  // poll — the profile dips between them, so they read as ears rather than as spikes.
  // They are two more draw calls on the most numerous minor piece, so the cheap tier
  // leaves the poll flat; the mane and muzzle still say "knight" on their own.
  if (detail) {
    for (const dz of [-0.058, 0.058]) {
      add(new THREE.ConeGeometry(0.028 * s, 0.11 * s, 5), -0.055, 0.98, dz);
    }
  }
  return parts;
}

/** The bishop's diagonal slit, cut as a thin dark wedge across the mitre. */
function mitreSlit(THREE, material, s, { shadows = true } = {}) {
  const geo = new THREE.BoxGeometry(0.05 * s, 0.16 * s, 0.42 * s);
  const m = new THREE.Mesh(geo, material);
  m.position.set(0, 0.76 * s, 0);
  m.rotation.x = 0.5;
  m.castShadow = shadows;
  return m;
}

function crossFinial(THREE, material, s, { shadows = true } = {}) {
  const up = new THREE.Mesh(new THREE.BoxGeometry(0.05 * s, 0.20 * s, 0.05 * s), material);
  up.position.set(0, 1.12 * s, 0);
  const across = new THREE.Mesh(new THREE.BoxGeometry(0.14 * s, 0.05 * s, 0.05 * s), material);
  across.position.set(0, 1.13 * s, 0);
  up.castShadow = across.castShadow = shadows;
  // The cross is what tells a king from a queen at a glance, so it survives every tier.
  return [up, across];
}

function crownSpikes(THREE, material, s, { shadows = true } = {}) {
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.035 * s, 0.10 * s, 5), material);
    spike.position.set(Math.cos(a) * 0.24 * s, 0.95 * s, Math.sin(a) * 0.24 * s);
    spike.castShadow = shadows;
    parts.push(spike);
  }
  return parts;
}

function battlements(THREE, material, s, { shadows = true } = {}) {
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const block = new THREE.Mesh(new THREE.BoxGeometry(0.10 * s, 0.10 * s, 0.08 * s), material);
    block.position.set(Math.cos(a) * 0.22 * s, 0.84 * s, Math.sin(a) * 0.22 * s);
    block.rotation.y = -a;
    block.castShadow = shadows;
    parts.push(block);
  }
  return parts;
}
