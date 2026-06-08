#!/bin/bash
set -e
rm -f /tmp/r354-designs/*.png /tmp/r354-designs/*.jpg
node > /tmp/r354-dl.log 2>&1 <<'NODE'
const fs=require('fs');
const lines=fs.readFileSync('/tmp/designs.jsonl','utf8').split(/\r?\n/).filter(Boolean);
function slug(s){ return (s||'design').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,60); }
function deriveSubject(prompt){
  if (!prompt) return 'design';
  // Try removing the leading template; pick the first clause
  let p = prompt
    .replace(/^vintage\s+(natural\s+history|botanical|scientific)\s+illustration\s+of\s+(an?\s+)?/i,'')
    .replace(/^vintage\s+illustration\s+of\s+(an?\s+)?/i,'');
  return p.split(',')[0].trim();
}
const manifest=[];
for (const ln of lines) {
  let d;
  try { d=JSON.parse(ln); } catch(e){ continue; }
  const subject = deriveSubject(d.prompt);
  const subjSlug = slug(subject);
  const url = d.image_url || '';
  const m = url.match(/^data:([^;,]+);base64,(.*)$/);
  if (!m) { manifest.push({ id: d.id, subject, niche: d.niche, error: 'no data uri' }); continue; }
  const b64 = m[2];
  const buf = Buffer.from(b64, 'base64');
  // Magic-byte sniff: PNG (89 50 4E 47) vs JPEG (FF D8 FF)
  const isPng = buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47;
  const isJpg = buf[0]===0xFF && buf[1]===0xD8 && buf[2]===0xFF;
  const ext = isPng ? '.png' : isJpg ? '.jpg' : '.bin';
  const path = '/tmp/r354-designs/'+subjSlug+ext;
  fs.writeFileSync(path, buf);
  manifest.push({ id: d.id, subject, niche: d.niche, style: d.style, prompt: d.prompt, file: path, bytes: buf.length, format: ext.slice(1) });
  console.log('OK '+subjSlug+ext+' ('+buf.length+' B, '+ext.slice(1).toUpperCase()+')');
}
fs.writeFileSync('/tmp/r354-manifest.json', JSON.stringify(manifest, null, 2));
console.log('---');
console.log('wrote '+manifest.length+' designs');
NODE
cat /tmp/r354-dl.log
echo "===files==="
ls -la /tmp/r354-designs/
echo "===manifest summary==="
node -e "const m=require('/tmp/r354-manifest.json'); for (const e of m) console.log(e.format+'  '+(e.bytes||'?').toString().padStart(8)+'B  '+e.niche.padEnd(18)+e.subject)"
