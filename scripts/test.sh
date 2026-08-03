#!/usr/bin/env bash
# Runs the security-rules suite against a throwaway emulator instance.
set -euo pipefail

cd "$(dirname "$0")/.."

JDK21="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
if [[ -z "$JDK21" ]]; then
  echo "JDK 21+ required for the Firebase emulators. Install Temurin 21 and retry." >&2
  exit 1
fi
export JAVA_HOME="$JDK21"
export PATH="$JAVA_HOME/bin:$PATH"

if [[ ! -d node_modules/@firebase/rules-unit-testing ]]; then
  pnpm install
fi

exec firebase emulators:exec \
  --only database,auth \
  --project webconsole-8a62c \
  "node scripts/test-rules.mjs"
