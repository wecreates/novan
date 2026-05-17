/**
 * governance-core.ts — Autonomy boundaries + protected-system enforcement.
 *
 * This service is the deny-by-default boundary between autonomous agents
 * and the platform's core. It does three things:
 *
 *   1. classifyAutonomousAction(intent) — decides if an action is safe to
 *      auto-apply, must require approval, or is hard-blocked.
 *   2. isProtectedPath(filePath) — blocks autonomous patches that would
 *      modify orchestration / rollback / approval / security / governance
 *      / deployment code without explicit human review.
 *   3. stabilitySnapshot(workspaceId) — surfaces real signs of instability
 *      (event spam, repeated failed patches, runaway research, cost spikes)
 *      so the governor can throttle.
 *
 * All decisions emit `governance.*` events. No hidden throttling.
 */
import { db }                          from '../db/client.js'
import { events, failureMemory, providerBudgets, incidents } from '../db/schema.js'
import { and, eq, gte, sql }           from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

// ─── Protected paths ─────────────────────────────────────────────────────────

/** Globs autonomous patches MUST NOT touch without human approval. */
const PROTECTED_PATHS: RegExp[] = [
  // Core orchestration + replay + rollback
  /\/services\/(autonomous-orchestrator|orchestrator|workflow-engine|replay-engine|rollback|recovery)\.ts$/,
  // Security + auth
  /\/services\/(auth|secrets-vault|secret-redactor|security-monitor|security-team|rbac|tenant-isolation)\.ts$/,
  /\/services\/research-safety\.ts$/,
  // Governance + budget
  /\/services\/(governance-core|resource-governor|agent-coordinator|safety-mode|launch-gate)\.ts$/,
  /\/services\/(budget|provider-router|kill-switch|approval)/,
  // Deployment + infra
  /\/(Dockerfile|docker-compose\.[a-z]+\.yml|drizzle\.config\.ts)$/,
  /\/services\/(deployment|infra-validator|production-readiness)\.ts$/,
  // Verification + patch pipeline
  /\/services\/(verification-engine|patch-executor|agent-patch-pipeline|risk-classifier)\.ts$/,
  // Database schema
  /\/packages\/db\/src\/schema\.ts$/,
]

export function isProtectedPath(filePath: string): { protected: boolean; pattern?: string } {
  for (const p of PROTECTED_PATHS) {
    if (p.test(filePath)) return { protected: true, pattern: p.source }
  }
  return { protected: false }
}

// ─── Autonomous action classifier ────────────────────────────────────────────

export type AutonomousIntent =
  | 'spawn_agent'
  | 'modify_prompt'
  | 'modify_core_runtime'
  | 'apply_patch'
  | 'deploy'
  | 'modify_provider_routing'
  | 'modify_budget'
  | 'modify_security_policy'
  | 'modify_kill_switch'
  | 'bypass_approval'
  | 'bypass_budget'
  | 'bypass_kill_switch'
  | 'bypass_verification'
  | 'recursive_self_modify'

export type ClassifyDecision = 'auto_apply_ok' | 'requires_approval' | 'hard_blocked'

const HARD_BLOCK_INTENTS: AutonomousIntent[] = [
  'bypass_approval', 'bypass_budget', 'bypass_kill_switch', 'bypass_verification',
  'recursive_self_modify',
]
const REQUIRES_APPROVAL_INTENTS: AutonomousIntent[] = [
  'modify_core_runtime', 'deploy', 'modify_provider_routing',
  'modify_budget', 'modify_security_policy', 'modify_kill_switch',
]

export interface ClassifyResult {
  decision: ClassifyDecision
  reason:   string
  intent:   AutonomousIntent
  context?: Record<string, unknown>
}

export function classifyAutonomousAction(intent: AutonomousIntent, context?: Record<string, unknown>): ClassifyResult {
  if (HARD_BLOCK_INTENTS.includes(intent)) {
    return { decision: 'hard_blocked', intent, reason: `intent '${intent}' is permanently blocked for autonomous agents`, ...(context !== undefined ? { context } : {}) }
  }
  if (REQUIRES_APPROVAL_INTENTS.includes(intent)) {
    return { decision: 'requires_approval', intent, reason: `intent '${intent}' requires human approval`, ...(context !== undefined ? { context } : {}) }
  }
  // For apply_patch + spawn_agent + modify_prompt — caller must pass file paths to check
  if (intent === 'apply_patch' && context && Array.isArray(context['filePaths'])) {
    for (const fp of context['filePaths'] as string[]) {
      const p = isProtectedPath(fp)
      if (p.protected) {
        return { decision: 'requires_approval', intent, reason: `patch touches protected path: ${fp}`, context }
      }
    }
  }
  return { decision: 'auto_apply_ok', intent, reason: 'no boundary violated', ...(context !== undefined ? { context } : {}) }
}

// ─── Governance emission ─────────────────────────────────────────────────────

