#!/usr/bin/env bash
# Runs the end-to-end room lifecycle test against a throwaway emulator instance.
set -euo pipefail

cd "$(dirname "$0")/.."

JDK21="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
if [[ -z "$JDK21" ]]; then
  echo "JDK 21+ required for the Firebase emulators. Install Temurin 21 and retry." >&2
  exit 1
fi
export JAVA_HOME="$JDK21"
export PATH="$JAVA_HOME/bin:$PATH"

if [[ ! -d node_modules/firebase ]]; then
  pnpm install
fi

# The catalog is seeded with the admin SDK (client writes to /games are forbidden by
# firestore.rules), so point admin at the emulator too.
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
export GCLOUD_PROJECT="webconsole-8a62c"

exec firebase emulators:exec \
  --only database,auth,firestore,functions \
  --project webconsole-8a62c \
  "node scripts/test-flow.mjs"
