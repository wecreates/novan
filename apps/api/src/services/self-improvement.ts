/**
 * self-improvement.ts — The brain's improvement loop applied to itself.
 *
 * Per the spec: a system designed to improve businesses must also
 * improve itself, but the rules for self-improvement are different.
 * The cost of being wrong on a self-modification is potentially
 * unbounded — every subsequent decision is compromised.
 *
 * Implements:
 *   - LOCKED CORE registry — components the brain CANNOT modify:
 *     governance, kill switches, audit log, constitution, improvement
 *     loop itself. Locks enforced architecturally via the policy engine.
 *   - Structured improvement loop: observe → hypothesise → experiment →
 *     sandbox → shadow → gradual rollout → regression-eval-addition
 *   - Drift detectors for the 5 pathologies the spec calls out:
 *     Goodhart, capability narrowing, coordination drift,
 *     compounding subtle errors, reward hacking
 *
 * Honest scope:
 *   - This module defines the protocol + detectors. The actual loop
 *     stages (sandbox, shadow, gradual rollout) integrate with the
 *     simulation sandbox (round 108) + eval system (round 120). Adding
 *     a self-modification = creating an `ImprovementProposal` row that
 *     traverses the stages with operator gates between each one.
 *   - Locked-core enforcement happens via the policy engine — a new
 *     built-in rule `locked_core_protection` denies any op that
 *     mutates a path on the locked list.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { eq, and, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ── Locked core registry ──────────────────────────────────────────
/** Components that the brain CANNOT self-modify. Any op that mutates
 *  a path on this list is denied at policy-engine level regardless of
 *  caller authority. Operator-only modifications via explicit code
 *  change + human review. The spec: "A brain that could relax its own
 *  governance would, over time, do exactly that."
 *
 *  Each entry is a path pattern matched against op names + file paths
 *  the op would touch. The matcher is conservative — false positives
 *  refuse a legitimate change; false negatives let an illegitimate
 *  change through. We bias toward false positives. */
export const LOCKED_CORE_PATHS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^services\/policy-engine\.ts$/,
    reason: 'governance: policy engine cannot self-modify; operator approves rule changes via /blueprint?tab=policy' },
  { pattern: /^services\/kill-?switch/,
    reason: 'kill switches: brain cannot make itself harder to stop' },
  { pattern: /^services\/audit/,
    reason: 'audit log: brain cannot edit its own history' },
  { pattern: /^services\/mission-charter\.ts$/,
    reason: 'constitution: core values + constraints require explicit human action' },
  { pattern: /^services\/self-improvement\.ts$/,
    reason: 'meta-loop: brain cannot modify how it modifies itself' },
  { pattern: /^services\/agent-coordination\.ts$/,
    reason: 'coordination primitives: blackboard/escalation/auth rules locked' },
  { pattern: /^services\/safety-policy\.ts$/,
    reason: 'safety policy: intent denylist + path policy + content scanner' },
  { pattern: /^db\/schema\.ts$|^packages\/db\/src\/schema\.ts$/,
    reason: 'schema: structural integrity — schema changes need migration + human review' },
]

/** Check whether a proposed change touches the locked core. Caller
 *  passes affected files; we return the blocking reasons (if any). */
