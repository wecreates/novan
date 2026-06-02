/**
 * R146.130 — Tier 2 batch: decision memory + prompt A/B harness + morning push briefing.
 */
import { db } from '../db/client.js'
import { operatorDecisions, promptAbTrials } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── P2.5 — Operator decision memory ─────────────────────────────────

export interface DecisionInput {
  subjectType: 'proposal' | 'improvement' | 'finding' | 'business' | 'channel' | 'content'
  subjectId:   string
  decision:    'approved' | 'rejected' | 'dismissed' | 'snoozed' | 'edited'
  reason?:     string
  features?:   Record<string, unknown>
}

export async function recordDecision(workspaceId: string, input: DecisionInput): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(operatorDecisions).values({
    id, workspaceId,
    subjectType: input.subjectType,
    subjectId:   input.subjectId,
    decision:    input.decision,
    reason:      input.reason ?? null,
    features:    input.features ?? {},
    decidedBy:   'operator',
    createdAt:   Date.now(),
  })
  return { id }
}

/**
 * Before filing a new suggestion/proposal, check whether the operator
 * has rejected/dismissed N similar items in the last D days. Used by
 * suggestions producer + proposal creators to stop spam.
 */
export async function shouldSuppress(workspaceId: string, opts: {
  subjectType: DecisionInput['subjectType']
  featuresToMatch: Record<string, unknown>
  windowDays?: number
  thresholdRejections?: number
}): Promise<{ suppress: boolean; matches: number; reasons: string[] }> {
  const windowDays = opts.windowDays ?? 30
  const threshold  = opts.thresholdRejections ?? 3
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const rows = await db.select({ reason: operatorDecisions.reason, features: operatorDecisions.features })
    .from(operatorDecisions)
    .where(and(
      eq(operatorDecisions.workspaceId, workspaceId),
      eq(operatorDecisions.subjectType, opts.subjectType),
      gte(operatorDecisions.createdAt, since),
      sql`${operatorDecisions.decision} IN ('rejected', 'dismissed')`,
    ))
    .limit(200)
  const matches: string[] = []
  for (const r of rows) {
    const feat = (r.features ?? {}) as Record<string, unknown>
    let allMatch = true
    for (const [k, v] of Object.entries(opts.featuresToMatch)) {
      if (feat[k] !== v) { allMatch = false; break }
    }
    if (allMatch && r.reason) matches.push(r.reason.slice(0, 120))
  }
  return { suppress: matches.length >= threshold, matches: matches.length, reasons: matches.slice(0, 5) }
}

// ─── P2.6 — Prompt A/B trial harness ─────────────────────────────────

export interface StartTrialInput {
  promptKey:     string
  variantA:      string       // champion
  variantB:      string       // challenger
  samplesTarget?: number      // default 20
}

export async function startTrial(workspaceId: string, input: StartTrialInput): Promise<{ id: string }> {
  if (!input.promptKey || !input.variantA || !input.variantB) throw new Error('promptKey, variantA, variantB required')
  const id = uuidv7()
  await db.insert(promptAbTrials).values({
    id, workspaceId,
    promptKey: input.promptKey,
    variantA: input.variantA,
    variantB: input.variantB,
    samplesTarget: Math.max(5, Math.min(input.samplesTarget ?? 20, 200)),
    startedAt: Date.now(),
  })
  return { id }
}

/**
 * Record an outcome for one sample of a trial. Caller has already run
 * both variants against the same input and decided which "won" (by
 * downstream metric: engagement, conversion, revenue, score, etc).
 *
 * outcome: 'a' | 'b' | 'tie'. When samples_done reaches samples_target
 * the trial auto-completes and winner is set.
 */
export async function recordTrialOutcome(workspaceId: string, trialId: string, outcome: 'a' | 'b' | 'tie'): Promise<{ status: string; winner?: string }> {
  const [row] = await db.select().from(promptAbTrials)
    .where(and(eq(promptAbTrials.workspaceId, workspaceId), eq(promptAbTrials.id, trialId)))
    .limit(1)
  if (!row) throw new Error('trial not found')
  if (row.status !== 'running') return { status: row.status, ...(row.winner ? { winner: row.winner } : {}) }

  const winsA = row.winsA + (outcome === 'a' ? 1 : 0)
  const winsB = row.winsB + (outcome === 'b' ? 1 : 0)
  const ties  = row.ties  + (outcome === 'tie' ? 1 : 0)
  const samplesDone = row.samplesDone + 1
  const reachedTarget = samplesDone >= row.samplesTarget
  const winner = reachedTarget
    ? (winsA > winsB + ties ? 'a' : winsB > winsA + ties ? 'b' : 'tie')
    : null
  await db.update(promptAbTrials).set({
    winsA, winsB, ties, samplesDone,
    status: reachedTarget ? 'completed' : 'running',
    winner,
    completedAt: reachedTarget ? Date.now() : null,
  }).where(eq(promptAbTrials.id, trialId))
  return { status: reachedTarget ? 'completed' : 'running', ...(winner ? { winner } : {}) }
}

export async function listTrials(workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<typeof promptAbTrials.$inferSelect>> {
  const limit = Math.min(opts.limit ?? 30, 100)
  const where = opts.status
    ? and(eq(promptAbTrials.workspaceId, workspaceId), eq(promptAbTrials.status, opts.status))
    : eq(promptAbTrials.workspaceId, workspaceId)
  return db.select().from(promptAbTrials).where(where).orderBy(desc(promptAbTrials.startedAt)).limit(limit)
}

// ─── P2.7 — Morning push briefing ───────────────────────────────────

/**
 * Build the morning briefing payload + send via existing web push.
 * Pulls autonomy.counts (R125) + top open proposals + critical findings.
 * Cron: 07:00 UTC daily.
 */
export async function sendMorningBriefing(workspaceId: string): Promise<{ sent: number; skipped: number }> {
  const { autonomyCounts } = await import('./r124-autonomy.js')
  const counts = await autonomyCounts(workspaceId)
  const lines: string[] = []
  if (counts.findingsOpen > 0)       lines.push(`${counts.findingsOpen} open security finding${counts.findingsOpen === 1 ? '' : 's'}`)
  if (counts.proposalsProposed > 0)  lines.push(`${counts.proposalsProposed} proposal${counts.proposalsProposed === 1 ? '' : 's'} awaiting review`)
  if (counts.connectorsNeedingRefresh > 0) lines.push(`${counts.connectorsNeedingRefresh} OAuth token${counts.connectorsNeedingRefresh === 1 ? '' : 's'} near expiry`)
  if (counts.opsInProcess > 0)       lines.push(`${counts.opsInProcess} agent task${counts.opsInProcess === 1 ? '' : 's'} in progress`)
  if (lines.length === 0)            lines.push('all clear · 0 open items')

  const body = lines.slice(0, 3).join(' · ')
  try {
    const { broadcastPush } = await import('./web-push.js')
    const r = await broadcastPush(workspaceId, {
      title: '☀ Novan · morning briefing',
      body,
      url: '/proposals',
      icon: '/icons/icon-192.png',
      tag: 'morning-briefing',
    } as Parameters<typeof broadcastPush>[1])
    return { sent: r.succeeded, skipped: r.errors.length }
  } catch {
    return { sent: 0, skipped: 1 }
  }
}
