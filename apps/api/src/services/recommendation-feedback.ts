/**
 * recommendation-feedback.ts — Tier-1 closure: explicit operator feedback
 * on recommendations becomes a first-class signal.
 *
 * Records accept/reject/snooze/noop on a reasoning chain. The weight_delta
 * column lets the recommendation-engine bias future scores by past
 * operator preference (positive for accepted patterns, negative for
 * rejected ones).
 */
import { db } from '../db/client.js'
import { recommendationFeedback, reasoningChains } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type FeedbackAction = 'accept' | 'reject' | 'snooze' | 'noop'

const WEIGHT_DELTA: Record<FeedbackAction, number> = {
  accept: +0.2,
  reject: -0.3,
  snooze: -0.05,
  noop:    0,
}

export async function submitFeedback(input: {
  workspaceId: string
  chainId:     string
  action:      FeedbackAction
  reason?:     string
  operatorId?: string
}): Promise<{ id: string; weightDelta: number }> {
  const id = uuidv7()
  const weightDelta = WEIGHT_DELTA[input.action]
  await db.insert(recommendationFeedback).values({
    id, workspaceId: input.workspaceId, chainId: input.chainId,
    action: input.action,
    reason:     input.reason     ?? null,
    operatorId: input.operatorId ?? null,
    weightDelta, createdAt: Date.now(),
  }).catch(() => null)
  // Side-effect: rejecting a recommendation cuts its confidence
  if (input.action === 'reject') {
    await db.update(reasoningChains).set({
      confidence: sql`greatest(0.05, coalesce(${reasoningChains.confidence}, 0.5) * 0.6)`,
    }).where(and(
      eq(reasoningChains.workspaceId, input.workspaceId),
      eq(reasoningChains.id,          input.chainId),
    )).catch(() => null)
  }
  return { id, weightDelta }
}

export async function feedbackOnChain(workspaceId: string, chainId: string) {
  return db.select().from(recommendationFeedback)
    .where(and(eq(recommendationFeedback.workspaceId, workspaceId), eq(recommendationFeedback.chainId, chainId)))
    .orderBy(desc(recommendationFeedback.createdAt))
    .catch(() => [])
}

/** Aggregate operator-preference signal for use by recommendation-engine. */
export async function operatorPreferenceWeights(workspaceId: string, windowDays = 90): Promise<Record<string, number>> {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  // Join feedback to chains to get subjectId; aggregate weight_delta by subjectId
  const rows = await db.select({
    subjectId: reasoningChains.subjectId,
    delta:     sql<number>`coalesce(sum(${recommendationFeedback.weightDelta}), 0)::float`,
    n:         sql<number>`count(*)::int`,
  }).from(recommendationFeedback)
    .innerJoin(reasoningChains, eq(reasoningChains.id, recommendationFeedback.chainId))
    .where(and(
      eq(recommendationFeedback.workspaceId, workspaceId),
      gte(recommendationFeedback.createdAt, since),
    ))
    .groupBy(reasoningChains.subjectId)
    .catch(() => [])

  const out: Record<string, number> = {}
  for (const r of rows) {
    if (!r.subjectId) continue
    // Clamp to [-1, +1] to prevent runaway bias
    out[r.subjectId] = Math.max(-1, Math.min(1, Number(r.delta)))
  }
  return out
}

export async function feedbackSummary(workspaceId: string, windowDays = 30) {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const rows = await db.select().from(recommendationFeedback)
    .where(and(eq(recommendationFeedback.workspaceId, workspaceId), gte(recommendationFeedback.createdAt, since)))
    .catch(() => [])
  const byAction: Record<string, number> = {}
  for (const r of rows) byAction[r.action] = (byAction[r.action] ?? 0) + 1
  return { windowDays, total: rows.length, byAction }
}
