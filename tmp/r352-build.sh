#!/bin/bash
set -e
cd /root/novan
docker compose cp /tmp/dump.sql postgres:/tmp/dump.sql >/dev/null
docker compose exec -T postgres bash -lc 'psql -U $POSTGRES_USER -d $POSTGRES_DB -f /tmp/dump.sql' > /tmp/q.jsonl 2>/tmp/q.err
echo "lines=$(wc -l < /tmp/q.jsonl)"
head -c 200 /tmp/q.err || true

node > /tmp/node.log 2>&1 <<'NODE'
const fs=require('fs');
const lines=fs.readFileSync('/tmp/q.jsonl','utf8').split(/\r?\n/).filter(Boolean);
const byP={};
for (const ln of lines) {
  try {
    const it=JSON.parse(ln);
    (byP[it.platform]=byP[it.platform]||[]).push(it);
  } catch(e) { /* skip */ }
}
function parseTags(s){
  if (!s) return [];
  try { const j=JSON.parse(s); if (Array.isArray(j)) return j; } catch(e){}
  return String(s).split(/[,;]/).map(x=>x.trim()).filter(Boolean);
}
let out='# R352 Paste-Ready Storefront Payloads\n';
out+='Generated: '+new Date().toISOString()+'\n\n';
out+='Top 3 per platform, priority DESC (proven=70 > breakout=60 > niche=50).\n';
out+='Respect daily velocity caps + new-account ramp (R350 anti-flag).\n\n';
for (const p of Object.keys(byP).sort()) {
  out+='---\n\n## '+p.toUpperCase()+' ('+byP[p].length+' queued)\n\n';
  for (let i=0;i<Math.min(3,byP[p].length);i++) {
    const it=byP[p][i];
    out+='### #'+(i+1)+'  priority='+it.priority+'\n';
    out+='**Title:** '+it.title+'\n\n';
    out+='**Description:**\n'+it.description+'\n\n';
    out+='**Tags:** '+parseTags(it.tags).join(', ')+'\n\n';
    out+='**Price:** $'+it.price+'  **design_id:** `'+it.design_id+'`\n\n';
  }
}
fs.writeFileSync('/tmp/r352-paste-ready.md', out);
console.log('bytes='+out.length+' platforms='+Object.keys(byP).length+' total_lines='+lines.length);
NODE
cat /tmp/node.log
