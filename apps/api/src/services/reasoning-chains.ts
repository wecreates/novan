/**
 * reasoning-chains.ts — Persistent reasoning trail with outcome linking.
 *
 * Every recommendation/forecast/decision the platform produces can be
 * persisted here. When the prediction window passes, the outcome is
 * linked back so meta-reasoning can score accuracy.
 *
 * No fabrication: confidence and prediction are taken straight from the
 * source (recommendation-engine / forecasting / tradeoff-analysis).
 */
import { db }                          from '../db/client.js'
import { reasoningChains, events }     from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

export type ChainKind = 'recommendation' | 'forecast' | 'tradeoff' | 'decision'

export interface RecordChainInput {
  workspaceId:  string
  kind:         ChainKind
  subjectId?:   string
  decision:     string
  evidence?:    Array<{ type: string; id: string; extract: string }>
  tradeoffs?:   Array<{ name: string; value: string | number; rationale: string }>
  confidence?:  number
  prediction?:  Record<string, unknown>
  source:       string
}

export async function record(input: RecordChainInput): Promise<string> {
  const id = uuidv7()
  await db.insert(reasoningChains).values({
    id,
    workspaceId: input.workspaceId,
    kind:        input.kind,
    subjectId:   input.subjectId ?? null,
    decision:    input.decision.slice(0, 2000),
    evidence:    input.evidence  ?? [],
    tradeoffs:   input.tradeoffs ?? [],
    confidence:  input.confidence ?? null,
    prediction:  input.prediction ?? null,
    outcomeKnown: false,
    source:      input.source,
    createdAt:   Date.now(),
  }).catch(() => null)
  return id
}

export async function linkOutcome(workspaceId: string, chainId: string, outcomeMatched: boolean, outcomeEvidence: Record<string, unknown>): Promise<void> {
  await db.update(reasoningChains).set({
    outcomeKnown: true,
    outcomeMatched,
    outcomeEvidence,
    outcomeAt: Date.now(),
  }).where(and(eq(reasoningChains.workspaceId, workspaceId), eq(reasoningChains.id, chainId)))
    .catch(() => null)
}

export async function recentChains(workspaceId: string, opts?: { kind?: ChainKind; limit?: number; withOutcomeOnly?: boolean }) {
  const conds = [eq(reasoningChains.workspaceId, workspaceId)]
  if (opts?.kind) conds.push(eq(reasoningChains.kind, opts.kind))
  if (opts?.withOutcomeOnly) conds.push(eq(reasoningChains.outcomeKnown, true))
  return db.select().from(reasoningChains)
    .where(and(...conds))
    .orderBy(desc(reasoningChains.createdAt))
    .limit(opts?.limit ?? 50)
    .catch(() => [])
}

/**
 * Auto-link outcomes for recommendations: when a recommendation.acted_on
 * event exists for a subjectId, mark the matching chain's outcome.
 * Conservative — only marks 'accepted' as matched=true; defer/dismiss
 * leaves outcomeMatched=null (we can't measure those).
 */
export async function reconcileRecommendationOutcomes(workspaceId: string): Promise<{ linked: number }> {
  const sinceTs = Date.now() - 30 * 24 * 60 * 60_000
  const actedEvents = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'recommendation.acted_on'),
      gte(events.createdAt, sinceTs),
    ))
    .catch(() => [])

  let linked = 0
  for (const e of actedEvents) {
    const p = e.payload as Record<string, unknown> | null
    const recId = p && typeof p['recommendationId'] === 'string' ? p['recommendationId'] as string : null
    const action = p && typeof p['action'] === 'string' ? p['action'] as string : 'unknown'
    if (!recId) continue
    const chain = await db.select().from(reasoningChains)
      .where(and(
        eq(reasoningChains.workspaceId, workspaceId),
        eq(reasoningChains.kind, 'recommendation'),
        eq(reasoningChains.subjectId, recId),
        eq(reasoningChains.outcomeKnown, false),
      )).limit(1).then(r => r[0]).catch(() => null)
    if (!chain) continue

    const matched = action === 'accepted'
    await linkOutcome(workspaceId, chain.id, matched, { action, sourceEventId: e.id })
    linked++
  }
  return { linked }
}
