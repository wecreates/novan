/**
 * R146.145 — B-tier round 2 (features 31-35):
 * Mid-stream model swap, embedding cache, context window manager,
 * per-op model pin, adaptive sampling temperature.
 */
import { db } from '../db/client.js'
import { embeddingCache, opModelPins, adaptiveTemperatures } from '../db/schema.js'
import { and, eq, sql } from 'drizzle-orm'
import { createHash } from 'crypto'

// ─── #31 — Quantized local-model swap (advisory routing) ─────────────

/**
 * Heuristic: for a long task, the "easy tail" (after the model has
 * established structure) often only needs a small model to finish.
 * Caller asks if a swap is recommended for a given completion stage.
 *
 * Skeleton: returns recommendation based on tokens-so-far. True
 * mid-stream provider swap requires SSE re-routing infrastructure.
 */
export function midstreamSwapAdvice(opts: { tokensSoFar: number; totalEstimate: number }): { swap: boolean; from: string; to: string; reason: string } {
  const ratio = opts.tokensSoFar / Math.max(1, opts.totalEstimate)
  if (ratio < 0.4) return { swap: false, from: 'sonnet', to: 'sonnet', reason: 'early — keep main model' }
  return { swap: true, from: 'sonnet', to: 'haiku', reason: `${(ratio * 100).toFixed(0)}% complete; tail can run on cheaper model` }
}

// ─── #32 — Embedding cache ───────────────────────────────────────────

function hashText(text: string, provider: string): string {
  return createHash('sha256').update(`${provider}:${text}`).digest('hex').slice(0, 40)
}

export async function embedCached(text: string): Promise<{ embedding: number[] | null; cached: boolean }> {
  const { embed, configuredEmbedProvider } = await import('./embeddings.js')
  const provider = configuredEmbedProvider() ?? 'unknown'
  if (!provider || provider === 'unknown') {
    const v = await embed(text)
    return { embedding: v, cached: false }
  }
  const key = hashText(text.slice(0, 2000), provider)
  const [hit] = await db.select().from(embeddingCache).where(eq(embeddingCache.textHash, key)).limit(1)
  if (hit) {
    db.update(embeddingCache).set({ hitCount: sql`${embeddingCache.hitCount} + 1` }).where(eq(embeddingCache.textHash, key)).catch(() => null)
    return { embedding: hit.embedding as number[], cached: true }
  }
  const fresh = await embed(text)
  if (fresh) {
    await db.insert(embeddingCache).values({
      textHash: key, provider, embedding: fresh,
      createdAt: Date.now(),
    }).onConflictDoNothing().catch(() => null)
  }
  return { embedding: fresh, cached: false }
}

export async function embedCacheStats(): Promise<{ total: number; topProviders: Array<{ provider: string; count: number }> }> {
  const all = await db.select().from(embeddingCache).limit(100_000)
  const byProvider = new Map<string, number>()
  for (const r of all) byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + 1)
  return {
    total: all.length,
    topProviders: [...byProvider.entries()].map(([provider, count]) => ({ provider, count })).sort((a, b) => b.count - a.count).slice(0, 10),
  }
}

// ─── #33 — Context window manager ────────────────────────────────────

/**
 * Estimate token count of messages; if over budget, auto-summarize older
 * messages into a single summary block. Caller passes maxTokens budget.
 */
