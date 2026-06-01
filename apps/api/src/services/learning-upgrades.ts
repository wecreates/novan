/**
 * learning-upgrades.ts — R146.90 — 24/7 learning system gaps closed:
 *  ab prompt framework, lesson-durability tagging, deprecation,
 *  external ingestion (podcast/newsletter/youtube stubs),
 *  model-comparison harness.
 */
import { db } from '../db/client.js'
import { events, memories } from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── A/B prompt framework (variant assignment + outcome scoring) ───────────

export async function createPromptAbTest(input: { workspaceId: string; slot: string; variantA: string; variantB: string; trafficSplit?: number; notes?: string }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(events).values({
    id: uuidv7(), type: 'prompt_ab.created', workspaceId: input.workspaceId,
    payload: { id, slot: input.slot, variantA: input.variantA.slice(0, 2000), variantB: input.variantB.slice(0, 2000), trafficSplit: Math.max(0.1, Math.min(0.9, input.trafficSplit ?? 0.5)), notes: (input.notes ?? '').slice(0, 500), status: 'running', a: { uses: 0, score: 0 }, b: { uses: 0, score: 0 } },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'learning-upgrades', version: 1, createdAt: Date.now(),
  })
  return { id }
}

export async function pickPromptVariant(workspaceId: string, slot: string): Promise<{ variant: 'A' | 'B' | 'none'; testId?: string; body?: string }> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'prompt_ab.created')))
    .orderBy(desc(events.createdAt)).limit(20)
  const active = rows.map(r => r.payload as Record<string, unknown>).find(p => p['slot'] === slot && p['status'] === 'running')
  if (!active) return { variant: 'none' }
  const split = Number(active['trafficSplit'] ?? 0.5)
  // Deterministic by ms — close enough for solo-operator volume
  const variant: 'A' | 'B' = (Date.now() % 1000) / 1000 < split ? 'A' : 'B'
  return { variant, testId: active['id'] as string, body: (variant === 'A' ? active['variantA'] : active['variantB']) as string }
}

export async function recordPromptOutcome(input: { workspaceId: string; testId: string; variant: 'A' | 'B'; score: number }): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type: 'prompt_ab.outcome', workspaceId: input.workspaceId,
    payload: { testId: input.testId, variant: input.variant, score: Math.max(0, Math.min(1, input.score)) },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'learning-upgrades', version: 1, createdAt: Date.now(),
  })
}

export async function promptAbResults(workspaceId: string, testId: string): Promise<{ a: { n: number; mean: number }; b: { n: number; mean: number }; winner: 'A' | 'B' | 'tie' }> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'prompt_ab.outcome'),
               sql`payload->>'testId' = ${testId}`))
    .limit(2000)
  const aScores: number[] = [], bScores: number[] = []
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>
    if (p['variant'] === 'A') aScores.push(Number(p['score']))
    else if (p['variant'] === 'B') bScores.push(Number(p['score']))
  }
  const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
  const a = { n: aScores.length, mean: mean(aScores) }
  const b = { n: bScores.length, mean: mean(bScores) }
  const winner: 'A' | 'B' | 'tie' = Math.abs(a.mean - b.mean) < 0.02 ? 'tie' : a.mean > b.mean ? 'A' : 'B'
  return { a, b, winner }
}

// ─── Lesson durability tagging ─────────────────────────────────────────────

export async function tagLessonDurability(input: { workspaceId: string; memoryId: string; durability: 'evergreen' | 'long' | 'medium' | 'short' | 'time-sensitive'; reason?: string }): Promise<void> {
  const [mem] = await db.select().from(memories).where(eq(memories.id, input.memoryId)).limit(1)
  if (!mem) throw new Error(`memory ${input.memoryId} not found`)
  const existingTags = (mem.tags as string[] | null) ?? []
  const filteredTags = existingTags.filter(t => !t.startsWith('durability:'))
  const newTags = [...filteredTags, `durability:${input.durability}`, ...(input.reason ? [`durability-reason:${input.reason.slice(0, 80).replace(/\s+/g, '-')}`] : [])]
  await db.update(memories)
    .set({ tags: newTags, updatedAt: Date.now() })
    .where(eq(memories.id, input.memoryId))
}

export async function deprecateStaleLessons(workspaceId: string, opts: { olderThanDays?: number } = {}): Promise<{ deprecated: number }> {
  const cutoff = Date.now() - (opts.olderThanDays ?? 180) * 86_400_000
  const rows = await db.select().from(memories)
    .where(and(eq(memories.workspaceId, workspaceId), sql`updated_at < ${cutoff}`))
    .limit(500)
  let count = 0
  for (const r of rows) {
    const tags = (r.tags as string[] | null) ?? []
    if (tags.includes('durability:evergreen')) continue
    if (tags.includes('durability:long')) continue
    if (tags.includes('deprecated')) continue
    await db.update(memories)
      .set({ tags: [...tags, 'deprecated'], updatedAt: Date.now() })
      .where(eq(memories.id, r.id))
    count++
  }
  return { deprecated: count }
}

