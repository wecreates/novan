/**
 * R438 — Server-side design file store.
 *
 * Operator can upload design PNG/JPG files to /api/v1/designs/upload so the
 * droplet has a copy. design_catalog.image_url gets rewritten from a local
 * Windows path to /api/v1/designs/<id>/file URL. R411 cross-list + R382
 * pipeline + R374 variants all become portable across machines.
 *
 * Files stored under NOVAN_DESIGN_STORE (default /root/novan/design-files/).
 * Each row is (workspace_id, design_id, filename, bytes, mime, sha256).
 */
import { sql } from 'drizzle-orm'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db } from '../db/client.js'

// R444 — moved outside the bind-mounted project dir so docker compose
// down -v can't wipe operator design files. Operator should mount this on
// a separate volume or back it up via R429b.
const STORE_DIR = process.env['NOVAN_DESIGN_STORE'] ?? '/var/lib/novan/design-files'

// R445 — concurrency cap on uploads so operator can't exhaust file descriptors.
let UPLOAD_IN_FLIGHT = 0
const UPLOAD_MAX = 4

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS design_files (
      workspace_id  TEXT NOT NULL,
      design_id     TEXT NOT NULL,
      filename      TEXT NOT NULL,
      mime          TEXT NOT NULL,
      bytes         BIGINT NOT NULL,
      sha256        TEXT NOT NULL,
      stored_path   TEXT NOT NULL,
      uploaded_at   BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, design_id)
    )
  `).catch(() => {})
}

export interface StoreInput {
  workspaceId: string
  designId:    string
  filename:    string
  mime:        string
  bytes:       Buffer
}

export interface StoreResult {
  ok:        boolean
  url?:      string
  sha256?:   string
  reason?:   string
}

// R446 — magic-byte signatures. Reject anything whose first bytes don't
// match the declared MIME, even if extension says .png.
function detectMimeFromMagic(bytes: Buffer): string | null {
  if (bytes.length < 4) return null
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  // WebP: "RIFF...WEBP"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

export async function storeDesignFile(input: StoreInput): Promise<StoreResult> {
  if (UPLOAD_IN_FLIGHT >= UPLOAD_MAX) return { ok: false, reason: 'too many concurrent uploads, retry shortly' }
  UPLOAD_IN_FLIGHT++
  try {
  await ensureTable()
  if (!input.designId || !input.bytes || input.bytes.length === 0) return { ok: false, reason: 'designId + bytes required' }
  if (input.bytes.length > 25 * 1024 * 1024) return { ok: false, reason: 'too large (>25MB)' }
  // R459 — verify design_id exists in design_catalog so we don't strand orphan files.
  try {
    const e = await db.execute(sql`SELECT 1 FROM design_catalog WHERE workspace_id = ${input.workspaceId} AND id = ${input.designId} LIMIT 1`)
    const arr = (e as unknown as { rows?: unknown[] } | unknown[])
    const rows = Array.isArray(arr) ? arr : (arr.rows ?? [])
    if (rows.length === 0) return { ok: false, reason: 'designId not found in design_catalog' }
  } catch { /* tolerated — fall through */ }
  const sniffed = detectMimeFromMagic(input.bytes)
  if (!sniffed) return { ok: false, reason: 'unrecognized image format (magic-byte check failed)' }
  if (sniffed.replace('jpeg','jpg') !== input.mime.replace('jpeg','jpg').toLowerCase() && !(input.mime.toLowerCase() === 'image/jpeg' && sniffed === 'image/jpeg')) {
    return { ok: false, reason: `declared MIME ${input.mime} doesn't match magic bytes (${sniffed})` }
  }

  // R442 — sanitize designId so it can't break out of the workspace dir via '../'.
  const safeDesignId = String(input.designId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
  const safeWsId     = String(input.workspaceId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100)
  if (!safeDesignId || !safeWsId) return { ok: false, reason: 'designId/workspaceId became empty after sanitization' }
  const sha = crypto.createHash('sha256').update(input.bytes).digest('hex')
  const safeName = path.basename(input.filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'design.bin'
  const ext = path.extname(safeName) || '.bin'
  const wsDir = path.join(STORE_DIR, safeWsId)
  try { fs.mkdirSync(wsDir, { recursive: true }) } catch { /* tolerated */ }
  const stored = path.join(wsDir, `${safeDesignId}${ext}`)
  // Resolve to absolute and verify it stays inside STORE_DIR
  const storeAbs = path.resolve(STORE_DIR)
  const storedAbs = path.resolve(stored)
  if (!storedAbs.startsWith(storeAbs + path.sep)) return { ok: false, reason: 'path traversal blocked' }
  // R475 — if a prior upload used a different extension, unlink it so disk
  // doesn't leak when operator re-uploads (e.g., png → jpg).
  try {
    const r = await db.execute(sql`SELECT stored_path FROM design_files WHERE workspace_id = ${safeWsId} AND design_id = ${safeDesignId} LIMIT 1`)
    const old = (r as unknown as Array<{ stored_path: string }>)[0]?.stored_path
    if (old) {
      const oldAbs = path.isAbsolute(old) ? old : path.join(STORE_DIR, old)
      if (oldAbs !== stored && oldAbs.startsWith(storeAbs + path.sep)) {
        await fs.promises.unlink(oldAbs).catch(() => {/* tolerated */})
      }
    }
  } catch { /* tolerated */ }
  // R460 — async write so we don't block the event loop on large files.
  await fs.promises.writeFile(stored, input.bytes)

  // R447 — persist RELATIVE path (relative to STORE_DIR) so restoring on a
  // different machine works.
  const relStored = path.relative(STORE_DIR, stored)
  await db.execute(sql`
    INSERT INTO design_files (workspace_id, design_id, filename, mime, bytes, sha256, stored_path, uploaded_at)
    VALUES (${input.workspaceId}, ${input.designId}, ${safeName}, ${input.mime}, ${input.bytes.length}, ${sha}, ${relStored}, ${Date.now()})
    ON CONFLICT (workspace_id, design_id) DO UPDATE SET
      filename = EXCLUDED.filename, mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
      sha256 = EXCLUDED.sha256, stored_path = EXCLUDED.stored_path, uploaded_at = EXCLUDED.uploaded_at
  `).catch(() => {/* best effort */})

  // Rewrite design_catalog.image_url to the served URL so downstream R393 etc
  // pick up the droplet copy.
  const url = `/api/v1/designs/${encodeURIComponent(input.designId)}/file`
  await db.execute(sql`
    UPDATE design_catalog SET image_url = ${url} WHERE workspace_id = ${input.workspaceId} AND id = ${input.designId}
  `).catch(() => {/* best effort */})

  return { ok: true, url, sha256: sha }
  } finally { UPLOAD_IN_FLIGHT-- }
}

