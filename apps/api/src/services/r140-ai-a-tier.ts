/**
 * R146.140 — A-tier AI features 6-10.
 */
import { db } from '../db/client.js'
import { inferenceCache, promptTemplatesV2, aiUsage } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'crypto'

// ─── #6 — Local-first model serving (Ollama) ─────────────────────────

/**
 * Health-check the Ollama endpoint + list locally available models.
 * Used by the router to decide if Ollama is an option.
 */
export async function ollamaStatus(): Promise<{ available: boolean; models: string[]; url: string; error?: string }> {
  const url = process.env['OLLAMA_URL'] ?? ''
  if (!url) return { available: false, models: [], url: '<unset>', error: 'OLLAMA_URL not configured' }
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 5000)
    const r = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: ac.signal })
    clearTimeout(timer)
    if (!r.ok) return { available: false, models: [], url, error: `HTTP ${r.status}` }
    const j = await r.json() as { models?: Array<{ name: string }> }
    return { available: true, models: (j.models ?? []).map(m => m.name), url }
  } catch (e) {
    return { available: false, models: [], url, error: (e as Error).message.slice(0, 200) }
  }
}

// ─── #7 — Auto model routing by task type ────────────────────────────

const ROUTING_TABLE: Record<string, Array<{ provider: string; model: string; reason: string }>> = {
  chat:        [{ provider: 'anthropic', model: 'claude-sonnet-4-5', reason: 'balanced quality+cost' }],
  codegen:     [{ provider: 'anthropic', model: 'claude-opus-4-1',   reason: 'best at code' }],
  vision:     [{ provider: 'anthropic', model: 'claude-sonnet-4-5', reason: 'vision-capable + cheap' }],
  embedding:  [{ provider: 'ollama',    model: 'nomic-embed-text',   reason: 'local + free' },
               { provider: 'gemini',    model: 'text-embedding-004', reason: 'free tier' },
               { provider: 'openai',    model: 'text-embedding-3-small', reason: 'fallback' }],
  'image-gen': [{ provider: 'replicate', model: 'flux-schnell',      reason: 'cheap + fast' }],
  other:      [{ provider: 'anthropic', model: 'claude-haiku-4-5',  reason: 'cheapest reasoning' }],
}

export function routeForTask(taskType: string): { provider: string; model: string; reason: string } {
  const candidates = ROUTING_TABLE[taskType] ?? ROUTING_TABLE['other'] ?? []
  return candidates[0] ?? { provider: 'anthropic', model: 'claude-sonnet-4-5', reason: 'default' }
}

export function routingTable(): typeof ROUTING_TABLE { return ROUTING_TABLE }

// ─── #8 — Semantic inference cache ───────────────────────────────────

const CACHE_SIMILARITY_THRESHOLD = 0.95

function hashPrompt(messages: Array<{ role: string; content: string }>): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 32)
}

export async function cacheLookup(workspaceId: string, opts: {
  messages: Array<{ role: string; content: string }>
  taskType: string
}): Promise<{ hit: boolean; response?: string; cacheId?: string }> {
  const promptHash = hashPrompt(opts.messages)
  // Exact match first
  const [exact] = await db.select().from(inferenceCache)
    .where(and(eq(inferenceCache.workspaceId, workspaceId), eq(inferenceCache.promptHash, promptHash)))
    .limit(1)
  if (exact) {
    db.update(inferenceCache).set({ hitCount: sql`${inferenceCache.hitCount} + 1`, lastHitAt: Date.now() })
      .where(eq(inferenceCache.id, exact.id)).catch(() => null)
    return { hit: true, response: exact.response, cacheId: exact.id }
  }
  // Semantic match: embed last user message + cosine search
  const lastUser = [...opts.messages].reverse().find(m => m.role === 'user')
  if (!lastUser) return { hit: false }
  try {
    const { embed } = await import('./embeddings.js')
    const queryVec = await embed(lastUser.content.slice(0, 2000))
    if (!queryVec) return { hit: false }
    const rows = await db.execute(sql`
      SELECT id, response, 1 - (prompt_embedding <=> ${sql.raw(`'[${queryVec.join(',')}]'::vector`)}) AS sim
      FROM inference_cache
      WHERE workspace_id = ${workspaceId} AND prompt_embedding IS NOT NULL AND task_type = ${opts.taskType}
      ORDER BY prompt_embedding <=> ${sql.raw(`'[${queryVec.join(',')}]'::vector`)}
      LIMIT 1
    `) as unknown as Array<{ id: string; response: string; sim: number }>
    if (rows[0] && rows[0].sim >= CACHE_SIMILARITY_THRESHOLD) {
      db.update(inferenceCache).set({ hitCount: sql`${inferenceCache.hitCount} + 1`, lastHitAt: Date.now() })
        .where(eq(inferenceCache.id, rows[0].id)).catch(() => null)
      return { hit: true, response: rows[0].response, cacheId: rows[0].id }
    }
  } catch { /* embed unavailable */ }
  return { hit: false }
}

