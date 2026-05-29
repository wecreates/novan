/**
 * autonomous-mind.ts — The 24/7 self-improvement meta-loop.
 *
 * Connects existing analytical services into a closed loop:
 *
 *   1. Detect capability gaps        (capability-gap-detector)
 *   2. For each gap → build plan     (self-build-planner)
 *   3. For drift warnings            (reality-correction is policy-gated)
 *   4. For low-risk recs untouched   → record decision chain
 *   5. Sweep research findings       (research-to-action handles this already)
 *
 * SPEC RULES:
 *   - Conservative: never patches code itself. Plans are persisted as
 *     improvement tasks; operator (or autonomous-orchestrator under its
 *     own approval policy) executes.
 *   - Every meta-decision is recorded as a reasoning_chain so drift +
 *     calibration can score it later.
 *   - Cron-budget gated so a bug can't run away.
 *   - Honest: returns counts of what it did, including 0s.
 */
import { detectGaps }                  from './capability-gap-detector.js'
import { planBuild, persistPlan }      from './self-build-planner.js'
import { record as recordChain }       from './reasoning-chains.js'
import { db }                          from '../db/client.js'
import { reasoningChains, driftWarnings, recommendationFeedback } from '../db/schema.js'
import { and, eq, gte, desc, sql } from 'drizzle-orm'
import { alignmentScore }              from './horizon-scorer.js'
import { proposeFromPlanWithSkills, persistProposal } from './code-writer.js'

export interface MindCycleResult {
  workspaceId:       string
  generatedAt:       number
  gapsDetected:      number
  buildPlansCreated: number
  proposalsCreated:  number
  driftWarningsSeen: number
  chainsRecorded:    number
  notes:             string[]
}

/**
 * Run one cycle of the meta-loop for a workspace.
 *
 * Safe to call repeatedly — every step is idempotent or guarded.
 */
export async function runMindCycle(workspaceId: string): Promise<MindCycleResult> {
  const { recordAgentActivityAsync } = await import('./agent-state-sync.js')
  recordAgentActivityAsync(workspaceId, 'research_planner', { status: 'running' })
  try {
    return await runMindCycleInner(workspaceId)
  } finally {
    recordAgentActivityAsync(workspaceId, 'research_planner', { status: 'idle' })
  }
}

