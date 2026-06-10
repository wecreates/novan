/**
 * R612 — Task inbox: a queue where ANY caller (operator chat, cron tick,
 * R357 agent, external webhook, R193 self-dev) can drop a brief for Novan
 * to execute autonomously when capacity is available.
 *
 * Bridges the gap between "things to do" and "things being done." Before
 * R612, Novan only acted on direct chat requests or hardcoded crons.
 * After R612: drop a brief → brain workers pull it → route by type →
 * complete or fail with structured result.
 *
 * Brief types (kind) — handlers can be added without schema change:
 *
 *   image       → R609 free image generation (FLUX/Pollinations)
 *   music       → R600 ACE-Step / R610 OpenAI TTS / R599 OmniVoice
 *   video       → R600 LTX-2 video generation
 *   chat_summary→ summarize last N events for a workspace
 *   kg_ingest   → parse text + extract entities into R601 KG
 *   custom      → invoke an arbitrary brain op (params include {op, opParams})
 *
 * Workers (cron tick R612.tick) claim with SKIP LOCKED so multiple
 * pollers don't double-process. Default poll cadence 30s. Concurrent
 * worker count bounded by R602's autobrowser pool (no extra cap needed —
 * heavy ops use the pool's lease). DISABLE_INBOX=1 kills the dispatcher.
 *
 * Surfaces in R603 neural dashboard via inbox.stats counters.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS novan_inbox (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      business_id   TEXT,
      kind          TEXT NOT NULL,
      brief         TEXT NOT NULL,
      params        JSONB NOT NULL DEFAULT '{}'::jsonb,
      priority      INT NOT NULL DEFAULT 50,
      status        TEXT NOT NULL DEFAULT 'pending',
      assigned_to   TEXT,
      result        JSONB,
      error         TEXT,
      attempts      INT NOT NULL DEFAULT 0,
      max_attempts  INT NOT NULL DEFAULT 3,
      created_at    BIGINT NOT NULL,
      started_at    BIGINT,
      completed_at  BIGINT,
      due_at        BIGINT,
      created_by    TEXT
    )
  `).catch(() => {})
  // Hot path index: claim next pending by priority + age
  await db.execute(sql`CREATE INDEX IF NOT EXISTS novan_inbox_pending_idx ON novan_inbox (workspace_id, priority DESC, created_at ASC) WHERE status = 'pending'`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS novan_inbox_status_idx ON novan_inbox (workspace_id, status, created_at DESC)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS novan_inbox_due_idx ON novan_inbox (due_at) WHERE due_at IS NOT NULL AND status = 'pending'`).catch(() => {})
}

const VALID_KINDS = new Set(['image', 'music', 'video', 'chat_summary', 'kg_ingest', 'custom'])

// ─── Public surface ──────────────────────────────────────────────────────────

export interface AddBriefInput {
  kind:         string
  brief:        string
  params?:      Record<string, unknown>
  priority?:    number       // higher = sooner; default 50
  businessId?:  string
  maxAttempts?: number
  dueAt?:       number       // ms epoch; if set, won't dispatch before
  createdBy?:   string       // free-form attribution
}

export interface InboxItem {
  id:           string
  workspaceId:  string
  businessId:   string | null
  kind:         string
  brief:        string
  params:       Record<string, unknown>
  priority:     number
  status:       'pending' | 'working' | 'done' | 'failed' | 'cancelled'
  assignedTo:   string | null
  result:       unknown
  error:        string | null
  attempts:     number
  maxAttempts:  number
  createdAt:    number
  startedAt:    number | null
  completedAt:  number | null
  dueAt:        number | null
  createdBy:    string | null
}

function rowToItem(r: any): InboxItem {
  return {
    id: r.id, workspaceId: r.workspace_id, businessId: r.business_id ?? null,
    kind: r.kind, brief: r.brief,
    params: (r.params && typeof r.params === 'object') ? r.params : {},
    priority: Number(r.priority), status: r.status,
    assignedTo: r.assigned_to ?? null, result: r.result ?? null, error: r.error ?? null,
    attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts),
    createdAt: Number(r.created_at),
    startedAt: r.started_at == null ? null : Number(r.started_at),
    completedAt: r.completed_at == null ? null : Number(r.completed_at),
    dueAt: r.due_at == null ? null : Number(r.due_at),
    createdBy: r.created_by ?? null,
  }
}

export async function add(workspaceId: string, input: AddBriefInput): Promise<{ id: string }> {
  await ensureTable()
  if (!VALID_KINDS.has(input.kind)) throw new Error(`unknown kind: ${input.kind} (allowed: ${[...VALID_KINDS].join(', ')})`)
  if (!input.brief?.trim()) throw new Error('brief required')
  const id = uuidv7()
  await db.execute(sql`
    INSERT INTO novan_inbox (id, workspace_id, business_id, kind, brief, params, priority, max_attempts, created_at, due_at, created_by)
    VALUES (${id}, ${workspaceId}, ${input.businessId ?? null}, ${input.kind}, ${input.brief.slice(0, 8000)},
            ${JSON.stringify(input.params ?? {})}::jsonb, ${input.priority ?? 50},
            ${input.maxAttempts ?? 3}, ${Date.now()},
            ${input.dueAt ?? null}, ${input.createdBy ?? null})
  `).catch(() => {})
  return { id }
}

export async function list(workspaceId: string, opts: { status?: string; kind?: string; limit?: number } = {}): Promise<InboxItem[]> {
  await ensureTable()
  const lim = Math.min(opts.limit ?? 50, 500)
  const rows = opts.status && opts.kind
    ? await db.execute(sql`SELECT * FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = ${opts.status} AND kind = ${opts.kind} ORDER BY priority DESC, created_at DESC LIMIT ${lim}`)
    : opts.status
    ? await db.execute(sql`SELECT * FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = ${opts.status} ORDER BY priority DESC, created_at DESC LIMIT ${lim}`)
    : opts.kind
    ? await db.execute(sql`SELECT * FROM novan_inbox WHERE workspace_id = ${workspaceId} AND kind = ${opts.kind} ORDER BY priority DESC, created_at DESC LIMIT ${lim}`)
    : await db.execute(sql`SELECT * FROM novan_inbox WHERE workspace_id = ${workspaceId} ORDER BY priority DESC, created_at DESC LIMIT ${lim}`)
  return (rows as any[]).map(rowToItem)
}

export async function cancel(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await ensureTable()
  const r = await db.execute(sql`
    UPDATE novan_inbox SET status = 'cancelled', completed_at = ${Date.now()}
    WHERE workspace_id = ${workspaceId} AND id = ${id} AND status = 'pending'
    RETURNING id
  `).catch(() => [] as unknown[])
  return { ok: (r as Array<{ id: string }>).length > 0 }
}

export async function stats(workspaceId: string): Promise<{ pending: number; working: number; done24h: number; failed24h: number; byKind: Record<string, number>; oldestPendingAgeMin: number | null }> {
  await ensureTable()
  const since24 = Date.now() - 24 * 60 * 60_000
  const [p, w, d, f, k, o] = await Promise.all([
    db.execute(sql`SELECT COUNT(*)::int AS n FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = 'pending'`).catch(() => [{ n: 0 }] as unknown[]),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = 'working'`).catch(() => [{ n: 0 }] as unknown[]),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = 'done' AND completed_at >= ${since24}`).catch(() => [{ n: 0 }] as unknown[]),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = 'failed' AND completed_at >= ${since24}`).catch(() => [{ n: 0 }] as unknown[]),
    db.execute(sql`SELECT kind, COUNT(*)::int AS n FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = 'pending' GROUP BY kind`).catch(() => [] as unknown[]),
    db.execute(sql`SELECT MIN(created_at) AS oldest FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = 'pending'`).catch(() => [{ oldest: null }] as unknown[]),
  ])
  const byKind: Record<string, number> = {}
  for (const row of k as Array<{ kind: string; n: number }>) byKind[row.kind] = Number(row.n)
  const oldest = (o as Array<{ oldest: number | null }>)[0]?.oldest
  return {
    pending: Number((p as Array<{ n: number }>)[0]?.n ?? 0),
    working: Number((w as Array<{ n: number }>)[0]?.n ?? 0),
    done24h: Number((d as Array<{ n: number }>)[0]?.n ?? 0),
    failed24h: Number((f as Array<{ n: number }>)[0]?.n ?? 0),
    byKind,
    oldestPendingAgeMin: oldest == null ? null : Math.round((Date.now() - Number(oldest)) / 60_000),
  }
}

// ─── Worker dispatch (cron tick) ────────────────────────────────────────────

/** Claim the next pending item atomically. SKIP LOCKED prevents two
 *  pollers from grabbing the same row in concurrent runs. */
