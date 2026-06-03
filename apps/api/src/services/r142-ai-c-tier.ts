/**
 * R146.142 — C-tier AI features 16-20.
 *
 * Honest scope:
 *   #16 streaming transform — wrapper around streamChat; useful when caller
 *       wants to censor/translate/highlight deltas in flight
 *   #17 cost prediction — token-count via simple char/4 estimate then price
 *       via published rates; not perfectly accurate but order-of-magnitude
 *   #18 interruption — AbortController plumbing already exists; this op
 *       exposes a session-keyed cancellation
 *   #19 fine-tune integration — submit job to OpenAI, store external id;
 *       polling happens via separate cron (not implemented in this round)
 *   #20 batch API — submit/check Anthropic + OpenAI batch endpoints
 */
import { db } from '../db/client.js'
import { finetuneJobs, batchJobs } from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #16 — Streaming output transformation ───────────────────────────

export type DeltaTransform = (delta: string) => string

/**
 * Wraps streamChat and applies a transform per delta. Caller passes a
 * transform name; runtime resolves to a known transform (uppercase /
 * censor / strip-html / token-count).
 */
export async function transformingStream(workspaceId: string, opts: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  transform: 'uppercase' | 'lowercase' | 'censor_pii' | 'strip_html'
}): Promise<{ text: string; deltaCount: number }> {
  const { streamChat } = await import('./chat-providers.js')
  const transformFn: DeltaTransform =
    opts.transform === 'uppercase' ? (s) => s.toUpperCase() :
    opts.transform === 'lowercase' ? (s) => s.toLowerCase() :
    opts.transform === 'strip_html' ? (s) => s.replace(/<[^>]+>/g, '') :
    /* censor_pii */                  (s) => s
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '<SSN>')
      .replace(/\b\d{16}\b/g, '<CARD>')
      .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, '<EMAIL>')
      .replace(/\b\+?\d{1,2}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '<PHONE>')
  const gen = streamChat(workspaceId, opts.messages, { taskType: 'other' } as Parameters<typeof streamChat>[2])
  let text = ''
  let deltaCount = 0
  for await (const ch of gen) {
    text += transformFn(ch.delta)
    deltaCount++
  }
  return { text, deltaCount }
}

// ─── #17 — Token + cost prediction ───────────────────────────────────

// Approximate published rates (USD per 1M tokens, in/out) as of 2026-06.
const RATES: Record<string, { inPer1M: number; outPer1M: number }> = {
  'claude-opus-4-1':       { inPer1M: 15,    outPer1M: 75 },
  'claude-sonnet-4-5':     { inPer1M: 3,     outPer1M: 15 },
  'claude-haiku-4-5':      { inPer1M: 0.25,  outPer1M: 1.25 },
  'gpt-5':                  { inPer1M: 8,     outPer1M: 24 },
  'gpt-5-mini':             { inPer1M: 0.6,   outPer1M: 2.4 },
  'gemini-2-5-pro':        { inPer1M: 3.5,   outPer1M: 10.5 },
  'gemini-2-5-flash':      { inPer1M: 0.3,   outPer1M: 1.2 },
}

export function predictCost(opts: {
  messages: Array<{ role: string; content: string }>
  expectedOutputChars?: number
  model?: string
}): { promptTokensEst: number; outputTokensEst: number; costUsdEst: number; modelUsed: string } {
  // Cheap char-based token estimate: ~3.5 chars per token for English-mixed
  const promptChars = opts.messages.reduce((s, m) => s + m.content.length, 0)
  const promptTokensEst = Math.ceil(promptChars / 3.5)
  const outputTokensEst = Math.ceil((opts.expectedOutputChars ?? 800) / 3.5)
  const model = opts.model ?? 'claude-sonnet-4-5'
  const rate = RATES[model] ?? RATES['claude-sonnet-4-5']!
  const costUsdEst = (promptTokensEst / 1_000_000) * rate.inPer1M + (outputTokensEst / 1_000_000) * rate.outPer1M
  return { promptTokensEst, outputTokensEst, costUsdEst, modelUsed: model }
}

// ─── #18 — Real-time interruption ────────────────────────────────────

const INFLIGHT = new Map<string, AbortController>()

export function startInterruptibleSession(): { sessionId: string; signal: AbortSignal } {
  const sessionId = uuidv7()
  const ac = new AbortController()
  INFLIGHT.set(sessionId, ac)
  // Auto-cleanup after 5 min
  setTimeout(() => INFLIGHT.delete(sessionId), 5 * 60_000).unref?.()
  return { sessionId, signal: ac.signal }
}

export function interrupt(sessionId: string): { ok: boolean } {
  const ac = INFLIGHT.get(sessionId)
  if (!ac) return { ok: false }
  ac.abort()
  INFLIGHT.delete(sessionId)
  return { ok: true }
}

export function inflightCount(): number { return INFLIGHT.size }

// ─── #19 — Fine-tune integration ─────────────────────────────────────

/**
 * Submit a fine-tune job. OpenAI path uses /v1/files + /v1/fine_tuning/jobs.
 * Anthropic doesn't expose public fine-tuning as of 2026-06; that branch
 * returns "not supported".
 */
