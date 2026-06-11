/**
 * R642d — Prompt-to-deployed-app builder (D3 — scaffold).
 *
 * The full Lovable/Bolt-class flow needs sandboxed builds, runtime
 * isolation, asset bundling, etc. — multi-day. This scaffold ships
 * the high-leverage 80% in one round:
 *
 *   1. app.create(prompt) — LLM generates a single-file HTML app
 *      (HTML + CSS + JS in one document, no build chain) targeted at
 *      whatever the operator described. The file is stored in
 *      generated_apps as text.
 *   2. app.list / app.get / app.delete — CRUD.
 *   3. GET /apps/:slug — serves the latest version of the stored HTML.
 *
 * The single-file constraint keeps this safe: no npm install, no
 * runtime, no upload of arbitrary executables. Operator can iterate
 * via app.update to refine the prompt and have Novan regenerate.
 *
 * Multi-file builds with bundling arrive in a future round once the
 * sandbox tier is real (R357 local agent + Caddy reverse-proxy is the
 * planned path).
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import type { ChatMsg } from './chat-providers.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS generated_apps (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      slug         TEXT NOT NULL,
      name         TEXT NOT NULL,
      prompt       TEXT NOT NULL,
      html         TEXT NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL,
      UNIQUE (workspace_id, slug)
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gen_apps_ws_idx ON generated_apps (workspace_id, updated_at DESC)`).catch(() => {})
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `app-${Date.now().toString(36)}`
}

export interface CreateInput {
  prompt: string
  name?:  string
  slug?:  string         // explicit override; otherwise derived from name
}

export interface CreateResult {
  id: string
  slug: string
  version: number
  bytes: number
  tokens: number
  costUsd: number
}

const SYSTEM_PROMPT = `You build single-file HTML web apps. Output exactly one self-contained HTML document with inline <style> and <script> — no external scripts (except hosted libs from cdnjs/jsdelivr/unpkg when essential), no build chain, no JSX. Mobile-first responsive. Dark + light auto-themed via prefers-color-scheme. Accessible (aria-labels, keyboard nav).

Hard rules:
- Output ONLY the raw HTML, starting with <!doctype html>. No markdown fences. No commentary.
- The page MUST work standalone — opening the file in a browser must render and function.
- Never hardcode secrets; if API access is needed, prompt the user to paste a key into a localStorage field.
- Validate user input; never execute arbitrary user-supplied code via eval/new Function.
- Keep total size under 64 KB unless absolutely necessary.`

export async function createApp(workspaceId: string, input: CreateInput): Promise<CreateResult> {
  await ensureTable()
  if (!input.prompt?.trim()) throw new Error('prompt required')

  const slug = slugify(input.slug ?? input.name ?? input.prompt.slice(0, 60))
  const name = input.name ?? input.prompt.split(/[.!?]/)[0]?.slice(0, 80).trim() ?? slug
  const id = uuidv7()

  const { streamChat } = await import('./chat-providers.js')
  const msgs: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: input.prompt },
  ]
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
  final = next.value

  // Extract HTML body — tolerate the LLM if it ignores our "no fence" instruction
  const fenced = raw.match(/```(?:html)?\s*([\s\S]*?)\s*```/i)
  let html = (fenced?.[1] ?? raw).trim()
  if (!/^<!doctype html|<html/i.test(html)) {
    // Last-resort wrap so a bare body still renders
    html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`
  }
  if (html.length > 256 * 1024) throw new Error('generated HTML too large (>256 KB)')

  const now = Date.now()
  // Bump version on conflict
  const r = await db.execute(sql`
    INSERT INTO generated_apps (id, workspace_id, slug, name, prompt, html, version, created_at, updated_at)
    VALUES (${id}, ${workspaceId}, ${slug}, ${name}, ${input.prompt}, ${html}, 1, ${now}, ${now})
    ON CONFLICT (workspace_id, slug) DO UPDATE SET
      prompt = EXCLUDED.prompt, html = EXCLUDED.html, name = EXCLUDED.name,
      version = generated_apps.version + 1, updated_at = EXCLUDED.updated_at
    RETURNING id, version
  `).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  const finalId      = row ? String(row['id']) : id
  const finalVersion = row ? Number(row['version']) : 1

  return {
    id:      finalId,
    slug,
    version: finalVersion,
    bytes:   html.length,
    tokens:  final.tokens,
    costUsd: final.costUsd,
  }
}

export interface AppRow {
  id: string
  workspaceId: string
  slug: string
  name: string
  prompt: string
  version: number
  bytes: number
  createdAt: number
  updatedAt: number
}

function rowToApp(r: Record<string, unknown>, includeHtml = false): AppRow & { html?: string } {
  const base: AppRow = {
    id:          String(r['id']),
    workspaceId: String(r['workspace_id']),
    slug:        String(r['slug']),
    name:        String(r['name']),
    prompt:      String(r['prompt']),
    version:     Number(r['version'] ?? 1),
    bytes:       String(r['html'] ?? '').length,
    createdAt:   Number(r['created_at']),
    updatedAt:   Number(r['updated_at']),
  }
  return includeHtml ? { ...base, html: String(r['html'] ?? '') } : base
}

export async function listApps(workspaceId: string, limit = 30): Promise<AppRow[]> {
  await ensureTable()
  const lim = Math.max(1, Math.min(100, limit))
  const r = await db.execute(sql`SELECT id, workspace_id, slug, name, prompt, html, version, created_at, updated_at FROM generated_apps WHERE workspace_id = ${workspaceId} ORDER BY updated_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => rowToApp(row, false))
}

export async function getApp(workspaceId: string, slug: string, includeHtml = false): Promise<(AppRow & { html?: string }) | null> {
  await ensureTable()
  const r = await db.execute(sql`SELECT id, workspace_id, slug, name, prompt, html, version, created_at, updated_at FROM generated_apps WHERE workspace_id = ${workspaceId} AND slug = ${slug}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  return row ? rowToApp(row, includeHtml) : null
}

export async function deleteApp(workspaceId: string, slug: string): Promise<{ ok: boolean }> {
  await ensureTable()
  await db.execute(sql`DELETE FROM generated_apps WHERE workspace_id = ${workspaceId} AND slug = ${slug}`).catch(() => {})
  return { ok: true }
}

/** Server route handler delegates here to render the latest version of an app. */
export async function serveAppHtml(workspaceId: string, slug: string): Promise<string | null> {
  const a = await getApp(workspaceId, slug, true)
  return a?.html ?? null
}