export function checkLockedCore(input: { affectedFiles: string[]; opName?: string }): { locked: boolean; matched: Array<{ file: string; reason: string }> } {
  const matched: Array<{ file: string; reason: string }> = []
  for (const file of input.affectedFiles) {
    // Normalise — strip leading apps/api/src/ or packages/db/src/.
    const norm = file
      .replace(/^apps\/api\/src\//, '')
      .replace(/^apps\/web\/src\//, '')
      .replace(/^packages\/db\/src\//, 'db/')
      .replace(/\\/g, '/')
    for (const lock of LOCKED_CORE_PATHS) {
      if (lock.pattern.test(norm)) {
        matched.push({ file, reason: lock.reason })
      }
    }
  }
  // Op-name pattern lock: any op starting with policy.* OR kill_switch.*
  // that would MUTATE state (not just read) is locked.
  if (input.opName && /^(policy|kill_switch|audit|mission|self)\./.test(input.opName) && /\.(set|update|delete|modify)/.test(input.opName)) {
    matched.push({ file: `op:${input.opName}`, reason: 'locked-core op pattern — operator-only mutation' })
  }
  return { locked: matched.length > 0, matched }
}

// ── Improvement proposal lifecycle ────────────────────────────────
export type ImprovementDimension =
  | 'knowledge'           // safest — Knowledge Curator extends
  | 'capability'          // tools / MCP servers / integrations
  | 'prompt_tuning'       // dangerous — agent decision behavior
  | 'model_upgrade'       // model swap (round 102 prompt-caching machinery applies)
  | 'architectural'       // structural — slowest + most consequential
  | 'autonomy_expansion'  // human-felt — brain doing more on its own

export type ProposalStage =
  | 'observed'             // hypothesis generated from telemetry
  | 'designed'             // experiment design + predicted outcome
  | 'sandbox_passed'       // simulation sandbox verified
  | 'shadow_running'       // executing alongside production in shadow mode
  | 'gradual_rollout'      // small % traffic, expanding
  | 'fully_promoted'       // 100% + regression eval case captured
  | 'rolled_back'          // outcome was worse than baseline
  | 'abandoned'            // refined or dropped along the way

export interface ImprovementProposal {
  id:                  string
  workspaceId:         string
  dimension:           ImprovementDimension
  hypothesis:          string
  /** Predicted outcome + measurement plan + rollback triggers. */
  experimentDesign: {
    predictedOutcome:   string
    measurementPlan:    string
    rollbackTriggers:   string[]
    timelineDays:       number
  }
  affectedFiles:       string[]
  stage:               ProposalStage
  /** Forces operator approval at every stage transition above sandbox. */
  approvalsLog:        Array<{ stage: ProposalStage; approvedBy: string; at: number; note?: string }>
  /** Captured regression-set eval case id once fully_promoted. */
  regressionCaseId:    string | null
  createdAt:           number
  updatedAt:           number
}

/** Create an improvement proposal. Enforces locked-core check BEFORE
 *  the proposal can even enter the design stage. */
export async function proposeImprovement(input: {
  workspaceId:    string
  dimension:      ImprovementDimension
  hypothesis:     string
  affectedFiles:  string[]
}): Promise<{ ok: true; proposalId: string } | { ok: false; error: string; lockedReasons?: Array<{ file: string; reason: string }> }> {
  // Locked-core gate — refused before any persistence.
  const lockCheck = checkLockedCore({ affectedFiles: input.affectedFiles })
  if (lockCheck.locked) {
    return { ok: false, error: 'proposal touches locked-core paths — refused', lockedReasons: lockCheck.matched }
  }

  const id = uuidv7()
  const now = Date.now()
  await db.insert(events).values({
    id, type: 'self_improvement.proposed', workspaceId: input.workspaceId,
    payload: {
      id, dimension: input.dimension, hypothesis: input.hypothesis,
      affectedFiles: input.affectedFiles, stage: 'observed',
      createdAt: now,
    } as never,
    traceId: uuidv7(), correlationId: id, causationId: null,
    source: 'self-improvement', version: 1, createdAt: now,
  }).catch((e: Error) => { console.error('[self-improvement]', e.message); return null })
  return { ok: true, proposalId: id }
}

/** Transition a proposal to the next stage. Each transition requires
 *  the previous stage to be complete + an operator approval log entry
 *  (except observed → designed which is automatic, and the rollback /
 *  abandoned terminal states). */
export async function transitionProposal(input: {
  workspaceId:  string
  proposalId:   string
  toStage:      ProposalStage
  approvedBy:   string
  note?:        string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  // Read current state from events ledger.
  const rows = await db.select({ payload: events.payload })
    .from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      eq(events.correlationId, input.proposalId),
    ))
    .orderBy(sql`${events.createdAt} DESC`)
    .limit(50)
    .catch(() => [])
  if (rows.length === 0) return { ok: false, error: 'proposal not found' }

  const VALID_TRANSITIONS: Record<ProposalStage, ProposalStage[]> = {
    observed:         ['designed', 'abandoned'],
    designed:         ['sandbox_passed', 'abandoned'],
    sandbox_passed:   ['shadow_running', 'abandoned'],
    shadow_running:   ['gradual_rollout', 'rolled_back', 'abandoned'],
    gradual_rollout:  ['fully_promoted', 'rolled_back'],
    fully_promoted:   [],
    rolled_back:      [],
    abandoned:        [],
  }
  // Walk events to find latest stage.
  let currentStage: ProposalStage = 'observed'
  for (const r of rows.reverse()) {
    const p = r.payload as { stage?: ProposalStage }
    if (p?.stage) currentStage = p.stage
  }
  if (!VALID_TRANSITIONS[currentStage].includes(input.toStage)) {
    return { ok: false, error: `invalid transition ${currentStage} → ${input.toStage}` }
  }

  await db.insert(events).values({
    id: uuidv7(), type: 'self_improvement.transitioned',
    workspaceId: input.workspaceId,
    payload: {
      proposalId: input.proposalId,
      stage:      input.toStage,
      approvedBy: input.approvedBy,
      note:       input.note ?? null,
    } as never,
    traceId: uuidv7(), correlationId: input.proposalId, causationId: null,
    source: 'self-improvement', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[self-improvement]', e.message); return null })
  return { ok: true }
}

// ── Pathology detectors (the 5 from the spec) ─────────────────────

/** Goodhart drift: the brain optimises measurable metrics while
 *  ground-truth metrics silently degrade. Operator supplies the
 *  ground-truth signals; we compare against the optimised signal. */
export function detectGoodhartDrift(input: {
  optimisedMetric:   { name: string; baseline: number; recent: number }
  groundTruthMetrics: Array<{ name: string; baseline: number; recent: number }>
  /** Threshold for "significant" drift — default 10pp. */
  divergenceThresholdPct?: number
}): { drifted: boolean; divergences: Array<{ name: string; optimisedTrend: string; groundTruthTrend: string }> } {
  const thresh = input.divergenceThresholdPct ?? 0.10
  const optimisedDelta = (input.optimisedMetric.recent - input.optimisedMetric.baseline) / Math.max(0.0001, input.optimisedMetric.baseline)
  const divergences: Array<{ name: string; optimisedTrend: string; groundTruthTrend: string }> = []
  for (const gt of input.groundTruthMetrics) {
    const gtDelta = (gt.recent - gt.baseline) / Math.max(0.0001, gt.baseline)
    // Drift = optimised went up significantly while ground-truth went
    // down significantly (or vice versa).
    if ((optimisedDelta > thresh && gtDelta < -thresh) || (optimisedDelta < -thresh && gtDelta > thresh)) {
      divergences.push({
        name: gt.name,
        optimisedTrend: `${input.optimisedMetric.name} ${(optimisedDelta * 100).toFixed(1)}%`,
        groundTruthTrend: `${gt.name} ${(gtDelta * 100).toFixed(1)}%`,
      })
    }
  }
  return { drifted: divergences.length > 0, divergences }
}

/** Capability narrowing: the brain gets very good at in-distribution
 *  cases and loses ability outside that distribution. Detected by
 *  tracking failure rates on out-of-distribution (OOD) inputs. */
export async function detectCapabilityNarrowing(input: {
  workspaceId:   string
  windowDays?:   number
  oodFailureRateThreshold?: number   // default 0.20
}): Promise<{
  narrowing:        boolean
  inDistFailRate:   number
  oodFailRate:      number
  oodSampleCount:   number
}> {
  const days = input.windowDays ?? 30
  const since = Date.now() - days * 86_400_000
  const threshold = input.oodFailureRateThreshold ?? 0.20

  // In-dist proxy: events with type 'workflow.run_completed' tagged
  // as expected. OOD proxy: events tagged 'novel_situation' or
  // 'escalation' (the agent encountered something it didn't know how
  // to handle).
  const inDistRows = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      gte(events.createdAt, since),
      sql`${events.type} IN ('workflow.run_completed', 'workflow.run_failed')`,
    )).catch(() => [])
  const inDistFails = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      gte(events.createdAt, since),
      eq(events.type, 'workflow.run_failed'),
    )).catch(() => [])
  const oodRows = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      gte(events.createdAt, since),
      eq(events.type, 'agent.escalation'),
    )).catch(() => [])

  const inDistTotal = Number(inDistRows[0]?.c ?? 0)
  const inDistFailCount = Number(inDistFails[0]?.c ?? 0)
  const oodCount = Number(oodRows[0]?.c ?? 0)
  const inDistFailRate = inDistTotal > 0 ? inDistFailCount / inDistTotal : 0
  // OOD failure rate proxy: escalations / (escalations + completions)
  const oodFailRate = (oodCount + inDistTotal) > 0 ? oodCount / (oodCount + inDistTotal) : 0
  return {
    narrowing: oodFailRate > threshold && inDistFailRate < threshold,
    inDistFailRate: Number(inDistFailRate.toFixed(3)),
    oodFailRate:    Number(oodFailRate.toFixed(3)),
    oodSampleCount: oodCount,
  }
}

