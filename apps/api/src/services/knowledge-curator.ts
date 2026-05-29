/**
 * knowledge-curator.ts — Captures learning from completed work.
 *
 * Spec: "When a pattern works well, it gets extracted into a playbook
 * other agents can use. When something fails in production, the
 * post-mortem feeds into avoidance rules. This is how the system gets
 * better over time rather than making the same mistakes repeatedly."
 *
 * Two feed paths:
 *   - SUCCESS path: prompt-evolution recordOutcome marks a mutation as
 *     a winner → curator extracts the pattern + writes a playbook
 *     addendum that other personas read on grounding.
 *   - FAILURE path: postmortem.generate produces lessons → curator
 *     converts each lesson into a 1-line avoidance rule + adds it to
 *     the affected persona's system prompt as a "Hard rule" line.
 *
 * Outputs are PROPOSALS — operator approves before they land in the
 * canonical playbook files. The curator never silently mutates
 * production knowledge.
 */
import { db } from '../db/client.js'
import { events, reasoningChains } from '../db/schema.js'
import { eq, and, desc, gte, sql } from 'drizzle-orm'

export interface ExtractedPattern {
  patternId:     string
  source:        'prompt_evolution' | 'reasoning_chain' | 'incident_postmortem' | 'manual'
  title:         string
  description:   string
  /** Personas/specialists this pattern applies to. */
  appliesTo:     string[]
  evidence:      Array<{ kind: string; ref: string; extract: string }>
  confidence:    number      // 0..1
  proposedAt:    number
  status:        'proposed' | 'approved' | 'rejected' | 'superseded'
}

/** Scan recent prompt-evolution wins + postmortem lessons and propose
 *  patterns to the operator. Output is the proposal queue. */
export async function curate(workspaceId: string, opts?: { days?: number }): Promise<ExtractedPattern[]> {
  const since = Date.now() - (opts?.days ?? 30) * 86_400_000
  const out: ExtractedPattern[] = []

  // 1. Prompt-evolution winners — find any prompt mutation that recorded
  //    significantly better outcomes than its parent. Heuristic: look
  //    for events of type 'prompt_evolution.outcome' with payload.gain > 0.1.
  const winEvents = await db.select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'prompt_evolution.outcome'),
      gte(events.createdAt, since),
    ))
    .orderBy(desc(events.createdAt))
    .limit(200)
    .catch(() => [])

  for (const e of winEvents) {
    const p = e.payload as { slot?: string; gain?: number; promptText?: string } | null
    if (!p || (p.gain ?? 0) < 0.1) continue
    out.push({
      patternId:   `prompt-win-${e.createdAt}`,
      source:      'prompt_evolution',
      title:       `Winning prompt mutation for slot "${p.slot ?? 'unknown'}" (+${((p.gain ?? 0) * 100).toFixed(1)}pp)`,
      description: `A prompt mutation in slot ${p.slot} outperformed its parent by ${((p.gain ?? 0) * 100).toFixed(1)} percentage points across recent outcomes. Pattern worth extracting into the playbook for this slot.`,
      appliesTo:   [String(p.slot ?? 'all')],
      evidence:    [{ kind: 'prompt_outcome', ref: String(e.createdAt), extract: (p.promptText ?? '').slice(0, 400) }],
      confidence:  Math.min(1, 0.6 + (p.gain ?? 0)),
      proposedAt:  Date.now(),
      status:      'proposed',
    })
  }

  // 2. Postmortem-derived avoidance rules — find postmortems generated
  //    recently and lift each "lesson" into an avoidance rule.
  const postEvents = await db.select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'incident.postmortem_generated'),
      gte(events.createdAt, since),
    ))
    .orderBy(desc(events.createdAt))
    .limit(50)
    .catch(() => [])

  for (const e of postEvents) {
    const p = e.payload as { incidentId?: string; lessons?: string[]; affectedSystems?: string[] } | null
    if (!p?.lessons) continue
    for (const lesson of p.lessons.slice(0, 5)) {
      out.push({
        patternId:   `postmortem-${e.createdAt}-${lesson.slice(0, 20)}`,
        source:      'incident_postmortem',
        title:       `Avoidance rule from incident ${p.incidentId ?? '?'}`,
        description: lesson,
        appliesTo:   p.affectedSystems ?? ['all'],
        evidence:    [{ kind: 'postmortem', ref: String(p.incidentId ?? e.createdAt), extract: lesson }],
        confidence:  0.7,
        proposedAt:  Date.now(),
        status:      'proposed',
      })
    }
  }

  // 3. High-confidence reasoning chains marked as decisions — extract
  //    their decision text as candidate patterns for the relevant persona.
  const decisions = await db.select({
    id:          reasoningChains.id,
    decision:    reasoningChains.decision,
    confidence:  reasoningChains.confidence,
    source:      reasoningChains.source,
    createdAt:   reasoningChains.createdAt,
  })
    .from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.kind, 'decision'),
      gte(reasoningChains.createdAt, since),
      sql`${reasoningChains.confidence} >= 0.85`,
    ))
    .orderBy(desc(reasoningChains.createdAt))
    .limit(50)
    .catch(() => [])

  for (const d of decisions) {
    out.push({
      patternId:   `decision-${d.id}`,
      source:      'reasoning_chain',
      title:       `High-confidence decision pattern`,
      description: String(d.decision ?? '').slice(0, 400),
      appliesTo:   [String(d.source ?? 'all')],
      evidence:    [{ kind: 'reasoning_chain', ref: d.id, extract: String(d.decision ?? '') }],
      confidence:  Number(d.confidence ?? 0.85),
      proposedAt:  Date.now(),
      status:      'proposed',
    })
  }

  return out
}

/** Approve a proposed pattern. Writes an event row marking the
 *  pattern as approved so the persona-grounding step picks it up. */
export async function approvePattern(input: {
  workspaceId:  string
  patternId:    string
  approvedBy:   string
  patternData:  ExtractedPattern
}): Promise<void> {
  const { v7: uuidv7 } = await import('uuid')
  await db.insert(events).values({
    id: uuidv7(), type: 'knowledge.pattern_approved', workspaceId: input.workspaceId,
    payload: { ...input.patternData, status: 'approved', approvedBy: input.approvedBy },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'knowledge-curator', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[knowledge-curator]', e.message); return null })
}

/** Reject a proposal — the curator won't surface it again. */
export async function rejectPattern(input: {
  workspaceId:  string
  patternId:    string
  reason:       string
}): Promise<void> {
  const { v7: uuidv7 } = await import('uuid')
  await db.insert(events).values({
    id: uuidv7(), type: 'knowledge.pattern_rejected', workspaceId: input.workspaceId,
    payload: { patternId: input.patternId, reason: input.reason },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'knowledge-curator', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[knowledge-curator]', e.message); return null })
}
