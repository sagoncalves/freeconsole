#!/usr/bin/env bash
# Regenerates public/vendor/qrcode.js.
#
# The QR encoder is vendored as a single self-contained ESM file so the shell pulls in no
# third-party code at runtime. Re-run this after bumping the qrcode dependency.
set -euo pipefail

cd "$(dirname "$0")/.."

pnpm install

ENTRY="$(mktemp -t qr-entry).js"
cat > "$ENTRY" <<'EOF'
import QRCode from "qrcode";
export function createQR(text) {
  return QRCode.create(text, { errorCorrectionLevel: "M" });
}
EOF

# esbuild resolves from the entry file's directory, so keep it inside the project.
cp "$ENTRY" ./.qr-entry.js
trap 'rm -f ./.qr-entry.js "$ENTRY"' EXIT

mkdir -p public/vendor
pnpm dlx esbuild@0.24.0 \
  --bundle --format=esm --minify --platform=browser \
  --outfile=public/vendor/qrcode.js \
  ./.qr-entry.js

echo "wrote public/vendor/qrcode.js"

# Three.js, used by games that render in 3D. Vendored for the same reason as the QR
# encoder: no third-party code fetched at runtime.
cat > ./.three-entry.js <<'EOF'
export * from "three";
// GLTFLoader lives outside the main three bundle, but games need it to load .glb models.
export { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
// SkeletonUtils.clone is the only correct way to copy a skinned mesh: a plain .clone()
// shares the skeleton, so every copy would animate identically.
export { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
EOF
trap 'rm -f ./.qr-entry.js ./.three-entry.js "$ENTRY"' EXIT

pnpm dlx esbuild@0.24.0 \
  --bundle --format=esm --minify --platform=browser \
  --outfile=public/vendor/three.js \
  ./.three-entry.js

echo "wrote public/vendor/three.js"