/** R466 — operator deletes a design file (NOT the design row). */
export async function deleteDesignFile(workspaceId: string, designId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await db.execute(sql`
      SELECT stored_path FROM design_files WHERE workspace_id = ${workspaceId} AND design_id = ${designId} LIMIT 1
    `)
    const row = (r as unknown as Array<{ stored_path: string }>)[0]
    if (!row) return { ok: false, reason: 'not found' }
    const abs = path.isAbsolute(row.stored_path) ? row.stored_path : path.join(STORE_DIR, row.stored_path)
    const storeAbs = path.resolve(STORE_DIR)
    const absResolved = path.resolve(abs)
    if (!absResolved.startsWith(storeAbs + path.sep)) return { ok: false, reason: 'path traversal blocked' }
    try { await fs.promises.unlink(abs) } catch { /* file may already be gone */ }
    await db.execute(sql`
      DELETE FROM design_files WHERE workspace_id = ${workspaceId} AND design_id = ${designId}
    `).catch(() => {/* best effort */})
    // R489 — clear the stale URL pointer in design_catalog. NULL is safer than
    // leaving a 404'ing URL there; downstream R393 auto-pin will skip.
    await db.execute(sql`
      UPDATE design_catalog SET image_url = '' WHERE workspace_id = ${workspaceId} AND id = ${designId} AND image_url LIKE '/api/v1/designs/%'
    `).catch(() => {/* best effort */})
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 200) }
  }
}

export async function readDesignFile(workspaceId: string, designId: string): Promise<{ path: string; mime: string; filename: string } | null> {
  try {
    const r = await db.execute(sql`
      SELECT stored_path, mime, filename FROM design_files WHERE workspace_id = ${workspaceId} AND design_id = ${designId} LIMIT 1
    `)
    const row = (r as unknown as Array<{ stored_path: string; mime: string; filename: string }>)[0]
    if (!row) return null
    // R447 — stored_path is relative; resolve against STORE_DIR for read.
    const abs = path.isAbsolute(row.stored_path) ? row.stored_path : path.join(STORE_DIR, row.stored_path)
    return { path: abs, mime: row.mime, filename: row.filename }
  } catch { return null }
}
