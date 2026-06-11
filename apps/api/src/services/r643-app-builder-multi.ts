/**
 * R643d — Multi-file app builder.
 *
 * Extends R642d (single-file HTML) to support multi-file apps with a
 * file map: { 'index.html': '…', 'style.css': '…', 'app.js': '…' }.
 * Files are stored as JSONB and served at /apps/:slug/<path>.
 *
 * No build step yet — relies on browsers loading siblings via relative
 * URLs (or absolute /apps/:slug/<path>). No npm install, no node_modules.
 * Bundling + per-app sub-domains via Caddy arrive in a later round once
 * the operator wires DNS + Caddy config.
 *
 *   app.create_multi  generate multi-file app from prompt via LLM JSON mode
 *   app.put_files     bulk-upsert files for a slug (operator-authored)
 *   app.list_files    list filenames + sizes
 *   app.get_file      get one file's content
 *   app.delete_multi  delete the whole app
 *
 * The single-file r642 surface stays untouched; multi-file uses a separate
 * generated_apps_multi table so the legacy slug space doesn't collide.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import type { ChatMsg } from './chat-providers.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS generated_apps_multi (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      slug         TEXT NOT NULL,
      name         TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      files        JSONB NOT NULL DEFAULT '{}'::jsonb,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL,
      UNIQUE (workspace_id, slug)
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gen_apps_multi_ws_idx ON generated_apps_multi (workspace_id, updated_at DESC)`).catch(() => {})
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `app-${Date.now().toString(36)}`
}

// Limit individual file size + total bundle size
const MAX_FILE_BYTES   = 256 * 1024
const MAX_TOTAL_BYTES  = 2  * 1024 * 1024
const MAX_FILES        = 20
const SAFE_PATH        = /^[a-zA-Z0-9._-][a-zA-Z0-9._\-/]{0,180}$/
const FORBIDDEN_PATH   = /\.\.|\/\/|^\/|\.env|node_modules/

function validatePath(p: string): { ok: true } | { ok: false; reason: string } {
  if (!p || p.length > 180)            return { ok: false, reason: 'path empty or >180 chars' }
  if (!SAFE_PATH.test(p))              return { ok: false, reason: 'path has invalid chars' }
  if (FORBIDDEN_PATH.test(p))          return { ok: false, reason: 'forbidden path pattern' }
  if (p.endsWith('/'))                 return { ok: false, reason: 'trailing slash' }
  return { ok: true }
}

function validateFiles(files: Record<string, string>): { ok: true } | { ok: false; reason: string } {
  const keys = Object.keys(files)
  if (keys.length === 0)               return { ok: false, reason: 'empty files map' }
  if (keys.length > MAX_FILES)         return { ok: false, reason: `>${MAX_FILES} files` }
  let total = 0
  for (const [k, v] of Object.entries(files)) {
    const vp = validatePath(k); if (!vp.ok) return { ok: false, reason: `path "${k}": ${vp.reason}` }
    if (typeof v !== 'string')         return { ok: false, reason: `path "${k}": not a string` }
    if (v.length > MAX_FILE_BYTES)     return { ok: false, reason: `path "${k}": >${MAX_FILE_BYTES} bytes` }
    total += v.length
  }
  if (total > MAX_TOTAL_BYTES)         return { ok: false, reason: `total >${MAX_TOTAL_BYTES} bytes` }
  if (!keys.some(k => k === 'index.html' || k.endsWith('/index.html'))) {
    return { ok: false, reason: 'no index.html — every app needs one as the entry point' }
  }
  return { ok: true }
}

// ─── LLM generation ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You build multi-file static web apps. Output a strict JSON object: { "name": string, "files": { "index.html": "…", "style.css": "…", "app.js": "…", … } }.

Rules:
- ALWAYS include index.html with linked stylesheet and script via plain <link> + <script src=…>. Relative paths only ('style.css', 'app.js'). No CDN imports unless absolutely necessary, in which case use unpkg/jsdelivr/cdnjs.
- Use ONLY browser-native APIs. No npm, no node, no JSX, no build step.
- Each file ≤200 KB. Total ≤1.5 MB. Up to 18 files.
- File paths: a-zA-Z0-9._-/ only. No leading slash, no dotfiles, no .env, no traversal.
- Dark + light auto-theme via prefers-color-scheme.
- Mobile-first responsive. Accessible (semantic HTML, aria-labels, keyboard nav).
- localStorage for persistence; never hardcode secrets.
- Output ONLY the JSON object. No markdown fences. No commentary.`

export interface CreateMultiInput {
  prompt: string
  name?:  string
  slug?:  string
}

export interface CreateMultiResult {
  id:      string
  slug:    string
  version: number
  files:   Array<{ path: string; bytes: number }>
  tokens:  number
  costUsd: number
}

export async function createMulti(workspaceId: string, input: CreateMultiInput): Promise<CreateMultiResult> {
  await ensureTable()
  if (!input.prompt?.trim()) throw new Error('prompt required')

  const slug = slugify(input.slug ?? input.name ?? input.prompt.slice(0, 60))
  const id = uuidv7()

  const msgs: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: input.prompt },
  ]
  const { streamChat } = await import('./chat-providers.js')
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
  final = next.value

  // Strip code fences if the model used them despite instructions
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = (fenced?.[1] ?? raw).trim()
  const jsonMatch = candidate.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('LLM did not return JSON')
  let parsed: { name?: string; files?: Record<string, string> }
  try { parsed = JSON.parse(jsonMatch[0]) } catch (e) { throw new Error(`JSON parse: ${(e as Error).message}`) }

  const files = parsed.files ?? {}
  const v = validateFiles(files)
  if (!v.ok) throw new Error(`files invalid: ${v.reason}`)

  const name = parsed.name ?? input.name ?? input.prompt.slice(0, 80).trim()
  const now = Date.now()
  const r = await db.execute(sql`
    INSERT INTO generated_apps_multi (id, workspace_id, slug, name, prompt, files, version, created_at, updated_at)
    VALUES (${id}, ${workspaceId}, ${slug}, ${name}, ${input.prompt}, ${JSON.stringify(files)}::jsonb, 1, ${now}, ${now})
    ON CONFLICT (workspace_id, slug) DO UPDATE SET
      prompt = EXCLUDED.prompt, files = EXCLUDED.files, name = EXCLUDED.name,
      version = generated_apps_multi.version + 1, updated_at = EXCLUDED.updated_at
    RETURNING id, version
  `).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  return {
    id:      row ? String(row['id']) : id,
    slug,
    version: row ? Number(row['version']) : 1,
    files:   Object.entries(files).map(([path, content]) => ({ path, bytes: String(content).length })),
    tokens:  final.tokens,
    costUsd: final.costUsd,
  }
}

// ─── Direct operator-authored file map ───────────────────────────────────

export interface PutFilesInput {
  slug:  string
  name?: string
  files: Record<string, string>
}

export async function putFiles(workspaceId: string, input: PutFilesInput): Promise<{ id: string; slug: string; version: number }> {
  await ensureTable()
  if (!input.slug?.trim()) throw new Error('slug required')
  const v = validateFiles(input.files)
  if (!v.ok) throw new Error(`files invalid: ${v.reason}`)
  const id = uuidv7()
  const now = Date.now()
  const r = await db.execute(sql`
    INSERT INTO generated_apps_multi (id, workspace_id, slug, name, prompt, files, version, created_at, updated_at)
    VALUES (${id}, ${workspaceId}, ${input.slug}, ${input.name ?? input.slug}, ${'operator-authored'}, ${JSON.stringify(input.files)}::jsonb, 1, ${now}, ${now})
    ON CONFLICT (workspace_id, slug) DO UPDATE SET
      files = EXCLUDED.files, name = EXCLUDED.name,
      version = generated_apps_multi.version + 1, updated_at = EXCLUDED.updated_at
    RETURNING id, version
  `).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  return { id: row ? String(row['id']) : id, slug: input.slug, version: row ? Number(row['version']) : 1 }
}

export async function listFiles(workspaceId: string, slug: string): Promise<Array<{ path: string; bytes: number }>> {
  await ensureTable()
  const r = await db.execute(sql`SELECT files FROM generated_apps_multi WHERE workspace_id = ${workspaceId} AND slug = ${slug}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return []
  const files = (row['files'] as Record<string, string>) ?? {}
  return Object.entries(files).map(([path, content]) => ({ path, bytes: String(content).length }))
}

export async function getFile(workspaceId: string, slug: string, filePath: string): Promise<{ content: string; mime: string } | null> {
  await ensureTable()
  const vp = validatePath(filePath)
  if (!vp.ok) return null
  const r = await db.execute(sql`SELECT files FROM generated_apps_multi WHERE workspace_id = ${workspaceId} AND slug = ${slug}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return null
  const files = (row['files'] as Record<string, string>) ?? {}
  const content = files[filePath]
  if (typeof content !== 'string') return null
  return { content, mime: mimeFromPath(filePath) }
}

export async function listApps(workspaceId: string, limit = 30): Promise<Array<{ id: string; slug: string; name: string; version: number; fileCount: number; totalBytes: number; updatedAt: number }>> {
  await ensureTable()
  const lim = Math.max(1, Math.min(100, limit))
  const r = await db.execute(sql`SELECT id, slug, name, version, files, updated_at FROM generated_apps_multi WHERE workspace_id = ${workspaceId} ORDER BY updated_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => {
    const files = (row['files'] as Record<string, string>) ?? {}
    const totalBytes = Object.values(files).reduce((a, c) => a + String(c).length, 0)
    return {
      id:         String(row['id']),
      slug:       String(row['slug']),
      name:       String(row['name']),
      version:    Number(row['version'] ?? 1),
      fileCount:  Object.keys(files).length,
      totalBytes,
      updatedAt:  Number(row['updated_at']),
    }
  })
}

export async function deleteApp(workspaceId: string, slug: string): Promise<{ ok: boolean }> {
  await ensureTable()
  await db.execute(sql`DELETE FROM generated_apps_multi WHERE workspace_id = ${workspaceId} AND slug = ${slug}`).catch(() => {})
  return { ok: true }
}

function mimeFromPath(p: string): string {
  const ext = (p.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase()
  switch (ext) {
    case 'html': case 'htm': return 'text/html; charset=utf-8'
    case 'css':              return 'text/css; charset=utf-8'
    case 'js': case 'mjs':   return 'application/javascript; charset=utf-8'
    case 'json':             return 'application/json'
    case 'svg':              return 'image/svg+xml'
    case 'png':              return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'webp':             return 'image/webp'
    case 'ico':              return 'image/x-icon'
    case 'txt': case 'md':   return 'text/plain; charset=utf-8'
    case 'webmanifest':      return 'application/manifest+json'
    default:                 return 'application/octet-stream'
  }
}
