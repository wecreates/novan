/**
 * drift-detector.ts — Find places where reality has diverged from belief.
 *
 * 5 drift kinds with explicit thresholds:
 *   1. repeated_wrong_prediction   ≥3 unmatched chains of same kind in 7d
 *   2. stale_belief                assumptions in 'stale' status >7d
 *   3. failed_recommendations      ≥3 recommendation chains where outcome=false
 *                                  for the same subjectId
 *   4. low_confidence_loop         ≥5 chains created in 24h with confidence <0.4
 *                                  on same subjectId
 *   5. unsupported_conclusion      assumption marked 'verified' but evidenceRefs
 *                                  is empty
 *
 * Drift warnings go to drift_warnings table. No auto-action — the
 * reality-correction service reads these and applies corrections.
 */
import { db }                          from '../db/client.js'
import { driftWarnings, reasoningChains, assumptions } from '../db/schema.js'
import { and, eq, gte, sql }           from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

const DAY  = 24 * 60 * 60_000
const WEEK = 7 * DAY

export type DriftKind =
  | 'repeated_wrong_prediction' | 'stale_belief'
  | 'failed_recommendations'    | 'low_confidence_loop'
  | 'unsupported_conclusion'

export interface DriftScanResult {
  workspaceId:  string
  detected:     Array<{ kind: DriftKind; subjectId: string | null; severity: string; evidenceSize: number }>
  totalCreated: number
  totalExisting: number
}

async function recordDrift(workspaceId: string, opts: {
  kind: DriftKind
  subjectId: string | null
  severity: 'low' | 'medium' | 'high' | 'critical'
  evidence: unknown[]
  recommendedAction: string
}): Promise<{ created: boolean }> {
  // Idempotency: skip if open OR acknowledged warning with same
  // (kind, subjectId) exists. R141 — previously only deduped against
  // 'open', which let reality-correction's notify_only / no-op branches
  // (which set status='acknowledged' or 'resolved' WITHOUT actually
  // fixing the underlying condition) trigger a loop: warning created →
  // marked resolved without action → next tick re-creates because
  // underlying low-confidence chains are still there. 97 resolved
  // low_confidence_loop warnings in 7d before this fix.
  const existing = await db.select({ id: driftWarnings.id }).from(driftWarnings)
    .where(and(
      eq(driftWarnings.workspaceId, workspaceId),
      eq(driftWarnings.kind, opts.kind),
      sql`${driftWarnings.status} IN ('open', 'acknowledged')`,
      opts.subjectId ? eq(driftWarnings.subjectId, opts.subjectId) : sql`${driftWarnings.subjectId} IS NULL`,
    ))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[drift-detector]', e.message); return null })
  if (existing) return { created: false }

  await db.insert(driftWarnings).values({
    id: uuidv7(), workspaceId,
    kind: opts.kind, subjectId: opts.subjectId,
    severity: opts.severity,
    evidence: opts.evidence as never,
    recommendedAction: opts.recommendedAction,
    status: 'open',
    createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[drift-detector]', e.message); return null })
  return { created: true }
}

async function detectRepeatedWrongPredictions(workspaceId: string): Promise<number> {
  const since = Date.now() - WEEK
  const rows = await db.select({
    kind: reasoningChains.kind,
    c: sql<number>`count(*) filter (where ${reasoningChains.outcomeMatched} = false)::int`,
  }).from(reasoningChains)
    .where(and(eq(reasoningChains.workspaceId, workspaceId), gte(reasoningChains.createdAt, since)))
    .groupBy(reasoningChains.kind).catch(() => [])
  let n = 0
  for (const r of rows) {
    if (Number(r.c) < 3) continue
    const out = await recordDrift(workspaceId, {
      kind: 'repeated_wrong_prediction',
      subjectId: r.kind,
      severity: Number(r.c) >= 10 ? 'high' : 'medium',
      evidence: [{ kind: r.kind, unmatchedCount: Number(r.c), window: '7d' }],
      recommendedAction: `Lower default confidence for kind=${r.kind}; require additional evidence`,
    })
    if (out.created) n++
  }
  return n
}

async function detectStaleBeliefs(workspaceId: string): Promise<number> {
  const stale = await db.select().from(assumptions)
    .where(and(eq(assumptions.workspaceId, workspaceId), eq(assumptions.status, 'stale')))
    .catch(() => [])
  let n = 0
  for (const s of stale) {
    const out = await recordDrift(workspaceId, {
      kind: 'stale_belief',
      subjectId: s.id,
      severity: 'low',
      evidence: [{ assumptionId: s.id, statement: s.statement.slice(0, 120), lastVerifiedAt: s.lastVerifiedAt }],
      recommendedAction: 'Re-verify assumption against current evidence or invalidate.',
    })
    if (out.created) n++
  }
  return n
}

async function detectFailedRecommendations(workspaceId: string): Promise<number> {
  // chain kind='recommendation' with outcomeMatched=false, group by subjectId
  const rows = await db.select({
    subjectId: reasoningChains.subjectId,
    c: sql<number>`count(*)::int`,
  }).from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.kind, 'recommendation'),
      eq(reasoningChains.outcomeMatched, false),
    ))
    .groupBy(reasoningChains.subjectId)
    .having(sql`count(*) >= 3`)
    .catch(() => [])
  let n = 0
  for (const r of rows) {
    const out = await recordDrift(workspaceId, {
      kind: 'failed_recommendations',
      subjectId: r.subjectId,
      severity: Number(r.c) >= 5 ? 'high' : 'medium',
      evidence: [{ subjectId: r.subjectId, failedCount: Number(r.c) }],
      recommendedAction: 'Reduce auto-apply eligibility for this subject; require operator review.',
    })
    if (out.created) n++
  }
  return n
}