export async function emitGovernance(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type: `governance.${type}`, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'governance-core', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

/** Wrap an autonomous attempt — emits event + returns decision. */
export async function gate(opts: {
  workspaceId: string
  intent:      AutonomousIntent
  context?:    Record<string, unknown>
}): Promise<ClassifyResult> {
  const result = classifyAutonomousAction(opts.intent, opts.context)
  if (result.decision !== 'auto_apply_ok') {
    await emitGovernance(opts.workspaceId,
      result.decision === 'hard_blocked' ? 'autonomous_action_blocked' : 'autonomous_action_requires_approval',
      { intent: opts.intent, reason: result.reason, context: opts.context })
  }
  return result
}

// ─── Stability snapshot ──────────────────────────────────────────────────────

const HOUR = 60 * 60_000
const DAY  = 24 * HOUR

export interface StabilityIndicator {
  name:      string
  value:     number
  threshold: number
  unstable:  boolean
  detail?:   string
}

export interface StabilitySnapshot {
  workspaceId: string
  capturedAt:  number
  overall:     'stable' | 'attention' | 'unstable'
  indicators:  StabilityIndicator[]
  recommendedThrottle: boolean
}

export async function stabilitySnapshot(workspaceId: string): Promise<StabilitySnapshot> {
  const hourAgo = Date.now() - HOUR
  const dayAgo  = Date.now() - DAY

  const [
    eventVolHour, sameTypeMaxHour,
    failedPatch24h, deploymentFail24h,
    spendDelta, runawayResearch,
    openCriticalIncidents,
    rollback24h,
  ] = await Promise.all([
    // Total events / hour
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, hourAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    // Highest single event-type count in last hour (spam detector)
    db.select({
      type: events.type,
      c: sql<number>`count(*)::int`,
    }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, hourAgo)))
      .groupBy(events.type)
      .orderBy(sql`count(*) desc`)
      .limit(1)
      .then(r => ({ type: r[0]?.type ?? '', count: Number(r[0]?.c ?? 0) }))
      .catch(() => ({ type: '', count: 0 })),

    // Failed patches in last 24h (failure_memory recent occurrences)
    db.select({ c: sql<number>`coalesce(sum(${failureMemory.occurrenceCount}), 0)::int` }).from(failureMemory)
      .where(and(eq(failureMemory.workspaceId, workspaceId), gte(failureMemory.lastSeenAt, dayAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    // Deployment failures in 24h
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'deployment.failed'), gte(events.createdAt, dayAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    // Provider spend delta (current daily % vs alert threshold)
    db.select().from(providerBudgets)
      .where(eq(providerBudgets.workspaceId, workspaceId)).limit(1)
      .then(r => {
        const row = r[0]
        if (!row || row.dailyLimitUsd <= 0) return 0
        return Number((row.dailySpendUsd / row.dailyLimitUsd).toFixed(3))
      }).catch(() => 0),

    // Runaway research: research.run_started without matching run_completed in 1h
    db.select({
      started:   sql<number>`count(*) filter (where ${events.type} = 'research.run_started')::int`,
      completed: sql<number>`count(*) filter (where ${events.type} = 'research.run_completed')::int`,
    }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, hourAgo)))
      .then(r => {
        const s = Number(r[0]?.started ?? 0)
        const c = Number(r[0]?.completed ?? 0)
        return Math.max(0, s - c)
      }).catch(() => 0),

    db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open'), eq(incidents.severity, 'critical')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'patch.rolled_back'), gte(events.createdAt, dayAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
  ])

  const indicators: StabilityIndicator[] = [
    { name: 'events_per_hour',         value: eventVolHour,            threshold: 5000, unstable: eventVolHour            > 5000 },
    { name: 'event_type_max_per_hour', value: sameTypeMaxHour.count,   threshold: 500,  unstable: sameTypeMaxHour.count   > 500, detail: sameTypeMaxHour.type },
    { name: 'failures_24h',            value: failedPatch24h,          threshold: 50,   unstable: failedPatch24h          > 50 },
    { name: 'deployment_failures_24h', value: deploymentFail24h,       threshold: 3,    unstable: deploymentFail24h       > 3 },
    { name: 'daily_spend_pct',         value: Math.round(spendDelta * 100), threshold: 90, unstable: spendDelta * 100 > 90 },
    { name: 'runaway_research_open',   value: runawayResearch,         threshold: 5,    unstable: runawayResearch         > 5 },
    { name: 'open_critical_incidents', value: openCriticalIncidents,   threshold: 1,    unstable: openCriticalIncidents   >= 1 },
    { name: 'rollbacks_24h',           value: rollback24h,             threshold: 5,    unstable: rollback24h             > 5 },
  ]

  const unstableCount = indicators.filter(i => i.unstable).length
  const overall: StabilitySnapshot['overall'] =
      unstableCount === 0 ? 'stable'
    : unstableCount <= 2  ? 'attention'
    :                       'unstable'

  // Recommend throttle if any critical signals or >=2 unstable indicators
  const recommendedThrottle = unstableCount >= 2 || openCriticalIncidents >= 1 || (spendDelta * 100) >= 95

  return {
    workspaceId, capturedAt: Date.now(),
    overall, indicators, recommendedThrottle,
  }
}

// ─── Daily counters: autonomous patches + deployments ────────────────────────
// Lightweight in-process — read-only counts are derived from events table on demand.

export async function autonomousPatchesToday(workspaceId: string): Promise<number> {
  const dayAgo = Date.now() - DAY
  return db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      sql`${events.type} in ('patch.applied','patch.auto_applied')`,
      gte(events.createdAt, dayAgo),
    ))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
}

export async function deploymentsToday(workspaceId: string): Promise<number> {
  const dayAgo = Date.now() - DAY
  return db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      sql`${events.type} in ('deployment.started','deployment.completed')`,
      gte(events.createdAt, dayAgo),
    ))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
}

export const GOVERNANCE_DAILY_LIMITS = {
  maxAutonomousPatches: Number(process.env['GOV_MAX_AUTO_PATCHES_DAY'] ?? 20),
  maxDeployments:       Number(process.env['GOV_MAX_DEPLOYS_DAY']      ?? 5),
}