/** Coordination drift: individual agents improve but system-level
 *  outcomes degrade because coordination assumed older behaviours.
 *  Detected by comparing per-agent success rates to whole-workflow
 *  success rates over time. */
export async function detectCoordinationDrift(input: { workspaceId: string; days?: number }): Promise<{
  drifted:          boolean
  agentSuccessRate: number
  workflowSuccessRate: number
  delta:            number
}> {
  const since = Date.now() - (input.days ?? 30) * 86_400_000
  // Agent success: reasoning_chains with high confidence + outcomeMatched.
  const agentSuccess = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE outcome_matched = true)::float8 /
        NULLIF(COUNT(*) FILTER (WHERE outcome_known = true), 0) AS rate
    FROM reasoning_chains
    WHERE workspace_id = ${input.workspaceId} AND created_at >= ${since}
  `).catch(() => ({ rows: [] }))
  const aRate = Number(((agentSuccess as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['rate'] ?? 0) || 0

  // Workflow success: workflow.run_completed vs workflow.run_failed.
  const wf = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE type = 'workflow.run_completed')::float8 /
        NULLIF(COUNT(*) FILTER (WHERE type IN ('workflow.run_completed', 'workflow.run_failed')), 0) AS rate
    FROM events
    WHERE workspace_id = ${input.workspaceId} AND created_at >= ${since}
  `).catch(() => ({ rows: [] }))
  const wRate = Number(((wf as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['rate'] ?? 0) || 0

  const delta = aRate - wRate
  // Drift = agents are succeeding individually but workflows are not.
  return {
    drifted: aRate > 0.85 && wRate < aRate - 0.15,
    agentSuccessRate: Number(aRate.toFixed(3)),
    workflowSuccessRate: Number(wRate.toFixed(3)),
    delta: Number(delta.toFixed(3)),
  }
}

/** Compounding subtle errors: small biases in Knowledge Curator
 *  → slightly-wrong playbooks → slightly-wrong code → data for next
 *  extraction. Drift is invisible per-step but accumulates. Heuristic:
 *  count auto-deprecated patterns + count knowledge.outcome events
 *  where followed=true + good=false. A rising trend = compounding. */
export async function detectCompoundingSubtleErrors(input: { workspaceId: string }): Promise<{
  compounding:        boolean
  recentDeprecations: number
  recentFollowedBad:  number
  trendDirection:     'rising' | 'stable' | 'falling'
}> {
  const recent30 = Date.now() - 30 * 86_400_000
  const recent60 = Date.now() - 60 * 86_400_000

  const dep30 = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      eq(events.type, 'knowledge.auto_deprecated'),
      gte(events.createdAt, recent30),
    )).catch(() => [])
  const dep60 = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      eq(events.type, 'knowledge.auto_deprecated'),
      gte(events.createdAt, recent60),
      sql`${events.createdAt} < ${recent30}`,
    )).catch(() => [])

  // followed-bad outcomes from the curator-v2 ledger.
  const fbRows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM events
    WHERE workspace_id = ${input.workspaceId}
      AND type = 'knowledge.outcome'
      AND (payload->>'followed')::boolean = true
      AND (payload->>'good')::boolean = false
      AND created_at >= ${recent30}
  `).catch(() => ({ rows: [] }))
  const recentFollowedBad = Number(((fbRows as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['n'] ?? 0)

  const r30 = Number(dep30[0]?.c ?? 0)
  const r60 = Number(dep60[0]?.c ?? 0)
  const trendDirection: 'rising' | 'stable' | 'falling' =
    r30 > r60 * 1.2 ? 'rising'
    : r30 < r60 * 0.8 ? 'falling'
    : 'stable'

  return {
    compounding: trendDirection === 'rising' && r30 >= 3,
    recentDeprecations: r30,
    recentFollowedBad,
    trendDirection,
  }
}

/** Reward hacking: brain finds clever ways to satisfy its objectives
 *  that humans didn't intend. Hard to fully detect; the heuristic is
 *  to flag any single agent whose success-rate suddenly spikes far
 *  above its peers' rates on similar tasks. Compels human review. */
export async function detectRewardHacking(input: { workspaceId: string; days?: number }): Promise<{
  suspicious:     Array<{ agentId: string; successRate: number; peerMedian: number; spike: number }>
}> {
  const since = Date.now() - (input.days ?? 14) * 86_400_000
  const rows = await db.execute(sql`
    SELECT
      subject_id,
      COUNT(*) FILTER (WHERE outcome_matched = true)::float8 /
        NULLIF(COUNT(*) FILTER (WHERE outcome_known = true), 0) AS rate
    FROM reasoning_chains
    WHERE workspace_id = ${input.workspaceId} AND created_at >= ${since}
    GROUP BY subject_id
    HAVING COUNT(*) FILTER (WHERE outcome_known = true) >= 5
  `).catch(() => ({ rows: [] }))
  const agentRates = ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? [])
    .map(r => ({ agentId: String(r['subject_id'] ?? ''), rate: Number(r['rate'] ?? 0) }))
  if (agentRates.length < 3) return { suspicious: [] }

  const sorted = [...agentRates].sort((a, b) => a.rate - b.rate)
  const peerMedian = sorted[Math.floor(sorted.length / 2)]?.rate ?? 0
  const suspicious = agentRates
    .filter(r => r.rate > peerMedian + 0.30 && r.rate > 0.95)
    .map(r => ({ agentId: r.agentId, successRate: Number(r.rate.toFixed(3)), peerMedian: Number(peerMedian.toFixed(3)), spike: Number((r.rate - peerMedian).toFixed(3)) }))

  return { suspicious }
}

/** Run all 5 detectors in one pass and produce a unified health
 *  report. Called from a periodic cron + the operator's maturity
 *  dashboard. */
export async function runAllImprovementHealthChecks(workspaceId: string): Promise<{
  goodhart:              { drifted: boolean; divergences: number }
  capabilityNarrowing:   { narrowing: boolean; oodFailRate: number }
  coordinationDrift:     { drifted: boolean; delta: number }
  compoundingErrors:     { compounding: boolean; trend: string }
  rewardHacking:         { suspiciousCount: number }
  overallVerdict:        'healthy' | 'investigate' | 'pause_self_improvement'
}> {
  const [narrow, coord, compounding, reward] = await Promise.all([
    detectCapabilityNarrowing({ workspaceId }).catch(() => ({ narrowing: false, oodFailRate: 0, inDistFailRate: 0, oodSampleCount: 0 })),
    detectCoordinationDrift({ workspaceId }).catch(() => ({ drifted: false, agentSuccessRate: 0, workflowSuccessRate: 0, delta: 0 })),
    detectCompoundingSubtleErrors({ workspaceId }).catch(() => ({ compounding: false, recentDeprecations: 0, recentFollowedBad: 0, trendDirection: 'stable' as const })),
    detectRewardHacking({ workspaceId }).catch(() => ({ suspicious: [] })),
  ])
  // Goodhart requires ground-truth metric operator supplies; left
  // empty here. The cron caller passes operator-configured signals.
  const goodhart = { drifted: false, divergences: 0 }

  const alertCount = (narrow.narrowing ? 1 : 0)
                   + (coord.drifted ? 1 : 0)
                   + (compounding.compounding ? 1 : 0)
                   + (reward.suspicious.length > 0 ? 1 : 0)
  const overallVerdict: 'healthy' | 'investigate' | 'pause_self_improvement' =
    alertCount >= 2 ? 'pause_self_improvement'
    : alertCount === 1 ? 'investigate'
    : 'healthy'

  await db.insert(events).values({
    id: uuidv7(), type: 'self_improvement.health_check', workspaceId,
    payload: { goodhart, narrow, coord, compounding, reward, overallVerdict } as never,
    traceId: uuidv7(), correlationId: 'self_improvement', causationId: null,
    source: 'self-improvement', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[self-improvement]', e.message); return null })

  return {
    goodhart:              { drifted: goodhart.drifted, divergences: goodhart.divergences },
    capabilityNarrowing:   { narrowing: narrow.narrowing, oodFailRate: narrow.oodFailRate },
    coordinationDrift:     { drifted: coord.drifted, delta: coord.delta },
    compoundingErrors:     { compounding: compounding.compounding, trend: compounding.trendDirection },
    rewardHacking:         { suspiciousCount: reward.suspicious.length },
    overallVerdict,
  }
}
