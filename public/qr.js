/**
 * QR rendering for the join URL.
 *
 * The encoder itself is the `qrcode` package (v1.5.4), bundled to a single self-contained
 * ESM file at vendor/qrcode.js by scripts/build-vendor.sh. It is vendored rather than
 * loaded from a CDN so the shell has no third-party runtime dependency, and used rather
 * than hand-written because QR is a fiddly spec where "almost right" produces a square
 * that renders fine and scans not at all.
 */
import { createQR } from "./vendor/qrcode.js?v=202608011900";

/**
 * Renders `text` as a QR code and returns a canvas element.
 * @param {string} text
 * @param {number} [pixelSize] rendered width/height in CSS pixels
 */
export function renderQR(text, pixelSize = 132) {
  const qr = createQR(text);
  const size = qr.modules.size;
  const data = qr.modules.data;

  const quiet = 4;
  const total = size + quiet * 2;
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.max(1, Math.floor((pixelSize * dpr) / total));

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = total * scale;
  canvas.style.width = canvas.style.height = pixelSize + "px";

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (data[r * size + c]) {
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }
  return canvas;
}
