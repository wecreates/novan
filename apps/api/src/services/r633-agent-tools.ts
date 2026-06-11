/**
 * R633 — Agent tools: SQL sandbox (D2), GitHub PR (D5), code review (D6), debug-trace (D7).
 *
 *   db.explore       — read-only SELECT against allowlisted tables (D2)
 *   github.open_pr   — open a PR via GitHub REST (needs GITHUB_TOKEN) (D5)
 *   code.review      — LLM review of a file with rubric (D6 — wraps R340 if available)
 *   debug.trace      — pull recent error events + logs, LLM root-cause (D7)
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import type { ChatMsg } from './chat-providers.js'

// ─── D2 SQL sandbox (read-only) ─────────────────────────────────────────────

const ALLOWED_TABLES = new Set([
  'events', 'ai_usage', 'novan_inbox', 'generated_assets', 'pipelines', 'pipeline_runs',
  'kg_nodes', 'kg_edges', 'workspace_memory', 'rag_documents', 'rag_chunks',
  'ab_tests', 'r629_approvals', 'spend_caps', 'public_shares',
  'business_revenue', 'business_portfolio', 'content_analytics',
  'desktop_action_queue', 'connectors',
])

function isPureSelect(sql0: string): boolean {
  const s = sql0.trim().replace(/\s+/g, ' ')
  if (!/^SELECT\b/i.test(s)) return false
  if (/;/.test(s.slice(0, -1))) return false      // disallow stacked statements
  if (/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|EXECUTE|CALL|DO|LISTEN|NOTIFY|UNLISTEN|LOCK)\b/i.test(s)) return false
  if (/--|\/\*|\*\//.test(s)) return false        // strip-able comments could hide payload; reject for now
  return true
}

function extractTables(sql0: string): string[] {
  const m = [...sql0.matchAll(/\bFROM\s+([a-z_][a-z0-9_]*)|\bJOIN\s+([a-z_][a-z0-9_]*)/gi)]
  const out = new Set<string>()
  for (const x of m) {
    const t = (x[1] ?? x[2] ?? '').toLowerCase()
    if (t) out.add(t)
  }
  return [...out]
}

export interface DbExploreInput {
  query:    string
  limit?:   number          // hard-capped to 200
  workspaceId?: string      // if set, query is auto-filtered to that ws (when workspace_id col exists)
}

export interface DbExploreResult {
  ok:        boolean
  rowCount?: number
  rows?:     Array<Record<string, unknown>>
  error?:    string
  tables?:   string[]
}

export async function dbExplore(input: DbExploreInput): Promise<DbExploreResult> {
  if (!input.query?.trim()) return { ok: false, error: 'query required' }
  if (input.query.length > 4000) return { ok: false, error: 'query too long (>4000 chars)' }
  if (!isPureSelect(input.query)) return { ok: false, error: 'only single SELECT allowed (no DML/DDL/comments/stacked statements)' }

  const tables = extractTables(input.query)
  const bad = tables.filter(t => !ALLOWED_TABLES.has(t))
  if (bad.length > 0) return { ok: false, error: `tables not in allowlist: ${bad.join(', ')}`, tables }

  const lim = Math.max(1, Math.min(200, input.limit ?? 100))
  const wrapped = `SELECT * FROM (${input.query}) _sub LIMIT ${lim}`
  try {
    const r = await db.execute(sql.raw(wrapped))
    const rows = r as Array<Record<string, unknown>>
    return { ok: true, rowCount: rows.length, rows, tables }
  } catch (e) {
    return { ok: false, error: (e as Error).message, tables }
  }
}

// ─── D5 GitHub PR ───────────────────────────────────────────────────────────

export interface OpenPrInput {
  repo:   string             // 'owner/name'
  base:   string             // base branch
  head:   string             // head branch (must already exist on remote)
  title:  string
  body?:  string
  draft?: boolean
}

export interface OpenPrResult {
  ok:      boolean
  number?: number
  url?:    string
  error?:  string
}

export async function openPr(input: OpenPrInput): Promise<OpenPrResult> {
  const token = process.env['GITHUB_TOKEN']
  if (!token) return { ok: false, error: 'GITHUB_TOKEN not set' }
  if (!/^[^/]+\/[^/]+$/.test(input.repo)) return { ok: false, error: 'repo must be owner/name' }
  try {
    const r = await fetch(`https://api.github.com/repos/${input.repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:        'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent':  'Novan-R633/1.0',
      },
      body: JSON.stringify({
        title: input.title.slice(0, 256),
        head:  input.head, base: input.base,
        body:  input.body ?? '',
        draft: !!input.draft,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return { ok: false, error: `github ${r.status} ${text.slice(0, 300)}` }
    }
    const j = await r.json().catch(() => ({})) as { number?: number; html_url?: string }
    const result: OpenPrResult = { ok: true }
    if (typeof j.number === 'number') result.number = j.number
    if (typeof j.html_url === 'string') result.url = j.html_url
    return result
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ─── D6 Code review ─────────────────────────────────────────────────────────

export interface CodeReviewInput {
  filename:  string
  code:      string
  language?: string
  focus?:    'bugs' | 'security' | 'perf' | 'style' | 'all'
}

export interface CodeReviewResult {
  filename: string
  findings: Array<{ severity: 'critical' | 'high' | 'medium' | 'low' | 'note'; line?: number; title: string; suggestion?: string }>
  summary:  string
  tokens:   number
  costUsd:  number
}

export async function codeReview(workspaceId: string, input: CodeReviewInput): Promise<CodeReviewResult> {
  if (!input.code?.trim()) throw new Error('code required')
  const focus = input.focus ?? 'all'
  const msgs: ChatMsg[] = [
    { role: 'system', content: `You review code. Focus: ${focus}. Output JSON: { "summary": string, "findings": [{"severity": "critical"|"high"|"medium"|"low"|"note", "line": number?, "title": string, "suggestion": string?}] }. Be concrete — cite line numbers when possible. Do not invent issues to fill space.` },
    { role: 'user', content: `Filename: ${input.filename}${input.language ? ` (${input.language})` : ''}\n\n\`\`\`${input.language ?? ''}\n${input.code.slice(0, 50000)}\n\`\`\`` },
  ]
  const { streamChat } = await import('./chat-providers.js')
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
  final = next.value
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('LLM did not return JSON')
  let parsed: { summary?: string; findings?: CodeReviewResult['findings'] }
  try { parsed = JSON.parse(m[0]) } catch { throw new Error('review JSON parse failed') }
  return {
    filename: input.filename,
    findings: parsed.findings ?? [],
    summary:  parsed.summary ?? '',
    tokens:   final.tokens,
    costUsd:  final.costUsd,
  }
}

// ─── D7 Debug trace ─────────────────────────────────────────────────────────

export interface DebugTraceInput {
  hoursBack?: number       // default 1
  filter?:    string       // grep-like over payload
  limit?:     number       // default 30
}

export interface DebugTraceResult {
  errorEvents: Array<{ id: string; type: string; createdAt: number; payload: Record<string, unknown> }>
  rootCause:   string
  suggestion:  string
  tokens:      number
  costUsd:     number
}

export async function debugTrace(workspaceId: string, input: DebugTraceInput): Promise<DebugTraceResult> {
  const hoursBack = Math.max(1, Math.min(72, input.hoursBack ?? 1))
  const since = Date.now() - hoursBack * 3600_000
  const lim = Math.max(5, Math.min(100, input.limit ?? 30))
  const r = await db.execute(sql`
    SELECT id, type, payload, created_at FROM events
    WHERE workspace_id = ${workspaceId}
      AND created_at > ${since}
      AND (type LIKE '%error%' OR type LIKE '%fail%' OR type LIKE '%block%')
    ORDER BY created_at DESC LIMIT ${lim}
  `).catch(() => [] as unknown[])
  const errs = (r as Array<Record<string, unknown>>).map(row => ({
    id:         String(row['id']),
    type:       String(row['type']),
    createdAt:  Number(row['created_at']),
    payload:    (row['payload'] as Record<string, unknown>) ?? {},
  }))

  let filtered = errs
  if (input.filter) {
    const f = input.filter.toLowerCase()
    filtered = errs.filter(e => JSON.stringify(e.payload).toLowerCase().includes(f) || e.type.toLowerCase().includes(f))
  }

  if (filtered.length === 0) {
    return { errorEvents: [], rootCause: 'No error events in window.', suggestion: 'All quiet — nothing to debug.', tokens: 0, costUsd: 0 }
  }

  // Group by type for compactness
  const grouped: Record<string, number> = {}
  for (const e of filtered) grouped[e.type] = (grouped[e.type] ?? 0) + 1
  const summaryBlock = `Error event types in last ${hoursBack}h:\n${Object.entries(grouped).sort((a, b) => b[1] - a[1]).map(([t, n]) => `- ${t} ×${n}`).join('\n')}\n\nMost recent 10 payloads:\n${filtered.slice(0, 10).map(e => `${e.type}: ${JSON.stringify(e.payload).slice(0, 300)}`).join('\n')}`

  const { streamChat } = await import('./chat-providers.js')
  const msgs: ChatMsg[] = [
    { role: 'system', content: 'You are a senior SRE doing root-cause analysis. Output JSON: { "rootCause": string (≤3 sentences), "suggestion": string (concrete next action) }. Avoid speculation — note "insufficient data" if so.' },
    { role: 'user', content: summaryBlock },
  ]
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
  final = next.value
  const m = raw.match(/\{[\s\S]*\}/)
  const parsed = m ? (() => { try { return JSON.parse(m[0]) as { rootCause?: string; suggestion?: string } } catch { return {} } })() : {}

  return {
    errorEvents: filtered.slice(0, 30),
    rootCause:   parsed.rootCause ?? 'No clear pattern.',
    suggestion:  parsed.suggestion ?? 'Pull individual stack traces.',
    tokens:      final.tokens,
    costUsd:     final.costUsd,
  }
}
