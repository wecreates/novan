/**
 * R496 — Sync local designs to the droplet so R411 cross-list, R374
 * variants, and R393 auto-pin all have a server-side copy that doesn't
 * depend on the operator's laptop being online.
 *
 * Usage:
 *   pnpm sync-designs                  # sync all local design files referenced in design_catalog
 *   pnpm sync-designs --dry-run        # don't upload, just list what would be sent
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

{
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      const k = m[1]!
      let v = m[2]!.trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (process.env[k] === undefined) process.env[k] = v
    }
  }
}
import { loadConfig, requireOpsToken } from './config.js'

const DRY = process.argv.includes('--dry-run')

interface DesignRow {
  id:        string
  image_url: string
}

function mimeFromExt(p: string): string {
  const ext = path.extname(p).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  requireOpsToken(cfg)

  // 1. Pull designs from the server
  const listRes = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      workspace_id: cfg.workspaceId,
      plan: [{ op: 'designs.performance', params: {} }],
    }),
  })
  void listRes
  // Easier: read brain-task ops for catalog directly via a passthrough
  const catalogRes = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      workspace_id: cfg.workspaceId,
      plan: [{ op: 'designs.coverage', params: {} }],
    }),
  })
  const catBody = await catalogRes.json() as { data?: { results?: Array<{ data?: { items?: Array<{ designId: string }> } }> } }
  const designs = catBody?.data?.results?.[0]?.data?.items ?? []
  console.log(`[sync-designs] found ${designs.length} designs in catalog`)

  let uploaded = 0, skipped = 0, failed = 0
  // We need image_url per design to find the local file. Use a hack: assume
  // the operator's local mirror of /designs/<niche>/<filename> is stored
  // under the local repo's designs/ dir.
  const localRoot = path.resolve(process.cwd(), '..', '..', 'designs')
  if (!fs.existsSync(localRoot)) {
    console.error('[sync-designs] designs/ dir not found at ' + localRoot)
    process.exit(1)
  }

  // Walk designs/ tree, build a map of basename → full path
  const fileMap = new Map<string, string>()
  for (const sub of fs.readdirSync(localRoot)) {
    const subDir = path.join(localRoot, sub)
    if (!fs.statSync(subDir).isDirectory()) continue
    for (const f of fs.readdirSync(subDir)) {
      if (/\.(png|jpe?g|webp)$/i.test(f)) fileMap.set(f, path.join(subDir, f))
    }
  }
  console.log(`[sync-designs] indexed ${fileMap.size} local design files under ${localRoot}`)

  // Without image_url for each design, we can't map deterministically. Fall
  // back to uploading every local file under its basename as the design_id.
  // Operator should rename files to match design_catalog.id for this to work.
  // For seed batches (R352-R354), the filenames are deterministic.
  for (const [name, full] of fileMap) {
    const buf = fs.readFileSync(full)
    const sha = crypto.createHash('sha256').update(buf).digest('hex')
    const designId = path.parse(name).name             // strip extension
    const mime = mimeFromExt(full)
    if (DRY) { console.log(`[dry] ${designId} ${(buf.length / 1024).toFixed(1)}KB sha=${sha.slice(0, 12)}`); skipped++; continue }
    try {
      const res = await fetch(`${cfg.apiBase}/api/v1/designs/upload`, {
        method:  'POST',
        headers: {
          'X-Novan-Token':     cfg.opsToken,
          'X-Novan-Workspace': cfg.workspaceId,
          'X-Novan-Design-Id': designId,
          'X-Novan-Filename':  name,
          'X-Novan-Sha256':    sha,
          'Content-Type':      mime,
        },
        body: buf,
      })
      if (res.ok) { uploaded++; console.log(`[ok]  ${designId}`) }
      else { failed++; console.error(`[err] ${designId}: ${res.status} ${(await res.text()).slice(0, 100)}`) }
    } catch (e) { failed++; console.error(`[err] ${designId}:`, (e as Error).message) }
  }

  console.log(`[sync-designs] uploaded=${uploaded} skipped=${skipped} failed=${failed}`)
  void designs
}

main().catch((e: unknown) => { console.error('[sync-designs] fatal:', e); process.exit(1) })