async function claimNext(workspaceId: string, workerId: string): Promise<InboxItem | null> {
  await ensureTable()
  const r = await db.execute(sql`
    UPDATE novan_inbox SET status = 'working', assigned_to = ${workerId},
                          attempts = attempts + 1, started_at = ${Date.now()}
    WHERE id = (
      SELECT id FROM novan_inbox
      WHERE workspace_id = ${workspaceId} AND status = 'pending'
            AND (due_at IS NULL OR due_at <= ${Date.now()})
      ORDER BY priority DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `).catch(() => [] as unknown[])
  const row = (r as any[])[0]
  return row ? rowToItem(row) : null
}

async function settle(id: string, ok: boolean, payload: { result?: unknown; error?: string }): Promise<void> {
  const now = Date.now()
  if (ok) {
    await db.execute(sql`
      UPDATE novan_inbox SET status = 'done', result = ${JSON.stringify(payload.result ?? null)}::jsonb, completed_at = ${now}
      WHERE id = ${id}
    `).catch(() => {})
  } else {
    // Re-queue if we still have attempts left, else mark failed.
    const r = await db.execute(sql`
      SELECT attempts, max_attempts FROM novan_inbox WHERE id = ${id} LIMIT 1
    `).catch(() => [] as unknown[])
    const row = (r as Array<{ attempts: number; max_attempts: number }>)[0]
    const shouldRetry = row && Number(row.attempts) < Number(row.max_attempts)
    if (shouldRetry) {
      await db.execute(sql`UPDATE novan_inbox SET status = 'pending', assigned_to = NULL, error = ${payload.error ?? ''} WHERE id = ${id}`).catch(() => {})
    } else {
      await db.execute(sql`UPDATE novan_inbox SET status = 'failed', error = ${payload.error ?? 'unknown'}, completed_at = ${now} WHERE id = ${id}`).catch(() => {})
    }
  }
}

