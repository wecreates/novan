/**
 * experiments.ts — R146.86 — learning loop foundation.
 *
 * The brain's claims become testable. Every meaningful change (offer
 * tweak, niche pivot, channel switch, prompt edit) is logged as an
 * experiment with a falsifiable prediction. Outcomes feed back into
 * prompt-evolution + reasoning-chains so the brain calibrates.
 *
 * Hypotheses are belief-units: claim + falsifying condition + confidence.
 * As evidence accumulates the brain marks them supported/refuted.
 *
 * Calibration observations connect a claimed confidence to an observed
 * outcome so we can compute the brain's reliability curve over time.
 */
import { db } from '../db/client.js'
import { experiments, hypotheses, calibrationObservations, events } from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Experiments ─────────────────────────────────────────────────────────────

export interface CreateExperimentInput {
  workspaceId:  string
  businessId?:  string
  title:        string
  hypothesis:   string
  prediction:   string         // falsifiable, e.g. "subscribers grow ≥15% in 14 days"
  metric:       string         // e.g. "subscribers_growth_pct_14d"
  baseline?:    Record<string, unknown>
  intervention: string
  confidence?:  number         // 0..1 pre-experiment
}

export async function createExperiment(i: CreateExperimentInput): Promise<{ id: string }> {
  const id  = uuidv7()
  const now = Date.now()
  await db.insert(experiments).values({
    id,
    workspaceId: i.workspaceId,
    ...(i.businessId ? { businessId: i.businessId } : {}),
    title:       i.title.slice(0, 200),
    hypothesis:  i.hypothesis.slice(0, 1000),
    prediction:  i.prediction.slice(0, 500),
    metric:      i.metric.slice(0, 100),
    baseline:    i.baseline ?? {},
    intervention: i.intervention.slice(0, 1000),
    startAt:     now,
    status:      'running',
    confidencePre: i.confidence ?? 0.5,
    createdAt:   now,
    updatedAt:   now,
  })
  await emitEvent(i.workspaceId, 'experiment.created', { id, title: i.title })
  return { id }
}

export async function listExperiments(workspaceId: string, status?: string): Promise<unknown[]> {
  const rows = await db.select().from(experiments)
    .where(status
      ? and(eq(experiments.workspaceId, workspaceId), eq(experiments.status, status))
      : eq(experiments.workspaceId, workspaceId))
    .orderBy(desc(experiments.createdAt))
    .limit(100)
  return rows
}

export interface ConcludeExperimentInput {
  workspaceId: string
  id:          string
  outcome:     Record<string, unknown>
  verdict:     'supported' | 'refuted' | 'inconclusive'
  lessons?:    string
  confidencePost?: number
}

export async function concludeExperiment(i: ConcludeExperimentInput): Promise<void> {
  const now = Date.now()
  await db.update(experiments)
    .set({
      status:    'concluded',
      outcome:   i.outcome,
      verdict:   i.verdict,
      ...(i.lessons ? { lessons: i.lessons.slice(0, 2000) } : {}),
      endAt:     now,
      updatedAt: now,
      ...(typeof i.confidencePost === 'number' ? { confidencePost: i.confidencePost } : {}),
    })
    .where(and(eq(experiments.id, i.id), eq(experiments.workspaceId, i.workspaceId)))

  // If we have both pre + post confidence, log calibration observation.
  const [row] = await db.select().from(experiments)
    .where(eq(experiments.id, i.id))
    .limit(1)
  if (row?.confidencePre != null) {
    await recordCalibration({
      workspaceId:        i.workspaceId,
      subjectType:        'experiment',
      subjectId:          i.id,
      claimedConfidence:  row.confidencePre,
      outcome:            i.verdict === 'supported' ? 'true'
                       : i.verdict === 'refuted'    ? 'false'
                       : 'partial',
      ...(typeof i.confidencePost === 'number' ? { outcomeScore: i.confidencePost } : {}),
    })
  }
  await emitEvent(i.workspaceId, 'experiment.concluded', { id: i.id, verdict: i.verdict })
}

export async function abandonExperiment(workspaceId: string, id: string, reason: string): Promise<void> {
  const now = Date.now()
  await db.update(experiments)
    .set({ status: 'abandoned', lessons: reason.slice(0, 500), endAt: now, updatedAt: now })
    .where(and(eq(experiments.id, id), eq(experiments.workspaceId, workspaceId)))
  await emitEvent(workspaceId, 'experiment.abandoned', { id, reason })
}

// ─── Hypotheses ──────────────────────────────────────────────────────────────

export interface CreateHypothesisInput {
  workspaceId:  string
  subject:      string
  claim:        string
  prediction:   string
  confidence:   number     // 0..1
  relatedChain?: string
}

export async function createHypothesis(i: CreateHypothesisInput): Promise<{ id: string }> {
  const id  = uuidv7()
  const now = Date.now()
  await db.insert(hypotheses).values({
    id,
    workspaceId: i.workspaceId,
    subject:     i.subject.slice(0, 200),
    claim:       i.claim.slice(0, 1000),
    prediction:  i.prediction.slice(0, 500),
    confidence:  Math.max(0, Math.min(1, i.confidence)),
    ...(i.relatedChain ? { relatedChain: i.relatedChain } : {}),
    status:      'open',
    createdAt:   now,
    updatedAt:   now,
  })
  await emitEvent(i.workspaceId, 'hypothesis.created', { id, subject: i.subject, confidence: i.confidence })
  return { id }
}

