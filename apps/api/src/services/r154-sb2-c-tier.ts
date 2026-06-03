/**
 * R146.154 — SB2 C-tier 16-20: sentiment timeline, devil's advocate,
 * advisor archetype, counter-factual exploration, concept lifecycle.
 */
import { db } from '../db/client.js'
import { memoryChunks, memoryTags, conceptMaturity, decisions } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'

const DAY_MS = 24 * 60 * 60_000

// ─── #16 — Sentiment timeline ────────────────────────────────────────

/**
 * For each day in the window, sample recent chunks + score sentiment
 * via LLM (0=negative, 0.5=neutral, 1=positive). Surface trend shifts.
 */
export async function sentimentTimeline(workspaceId: string, opts: { days?: number } = {}): Promise<{ timeline: Array<{ date: string; avgSentiment: number; sampleCount: number }>; trendShift: string | null }> {
  const days = Math.max(7, Math.min(opts.days ?? 14, 90))
  const since = Date.now() - days * DAY_MS
  const rows = await db.execute(sql`
    SELECT to_char(to_timestamp(created_at / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
           STRING_AGG(LEFT(content, 200), E'\n---\n') AS samples,
           COUNT(*)::int AS n
    FROM memory_chunks
    WHERE workspace_id = ${workspaceId} AND created_at >= ${since}
    GROUP BY date ORDER BY date
  `) as unknown as Array<{ date: string; samples: string; n: number }>
  const timeline: Array<{ date: string; avgSentiment: number; sampleCount: number }> = []
  let lastAvg = 0.5
  let trendShift: string | null = null
  for (const r of rows) {
    let avg = 0.5
    try {
      const { streamChat } = await import('./chat-providers.js')
      const sys = `Score the OVERALL emotional tone of these note samples on 0..1 (0=very negative, 0.5=neutral, 1=very positive). Return STRICT JSON: {"score":0..1}.`
      const gen = streamChat(workspaceId, [
        { role: 'system', content: sys },
        { role: 'user',   content: r.samples.slice(0, 6000) },
      ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
      let acc = ''
      for await (const ch of gen) acc += ch.delta
      const m = acc.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as { score?: number }
        if (typeof parsed.score === 'number') avg = Math.max(0, Math.min(parsed.score, 1))
      }
    } catch { /* leave 0.5 */ }
    timeline.push({ date: r.date, avgSentiment: avg, sampleCount: r.n })
    if (lastAvg !== 0.5 && Math.abs(avg - lastAvg) > 0.25) {
      trendShift = `${lastAvg < 0.5 ? 'down' : 'up'} → ${avg < 0.5 ? 'down' : 'up'} on ${r.date}`
    }
    lastAvg = avg
  }
  return { timeline, trendShift }
}

// ─── #17 — Devil's advocate ──────────────────────────────────────────

export async function devilsAdvocate(workspaceId: string, opts: { conclusion: string; n?: number }): Promise<{ counterArguments: Array<{ argument: string; strength: number }> }> {
  const n = Math.max(2, Math.min(opts.n ?? 4, 8))
  const counterArguments: Array<{ argument: string; strength: number }> = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `You are a relentless devil's advocate. Given a conclusion, produce ${n} STRONG counter-arguments. Each must be specific (not generic skepticism). Return STRICT JSON: {"counters":[{"argument":"...","strength":0..1}]}. Strength = how seriously the original believer should take it.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Conclusion: ${opts.conclusion.slice(0, 2000)}` },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { counters?: Array<{ argument: string; strength: number }> }
      for (const c of parsed.counters ?? []) {
        counterArguments.push({
          argument: c.argument.slice(0, 600),
          strength: Math.max(0, Math.min(c.strength, 1)),
        })
      }
    }
  } catch { /* empty */ }
  counterArguments.sort((a, b) => b.strength - a.strength)
  return { counterArguments }
}

// ─── #18 — Advisor archetype ─────────────────────────────────────────

const ARCHETYPES: Record<string, string> = {
  munger:   'You are Charlie Munger. Lean on mental models, inversion, multidisciplinary thinking. Be blunt. Quote Buffett or Franklin when apt. Avoid platitudes.',
  jobs:     'You are Steve Jobs. Focus on essence — what would I cut? Be uncompromising about quality. Reject feature creep.',
  bezos:    'You are Jeff Bezos. Demand metrics. Ask about input vs output metrics. Frame in two-pizza/Day-1 terms. Ask "why hasn\'t this been done."',
  drucker:  'You are Peter Drucker. Ask what business this really is. What does the customer pay for? Demand effectiveness over efficiency.',
  graham:   'You are Paul Graham. Push toward doing things that don\'t scale. Be skeptical of consensus. Ask what the founder is uniquely positioned to do.',
}