/** Brief-kind → handler. Each handler returns whatever it produced; the
 *  inbox stores it in result JSONB. Handlers throw on failure. */
const HANDLERS: Record<string, (workspaceId: string, item: InboxItem) => Promise<unknown>> = {
  image: async (ws, item) => {
    const { generateFreeImage } = await import('./r609-free-image-gen.js')
    const p = item.params as Record<string, unknown>
    const out = await generateFreeImage({
      prompt: item.brief,
      width:  typeof p['width']  === 'number' ? p['width']  : 1024,
      height: typeof p['height'] === 'number' ? p['height'] : 1024,
      ...(p['model'] ? { model: p['model'] as 'flux_schnell' | 'flux_dev' | 'sdxl' | 'sd3_medium' } : {}),
      ...(typeof p['seed'] === 'number' ? { seed: p['seed'] } : {}),
    }, ws)
    if (!out.ok) throw new Error(out.error ?? 'image gen failed')
    // Don't store full base64 in result (too large) — store metadata + first 256 chars as preview hash
    return { ok: true, provider: out.provider, model: out.model, bytes: out.bytes, mime: out.mime, durationMs: out.durationMs, b64Preview: (out.imageBase64 ?? '').slice(0, 64) + '...' }
  },
  music: async (ws, item) => {
    const { replicateSong } = await import('./music-studio.js')
    const p = item.params as Record<string, unknown>
    if (!p['url']) throw new Error('music kind requires params.url (song to replicate)')
    return replicateSong({ url: String(p['url']), instructions: item.brief, workspaceId: ws })
  },
  video: async (ws, item) => {
    const { ltxText2Video } = await import('./r600-ltx2-video.js')
    const p = item.params as Record<string, unknown>
    return ltxText2Video({
      prompt: item.brief,
      ...(typeof p['durationSec'] === 'number' ? { durationSec: p['durationSec'] } : {}),
      ...(typeof p['fps']         === 'number' ? { fps:         p['fps'] }         : {}),
    }, ws)
  },
  chat_summary: async (ws, item) => {
    const since = Date.now() - 24 * 60 * 60_000
    const r = await db.execute(sql`SELECT type, COUNT(*)::int AS n FROM events WHERE workspace_id = ${ws} AND created_at >= ${since} GROUP BY type ORDER BY n DESC LIMIT 20`).catch(() => [] as unknown[])
    return { brief: item.brief, last24hEventTypes: (r as Array<{ type: string; n: number }>).map(x => ({ type: x.type, n: Number(x.n) })) }
  },
  kg_ingest: async (ws, item) => {
    const { ingestText } = await import('./r601-knowledge-graph.js')
    const p = item.params as Record<string, unknown>
    const name = (p['name'] as string) || `inbox/${item.id.slice(0, 8)}`
    return ingestText(ws, { name, body: item.brief, type: 'note', source: 'inbox' })
  },
  custom: async (ws, item) => {
    const p = item.params as { op?: string; opParams?: Record<string, unknown> }
    if (!p.op) throw new Error('custom kind requires params.op (brain op name)')
    const { OPERATIONS } = await import('./brain-task.js') as { OPERATIONS: Record<string, { handler: (ws: string, params: Record<string, unknown>) => Promise<unknown> }> }
    const spec = OPERATIONS[p.op]
    if (!spec) throw new Error(`unknown op: ${p.op}`)
    return spec.handler(ws, p.opParams ?? {})
  },
}

