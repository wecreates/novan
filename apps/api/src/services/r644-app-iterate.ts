/**
 * R644c — app.iterate: refine an existing multi-file app via diff.
 *
 * Pattern: send the LLM the current files + an iteration prompt. It returns
 * one of two JSON shapes:
 *   1. Full replacement: { files: { path: content, ... } }
 *   2. Partial diff:     { changes: [{ op: "create"|"update"|"delete", path, content? }] }
 *
 * We accept either, apply it to the stored map, validate the result via the
 * same R643d safety rules, and persist as a bumped version.
 *
 * Per-iteration cost is bounded by the LLM context budget. Diff mode is
 * preferred for small changes (faster, cheaper); full mode is used when the
 * model decides a rewrite is cleaner.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import type { ChatMsg } from './chat-providers.js'

interface AppRow { files: Record<string, string>; name: string; version: number }

const MAX_FILE_BYTES   = 256 * 1024
const MAX_TOTAL_BYTES  = 2  * 1024 * 1024
const MAX_FILES        = 20
const SAFE_PATH        = /^[a-zA-Z0-9._-][a-zA-Z0-9._\-/]{0,180}$/
const FORBIDDEN_PATH   = /\.\.|\/\/|^\/|\.env|node_modules/

function validatePath(p: string): { ok: boolean; reason?: string } {
  if (!p || p.length > 180)            return { ok: false, reason: 'path empty or >180 chars' }
  if (!SAFE_PATH.test(p))              return { ok: false, reason: 'path has invalid chars' }
  if (FORBIDDEN_PATH.test(p))          return { ok: false, reason: 'forbidden path pattern' }
  if (p.endsWith('/'))                 return { ok: false, reason: 'trailing slash' }
  return { ok: true }
}

function validateFiles(files: Record<string, string>): { ok: boolean; reason?: string } {
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
    return { ok: false, reason: 'index.html missing after iteration' }
  }
  return { ok: true }
}

const SYSTEM_PROMPT = `You iterate on multi-file static web apps. You'll receive the current files + an iteration instruction. Output JSON in ONE of these shapes:

  A) DIFF MODE (preferred for small changes):
     { "mode": "diff", "changes": [
        { "op": "create" | "update" | "delete", "path": string, "content": string? }
     ]}

  B) FULL MODE (when a rewrite is cleaner):
     { "mode": "full", "files": { "path": "content", ... } }

Rules:
- Output ONLY the JSON object. No markdown fences. No commentary.
- Preserve unchanged files in DIFF mode (do NOT include them in changes).
- Each file ≤200 KB. Total ≤1.5 MB. Up to 18 files.
- File paths: a-zA-Z0-9._-/ only. No leading slash, no dotfiles, no .env, no traversal.
- index.html must still exist after the iteration.
- No npm, no node, no JSX, no build step. Browser-native only.
- For DELETE ops, content is omitted.`

export interface IterateInput {
  slug: string
  prompt: string
}

export interface IterateResult {
  slug: string
  version: number
  mode: 'diff' | 'full'
  filesAfter: Array<{ path: string; bytes: number }>
  changes?: Array<{ op: 'create' | 'update' | 'delete'; path: string; bytes: number }>
  tokens: number
  costUsd: number
}

async function getApp(workspaceId: string, slug: string): Promise<AppRow | null> {
  const r = await db.execute(sql`SELECT files, name, version FROM generated_apps_multi WHERE workspace_id = ${workspaceId} AND slug = ${slug}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return null
  return {
    files:   (row['files']   as Record<string, string>) ?? {},
    name:    String(row['name']),
    version: Number(row['version'] ?? 1),
  }
}

export async function iterate(workspaceId: string, input: IterateInput): Promise<IterateResult> {
  if (!input.slug?.trim()) throw new Error('slug required')
  if (!input.prompt?.trim()) throw new Error('prompt required')

  const app = await getApp(workspaceId, input.slug)
  if (!app) throw new Error(`app "${input.slug}" not found — use app.create_multi first`)

  // Build the user message: current files + iteration instruction
  const filesBlock = Object.entries(app.files).map(([path, content]) =>
    `--- ${path} (${content.length} bytes) ---\n${content}`
  ).join('\n\n')

  const msgs: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: `Current files for app "${app.name}":\n\n${filesBlock}\n\n--- Iteration instruction ---\n${input.prompt}` },
  ]

  const { streamChat } = await import('./chat-providers.js')
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
  final = next.value

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = (fenced?.[1] ?? raw).trim()
  const jsonMatch = candidate.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('LLM did not return JSON')
  let parsed: { mode?: 'diff' | 'full'; files?: Record<string, string>; changes?: Array<{ op: string; path: string; content?: string }> }
  try { parsed = JSON.parse(jsonMatch[0]) } catch (e) { throw new Error(`JSON parse: ${(e as Error).message}`) }

  // Apply
  let after: Record<string, string>
  const appliedChanges: Array<{ op: 'create' | 'update' | 'delete'; path: string; bytes: number }> = []
  const mode: 'diff' | 'full' = parsed.mode === 'full' ? 'full' : (parsed.changes ? 'diff' : 'full')

  if (mode === 'full') {
    if (!parsed.files || typeof parsed.files !== 'object') throw new Error('full mode requires files map')
    after = parsed.files
  } else {
    after = { ...app.files }
    for (const ch of parsed.changes ?? []) {
      const op = ch.op as 'create' | 'update' | 'delete'
      if (!['create', 'update', 'delete'].includes(op)) continue
      const vp = validatePath(ch.path)
      if (!vp.ok) throw new Error(`change "${ch.path}" rejected: ${vp.reason}`)
      if (op === 'delete') {
        if (!(ch.path in after)) continue
        delete after[ch.path]
        appliedChanges.push({ op, path: ch.path, bytes: 0 })
      } else {
        if (typeof ch.content !== 'string') throw new Error(`${op} "${ch.path}" missing content`)
        const isNew = !(ch.path in after)
        after[ch.path] = ch.content
        appliedChanges.push({ op: isNew ? 'create' : 'update', path: ch.path, bytes: ch.content.length })
      }
    }
  }

  const v = validateFiles(after)
  if (!v.ok) throw new Error(`iterated files invalid: ${v.reason}`)

  const now = Date.now()
  const r = await db.execute(sql`
    UPDATE generated_apps_multi
    SET files = ${JSON.stringify(after)}::jsonb, version = version + 1, updated_at = ${now}
    WHERE workspace_id = ${workspaceId} AND slug = ${input.slug}
    RETURNING version
  `).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  const newVersion = row ? Number(row['version']) : app.version + 1

  const result: IterateResult = {
    slug:       input.slug,
    version:    newVersion,
    mode,
    filesAfter: Object.entries(after).map(([path, content]) => ({ path, bytes: content.length })),
    tokens:     final.tokens,
    costUsd:    final.costUsd,
  }
  if (mode === 'diff') result.changes = appliedChanges
  return result
}
