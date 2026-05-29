/**
 * self-observation.ts — Novan reviews its own behavior (#63).
 *
 * Pulls the platform's own audit log and answers four questions
 * the operator (and Novan itself) should know:
 *
 *   1. What did I do most? — top recurring action types
 *   2. Where did I refuse? — what kinds of actions I blocked
 *   3. Where did the operator override me? — corrections, rejections,
 *      dry-runs the operator cancelled or marked safer
 *   4. Where am I weakest? — recurring "unknown" intents, repeated
 *      misunderstandings, low-confidence routing
 *
 * Output is a SelfReport — bullets + recommendations. No grand claims,
 * no auto-modification. The platform never edits its own prompts or
 * routing rules from this report; it only surfaces honest signal.
 *
 * Pure aggregator + DB-backed wrapper. Tested with fixtures.
 */
import { db } from '../db/client.js'
import { events, voiceSkillObservations } from '../db/schema.js'
import { and, eq, gte, desc } from 'drizzle-orm'

export interface SelfReport {
  windowMs:               number
  totalEvents:            number
  topActions:             Array<{ type: string; count: number }>
  refusals:               Array<{ kind: string; count: number; sampleReason: string | null }>
  operatorOverrides:      Array<{ kind: string; count: number }>
  weaknesses:             Array<{ category: 'unknown_intent' | 'repeated_correction' | 'low_confidence'; signal: string; count: number }>
  recommendations:        Array<{ priority: 'low' | 'medium' | 'high'; text: string }>
  honesty:                { samples: number; confidence: number; insufficient: boolean }
}

interface EventRow { type: string; payload: unknown; createdAt: number }
interface SkillRow {
  kind: string; phrase: string | null; intentKind: string | null
  fromIntent: string | null; toIntent: string | null
  confidence: number | null; createdAt: number
}

const MIN_SAMPLES = 25

/** Pure: build a SelfReport from a pre-fetched event + skill slice. */
export function buildSelfReport(rows: ReadonlyArray<EventRow>, skills: ReadonlyArray<SkillRow>, windowMs: number): SelfReport {
  const total = rows.length
  // Top actions
  const typeCount = new Map<string, number>()
  for (const r of rows) typeCount.set(r.type, (typeCount.get(r.type) ?? 0) + 1)
  const topActions = [...typeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([type, count]) => ({ type, count }))

  // Refusals: events with a verdict==='reject' OR type matching block/reject
  const refusalCounts = new Map<string, { count: number; sampleReason: string | null }>()
  for (const r of rows) {
    const p = (r.payload ?? {}) as { plan?: { verdict?: string; reason?: string }; reason?: string; intent?: { kind?: string } }
    const isRefusal = p.plan?.verdict === 'reject'
                   || /(?:^|\.)(block|reject(ed)?|refused|hard_block)/.test(r.type)
    if (!isRefusal) continue
    const key = p.intent?.kind ?? r.type
    const e = refusalCounts.get(key) ?? { count: 0, sampleReason: null }
    e.count++
    if (!e.sampleReason) e.sampleReason = p.plan?.reason ?? p.reason ?? null
    refusalCounts.set(key, e)
  }
  const refusals = [...refusalCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10)
    .map(([kind, v]) => ({ kind, count: v.count, sampleReason: v.sampleReason }))

  // Operator overrides — corrections + never_mind from skill observations
  const overrideCounts = new Map<string, number>()
  for (const s of skills) {
    if (s.kind === 'corrected' && s.fromIntent) {
      overrideCounts.set(s.fromIntent, (overrideCounts.get(s.fromIntent) ?? 0) + 1)
    }
  }
  const operatorOverrides = [...overrideCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([kind, count]) => ({ kind, count }))

  // Weaknesses
  const weaknesses: SelfReport['weaknesses'] = []
  const unknownPhrases = new Map<string, number>()
  for (const s of skills) {
    if (s.kind === 'misunderstood' && s.phrase) {
      unknownPhrases.set(s.phrase, (unknownPhrases.get(s.phrase) ?? 0) + 1)
    }
  }
  for (const [phrase, count] of unknownPhrases) {
    if (count >= 2) weaknesses.push({ category: 'unknown_intent', signal: phrase, count })
  }
  for (const [kind, count] of overrideCounts) {
    if (count >= 3) weaknesses.push({ category: 'repeated_correction', signal: kind, count })
  }
  const lowConfCount = skills.filter(s => typeof s.confidence === 'number' && s.confidence < 0.5).length
  if (lowConfCount >= 5) weaknesses.push({ category: 'low_confidence', signal: 'intent-parser', count: lowConfCount })
  weaknesses.sort((a, b) => b.count - a.count)

  // Recommendations — only surface when there's enough signal to back them up
  const recommendations: SelfReport['recommendations'] = []
  for (const w of weaknesses.slice(0, 5)) {
    if (w.category === 'unknown_intent') {
      recommendations.push({ priority: 'medium', text: `Phrase "${w.signal}" wasn't understood ${w.count}× — consider adding a shortcut or intent pattern.` })
    } else if (w.category === 'repeated_correction') {
      recommendations.push({ priority: 'high', text: `Intent ${w.signal} was corrected ${w.count}× — the parser routes it wrong; review the regex.` })
    } else if (w.category === 'low_confidence') {
      recommendations.push({ priority: 'medium', text: `${w.count} recent intents fired below 0.50 confidence — clarification cadence may be too low.` })
    }
  }
  if (refusals.length > 5) {
    recommendations.push({ priority: 'low', text: `${refusals.length} distinct refusal categories in this window — review whether any of them deserve a smoother explanation.` })
  }

  // Honesty: when we don't have enough data, say so instead of guessing
  const honesty = {
    samples: total + skills.length,
    confidence: Math.min(1, (total + skills.length) / 100),
    insufficient: (total + skills.length) < MIN_SAMPLES,
  }
  if (honesty.insufficient) {
    recommendations.unshift({ priority: 'low', text: 'Not enough recent activity to draw strong conclusions — observations are tentative.' })
  }

  return {
    windowMs,
    totalEvents: total,
    topActions,
    refusals,
    operatorOverrides,
    weaknesses,
    recommendations,
    honesty,
  }
}

// ─── DB wrapper ───────────────────────────────────────────────────────

export async function observeSelf(workspaceId: string, opts: { windowMs?: number } = {}): Promise<SelfReport> {
  const windowMs = opts.windowMs ?? 7 * 86_400_000
  const since = Date.now() - windowMs
  const [eventRows, skillRows] = await Promise.all([
    db.select({ type: events.type, payload: events.payload, createdAt: events.createdAt })
      .from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since)))
      .orderBy(desc(events.createdAt))
      .limit(5000).catch(() => []),
    db.select({
      kind: voiceSkillObservations.kind, phrase: voiceSkillObservations.phrase,
      intentKind: voiceSkillObservations.intentKind,
      fromIntent: voiceSkillObservations.fromIntent, toIntent: voiceSkillObservations.toIntent,
      confidence: voiceSkillObservations.confidence,
      createdAt: voiceSkillObservations.createdAt,
    }).from(voiceSkillObservations)
      .where(and(eq(voiceSkillObservations.workspaceId, workspaceId), gte(voiceSkillObservations.createdAt, since)))
      .orderBy(desc(voiceSkillObservations.createdAt))
      .limit(2000).catch(() => []),
  ])
  return buildSelfReport(eventRows, skillRows, windowMs)
}
