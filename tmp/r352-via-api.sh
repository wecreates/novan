#!/bin/bash
set -e
TOKEN="ops_22fc979915bc00a7115b0903524dedd3e1d954faab5f4978472cfcd0323bafca"
PLATFORMS="gumroad fine_art_america inprnt society6 redbubble zazzle spreadshirt teepublic tiktok_shop"

# Build a single brain/task plan that pulls top-3 for every platform in one call
echo "=== Pulling top-3 per platform via upload_queue.next ==="
PLAN='['
first=1
for P in $PLATFORMS; do
  if [ $first -eq 1 ]; then first=0; else PLAN+=','; fi
  PLAN+='{"op":"upload_queue.next","params":{"platform":"'$P'","limit":3}}'
done
PLAN+=']'
echo "{\"workspace_id\":\"default\",\"plan\":$PLAN}" > /tmp/plan.json
curl -sS -X POST https://137-184-198-2.sslip.io/api/v1/brain/task \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d @/tmp/plan.json --max-time 60 -o /tmp/api.json
echo "size=$(wc -c < /tmp/api.json)"

node > /tmp/r352-paste-ready.md << 'NODE'
const fs=require('fs');
const data=JSON.parse(fs.readFileSync('/tmp/api.json','utf8'));
const results=data.data?.results||[];
const out=[];
out.push('# R352 Paste-Ready Storefront Payloads');
out.push('Generated: '+new Date().toISOString());
out.push('');
out.push('Top 3 per platform, priority DESC (proven=70 > breakout=60 > niche=50).');
out.push('Respect daily velocity caps + new-account ramp (R350 anti-flag).');
out.push('');
function parseTags(s){
  if (!s) return [];
  try { const j=JSON.parse(s); if (Array.isArray(j)) return j; } catch(e){}
  return String(s).split(/[,;]/).map(x=>x.trim()).filter(Boolean);
}
let totalItems=0, platformsWithItems=0;
// Reconstruct plan order: same as the order we built in the bash loop.
const PLATFORM_ORDER = ['gumroad','fine_art_america','inprnt','society6','redbubble','zazzle','spreadshirt','teepublic','tiktok_shop'];
for (let idx=0; idx<results.length; idx++) {
  const r = results[idx];
  // Prefer platform name from first item; fall back to plan order index.
  const items = Array.isArray(r.data) ? r.data : (r.data?.items || []);
  const platform = items[0]?.platform || PLATFORM_ORDER[idx] || 'unknown';
  if (!r.ok) { out.push('## '+platform.toUpperCase()+' — ERROR: '+JSON.stringify(r).slice(0,200)); continue; }
  if (!items.length) continue;
  platformsWithItems++;
  out.push('---');
  out.push('');
  out.push('## '+platform.toUpperCase()+' ('+items.length+' shown)');
  out.push('');
  for (let i=0;i<items.length;i++) {
    const it = items[i];
    totalItems++;
    out.push('### #'+(i+1)+'  priority='+(it.priority ?? '?'));
    out.push('**Title:** '+(it.title||'(no title)'));
    out.push('');
    out.push('**Description:**');
    out.push(it.description || '(no description)');
    out.push('');
    out.push('**Tags:** '+parseTags(it.tags).join(', '));
    out.push('');
    out.push('**Price:** $'+(it.priceUsd ?? it.price_usd ?? '0.00')+'  **design_id:** `'+(it.designId || it.design_id || '?')+'`  **queue_id:** `'+(it.id||'?')+'`');
    out.push('');
  }
}
process.stderr.write('platforms_with_items='+platformsWithItems+' total='+totalItems+'\n');
process.stdout.write(out.join('\n'));
NODE
echo "md_bytes=$(wc -c < /tmp/r352-paste-ready.md)"
echo "platforms_in_md=$(grep -c '^## ' /tmp/r352-paste-ready.md)"
