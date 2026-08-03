#!/usr/bin/env bash
# Serves the site locally against the REAL Firebase project.
#
# No emulators: pages talk to the live RTDB, Firestore, Auth and Functions, so what you see
# is what players get. Rooms created here are real rooms; the catalog you edit is the real
# catalog.
#
# Binds 0.0.0.0 so phones on the same wifi can reach it — open the LAN address it prints on
# the big screen, not localhost, or the QR code points somewhere phones can't resolve.
set -euo pipefail

cd "$(dirname "$0")/.."

exec node scripts/dev-server.cjs