export async function addEvidence(input: {
  workspaceId: string; id: string; side: 'for' | 'against'; description: string; weight?: number
}): Promise<void> {
  const [row] = await db.select().from(hypotheses).where(eq(hypotheses.id, input.id)).limit(1)
  if (!row) throw new Error(`hypothesis ${input.id} not found`)
  const list = input.side === 'for' ? (row.evidenceFor as unknown[]) : (row.evidenceAgainst as unknown[])
  const next = [...list, { description: input.description.slice(0, 500), weight: input.weight ?? 1, at: Date.now() }].slice(-20)
  const patch: Record<string, unknown> = { updatedAt: Date.now() }
  if (input.side === 'for') patch.evidenceFor = next; else patch.evidenceAgainst = next
  await db.update(hypotheses).set(patch)
    .where(and(eq(hypotheses.id, input.id), eq(hypotheses.workspaceId, input.workspaceId)))
}

export async function reviewHypothesis(input: {
  workspaceId: string; id: string; verdict: 'supported' | 'refuted' | 'superseded'; notes?: string
}): Promise<void> {
  const now = Date.now()
  await db.update(hypotheses)
    .set({ status: input.verdict, reviewedAt: now, updatedAt: now })
    .where(and(eq(hypotheses.id, input.id), eq(hypotheses.workspaceId, input.workspaceId)))
  const [row] = await db.select().from(hypotheses).where(eq(hypotheses.id, input.id)).limit(1)
  if (row) {
    await recordCalibration({
      workspaceId:       input.workspaceId,
      subjectType:       'hypothesis',
      subjectId:         input.id,
      claimedConfidence: row.confidence,
      outcome:           input.verdict === 'supported' ? 'true'
                       : input.verdict === 'refuted'    ? 'false' : 'partial',
      ...(input.notes ? { notes: input.notes.slice(0, 300) } : {}),
    })
  }
  await emitEvent(input.workspaceId, 'hypothesis.reviewed', { id: input.id, verdict: input.verdict })
}

export async function listHypotheses(workspaceId: string, status?: string): Promise<unknown[]> {
  const rows = await db.select().from(hypotheses)
    .where(status
      ? and(eq(hypotheses.workspaceId, workspaceId), eq(hypotheses.status, status))
      : eq(hypotheses.workspaceId, workspaceId))
    .orderBy(desc(hypotheses.createdAt))
    .limit(100)
  return rows
}

// ─── Calibration ─────────────────────────────────────────────────────────────

export interface CalibrationInput {
  workspaceId:       string
  subjectType:       'hypothesis' | 'experiment' | 'plan_step'
  subjectId:         string
  claimedConfidence: number
  outcome:           'true' | 'false' | 'partial'
  outcomeScore?:     number
  notes?:            string
}

export async function recordCalibration(i: CalibrationInput): Promise<void> {
  await db.insert(calibrationObservations).values({
    id:                uuidv7(),
    workspaceId:       i.workspaceId,
    subjectType:       i.subjectType,
    subjectId:         i.subjectId,
    claimedConfidence: i.claimedConfidence,
    outcome:           i.outcome,
    ...(typeof i.outcomeScore === 'number' ? { outcomeScore: i.outcomeScore } : {}),
    observedAt:        Date.now(),
    ...(i.notes ? { notes: i.notes.slice(0, 500) } : {}),
  })
}

/** Reliability diagram data: for each confidence bucket, what fraction
 *  of outcomes were "true"? Ideal calibration: bucket midpoint = empirical rate. */
export async function calibrationCurve(workspaceId: string, daysBack = 90): Promise<{
  buckets: Array<{ binLow: number; binHigh: number; n: number; empirical: number }>
  brierScore: number
  n: number
}> {
  const since = Date.now() - daysBack * 86_400_000
  const rows = await db.select().from(calibrationObservations)
    .where(and(eq(calibrationObservations.workspaceId, workspaceId),
               gte(calibrationObservations.observedAt, since)))
  const bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
  const buckets: Array<{ binLow: number; binHigh: number; n: number; empirical: number }> = []
  for (let i = 0; i < bins.length - 1; i++) {
    const lo = bins[i]!, hi = bins[i + 1]!
    const inBucket = rows.filter(r => r.claimedConfidence >= lo && r.claimedConfidence < hi)
    const trues   = inBucket.filter(r => r.outcome === 'true').length
    const partials = inBucket.filter(r => r.outcome === 'partial').length
    const score = (trues + 0.5 * partials) / Math.max(1, inBucket.length)
    buckets.push({ binLow: lo, binHigh: hi, n: inBucket.length, empirical: score })
  }
  // Brier score: mean((claimed - observed)^2). observed: true=1, partial=0.5, false=0
  const brier = rows.length === 0 ? 0
    : rows.reduce((s, r) => {
        const obs = r.outcome === 'true' ? 1 : r.outcome === 'partial' ? 0.5 : 0
        return s + (r.claimedConfidence - obs) ** 2
      }, 0) / rows.length
  return { buckets, brierScore: brier, n: rows.length }
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function emitEvent(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id:            uuidv7(),
    type,
    workspaceId,
    payload,
    traceId:       uuidv7(),
    correlationId: uuidv7(),
    causationId:   null,
    source:        'experiments',
    version:       1,
    createdAt:     Date.now(),
  }).catch((e: Error) => { console.error('[experiments]', e.message); return null })
  void sql  // keep import used
}