async function detectLowConfidenceLoops(workspaceId: string): Promise<number> {
  const since = Date.now() - DAY
  const rows = await db.select({
    subjectId: reasoningChains.subjectId,
    c: sql<number>`count(*)::int`,
  }).from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      gte(reasoningChains.createdAt, since),
      sql`${reasoningChains.confidence} < 0.4`,
    ))
    .groupBy(reasoningChains.subjectId)
    .having(sql`count(*) >= 5`)
    .catch(() => [])
  let n = 0
  for (const r of rows) {
    const out = await recordDrift(workspaceId, {
      kind: 'low_confidence_loop',
      subjectId: r.subjectId,
      severity: 'medium',
      evidence: [{ subjectId: r.subjectId, lowConfidenceCount24h: Number(r.c) }],
      recommendedAction: 'Trigger additional research; pause autonomous action on this subject.',
    })
    if (out.created) n++
  }
  return n
}

async function detectUnsupportedConclusions(workspaceId: string): Promise<number> {
  // Assumptions in 'verified' status with empty evidenceRefs
  const verified = await db.select().from(assumptions)
    .where(and(eq(assumptions.workspaceId, workspaceId), eq(assumptions.status, 'verified')))
    .catch(() => [])
  let n = 0
  for (const a of verified) {
    const refs = Array.isArray(a.evidenceRefs) ? a.evidenceRefs : []
    if ((refs as unknown[]).length > 0) continue
    const out = await recordDrift(workspaceId, {
      kind: 'unsupported_conclusion',
      subjectId: a.id,
      severity: 'high',
      evidence: [{ assumptionId: a.id, statement: a.statement.slice(0, 200) }],
      recommendedAction: 'Mark assumption as unverified — evidence missing despite verified status.',
    })
    if (out.created) n++
  }
  return n
}

export async function scanDrift(workspaceId: string): Promise<DriftScanResult> {
  const [a, b, c, d, e] = await Promise.all([
    detectRepeatedWrongPredictions(workspaceId).catch(() => 0),
    detectStaleBeliefs(workspaceId).catch(() => 0),
    detectFailedRecommendations(workspaceId).catch(() => 0),
    detectLowConfidenceLoops(workspaceId).catch(() => 0),
    detectUnsupportedConclusions(workspaceId).catch(() => 0),
  ])
  const totalCreated = a + b + c + d + e
  const existingCount = await db.select({ c: sql<number>`count(*)::int` }).from(driftWarnings)
    .where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.status, 'open')))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)

  return {
    workspaceId,
    detected: [
      { kind: 'repeated_wrong_prediction', subjectId: null, severity: 'detected', evidenceSize: a },
      { kind: 'stale_belief',              subjectId: null, severity: 'detected', evidenceSize: b },
      { kind: 'failed_recommendations',    subjectId: null, severity: 'detected', evidenceSize: c },
      { kind: 'low_confidence_loop',       subjectId: null, severity: 'detected', evidenceSize: d },
      { kind: 'unsupported_conclusion',    subjectId: null, severity: 'detected', evidenceSize: e },
    ],
    totalCreated,
    totalExisting: existingCount,
  }
}

export async function listWarnings(workspaceId: string, status: 'open' | 'acknowledged' | 'resolved' = 'open', limit = 50) {
  return db.select().from(driftWarnings)
    .where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.status, status)))
    .orderBy(sql`${driftWarnings.createdAt} desc`)
    .limit(limit).catch(() => [])
}

export async function resolveWarning(workspaceId: string, id: string, status: 'acknowledged' | 'resolved'): Promise<{ ok: boolean }> {
  await db.update(driftWarnings).set({
    status, resolvedAt: status === 'resolved' ? Date.now() : null,
  }).where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.id, id)))
    .catch((e: Error) => { console.error('[drift-detector]', e.message); return null })
  return { ok: true }
}
