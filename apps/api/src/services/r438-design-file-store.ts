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

const STORE_DIR = process.env['NOVAN_DESIGN_STORE'] ?? '/root/novan/design-files'

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

export async function storeDesignFile(input: StoreInput): Promise<StoreResult> {
  await ensureTable()
  if (!input.designId || !input.bytes || input.bytes.length === 0) return { ok: false, reason: 'designId + bytes required' }
  if (input.bytes.length > 25 * 1024 * 1024) return { ok: false, reason: 'too large (>25MB)' }
  if (!/^image\/(png|jpe?g|webp)$/i.test(input.mime)) return { ok: false, reason: 'mime must be image/png|jpg|webp' }

  const sha = crypto.createHash('sha256').update(input.bytes).digest('hex')
  const safeName = path.basename(input.filename).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'design.bin'
  const ext = path.extname(safeName) || '.bin'
  const wsDir = path.join(STORE_DIR, input.workspaceId)
  try { fs.mkdirSync(wsDir, { recursive: true }) } catch { /* tolerated */ }
  const stored = path.join(wsDir, `${input.designId}${ext}`)
  fs.writeFileSync(stored, input.bytes)

  await db.execute(sql`
    INSERT INTO design_files (workspace_id, design_id, filename, mime, bytes, sha256, stored_path, uploaded_at)
    VALUES (${input.workspaceId}, ${input.designId}, ${safeName}, ${input.mime}, ${input.bytes.length}, ${sha}, ${stored}, ${Date.now()})
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
}

export async function readDesignFile(workspaceId: string, designId: string): Promise<{ path: string; mime: string; filename: string } | null> {
  try {
    const r = await db.execute(sql`
      SELECT stored_path, mime, filename FROM design_files WHERE workspace_id = ${workspaceId} AND design_id = ${designId} LIMIT 1
    `)
    const row = (r as unknown as Array<{ stored_path: string; mime: string; filename: string }>)[0]
    if (!row) return null
    return { path: row.stored_path, mime: row.mime, filename: row.filename }
  } catch { return null }
}