export async function cacheStore(workspaceId: string, opts: {
  messages: Array<{ role: string; content: string }>
  response: string
  taskType: string
  provider: string
}): Promise<{ id: string }> {
  const promptHash = hashPrompt(opts.messages)
  const lastUser = [...opts.messages].reverse().find(m => m.role === 'user')
  let embedding: number[] | null = null
  if (lastUser) {
    try {
      const { embed } = await import('./embeddings.js')
      embedding = await embed(lastUser.content.slice(0, 2000))
    } catch { /* no-op */ }
  }
  const id = uuidv7()
  await db.insert(inferenceCache).values({
    id, workspaceId, promptHash,
    promptEmbedding: embedding,
    response: opts.response.slice(0, 16000),
    taskType: opts.taskType,
    provider: opts.provider,
    createdAt: Date.now(),
  }).catch(() => null)
  return { id }
}

export async function cacheStats(workspaceId: string): Promise<{ total: number; totalHits: number; topHits: Array<{ id: string; hitCount: number; provider: string; taskType: string }> }> {
  const rows = await db.select().from(inferenceCache).where(eq(inferenceCache.workspaceId, workspaceId)).orderBy(desc(inferenceCache.hitCount)).limit(10)
  const totalRow = await db.select({ c: sql<number>`COUNT(*)::int`, h: sql<number>`SUM(hit_count)::int` }).from(inferenceCache).where(eq(inferenceCache.workspaceId, workspaceId))
  return {
    total: totalRow[0]?.c ?? 0,
    totalHits: totalRow[0]?.h ?? 0,
    topHits: rows.map(r => ({ id: r.id, hitCount: r.hitCount, provider: r.provider, taskType: r.taskType })),
  }
}

// ─── #9 — Prompt template library ────────────────────────────────────

export async function templateSave(workspaceId: string, opts: {
  name: string
  body: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}): Promise<{ id: string; version: number }> {
  // Bump version + mark previous inactive
  const [last] = await db.select().from(promptTemplatesV2)
    .where(and(eq(promptTemplatesV2.workspaceId, workspaceId), eq(promptTemplatesV2.name, opts.name)))
    .orderBy(desc(promptTemplatesV2.version)).limit(1)
  const version = (last?.version ?? 0) + 1
  if (last) {
    await db.update(promptTemplatesV2).set({ active: false }).where(eq(promptTemplatesV2.id, last.id))
  }
  const id = uuidv7()
  await db.insert(promptTemplatesV2).values({
    id, workspaceId,
    name: opts.name.slice(0, 120),
    version,
    body: opts.body.slice(0, 20000),
    inputSchema: opts.inputSchema ?? {},
    outputSchema: opts.outputSchema ?? null,
    active: true,
    createdAt: Date.now(),
  })
  return { id, version }
}

export async function templateRender(workspaceId: string, opts: {
  name: string
  variables: Record<string, unknown>
}): Promise<{ body: string; version: number } | null> {
  const [row] = await db.select().from(promptTemplatesV2)
    .where(and(eq(promptTemplatesV2.workspaceId, workspaceId), eq(promptTemplatesV2.name, opts.name), eq(promptTemplatesV2.active, true)))
    .orderBy(desc(promptTemplatesV2.version)).limit(1)
  if (!row) return null
  // Simple {{var}} substitution
  let body = row.body
  for (const [k, v] of Object.entries(opts.variables)) {
    body = body.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), String(v))
  }
  return { body, version: row.version }
}

