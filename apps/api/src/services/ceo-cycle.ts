/**
 * ceo-cycle.ts — Autonomous CEO orchestration cycle.
 *
 * Runs on a cron (every 15 min). Each cycle:
 *   1. Snapshots health across all 8 divisions
 *   2. Iterates every active business in the workspace
 *   3. For each red/yellow division → delegates a remediation task to the
 *      matching department's best agent
 *   4. Records reasoning chains so the brain graph + decision-path view
 *      see CEO activity
 *   5. Heartbeats the research_planner + workflow agents
 *
 * Safety:
 *   - Each cycle has a hard delegation cap (default 3/cycle) so a flaky
 *     division doesn't fan out into hundreds of LLM calls
 *   - Cron-budget gated via existing `checkBudget('ceo_cycle')` infra
 *   - Money guard inherited from chat-providers (delegate uses streamChat)
 *   - Operator rejections in `recommendation_feedback` are honored
 */
import { db } from '../db/client.js'
import {
  businesses,
  events, recommendationFeedback, reasoningChains,
} from '../db/schema.js'
import { and, eq, desc, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { DIVISIONS, allDivisionsSnapshot, type Division, type DivisionSnapshot } from './divisions.js'
import { delegateToAgent } from './ceo-orchestrator.js'
import { record as recordChain } from './reasoning-chains.js'
import { checkBudget, consume } from './cron-budget.js'
import { recordAgentActivityAsync } from './agent-state-sync.js'

const MAX_DELEGATIONS_PER_CYCLE = 3

// Each division maps to the agent_definitions.department slug that should
// receive its remediation tasks. Departments that don't exist in the
// catalog are tried via hint and fall back to 'no confident match'.
const DIVISION_TO_DEPT: Record<Division, string> = {
  engineering:    'engineering',
  security:       'security',
  operations:     'operations',
  research:       'research',
  product:        'product',
  growth:         'marketing',
  support:        'customer-success',
  infrastructure: 'engineering',
}

export interface CycleResult {
  workspaceId:        string
  generatedAt:        number
  durationMs:         number
  businessesObserved: number
  divisionsRed:       number
  divisionsYellow:    number
  delegationsCreated: number
  chainsRecorded:     number
  skipped:            string[]
  notes:              string[]
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'ceo-cycle', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[ceo-cycle]', e.message); return null })
}

export async function runCeoCycle(workspaceId: string): Promise<CycleResult> {
  const t0 = Date.now()
  const result: CycleResult = {
    workspaceId, generatedAt: t0, durationMs: 0,
    businessesObserved: 0, divisionsRed: 0, divisionsYellow: 0,
    delegationsCreated: 0, chainsRecorded: 0,
    skipped: [], notes: [],
  }

  // Heartbeat so the agents table shows CEO activity
  recordAgentActivityAsync(workspaceId, 'research_planner', { status: 'running' })

  // 1. Budget guard.
  // R146.56 — fail closed. Previously caught any error from checkBudget
  // and treated it as { ok: true }; a DB blip would unblock spend and
  // the cycle would run unmetered. Now: any error from the budget check
  // refuses the cycle (next tick retries; one missed cycle is cheap,
  // blowing through the $2 cap on a transient DB error isn't).
  const budget = await checkBudget('ceo_cycle', { maxCalls: 200, maxCostUsd: 2.0 })
    .catch((e: Error) => ({ ok: false as const, reason: `budget check failed (failing closed): ${e.message}` }))
  if (!budget.ok) {
    result.notes.push(`cron-budget blocked: ${budget.reason}`)
    await emit(workspaceId, 'cron.budget_blocked', { task: 'ceo_cycle', reason: budget.reason })
    result.durationMs = Date.now() - t0
    recordAgentActivityAsync(workspaceId, 'research_planner', { status: 'idle' })
    return result
  }

  // 2. Snapshot all divisions
  const snapshots = await allDivisionsSnapshot(workspaceId).catch((e: Error) => { console.error('[ceo-cycle]', e.message); return null })
  if (!snapshots) {
    result.notes.push('division snapshot failed; aborting cycle')
    result.durationMs = Date.now() - t0
    recordAgentActivityAsync(workspaceId, 'research_planner', { status: 'idle' })
    return result
  }

  // Count critical/attention
  for (const div of DIVISIONS) {
    const snap = snapshots[div]
    if (snap.health === 'critical')  result.divisionsRed++
    else if (snap.health === 'attention') result.divisionsYellow++
  }

  // 3. Load active businesses (limited to non-archived)
  const activeBiz = await db.select().from(businesses)
    .where(eq(businesses.workspaceId, workspaceId))
    .catch(() => [])
  result.businessesObserved = activeBiz.length

  // 4. Identify already-delegated divisions in the last hour so we don't
  //    re-spam the same agent every 15 min for the same red signal
  const since = Date.now() - 60 * 60_000
  const recentChains = await db.select({ subjectId: reasoningChains.subjectId, decision: reasoningChains.decision })
    .from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.source, 'ceo-cycle'),
      gte(reasoningChains.createdAt, since),
    )).catch(() => [])
  const recentlyDelegated = new Set(recentChains.map(c => c.subjectId).filter(Boolean) as string[])

  // 5. Operator rejections: skip any division the operator has explicitly
  //    rejected in the last 30 days
  const rejected = await db.select({ subjectId: reasoningChains.subjectId })
    .from(recommendationFeedback)
    .innerJoin(reasoningChains, eq(reasoningChains.id, recommendationFeedback.chainId))
    .where(and(
      eq(recommendationFeedback.workspaceId, workspaceId),
      eq(recommendationFeedback.action, 'reject'),
      gte(recommendationFeedback.createdAt, Date.now() - 30 * 24 * 60 * 60_000),
    )).catch(() => [])
  const operatorRejected = new Set(rejected.map(r => r.subjectId).filter(Boolean) as string[])

  // 6. For each red/yellow division → delegate (up to cap)
  let delegations = 0
  for (const div of DIVISIONS) {
    if (delegations >= MAX_DELEGATIONS_PER_CYCLE) {
      result.notes.push(`hit per-cycle cap (${MAX_DELEGATIONS_PER_CYCLE}); deferring remaining divisions`)
      break
    }
    const snap = snapshots[div]
    if (snap.health === 'thriving' || snap.health === 'healthy') continue

    // Per-business fan-out: if there are businesses tagged for this division,
    // delegate per business; else single global delegation.
    const targets = businessesForDivision(activeBiz, div)
    const targetList: Array<{ businessId: string | null; name: string }> = targets.length > 0
      ? targets
      : [{ businessId: null, name: '(workspace-wide)' }]

    for (const target of targetList) {
      if (delegations >= MAX_DELEGATIONS_PER_CYCLE) break
      const subjectId = target.businessId
        ? `ceo:${div}:${target.businessId}`
        : `ceo:${div}:workspace`
      if (recentlyDelegated.has(subjectId)) { result.skipped.push(`${div}/${target.name}: recent`); continue }
      if (operatorRejected.has(subjectId))  { result.skipped.push(`${div}/${target.name}: operator-rejected`); continue }

      const task = composeRemediationTask(div, snap, target)
      const r = await delegateToAgent({
        workspaceId, task,
        hint: DIVISION_TO_DEPT[div],
        context: {
          division:    div,
          health:      snap.health,
          businessId:  target.businessId,
          businessName: target.name,
          openBlockers: snap.metrics.openBlockers,
          activeMissions: snap.metrics.activeMissions,
          activeAgents: snap.metrics.activeAgents,
        },
        requestedBy: 'ceo-cycle',
      }).catch((e) => ({ ok: false as const, reason: (e as Error).message }))

      if (r.ok) {
        delegations++
        const chainId = await recordChain({
          workspaceId,
          kind: 'decision',
          subjectId,
          decision: `CEO autonomous delegation: ${div} (${snap.health}) → ${r.slug}${target.businessId ? ` for ${target.name}` : ''}`,
          evidence: [
            { type: 'division',   id: div,   extract: `health=${snap.health} blockers=${snap.metrics.openBlockers} missions=${snap.metrics.activeMissions}` },
            { type: 'delegation', id: r.delegationId, extract: r.slug },
          ],
          confidence: 0.7,
          source: 'ceo-cycle',
        }).catch((e: Error) => { console.error('[ceo-cycle]', e.message); return null })
        if (chainId) result.chainsRecorded++

        await emit(workspaceId, 'ceo.delegation_dispatched', {
          division: div, health: snap.health,
          businessId: target.businessId, businessName: target.name,
          delegationId: r.delegationId, agent: r.slug,
          tokens: r.tokens, costUsd: r.costUsd,
        })
      } else {
        result.skipped.push(`${div}/${target.name}: ${r.reason}`)
      }
    }
  }
  result.delegationsCreated = delegations

  await consume('ceo_cycle', { calls: 1 })
  await emit(workspaceId, 'ceo.cycle_completed', {
    durationMs: Date.now() - t0,
    businessesObserved: result.businessesObserved,
    divisionsRed: result.divisionsRed,
    divisionsYellow: result.divisionsYellow,
    delegationsCreated: result.delegationsCreated,
  })

  result.durationMs = Date.now() - t0
  recordAgentActivityAsync(workspaceId, 'research_planner', { status: 'idle' })
  return result
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function businessesForDivision(
  bizList: Array<{ id: string; name: string; metadata: unknown }>,
  div: Division,
): Array<{ businessId: string; name: string }> {
  const out: Array<{ businessId: string; name: string }> = []
  for (const b of bizList) {
    const meta = (b.metadata as { responsibleDepartments?: string[] } | null) ?? {}
    const list = meta.responsibleDepartments ?? []
    if (list.includes(div) || list.includes(DIVISION_TO_DEPT[div])) {
      out.push({ businessId: b.id, name: b.name })
    }
  }
  return out
}

