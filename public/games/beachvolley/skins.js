/**
 * Character skins, shared by the screen and the controller.
 *
 * The controller needs names, colours and an emoji to draw its picker; the screen needs the
 * same colours to build the 3D body. Keeping both in one file is what stops a player from
 * picking "Marina" on their phone and appearing in someone else's colours on the TV.
 *
 * Skins are cosmetic only - every character has identical physics. Nothing here affects
 * gameplay, so adding one is safe.
 */

export const SKINS = [
  { id: "sunny",  name: "Sunny",  emoji: "🌞", skin: 0xf6c9a0, suit: 0xff2e88, hair: 0x3a2418, trunks: 0xffc247 },
  { id: "marina", name: "Marina", emoji: "🌊", skin: 0x8d5a3b, suit: 0x35f0e0, hair: 0x1a1410, trunks: 0x4fd2ff },
  { id: "coco",   name: "Coco",   emoji: "🥥", skin: 0x5c3823, suit: 0x9dff4f, hair: 0x241a12, trunks: 0xffffff },
  { id: "reef",   name: "Reef",   emoji: "🐠", skin: 0xe8b48c, suit: 0x7b6cff, hair: 0xd9a441, trunks: 0xff7a3d },
  { id: "kai",    name: "Kai",    emoji: "🏄", skin: 0xc98a5e, suit: 0xff7a3d, hair: 0x0f0d0b, trunks: 0x35f0e0 },
  { id: "pearl",  name: "Pearl",  emoji: "🐚", skin: 0xffd9bd, suit: 0xff5ec4, hair: 0xf2e6c9, trunks: 0xffffff },
];

/** Look up a skin by id, falling back to a stable default rather than undefined. */
export function skinById(id) {
  return SKINS.find((s) => s.id === id) || SKINS[0];
}

/**
 * The skin a device gets before it picks one. Derived from the device id so two players who
 * never open the picker still look different, and so the screen and the phone agree on the
 * default without exchanging a message.
 */
export function defaultSkinFor(deviceId) {
  const slot = Math.max(1, Number(deviceId) || 1);
  return SKINS[(slot - 1) % SKINS.length];
}

/** `0xRRGGBB` as `#rrggbb`, for CSS on the controller. */
export function hexCss(n) {
  return "#" + n.toString(16).padStart(6, "0");
}