export async function templateList(workspaceId: string, opts: { activeOnly?: boolean } = {}): Promise<Array<typeof promptTemplatesV2.$inferSelect>> {
  const where = opts.activeOnly
    ? and(eq(promptTemplatesV2.workspaceId, workspaceId), eq(promptTemplatesV2.active, true))
    : eq(promptTemplatesV2.workspaceId, workspaceId)
  return db.select().from(promptTemplatesV2).where(where).orderBy(promptTemplatesV2.name, desc(promptTemplatesV2.version)).limit(500)
}

// ─── #10 — LLM observability dashboard ───────────────────────────────

export async function llmObservability(workspaceId: string, opts: { windowHours?: number } = {}): Promise<{
  totals: { calls: number; tokens: number; costUsd: number; avgLatencyMs: number; errorRate: number }
  byProvider: Array<{ provider: string; calls: number; tokens: number; costUsd: number; avgLatencyMs: number }>
  byModel:    Array<{ model: string;    calls: number; tokens: number; costUsd: number; avgLatencyMs: number }>
  byTaskType: Array<{ taskType: string; calls: number; tokens: number; costUsd: number; avgLatencyMs: number }>
  byHour:     Array<{ hour: number; calls: number; costUsd: number }>
}> {
  const hours = Math.max(1, Math.min(opts.windowHours ?? 24, 24 * 30))
  const since = Date.now() - hours * 60 * 60_000
  const all = await db.select().from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
    .limit(50_000)

  const totals = {
    calls: all.length,
    tokens: all.reduce((s, r) => s + r.promptTokens + r.outputTokens, 0),
    costUsd: all.reduce((s, r) => s + r.costUsd, 0),
    avgLatencyMs: all.length > 0 ? all.reduce((s, r) => s + r.latencyMs, 0) / all.length : 0,
    errorRate: 0, // ai_usage doesn't record failures yet; future round wires
  }
  const groupBy = <K extends keyof typeof all[0]>(key: K): Array<{ [k: string]: unknown; calls: number; tokens: number; costUsd: number; avgLatencyMs: number }> => {
    const map = new Map<string, { calls: number; tokens: number; costUsd: number; latencySum: number }>()
    for (const r of all) {
      const k = String(r[key])
      const cur = map.get(k) ?? { calls: 0, tokens: 0, costUsd: 0, latencySum: 0 }
      cur.calls++; cur.tokens += r.promptTokens + r.outputTokens; cur.costUsd += r.costUsd; cur.latencySum += r.latencyMs
      map.set(k, cur)
    }
    return [...map.entries()]
      .map(([k, v]) => ({ [key]: k, calls: v.calls, tokens: v.tokens, costUsd: v.costUsd, avgLatencyMs: v.calls > 0 ? v.latencySum / v.calls : 0 }))
      .sort((a, b) => (b.costUsd as number) - (a.costUsd as number))
      .slice(0, 30)
  }
  const byHourMap = new Map<number, { calls: number; costUsd: number }>()
  for (const r of all) {
    const hour = Math.floor(r.timestamp / 3600_000) * 3600_000
    const cur = byHourMap.get(hour) ?? { calls: 0, costUsd: 0 }
    cur.calls++; cur.costUsd += r.costUsd
    byHourMap.set(hour, cur)
  }
  const byHour = [...byHourMap.entries()].map(([hour, v]) => ({ hour, calls: v.calls, costUsd: v.costUsd })).sort((a, b) => a.hour - b.hour)
  return {
    totals,
    byProvider: groupBy('provider') as Array<{ provider: string; calls: number; tokens: number; costUsd: number; avgLatencyMs: number }>,
    byModel:    groupBy('model')    as Array<{ model: string;    calls: number; tokens: number; costUsd: number; avgLatencyMs: number }>,
    byTaskType: groupBy('taskType') as Array<{ taskType: string; calls: number; tokens: number; costUsd: number; avgLatencyMs: number }>,
    byHour,
  }
}