// ─── External knowledge ingestion (stub — runs against operator-configured feeds) ────

export async function ingestExternalKnowledge(input: { workspaceId: string; sourceType: 'podcast' | 'newsletter' | 'youtube' | 'blog'; sourceUrl: string; title?: string; summary?: string; tags?: string[] }): Promise<{ id: string }> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(memories).values({
    workspaceId: input.workspaceId,
    type: 'lesson' as const,
    content: input.summary?.slice(0, 4000) ?? '',
    summary: (input.summary ?? input.title ?? input.sourceUrl).slice(0, 300),
    confidence: 0.6,
    tags: ['external', input.sourceType, ...(input.tags ?? []).slice(0, 10)],
    source: `external-${input.sourceType}`,
    sourceRef: input.sourceUrl.slice(0, 500),
    createdAt: now, updatedAt: now,
  }).catch(() => null)
  await db.insert(events).values({
    id: uuidv7(), type: 'knowledge.ingested', workspaceId: input.workspaceId,
    payload: { id, sourceType: input.sourceType, sourceUrl: input.sourceUrl.slice(0, 300) },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'learning-upgrades', version: 1, createdAt: now,
  }).catch(() => null)
  return { id }
}

// ─── Model-comparison harness ───────────────────────────────────────────────

export async function compareModels(input: { workspaceId: string; taskType: string; prompt: string; models?: Array<{ env: string; family: 'openai' | 'anthropic' | 'gemini'; url: string; model: string }> }): Promise<{
  results: Array<{ provider: string; model: string; ok: boolean; latencyMs: number; tokensOut: number; text: string; error?: string }>
  recommendation: string
}> {
  const defaults = [
    { env: 'ANTHROPIC_API_KEY', family: 'anthropic' as const, url: 'https://api.anthropic.com/v1/messages',                                  model: 'claude-haiku-4-5' },
    { env: 'OPENAI_API_KEY',    family: 'openai' as const,    url: 'https://api.openai.com/v1/chat/completions',                              model: 'gpt-4o-mini' },
    { env: 'GROQ_API_KEY',      family: 'openai' as const,    url: 'https://api.groq.com/openai/v1/chat/completions',                          model: 'llama-3.1-8b-instant' },
    { env: 'GEMINI_API_KEY',    family: 'gemini' as const,    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', model: 'gemini-2.0-flash' },
  ]
  const candidates = input.models ?? defaults
  const results: Array<{ provider: string; model: string; ok: boolean; latencyMs: number; tokensOut: number; text: string; error?: string }> = []
  for (const c of candidates) {
    const key = process.env[c.env]
    if (!key) { results.push({ provider: c.env, model: c.model, ok: false, latencyMs: 0, tokensOut: 0, text: '', error: 'no key' }); continue }
    const t0 = Date.now()
    try {
      let text = ''
      if (c.family === 'anthropic') {
        const res = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: c.model, max_tokens: 200, temperature: 0, messages: [{ role: 'user', content: input.prompt.slice(0, 2000) }] }), signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json() as { content?: Array<{ text?: string }> }
        text = data.content?.[0]?.text ?? ''
      } else if (c.family === 'openai') {
        const res = await fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: c.model, temperature: 0, max_tokens: 200, messages: [{ role: 'user', content: input.prompt.slice(0, 2000) }] }), signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
        text = data.choices?.[0]?.message?.content ?? ''
      } else {
        const res = await fetch(`${c.url}?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: input.prompt.slice(0, 2000) }] }], generationConfig: { temperature: 0, maxOutputTokens: 200 } }), signal: AbortSignal.timeout(15_000) })
        if (!res.ok) throw new Error(`${res.status}`)
        const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      }
      results.push({ provider: c.env, model: c.model, ok: true, latencyMs: Date.now() - t0, tokensOut: Math.ceil(text.length / 4), text: text.slice(0, 800) })
    } catch (e) {
      results.push({ provider: c.env, model: c.model, ok: false, latencyMs: Date.now() - t0, tokensOut: 0, text: '', error: (e as Error).message })
    }
  }
  const ok = results.filter(r => r.ok)
  ok.sort((a, b) => a.latencyMs - b.latencyMs)
  const recommendation = ok.length === 0 ? 'no providers responded' : `For taskType=${input.taskType}: fastest=${ok[0]?.provider} (${ok[0]?.latencyMs}ms). Inspect text quality to confirm.`
  await db.insert(events).values({
    id: uuidv7(), type: 'model_comparison.run', workspaceId: input.workspaceId,
    payload: { taskType: input.taskType, results: results.map(r => ({ provider: r.provider, model: r.model, ok: r.ok, latencyMs: r.latencyMs, tokensOut: r.tokensOut, error: r.error })) },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'learning-upgrades', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  return { results, recommendation }
}
