/**
 * daily-review.ts — Once-per-day summary of the autonomous system's state.
 *
 * Pulls top failures, top wins, top costs, top learning insights, top
 * blockers from real runtime tables and emits a single 'daily.review'
 * event with the digest. Lightweight — pure SELECTs, no LLM call.
 *
 * Idempotency: skips if a review was emitted in the last 23 hours.
 */
import { db }                     from '../db/client.js'
import {
  events, incidents, researchFindings, imageGenerations,
  auditFindings, failureMemory, successfulFixes,
} from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 }            from 'uuid'

export interface DailyReview {
  workspaceId:     string
  windowStart:     number
  windowEnd:       number
  topFailures:     Array<{ signature: string; occurrences: number }>
  topWins:         Array<{ description: string; appliedCount: number }>
  topCosts:        Array<{ provider: string; spendUsd: number; count: number }>
  topInsights:     Array<{ summary: string; sourceUrl: string; confidence: number }>
  topBlockers:     Array<{ title: string; severity: string }>
  nextRecommended: string[]
}

export async function alreadyEmittedToday(workspaceId: string): Promise<boolean> {
  const since = Date.now() - 23 * 60 * 60_000
  const row = await db.select({ id: events.id }).from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'daily.review'),
      gte(events.createdAt, since),
    ))
    .limit(1).then(r => r[0]).catch(() => null)
  return !!row
}

export async function generateDailyReview(workspaceId: string): Promise<DailyReview> {
  const now = Date.now()
  const dayAgo = now - 24 * 60 * 60_000

  const [failures, wins, imageSpend, insights, openIncidents, audit] = await Promise.all([
    db.select({
      signature: failureMemory.signature,
      occurrences: failureMemory.occurrenceCount,
    }).from(failureMemory)
      .where(eq(failureMemory.workspaceId, workspaceId))
      .orderBy(desc(failureMemory.occurrenceCount))
      .limit(5).catch(() => []),

    db.select({
      description:   successfulFixes.fixDescription,
      appliedCount:  successfulFixes.successCount,
    }).from(successfulFixes)
      .where(eq(successfulFixes.workspaceId, workspaceId))
      .orderBy(desc(successfulFixes.successCount))
      .limit(5).catch(() => []),

    db.select({
      provider: imageGenerations.provider,
      spendUsd: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float`,
      count:    sql<number>`count(*)::int`,
    }).from(imageGenerations)
      .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, dayAgo)))
      .groupBy(imageGenerations.provider).catch(() => []),

    db.select({
      summary:    researchFindings.summary,
      sourceUrl:  researchFindings.sourceUrl,
      confidence: researchFindings.confidence,
    }).from(researchFindings)
      .where(and(eq(researchFindings.workspaceId, workspaceId), gte(researchFindings.createdAt, dayAgo)))
      .orderBy(desc(researchFindings.confidence))
      .limit(5).catch(() => []),

    db.select({ title: incidents.title, severity: incidents.severity }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
      .orderBy(desc(incidents.detectedAt))
      .limit(5).catch(() => []),

    db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(eq(auditFindings.workspaceId, workspaceId))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
  ])

  const next: string[] = []
  if (openIncidents.length > 0) next.push(`resolve ${openIncidents.length} open incident(s) before new autonomous actions`)
  if (failures.length > 0 && Number(failures[0]?.occurrences ?? 0) >= 3) {
    next.push(`address recurring failure: ${String(failures[0]?.signature).slice(0, 80)}`)
  }
  if (audit > 50) next.push(`${audit} audit findings — triage and resolve top 5`)
  if (insights.length > 0) next.push('review new research insights in War Room')
  if (next.length === 0) next.push('all green — keep monitoring')

  return {
    workspaceId,
    windowStart: dayAgo, windowEnd: now,
    topFailures: failures.map(f => ({ signature: String(f.signature ?? ''), occurrences: Number(f.occurrences ?? 0) })),
    topWins:     wins.map(w => ({ description: String(w.description ?? ''), appliedCount: Number(w.appliedCount ?? 0) })),
    topCosts:    imageSpend.map(s => ({ provider: String(s.provider), spendUsd: Number(s.spendUsd), count: Number(s.count) })),
    topInsights: insights.map(i => ({ summary: String(i.summary ?? '').slice(0, 200), sourceUrl: String(i.sourceUrl), confidence: Number(i.confidence) })),
    topBlockers: openIncidents.map(i => ({ title: String(i.title ?? ''), severity: String(i.severity ?? '') })),
    nextRecommended: next,
  }
}

export async function runDailyReview(workspaceId: string, opts?: { force?: boolean }): Promise<DailyReview | null> {
  if (!opts?.force && await alreadyEmittedToday(workspaceId)) return null
  const review = await generateDailyReview(workspaceId)
  await db.insert(events).values({
    id: uuidv7(), type: 'daily.review', workspaceId,
    payload: review as unknown as Record<string, unknown>,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'daily-review', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  return review
}
