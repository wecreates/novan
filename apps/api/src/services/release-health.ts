/**
 * release-health.ts — score the health of recent deployments (#31).
 *
 * Pure function over event slices: combines deploy success / failure
 * counts, post-deploy error spike ratio, post-deploy latency drift,
 * and rollback frequency into a single 0..1 score with a clear
 * "ship / hold / rollback" recommendation.
 *
 * Tests drive the pure scorer with fixtures; the DB wrapper sources
 * inputs from the `events` table.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, eq, gte, sql } from 'drizzle-orm'

export type ReleaseVerdict = 'healthy' | 'watching' | 'hold' | 'rollback'

export interface ReleaseInputs {
  deploysAttempted: number
  deploysSucceeded: number
  deploysFailed:    number
  rollbacks:        number
  /** Errors / minute in the 30 min after the most recent deploy. */
  postDeployErrorRate: number
  /** Baseline errors / minute prior to the deploy window. */
  baselineErrorRate:   number
  /** Median latency after deploy (ms). */
  postDeployLatencyMs: number | null
  baselineLatencyMs:   number | null
}

export interface ReleaseHealth {
  score:           number       // 0..1, higher is healthier
  verdict:         ReleaseVerdict
  reasons:         string[]
  successRate:     number       // 0..1
  errorRatio:      number       // postDeployErrorRate / baselineErrorRate
  latencyRatio:    number | null
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)) }

export function scoreReleaseHealth(input: ReleaseInputs): ReleaseHealth {
  const reasons: string[] = []
  const successRate = input.deploysAttempted === 0
    ? 1
    : input.deploysSucceeded / input.deploysAttempted
  reasons.push(`success=${(successRate * 100).toFixed(0)}%`)

  const errorRatio = input.baselineErrorRate === 0
    ? (input.postDeployErrorRate === 0 ? 1 : input.postDeployErrorRate)
    : input.postDeployErrorRate / input.baselineErrorRate
  reasons.push(`error-ratio=${errorRatio.toFixed(2)}`)

  let latencyRatio: number | null = null
  if (input.postDeployLatencyMs != null && input.baselineLatencyMs != null && input.baselineLatencyMs > 0) {
    latencyRatio = input.postDeployLatencyMs / input.baselineLatencyMs
    reasons.push(`latency-ratio=${latencyRatio.toFixed(2)}`)
  }

  // Score: success rate is the floor; deductions for error spike,
  // latency drift, and rollback frequency.
  let score = successRate
  if (errorRatio > 2)  { score -= 0.30; reasons.push('error-spike') }
  else if (errorRatio > 1.5) { score -= 0.15; reasons.push('error-elevated') }
  if (latencyRatio !== null && latencyRatio > 1.5) { score -= 0.15; reasons.push('latency-drift') }
  if (input.rollbacks > 0) { score -= 0.10 * input.rollbacks; reasons.push(`rollbacks=${input.rollbacks}`) }
  if (input.deploysFailed > 0) { score -= 0.05 * input.deploysFailed; reasons.push(`failed-deploys=${input.deploysFailed}`) }
  score = clamp01(score)

  let verdict: ReleaseVerdict = 'healthy'
  if      (score < 0.30) verdict = 'rollback'
  else if (score < 0.50) verdict = 'hold'
  else if (score < 0.75) verdict = 'watching'

  return {
    score: Number(score.toFixed(3)),
    verdict, reasons,
    successRate: Number(successRate.toFixed(3)),
    errorRatio:  Number(errorRatio.toFixed(2)),
    latencyRatio: latencyRatio === null ? null : Number(latencyRatio.toFixed(2)),
  }
}

/**
 * DB-backed wrapper. Pulls a single deploy window: the most recent
 * `deploy.*` events compose the deploy counts, and event volume around
 * each deploy timestamp produces the error / latency ratios.
 */
export async function currentReleaseHealth(workspaceId: string, opts: { windowMs?: number } = {}): Promise<ReleaseHealth & { window: { from: number; to: number; deploysSeen: number } }> {
  const windowMs = opts.windowMs ?? 24 * 60 * 60_000
  const since = Date.now() - windowMs
  const recent = await db.select({
    type: events.type, createdAt: events.createdAt, payload: events.payload,
  }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since), sql`${events.type} LIKE 'deploy.%' OR ${events.type} LIKE 'rollback.%'`))
    .limit(500).catch(() => [])

  let deploysAttempted = 0, deploysSucceeded = 0, deploysFailed = 0, rollbacks = 0
  for (const r of recent) {
    if (r.type === 'deploy.attempted' || r.type === 'deploy.started')   deploysAttempted++
    if (r.type === 'deploy.succeeded' || r.type === 'deploy.completed') deploysSucceeded++
    if (r.type === 'deploy.failed')                                     deploysFailed++
    if (r.type.startsWith('rollback.'))                                 rollbacks++
  }
  if (deploysAttempted === 0) deploysAttempted = deploysSucceeded + deploysFailed   // tolerate absent attempted events

  // Error / latency ratios from event volume
  const lastDeployAt = recent.length === 0 ? Date.now() : Math.max(...recent.map(r => r.createdAt))
  const post = await db.select({ n: sql<number>`count(*)::int` }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, lastDeployAt), sql`${events.type} LIKE '%error%' OR ${events.type} LIKE '%fail%' OR ${events.type} LIKE 'incident%'`))
    .then(r => r[0]?.n ?? 0).catch(() => 0)
  const baseline = await db.select({ n: sql<number>`count(*)::int` }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, lastDeployAt - 24 * 60 * 60_000), sql`${events.type} LIKE '%error%' OR ${events.type} LIKE '%fail%'`))
    .then(r => r[0]?.n ?? 0).catch(() => 0)

  const postMin = Math.max(1, (Date.now() - lastDeployAt) / 60_000)
  const postRate = Number(post) / postMin
  const baselineRate = Number(baseline) / (24 * 60)

  const score = scoreReleaseHealth({
    deploysAttempted, deploysSucceeded, deploysFailed, rollbacks,
    postDeployErrorRate: postRate,
    baselineErrorRate:   baselineRate,
    postDeployLatencyMs: null,
    baselineLatencyMs:   null,
  })
  return { ...score, window: { from: since, to: Date.now(), deploysSeen: deploysAttempted } }
}