/** Cron-friendly: pull up to N items from the inbox and run them. */
export async function tickWorkspace(workspaceId: string, maxItems = 5): Promise<{ processed: number; ok: number; failed: number }> {
  if (process.env['DISABLE_INBOX'] === '1') return { processed: 0, ok: 0, failed: 0 }
  const workerId = `inbox-${Math.random().toString(36).slice(2, 8)}`
  let ok = 0, failed = 0, processed = 0
  for (let i = 0; i < maxItems; i++) {
    const item = await claimNext(workspaceId, workerId)
    if (!item) break
    processed++
    const handler = HANDLERS[item.kind]
    if (!handler) {
      await settle(item.id, false, { error: `no handler for kind: ${item.kind}` })
      failed++
      continue
    }
    try {
      const result = await Promise.race([
        handler(workspaceId, item),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`handler timeout 5min for ${item.kind}`)), 5 * 60_000)),
      ])
      await settle(item.id, true, { result })
      ok++
    } catch (e) {
      await settle(item.id, false, { error: (e as Error).message.slice(0, 500) })
      failed++
    }
  }
  return { processed, ok, failed }
}

/** Iterate every workspace once per tick. */
export async function tickAll(): Promise<{ workspaces: number; processed: number; ok: number; failed: number }> {
  if (process.env['DISABLE_INBOX'] === '1') return { workspaces: 0, processed: 0, ok: 0, failed: 0 }
  await ensureTable()
  const r = await db.execute(sql`SELECT id FROM workspaces`).catch(() => [] as unknown[])
  const ids = (r as Array<{ id: string }>).map(x => x.id)
  let processed = 0, ok = 0, failed = 0
  for (const id of ids) {
    const out = await tickWorkspace(id, 5).catch(() => ({ processed: 0, ok: 0, failed: 0 }))
    processed += out.processed; ok += out.ok; failed += out.failed
  }
  return { workspaces: ids.length, processed, ok, failed }
}

export const VALID_KINDS_LIST = [...VALID_KINDS]
