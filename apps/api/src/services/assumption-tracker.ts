/**
 * assumption-tracker.ts — Lifecycle for load-bearing beliefs.
 *
 * Every assumption requires a `statement` and an evidence trail. The
 * staleness sweep moves verified assumptions back to 'stale' after 7d
 * without re-verification.
 *
 * Honest: this is a deliberate skeleton — services have to register
 * their own assumptions. The platform doesn't pretend to know what
 * everything believes; it tracks what gets explicitly declared.
 */
import { db }                          from '../db/client.js'
import { assumptions, events }         from '../db/schema.js'
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

const WEEK = 7 * 24 * 60 * 60_000

export type AssumptionCategory =
  | 'runtime' | 'provider' | 'operator' | 'telemetry' | 'test'
  | 'recommendation' | 'forecast' | 'strategic'

export type AssumptionStatus =
  | 'unverified' | 'verifying' | 'verified' | 'invalidated' | 'stale'

export interface DeclareInput {
  workspaceId: string
  category:    AssumptionCategory
  statement:   string
  evidenceRefs?: Array<{ table: string; id: string; extract: string }>
  confidence?: number
  source:      string
}

export async function declare(input: DeclareInput): Promise<string> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(assumptions).values({
    id, workspaceId: input.workspaceId,
    category:   input.category,
    statement:  input.statement.slice(0, 1000),
    evidenceRefs: (input.evidenceRefs ?? []),
    confidence: input.confidence ?? 0.5,
    confidenceProvenance: 'heuristic',
    status:     input.evidenceRefs && input.evidenceRefs.length > 0 ? 'unverified' : 'unverified',
    source:     input.source,
    createdAt:  now, updatedAt: now,
  }).catch((e: Error) => { console.error('[assumption-tracker]', e.message); return null })
  return id
}

export async function setStatus(
  workspaceId: string, id: string, status: AssumptionStatus,
  opts?: { evidenceRefs?: Array<{ table: string; id: string; extract: string }>; reason?: string },
): Promise<{ ok: boolean }> {
  const now = Date.now()
  const update: Record<string, unknown> = { status, updatedAt: now }
  if (status === 'verified') {
    update['lastVerifiedAt'] = now
    update['verificationCount'] = sql`${assumptions.verificationCount} + 1`
  } else if (status === 'invalidated') {
    update['lastInvalidatedAt'] = now
    update['invalidationCount'] = sql`${assumptions.invalidationCount} + 1`
  }
  if (opts?.evidenceRefs) update['evidenceRefs'] = opts.evidenceRefs as never
  await db.update(assumptions).set(update)
    .where(and(eq(assumptions.workspaceId, workspaceId), eq(assumptions.id, id)))
    .catch((e: Error) => { console.error('[assumption-tracker]', e.message); return null })

  await db.insert(events).values({
    id: uuidv7(), type: `assumption.${status}`, workspaceId,
    payload: { assumptionId: id, status, reason: opts?.reason ?? null },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'assumption-tracker', version: 1, createdAt: now,
  }).catch((e: Error) => { console.error('[assumption-tracker]', e.message); return null })
  return { ok: true }
}

export async function list(workspaceId: string, opts?: { status?: AssumptionStatus; category?: AssumptionCategory; limit?: number }) {
  const conds = [eq(assumptions.workspaceId, workspaceId)]
  if (opts?.status)   conds.push(eq(assumptions.status, opts.status))
  if (opts?.category) conds.push(eq(assumptions.category, opts.category))
  return db.select().from(assumptions)
    .where(and(...conds))
    .orderBy(desc(assumptions.updatedAt))
    .limit(opts?.limit ?? 100).catch(() => [])
}

/** Stale sweep: verified assumptions not re-verified in >7 days become 'stale'. */
export async function sweepStale(workspaceId: string): Promise<{ markedStale: number }> {
  const cutoff = Date.now() - WEEK
  const candidates = await db.select({ id: assumptions.id }).from(assumptions)
    .where(and(
      eq(assumptions.workspaceId, workspaceId),
      eq(assumptions.status, 'verified'),
      lt(assumptions.lastVerifiedAt, cutoff),
    ))
    .catch(() => [])
  let n = 0
  for (const c of candidates) {
    await setStatus(workspaceId, c.id, 'stale', { reason: 'not re-verified in >7d' })
    n++
  }
  return { markedStale: n }
}

export async function summary(workspaceId: string) {
  const rows = await db.select({
    status: assumptions.status,
    c: sql<number>`count(*)::int`,
    avgConf: sql<number>`coalesce(avg(${assumptions.confidence}), 0)::float`,
  }).from(assumptions)
    .where(eq(assumptions.workspaceId, workspaceId))
    .groupBy(assumptions.status).catch(() => [])
  const out = {
    unverified: 0, verifying: 0, verified: 0, invalidated: 0, stale: 0,
    avgConfidenceByStatus: {} as Record<string, number>,
  }
  for (const r of rows) {
    const s = String(r.status) as keyof typeof out
    if (s in out && s !== 'avgConfidenceByStatus') (out[s] as number) = Number(r.c)
    out.avgConfidenceByStatus[s] = Number(Number(r.avgConf).toFixed(2))
  }
  return out
}