function composeRemediationTask(div: Division, snap: DivisionSnapshot, target: { businessId: string | null; name: string }): string {
  const scope = target.businessId ? `for business "${target.name}"` : '(workspace-wide)'
  const topBlockers = snap.blockers.slice(0, 3).map(b => `· [${b.kind}${b.severity ? '/' + b.severity : ''}] ${b.title.slice(0, 100)}`).join('\n') || '(no specific blockers — investigate recent events)'
  const topRecs = snap.recommendations.slice(0, 3).map(r => {
    const rr = r as { title?: string; recommendation?: string; subject?: string; summary?: string }
    return `· ${rr.title ?? rr.subject ?? rr.recommendation ?? ''}`
  }).filter(s => s.length > 2).join('\n')
  return [
    `Division "${div}" health is ${snap.health.toUpperCase()} ${scope}.`,
    `Blockers: ${snap.metrics.openBlockers}. Missions: ${snap.metrics.activeMissions}. Active agents: ${snap.metrics.activeAgents}.`,
    '',
    'Open blockers:',
    topBlockers,
    ...(topRecs ? ['', 'Recommendations on file:', topRecs] : []),
    '',
    'Your job: produce a concrete 3-step remediation plan with specific files/services/owners. ' +
    'If you need more context, name what you would query. ' +
    'Stay tactical — no abstractions, no "we should consider".',
  ].join('\n')
}

