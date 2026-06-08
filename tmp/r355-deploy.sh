#!/bin/bash
set -e
cd /root/novan
TOKEN="ops_22fc979915bc00a7115b0903524dedd3e1d954faab5f4978472cfcd0323bafca"

# Verify new code present
echo "=== verify new platforms in code ==="
grep -c "etsy\|displate\|threadless" /root/novan/apps/api/src/services/r349-listing-content-rotator.ts
grep -c "etsy:\|displate:\|threadless:" /root/novan/apps/api/src/services/r349-upload-queue.ts
grep "society6" /root/novan/apps/api/src/services/r349-listing-content-rotator.ts || echo "society6 fully removed from rotator"

# Force full recreate so tsx reloads
echo "=== recreate api container ==="
docker compose rm -sf api >/dev/null
docker compose up -d api >/dev/null
sleep 22
curl -sS https://137-184-198-2.sslip.io/health --max-time 10
echo ""

# Apply updated runbook
echo "=== update signup_runbook in workspace_memory ==="
docker compose cp /tmp/r355-runbook.sql postgres:/tmp/r355-runbook.sql >/dev/null
docker compose exec -T postgres bash -lc 'psql -U $POSTGRES_USER -d $POSTGRES_DB -f /tmp/r355-runbook.sql' 2>&1 | tail -3

# Wipe old queue + re-fire pipeline with new platform set
cat > /tmp/wipe.sql <<'SQL'
DELETE FROM design_upload_queue WHERE workspace_id = 'default';
SELECT count(*) AS remaining FROM design_upload_queue WHERE workspace_id='default';
SQL
docker compose cp /tmp/wipe.sql postgres:/tmp/wipe.sql >/dev/null
docker compose exec -T postgres bash -lc 'psql -U $POSTGRES_USER -d $POSTGRES_DB -f /tmp/wipe.sql' 2>&1 | tail -2

echo "=== Re-fire pipeline w/ new platform set ==="
curl -sS -X POST https://137-184-198-2.sslip.io/api/v1/brain/task \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"workspace_id":"default","plan":[{"op":"trends.run_pipeline","params":{"provenCount":3,"breakoutCount":2,"nicheBreakoutCount":1}}]}' \
  --max-time 540 -o /tmp/pipe.json
node -e "
const d=JSON.parse(require('fs').readFileSync('/tmp/pipe.json','utf8'));
const r=d.data.results[0];
if (!r.ok) { console.log('ERR:',JSON.stringify(r).slice(0,500)); process.exit(0); }
console.log('platforms='+r.data.platforms.length+': '+r.data.platforms.join(', '));
console.log('gen='+r.data.totals.designsGenerated+' queued='+r.data.totals.queueItemsCreated+' failed='+r.data.totals.designsFailed);
"

# Regen paste-ready markdown
/tmp/r352-via-api.sh
