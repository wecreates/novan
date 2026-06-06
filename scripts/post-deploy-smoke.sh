#!/usr/bin/env bash
# R146.328 (#1) — post-deploy smoke. Probes the admin brain bridge for a
# known-good set of ops. Any failure → exit 1 so CI/deploy halts loud
# instead of cache-reusing silently like the R325 Dockerfile incident.
set -euo pipefail

API="${API:-http://localhost:3001}"
TOKEN="${ADMIN_TOKEN:-$(cat /root/.novan-admin-token 2>/dev/null || true)}"

if [ -z "$TOKEN" ]; then
  echo "[smoke] ADMIN_TOKEN env or /root/.novan-admin-token required" >&2
  exit 2
fi

probe() {
  local op="$1"
  local params="${2:-{}}"
  local body
  body=$(curl -s --max-time 15 -H "x-admin-token: $TOKEN" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"op\":\"$op\",\"workspaceId\":\"default\",\"params\":$params}" \
    "$API/admin/brain")
  if echo "$body" | grep -q '"ok":true'; then
    echo "  ok    $op"
    return 0
  fi
  echo "  FAIL  $op  →  $(echo "$body" | head -c 200)" >&2
  return 1
}

echo "[smoke] post-deploy verification against $API"

FAIL=0
probe 'brain.health'                                            || FAIL=1
probe 'brain.capabilities'                                      || FAIL=1
probe 'cost.forecast'        '{"capUsd":5}'                     || FAIL=1
probe 'clarify.assess'       '{"userMessage":"fix it"}'         || FAIL=1
probe 'setup.state'                                             || FAIL=1
probe 'task.honest_assess'   '{"task":"draft an email"}'        || FAIL=1
probe 'brain.what_did_you_do_today' '{"windowHours":2}'         || FAIL=1
probe 'relationship.recall'  '{"query":"smoke"}'                || FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "[smoke] FAILED — investigate before declaring deploy success" >&2
  exit 1
fi
echo "[smoke] all probes ok"
