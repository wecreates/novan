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
  # bash ${2:-{}} adds a stray "}" when $2 is non-empty — use if/else
  local params
  if [ -z "${2:-}" ]; then params='{}'; else params="$2"; fi
  # Use printf to avoid double-escaping issues with nested quotes
  local payload
  payload=$(printf '{"op":"%s","workspaceId":"default","params":%s}' "$op" "$params")
  local body
  body=$(curl -s --max-time 15 -H "x-admin-token: $TOKEN" \
    -X POST -H "Content-Type: application/json" \
    --data-binary "$payload" \
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

# R329 (#3) — public routes. Mint a token via /bootstrap (if reusable env set)
# OR fall back to ops_TOKEN env if operator pre-provisioned one.
PUBLIC_TOKEN="${PUBLIC_TOKEN:-}"
if [ -n "$PUBLIC_TOKEN" ]; then
  echo
  echo "[smoke] public route probes (auth-gated)"
  probe_public() {
    local path="$1"
    local body
    body=$(curl -s --max-time 15 -H "Authorization: Bearer $PUBLIC_TOKEN" "$API$path")
    if echo "$body" | grep -q '"success":true'; then
      echo "  ok    GET $path"
      return 0
    fi
    echo "  FAIL  GET $path  →  $(echo "$body" | head -c 200)" >&2
    return 1
  }
  probe_public '/api/v1/setup/state'                       || FAIL=1
  probe_public '/api/v1/capabilities'                      || FAIL=1
  probe_public '/api/v1/cost/forecast'                     || FAIL=1
  probe_public '/api/v1/cost/by-business'                  || FAIL=1
  probe_public '/api/v1/clarify/outcomes'                  || FAIL=1
  probe_public '/api/v1/timeline/today?hours=2'            || FAIL=1
  probe_public '/api/v1/relationships/recall?q=smoke'      || FAIL=1
  probe_public '/api/v1/brain/ops?search=health'           || FAIL=1
else
  echo "[smoke] (skip public probes — set PUBLIC_TOKEN env to enable)"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "[smoke] FAILED — investigate before declaring deploy success" >&2
  exit 1
fi
echo "[smoke] all probes ok"
