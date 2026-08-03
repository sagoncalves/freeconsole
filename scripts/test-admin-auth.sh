#!/usr/bin/env bash
# Runs the email-auth admin tests against throwaway emulators.
#
# Needs auth + firestore + functions: the admin claim is set by a Cloud Function and checked
# by firestore.rules, so all three have to be live for the test to mean anything.
set -euo pipefail

cd "$(dirname "$0")/.."

JDK21="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
if [[ -z "$JDK21" ]]; then
  echo "JDK 21+ required for the Firebase emulators. Install Temurin 21 and retry." >&2
  exit 1
fi
export JAVA_HOME="$JDK21"
export PATH="$JAVA_HOME/bin:$PATH"

exec firebase emulators:exec \
  --only auth,firestore,functions \
  --project webconsole-8a62c \
  "node scripts/test-admin-auth.mjs"