export async function contextWindowFit(workspaceId: string, opts: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  maxTokens: number
}): Promise<{ messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; summarized: number; estimatedTokens: number }> {
  const estimate = (msgs: typeof opts.messages): number => msgs.reduce((s, m) => s + Math.ceil(m.content.length / 3.5), 0)
  let current = estimate(opts.messages)
  if (current <= opts.maxTokens) return { messages: opts.messages, summarized: 0, estimatedTokens: current }
  // Keep system messages + last user/assistant turn; summarize the middle
  const sys = opts.messages.filter(m => m.role === 'system')
  const rest = opts.messages.filter(m => m.role !== 'system')
  if (rest.length <= 2) return { messages: opts.messages, summarized: 0, estimatedTokens: current }
  const keepTail = rest.slice(-2)
  const toSummarize = rest.slice(0, -2)
  let summary = ''
  try {
    const { streamChat } = await import('./chat-providers.js')
    const gen = streamChat(workspaceId, [
      { role: 'system', content: 'Summarize this conversation in 200 words or less, preserving key facts + decisions:' },
      { role: 'user',   content: toSummarize.map(m => `${m.role}: ${m.content.slice(0, 800)}`).join('\n').slice(0, 16000) },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    for await (const ch of gen) summary += ch.delta
  } catch { summary = '(summary unavailable; older turns truncated)' }
  const newMessages: typeof opts.messages = [...sys, { role: 'system' as const, content: `[CONTEXT SUMMARY of ${toSummarize.length} prior turns]\n${summary.slice(0, 4000)}` }, ...keepTail]
  current = estimate(newMessages)
  return { messages: newMessages, summarized: toSummarize.length, estimatedTokens: current }
}

// ─── #34 — Per-op model pin ──────────────────────────────────────────

export async function modelPinOp(workspaceId: string, opts: {
  opName: string
  provider: string
  model: string
}): Promise<{ ok: boolean }> {
  await db.insert(opModelPins).values({
    workspaceId, opName: opts.opName.slice(0, 120),
    provider: opts.provider.slice(0, 60), model: opts.model.slice(0, 120),
    pinnedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [opModelPins.workspaceId, opModelPins.opName],
    set: { provider: opts.provider, model: opts.model, pinnedAt: Date.now() },
  })
  return { ok: true }
}

export async function modelPinResolve(workspaceId: string, opName: string): Promise<{ provider: string; model: string } | null> {
  const [row] = await db.select().from(opModelPins)
    .where(and(eq(opModelPins.workspaceId, workspaceId), eq(opModelPins.opName, opName))).limit(1)
  return row ? { provider: row.provider, model: row.model } : null
}

export async function modelPinList(workspaceId: string): Promise<Array<typeof opModelPins.$inferSelect>> {
  return db.select().from(opModelPins).where(eq(opModelPins.workspaceId, workspaceId)).limit(500)
}

// ─── #35 — Adaptive sampling temperature ─────────────────────────────

/**
 * Record an outcome (score 0..1) for a task-type at a temperature.
 * Update running avg + adjust suggested temperature using a simple
 * climbing heuristic.
 */
export async function adaptiveTempRecord(workspaceId: string, opts: {
  taskType: string
  temperature: number
  score: number
}): Promise<{ newTemperature: number; samples: number; avgScore: number }> {
  const [existing] = await db.select().from(adaptiveTemperatures)
    .where(and(eq(adaptiveTemperatures.workspaceId, workspaceId), eq(adaptiveTemperatures.taskType, opts.taskType))).limit(1)
  const samples = (existing?.samples ?? 0) + 1
  const prevAvg = existing?.avgScore ?? 0
  const avgScore = prevAvg + (opts.score - prevAvg) / samples
  // Simple climbing: if new score > prev avg, nudge toward this temp;
  // else nudge away (toward 0.7 baseline)
  let newTemp = existing?.temperature ?? 0.7
  if (samples > 3) {
    if (opts.score > avgScore + 0.05) newTemp = newTemp + (opts.temperature - newTemp) * 0.2
    else if (opts.score < avgScore - 0.05) newTemp = newTemp + (0.7 - newTemp) * 0.1
    newTemp = Math.max(0, Math.min(newTemp, 1.5))
  }
  await db.insert(adaptiveTemperatures).values({
    workspaceId, taskType: opts.taskType,
    temperature: newTemp, samples, avgScore,
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [adaptiveTemperatures.workspaceId, adaptiveTemperatures.taskType],
    set: { temperature: newTemp, samples, avgScore, updatedAt: Date.now() },
  })
  return { newTemperature: newTemp, samples, avgScore }
}

export async function adaptiveTempGet(workspaceId: string, taskType: string): Promise<{ temperature: number; samples: number; avgScore: number }> {
  const [row] = await db.select().from(adaptiveTemperatures)
    .where(and(eq(adaptiveTemperatures.workspaceId, workspaceId), eq(adaptiveTemperatures.taskType, taskType))).limit(1)
  return row ? { temperature: row.temperature, samples: row.samples, avgScore: row.avgScore } : { temperature: 0.7, samples: 0, avgScore: 0 }
}
