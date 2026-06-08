#!/bin/bash
set -e
cd /root/novan

# Dump 6 most recent designs (image_url is the deliverable)
cat > /tmp/designs.sql <<'SQL'
COPY (
  SELECT json_build_object(
    'id', id,
    'niche', niche,
    'style', style,
    'prompt', prompt,
    'image_url', image_url,
    'source_provider', source_provider,
    'created_at', created_at
  )::text
  FROM design_catalog
  WHERE workspace_id = 'default'
  ORDER BY created_at DESC
  LIMIT 6
) TO STDOUT;
SQL
docker compose cp /tmp/designs.sql postgres:/tmp/designs.sql >/dev/null
docker compose exec -T postgres bash -lc 'psql -U $POSTGRES_USER -d $POSTGRES_DB -f /tmp/designs.sql' > /tmp/designs.jsonl 2>/tmp/designs.err
echo "designs: $(wc -l < /tmp/designs.jsonl)"
head -1 /tmp/designs.jsonl | head -c 300
echo ""
echo "---"

mkdir -p /tmp/r354-designs
rm -f /tmp/r354-designs/*.png /tmp/r354-designs/*.jpg

node > /tmp/r354-dl.log 2>&1 <<'NODE'
const fs=require('fs');
const https=require('https');
const http=require('http');
const lines=fs.readFileSync('/tmp/designs.jsonl','utf8').split(/\r?\n/).filter(Boolean);
function fetchTo(url, path, maxRedirects=5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return fetchTo(next, path, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP '+res.statusCode)); }
      const file = fs.createWriteStream(path);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(path)));
      file.on('error', reject);
    }).on('error', reject);
  });
}
function slug(s){ return (s||'design').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,50); }
(async () => {
  const out=[];
  for (const ln of lines) {
    let d;
    try { d = JSON.parse(ln); } catch(e) { console.log('parse skip'); continue; }
    const subject = (d.prompt||'').split(',')[0].replace(/^[a-zA-Z\s\-]+illustration of an?/i,'').trim() || 'design';
    const fileSlug = slug(subject);
    const ext = (d.image_url||'').toLowerCase().includes('.jpg') ? '.jpg' : '.png';
    const path = '/tmp/r354-designs/'+fileSlug+ext;
    console.log('subj='+subject);
    console.log('  url='+(d.image_url||'').slice(0,90));
    try {
      await fetchTo(d.image_url, path);
      const sz = fs.statSync(path).size;
      console.log('  ok '+sz+' B -> '+path);
      out.push({ id: d.id, subject, niche: d.niche, prompt: d.prompt, file: path, bytes: sz, image_url: d.image_url });
    } catch (e) {
      console.log('  FAIL: '+e.message);
      out.push({ id: d.id, subject, niche: d.niche, prompt: d.prompt, error: e.message, image_url: d.image_url });
    }
  }
  fs.writeFileSync('/tmp/r354-manifest.json', JSON.stringify(out, null, 2));
  console.log('manifest written, '+out.length+' entries');
})();
NODE
cat /tmp/r354-dl.log
echo "===files==="
ls -la /tmp/r354-designs/
echo "===manifest==="
cat /tmp/r354-manifest.json
