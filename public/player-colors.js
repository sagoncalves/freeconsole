/**
 * Player colours, shared by the shell and every game.
 *
 * Indexed by DEVICE SLOT, not by position in a list of connected devices. Those two agree
 * only while slots are contiguous: once a player leaves, device 3 sits at array index 1,
 * and a game colouring by array position would show it device 2's colour while the room bar
 * still showed the original. Keying off the device id keeps a player's colour stable for as
 * long as they hold that slot, everywhere it appears.
 */
export const PLAYER_COLORS = [
  "#35f0e0", "#ff2e88", "#9dff4f", "#ffc247",
  "#7b6cff", "#4fd2ff", "#ff7a3d", "#ff5ec4",
];

/** Palette index for a device slot. Slot 1 is the first controller; the screen is slot 0. */
export function colorIndexFor(deviceId) {
  return (Math.max(1, Number(deviceId) || 1) - 1) % PLAYER_COLORS.length;
}

/** CSS colour for a device slot. */
export function playerColor(deviceId) {
  return PLAYER_COLORS[colorIndexFor(deviceId)];
}

/** The same colour as a 0xRRGGBB number, for Three.js materials. */
export function playerColorHex(deviceId) {
  return parseInt(playerColor(deviceId).slice(1), 16);
}
