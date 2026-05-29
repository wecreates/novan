/**
 * narrative-intelligence.ts — plain-English summaries of what happened (#48).
 *
 * Operators don't want to read 200 raw event rows to understand what
 * Novan did in the last hour. This module composes calm, structured
 * narratives over the existing audit log.
 *
 * Pure shape:
 *   buildNarrative(events, opts) → Narrative
 *     {
 *       headline:   one-sentence summary
 *       paragraphs: 2-4 short sections (what / why / outcome / next)
 *       bullets:    structured facts (counts, top actors, risks)
 *       confidence: 0..1 — how complete the picture is
 *     }
 *
 * The writer follows the operational philosophy:
 *   - short over long
 *   - calm over alarmist
 *   - facts over opinion
 *   - "I don't know" over hallucinated narrative
 *
 * No LLM round-trips. Deterministic template assembly so the narrative
 * is replayable + auditable. If the platform later wires an LLM
 * polisher, this module's output is the structured input.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, eq, gte } from 'drizzle-orm'
import { classifyRole, summarizeEvent, type WhyRole } from './voice-why-chain.js'

export interface NarrativeBullet { label: string; value: string }

export interface Narrative {
  headline:    string
  paragraphs:  Array<{ heading: string; body: string }>
  bullets:     NarrativeBullet[]
  confidence:  number     // 0..1
  windowMs:    number
  eventCount:  number
}

interface EventLike {
  type:      string
  payload:   unknown
  createdAt: number
}

// ─── Pure narrative composer ────────────────────────────────────────────

const ROLE_PRIORITY: WhyRole[] = ['safety', 'budget', 'approval', 'execution', 'intent', 'context']

/** Pure: build a Narrative from a slice of events. */
export function buildNarrative(rows: ReadonlyArray<EventLike>, opts: { windowMs: number; topic?: string } = { windowMs: 60 * 60_000 }): Narrative {
  const eventCount = rows.length
  if (eventCount === 0) {
    return {
      headline:   opts.topic ? `Nothing recorded for ${opts.topic} in the last ${humanizeMs(opts.windowMs)}.` : `Quiet window — no events recorded in the last ${humanizeMs(opts.windowMs)}.`,
      paragraphs: [],
      bullets:    [{ label: 'events', value: '0' }],
      confidence: 1,
      windowMs:   opts.windowMs,
      eventCount: 0,
    }
  }

  // Group by role
  const byRole: Record<WhyRole, EventLike[]> = { safety: [], budget: [], approval: [], execution: [], intent: [], context: [] }
  for (const r of rows) byRole[classifyRole(r.type)].push(r)

  // Headline picks the highest-priority non-empty bucket
  let headline = `${eventCount} event${eventCount === 1 ? '' : 's'} in the last ${humanizeMs(opts.windowMs)}.`
  for (const role of ROLE_PRIORITY) {
    if (byRole[role].length === 0) continue
    headline = headlineFor(role, byRole[role], eventCount, opts.windowMs)
    break
  }

  // Paragraphs — one per non-empty section, capped at 4
  const paragraphs: Array<{ heading: string; body: string }> = []
  const sectionOrder: Array<{ role: WhyRole; heading: string }> = [
    { role: 'safety',    heading: 'What was blocked' },
    { role: 'approval',  heading: 'What needed approval' },
    { role: 'execution', heading: 'What actually ran' },
    { role: 'intent',    heading: 'What the operator asked for' },
    { role: 'budget',    heading: 'What budget did' },
  ]
  for (const { role, heading } of sectionOrder) {
    if (byRole[role].length === 0) continue
    if (paragraphs.length >= 4) break
    const items = byRole[role].slice(0, 5)
    const lines = items.map(e => `· ${summarizeEvent(e.type, e.payload)}`)
    const more = byRole[role].length > items.length ? ` (+${byRole[role].length - items.length} more)` : ''
    paragraphs.push({ heading, body: lines.join('\n') + more })
  }

  // Bullets — quick scannable facts
  const typeCounts = new Map<string, number>()
  for (const r of rows) typeCounts.set(r.type, (typeCounts.get(r.type) ?? 0) + 1)
  const topTypes = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  const bullets: NarrativeBullet[] = [
    { label: 'events',   value: String(eventCount) },
    { label: 'blocked',  value: String(byRole.safety.length) },
    { label: 'approvals',value: String(byRole.approval.length) },
    { label: 'executed', value: String(byRole.execution.length) },
  ]
  if (topTypes[0]) bullets.push({ label: 'most-frequent', value: `${topTypes[0][0]} (×${topTypes[0][1]})` })

  // Confidence — high when a few event types dominate (so the narrative
  // is a faithful summary) AND we have enough samples to be confident.
  const dominantTypeCount = topTypes.length === 0 ? 0 : topTypes[0]![1]
  const typeConcentration = eventCount === 0 ? 0 : dominantTypeCount / eventCount
  const sampleConfidence = Math.min(1, eventCount / 20)
  const confidence = Number((0.6 * typeConcentration + 0.4 * sampleConfidence).toFixed(3))

  return { headline, paragraphs, bullets, confidence, windowMs: opts.windowMs, eventCount }
}

function headlineFor(role: WhyRole, items: EventLike[], total: number, windowMs: number): string {
  const n = items.length
  const window = humanizeMs(windowMs)
  switch (role) {
    case 'safety':    return `${n} action${n === 1 ? '' : 's'} blocked by safety in the last ${window}.`
    case 'budget':    return `${n} budget event${n === 1 ? '' : 's'} affected what ran in the last ${window}.`
    case 'approval':  return `${n} approval-gated action${n === 1 ? '' : 's'} in the last ${window}.`
    case 'execution': return `${n} action${n === 1 ? '' : 's'} executed in the last ${window}.`
    case 'intent':    return `${total} operator-driven event${total === 1 ? '' : 's'} in the last ${window}.`
    default:          return `${total} event${total === 1 ? '' : 's'} in the last ${window}.`
  }
}

function humanizeMs(ms: number): string {
  if (ms < 60_000)        return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000)     return `${Math.round(ms / 60_000)} min`
  if (ms < 86_400_000)    return `${Math.round(ms / 3_600_000)} hour${Math.round(ms / 3_600_000) === 1 ? '' : 's'}`
  return `${Math.round(ms / 86_400_000)} day${Math.round(ms / 86_400_000) === 1 ? '' : 's'}`
}

// ─── DB wrapper ────────────────────────────────────────────────────────

export async function summarizeRecentActivity(workspaceId: string, opts: { windowMs?: number; typeFilter?: string } = {}): Promise<Narrative> {
  const windowMs = opts.windowMs ?? 60 * 60_000
  const since = Date.now() - windowMs
  const rows = await db.select({ type: events.type, payload: events.payload, createdAt: events.createdAt }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since)))
    .limit(2000).catch(() => [])
  return buildNarrative(rows as EventLike[], { windowMs, ...(opts.typeFilter ? { topic: opts.typeFilter } : {}) })
}