export async function finetuneSubmit(workspaceId: string, opts: {
  provider: 'openai' | 'anthropic'
  baseModel: string
  datasetPath: string                          // local path to .jsonl
}): Promise<{ id: string; externalJobId?: string; status: string; error?: string }> {
  const id = uuidv7()
  const now = Date.now()
  if (opts.provider === 'anthropic') {
    await db.insert(finetuneJobs).values({
      id, workspaceId, provider: 'anthropic',
      baseModel: opts.baseModel, datasetPath: opts.datasetPath,
      status: 'unsupported',
      createdAt: now, updatedAt: now,
    })
    return { id, status: 'unsupported', error: 'Anthropic does not expose public fine-tuning' }
  }
  // OpenAI: upload file then create fine-tuning job
  const key = process.env['OPENAI_API_KEY']
  if (!key) {
    await db.insert(finetuneJobs).values({
      id, workspaceId, provider: 'openai', baseModel: opts.baseModel, datasetPath: opts.datasetPath,
      status: 'no_key', createdAt: now, updatedAt: now,
    })
    return { id, status: 'no_key', error: 'OPENAI_API_KEY not configured' }
  }
  try {
    const fs = await import('node:fs/promises')
    const fileBuf = await fs.readFile(opts.datasetPath)
    const fileForm = new FormData()
    fileForm.append('purpose', 'fine-tune')
    fileForm.append('file', new Blob([fileBuf]), 'data.jsonl')
    const upR = await fetch('https://api.openai.com/v1/files', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fileForm })
    if (!upR.ok) throw new Error(`upload ${upR.status}`)
    const upJ = await upR.json() as { id: string }
    const jobR = await fetch('https://api.openai.com/v1/fine_tuning/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ training_file: upJ.id, model: opts.baseModel }),
    })
    if (!jobR.ok) throw new Error(`job ${jobR.status}`)
    const jobJ = await jobR.json() as { id: string; status: string }
    await db.insert(finetuneJobs).values({
      id, workspaceId, provider: 'openai',
      baseModel: opts.baseModel, datasetPath: opts.datasetPath,
      externalJobId: jobJ.id, status: jobJ.status,
      createdAt: now, updatedAt: now,
    })
    return { id, externalJobId: jobJ.id, status: jobJ.status }
  } catch (e) {
    await db.insert(finetuneJobs).values({
      id, workspaceId, provider: 'openai',
      baseModel: opts.baseModel, datasetPath: opts.datasetPath,
      status: 'failed', createdAt: now, updatedAt: now,
    })
    return { id, status: 'failed', error: (e as Error).message.slice(0, 300) }
  }
}

export async function finetuneList(workspaceId: string, limit = 30): Promise<Array<typeof finetuneJobs.$inferSelect>> {
  return db.select().from(finetuneJobs).where(eq(finetuneJobs.workspaceId, workspaceId))
    .orderBy(desc(finetuneJobs.createdAt)).limit(Math.min(limit, 100))
}

// ─── #20 — Batch API integration ─────────────────────────────────────

/**
 * Submit a batch of requests to provider's batch endpoint.
 *   Anthropic: /v1/messages/batches (50% off list price, 24h SLA)
 *   OpenAI:    /v1/batches (50% off, 24h SLA)
 *
 * Skeleton: persists the job record + external id. Result-fetching/
 * splitting is future work.
 */
export async function batchSubmit(workspaceId: string, opts: {
  provider: 'anthropic' | 'openai'
  requests: Array<Record<string, unknown>>
}): Promise<{ id: string; externalBatchId?: string; status: string; error?: string }> {
  const id = uuidv7()
  const now = Date.now()
  const insertBase = {
    id, workspaceId, provider: opts.provider,
    requestCount: opts.requests.length, status: 'submitted' as string,
    createdAt: now, updatedAt: now,
  }
  if (opts.provider === 'anthropic') {
    const key = process.env['ANTHROPIC_API_KEY']
    if (!key) {
      await db.insert(batchJobs).values({ ...insertBase, status: 'no_key' })
      return { id, status: 'no_key', error: 'ANTHROPIC_API_KEY not configured' }
    }
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages/batches', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: opts.requests }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json() as { id: string; processing_status: string }
      await db.insert(batchJobs).values({ ...insertBase, externalBatchId: j.id, status: j.processing_status })
      return { id, externalBatchId: j.id, status: j.processing_status }
    } catch (e) {
      await db.insert(batchJobs).values({ ...insertBase, status: 'failed' })
      return { id, status: 'failed', error: (e as Error).message.slice(0, 300) }
    }
  }
  // OpenAI batch via /v1/batches requires file upload first; deferred to
  // future round. For now record and return.
  await db.insert(batchJobs).values({ ...insertBase, status: 'openai_pending_impl' })
  return { id, status: 'openai_pending_impl', error: 'OpenAI batch file-upload wiring is future work' }
}

export async function batchStatus(workspaceId: string, jobId: string): Promise<{ status: string; completedCount: number; externalBatchId: string | null }> {
  const [row] = await db.select().from(batchJobs).where(and(eq(batchJobs.workspaceId, workspaceId), eq(batchJobs.id, jobId))).limit(1)
  if (!row) return { status: 'not_found', completedCount: 0, externalBatchId: null }
  return { status: row.status, completedCount: row.completedCount, externalBatchId: row.externalBatchId }
}

export async function batchList(workspaceId: string, limit = 30): Promise<Array<typeof batchJobs.$inferSelect>> {
  return db.select().from(batchJobs).where(eq(batchJobs.workspaceId, workspaceId))
    .orderBy(desc(batchJobs.createdAt)).limit(Math.min(limit, 100))
}