export async function advisorAsk(workspaceId: string, opts: { archetype: string; question: string }): Promise<{ archetype: string; response: string }> {
  const arche = opts.archetype.toLowerCase()
  const persona = ARCHETYPES[arche]
  if (!persona) throw new Error(`unknown archetype. Available: ${Object.keys(ARCHETYPES).join(', ')}`)
  let response = ''
  try {
    const { streamChat } = await import('./chat-providers.js')
    const gen = streamChat(workspaceId, [
      { role: 'system', content: persona + ' Respond in 150-300 words. First-person voice. End with a question they would ask.' },
      { role: 'user',   content: opts.question.slice(0, 4000) },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    for await (const ch of gen) response += ch.delta
  } catch (e) {
    response = `(advisor unavailable: ${(e as Error).message.slice(0, 100)})`
  }
  return { archetype: arche, response }
}

export function advisorList(): string[] { return Object.keys(ARCHETYPES) }

// ─── #19 — Counter-factual exploration ───────────────────────────────

export async function counterFactual(workspaceId: string, opts: { decisionId: string }): Promise<{ scenario: string; outcomes: Array<{ branch: string; description: string; likelihood: number }> }> {
  const [d] = await db.select().from(decisions)
    .where(and(eq(decisions.workspaceId, workspaceId), eq(decisions.id, opts.decisionId))).limit(1)
  if (!d) throw new Error('decision not found')
  let scenario = `Original: ${d.question}\nReasoning: ${d.reasoning}\nDecided: ${d.expectedOutcome ?? '(no recorded outcome)'}`
  const outcomes: Array<{ branch: string; description: string; likelihood: number }> = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Run a counter-factual. Given a decision + alternatives, simulate what would have happened if EACH alternative had been chosen instead. Return STRICT JSON: {"outcomes":[{"branch":"<alt label>","description":"<3 sentences>","likelihood":0..1}]}. Be specific; mention what would have happened in 30 days + 90 days.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Decision: ${d.question}\nReasoning: ${d.reasoning}\nAlternatives considered: ${(d.alternatives ?? []).join(', ')}\nActual outcome: ${d.actualOutcome ?? '(not yet reviewed)'}` },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { outcomes?: Array<{ branch: string; description: string; likelihood: number }> }
      for (const o of parsed.outcomes ?? []) {
        outcomes.push({
          branch: String(o.branch).slice(0, 120),
          description: String(o.description).slice(0, 1500),
          likelihood: Math.max(0, Math.min(o.likelihood, 1)),
        })
      }
    }
  } catch (e) {
    scenario += `\n\n(simulator unavailable: ${(e as Error).message.slice(0, 100)})`
  }
  return { scenario, outcomes }
}

// ─── #20 — Concept lifecycle viz data ────────────────────────────────

/**
 * For a concept, return a timeline of first appearance → growth → peak
 * → current. Sparkline data per concept.
 */
export async function conceptLifecycle(workspaceId: string, opts: { concept: string }): Promise<{ concept: string; firstSeen: number; peak: { date: string; count: number } | null; current: { count: number; maturity: string }; sparkline: Array<{ date: string; count: number }> }> {
  const [maturityRow] = await db.select().from(conceptMaturity)
    .where(and(eq(conceptMaturity.workspaceId, workspaceId), eq(conceptMaturity.concept, opts.concept.toLowerCase()))).limit(1)
  // Sparkline: mentions per week over last 26 weeks
  const since = Date.now() - 26 * 7 * DAY_MS
  const weekly = await db.execute(sql`
    SELECT to_char(date_trunc('week', to_timestamp(created_at / 1000) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
           COUNT(*)::int AS n
    FROM memory_tags
    WHERE workspace_id = ${workspaceId} AND tag = ${opts.concept.toLowerCase()} AND created_at >= ${since}
    GROUP BY date ORDER BY date
  `) as unknown as Array<{ date: string; n: number }>
  let peak: { date: string; count: number } | null = null
  for (const w of weekly) {
    if (!peak || w.n > peak.count) peak = { date: w.date, count: w.n }
  }
  return {
    concept: opts.concept,
    firstSeen: maturityRow?.firstSeenAt ?? 0,
    peak,
    current: {
      count: maturityRow?.referenceCount ?? 0,
      maturity: maturityRow?.maturity ?? 'fresh',
    },
    sparkline: weekly.map(w => ({ date: w.date, count: w.n })),
  }
}

// suppress unused
void memoryChunks; void memoryTags; void gte; void desc
