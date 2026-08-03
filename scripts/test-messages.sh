#!/usr/bin/env bash
# Message delivery, including the clock-skew regression that silently killed all game input.
set -euo pipefail
cd "$(dirname "$0")/.."
JDK21="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
if [[ -z "$JDK21" ]]; then echo "JDK 21+ required for the Firebase emulators." >&2; exit 1; fi
export JAVA_HOME="$JDK21"; export PATH="$JAVA_HOME/bin:$PATH"
export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
export GCLOUD_PROJECT="webconsole-8a62c"
exec firebase emulators:exec --only database,auth,firestore,functions \
  --project webconsole-8a62c "node scripts/test-messages.mjs"