async function runMindCycleInner(workspaceId: string): Promise<MindCycleResult> {
  const result: MindCycleResult = {
    workspaceId, generatedAt: Date.now(),
    gapsDetected: 0, buildPlansCreated: 0, proposalsCreated: 0,
    driftWarningsSeen: 0, chainsRecorded: 0, notes: [],
  }

  // Respect the autonomous_writes safety flag. Previously the mind
  // cycle queued buildPlans + proposals even after the operator pulled
  // the kill switch — by the time runAutoLoopFor checked the gate, 2-3
  // proposals had already landed in the DB.
  try {
    const { isAllowed } = await import('./safety-mode.js')
    // self_edit_loop is the broadest safety flag in scope here — when
    // it's off, the operator has opted out of brain-initiated writes.
    if (!(await isAllowed(workspaceId, 'self_edit_loop'))) {
      result.notes.push('self_edit_loop flag is OFF — mind cycle skipped (operator opted out)')
      return result
    }
  } catch (e) {
    result.notes.push(`safety check failed: ${(e as Error).message} — refusing cycle`)
    return result
  }

  // 1. Detect capability gaps
  const gaps = await detectGaps(workspaceId).catch(() => [])
  result.gapsDetected = gaps.length

  // 2. Filter buildable gaps by operator bias (recent rejections of similar)
  //    and rank by strategic-horizon alignment.
  const rejected = await db.select({ subjectId: reasoningChains.subjectId })
    .from(recommendationFeedback)
    .innerJoin(reasoningChains, eq(reasoningChains.id, recommendationFeedback.chainId))
    .where(and(
      eq(recommendationFeedback.workspaceId, workspaceId),
      eq(recommendationFeedback.action, 'reject'),
      gte(recommendationFeedback.createdAt, Date.now() - 30 * 24 * 60 * 60_000),
    )).catch(() => [])
  const rejectedSubjects = new Set(rejected.map(r => r.subjectId).filter(Boolean) as string[])

  let buildable = gaps.filter(g =>
    (g.buildVsBuy.verdict === 'build' || g.buildVsBuy.verdict === 'hybrid')
    && (g.maturity === 'missing' || g.maturity === 'scaffolded')
    && !rejectedSubjects.has(`mind:build:${g.id}`),    // honor operator rejection
  )

  // Rank by horizon alignment
  const ranked = await Promise.all(buildable.map(async g => ({
    g, alignment: (await alignmentScore(workspaceId, `${g.title} ${g.description}`)).score,
  })))
  ranked.sort((a, b) => b.alignment - a.alignment)
  buildable = ranked.map(r => r.g)

  let plansCreated = 0
  let proposalsCreated = 0
  for (const g of buildable.slice(0, 5)) {   // cap per-cycle so we don't flood
    const plan = await planBuild(workspaceId, g.id).catch((e: Error) => { console.error('[autonomous-mind]', e.message); return null })
    if (!plan) continue
    const r = await persistPlan(workspaceId, plan).catch((e: Error) => { console.error('[autonomous-mind]', e.message); return null })
    if (r && r.created > 0) {
      plansCreated += r.created
      await recordChain({
        workspaceId,
        kind: 'decision',
        subjectId: `mind:build:${g.id}`,
        decision: `Auto-queued build plan for capability "${g.title}" (verdict=${g.buildVsBuy.verdict}, maturity=${g.maturity})`,
        evidence: [{ type: 'capability_gap', id: g.id, extract: `${g.dimension} · ${g.maturity}` }],
        confidence: 0.6,
        source: 'autonomous-mind',
      }).then(() => result.chainsRecorded++).catch((e: Error) => { console.error('[autonomous-mind]', e.message); return null })

      // Generate a code proposal so the autonomy loop has an actionable artifact
      try {
        const proposal = await proposeFromPlanWithSkills(workspaceId, plan)
        await persistProposal(proposal)
        proposalsCreated++
      } catch { /* tolerated */ }
    }
  }
  result.buildPlansCreated = plansCreated
  result.proposalsCreated  = proposalsCreated

  // 3. Snapshot open drift warnings (reality-correction cron already acts on
  //    them per policy; we just count for status reporting)
  const open = await db.select({ id: driftWarnings.id })
    .from(driftWarnings)
    .where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.status, 'open')))
    .catch(() => [])
  result.driftWarningsSeen = open.length

  // 4. Operator feedback bias: read recent rejection feedback and reduce
  //    confidence on chains whose subjectId pattern matches rejected ones.
  //    This is a lightweight learning signal — already partly handled by
  //    recommendation-feedback.submitFeedback on reject. Here we record a
  //    meta-chain noting the operator's bias.
  const recentRejections = await db.select({ n: sql<number>`count(*)::int` })
    .from(recommendationFeedback)
    .where(and(
      eq(recommendationFeedback.workspaceId, workspaceId),
      eq(recommendationFeedback.action, 'reject'),
      gte(recommendationFeedback.createdAt, Date.now() - 7 * 24 * 60 * 60_000),
    )).then(r => Number(r[0]?.n ?? 0)).catch(() => 0)
  if (recentRejections >= 3) {
    await recordChain({
      workspaceId,
      kind: 'decision',
      subjectId: 'mind:operator_bias',
      decision: `Operator rejected ${recentRejections} recommendations in 7d — bias signal applied to future scoring`,
      evidence: [{ type: 'recommendation_feedback', id: 'aggregate', extract: `${recentRejections} rejections in window` }],
      confidence: 0.7,
      source: 'autonomous-mind',
    }).then(() => result.chainsRecorded++).catch((e: Error) => { console.error('[autonomous-mind]', e.message); return null })
  }

  result.notes = [
    `Detected ${gaps.length} capability gaps; ${buildable.length} buildable.`,
    `Created ${plansCreated} build plans this cycle.`,
    `${result.driftWarningsSeen} drift warnings currently open (reality-correction cron handles per policy).`,
    recentRejections > 0 ? `${recentRejections} operator rejections in last 7d.` : 'No recent operator rejections.',
  ]
  return result
}

/** Recent meta-decisions for UI/status. */
export async function recentMindChains(workspaceId: string, limit = 20) {
  return db.select().from(reasoningChains)
    .where(and(eq(reasoningChains.workspaceId, workspaceId), eq(reasoningChains.source, 'autonomous-mind')))
    .orderBy(desc(reasoningChains.createdAt))
    .limit(limit).catch(() => [])
}
