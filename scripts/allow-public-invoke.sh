#!/usr/bin/env bash
# Grants public invoker on the callable Cloud Functions.
#
# Gen-2 callables are Cloud Run services, and Cloud Run denies unauthenticated invocation by
# default. A browser then gets a 403 from Google Frontend *before* the function runs, which
# surfaces confusingly as a CORS error ("No 'Access-Control-Allow-Origin' header") because a
# rejected request has no CORS headers to return.
#
# This does NOT make the functions unauthenticated in any meaningful sense - it only lets
# requests reach them. Every function still checks identity itself:
#   createRoom       requires request.auth
#   claimFirstAdmin  requires request.auth + password provider + no existing admin
#   grantAdmin       requires the caller's admin custom claim
#   revokeAdmin      requires the caller's admin custom claim
#
# Re-run after deploying a NEW callable function; existing ones keep their binding.
set -euo pipefail

PROJECT="${GCLOUD_PROJECT:-webconsole-8a62c}"
REGION="${FUNCTIONS_REGION:-us-central1}"

# Cloud Run lowercases function names for the service name.
SERVICES=(createroom claimfirstadmin grantadmin revokeadmin)

for svc in "${SERVICES[@]}"; do
  echo "granting run.invoker on $svc"
  gcloud run services add-iam-policy-binding "$svc" \
    --project "$PROJECT" \
    --region "$REGION" \
    --member="allUsers" \
    --role="roles/run.invoker" \
    --quiet >/dev/null
done

echo
echo "done — callable functions are reachable from the browser."
