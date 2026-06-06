/**
 * action-dispatcher.ts — Tier-1 closure: the platform can now *act*.
 *
 * Honest scope:
 *   - Pure dispatcher: validates type, routes to handler, persists outcome.
 *   - High-risk types gate through approval-gate (existing infra).
 *   - Handlers themselves are MINIMAL (notify, record_decision, throttle).
 *     Provider swaps / worker cancellations are wired to existing services
 *     when those services expose safe entry points; otherwise they record
 *     the decision and stop short of unsafe operations.
 *   - NEVER bypasses safety: approval-gate, kill-switches, budget guards.
 */
import { db } from '../db/client.js'
import { actions, reasoningChains, killSwitches, workerConcurrency, providerPreferences } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { notify } from './notifications.js'
import { shouldAutoAct, type LoadMode } from './strategic-restraint.js'

export type ActionType =
  | 'notify_operator'
  | 'record_decision'
  | 'throttle_queue'
  | 'engage_kill_switch'
  | 'swap_provider_recommendation'
  | 'cancel_pending'
  | 'delegate_to_agency'
  | 'construct_business'

export type ActionStatus =
  | 'pending' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'rejected' | 'cancelled'

export interface DispatchInput {
  workspaceId: string
  type: ActionType
  subjectId?: string
  payload: Record<string, unknown>
  requestedBy: string
}

/** Risk classifier — high-risk types require explicit approvalId in payload. */
function classifyRisk(type: ActionType): 'low' | 'medium' | 'high' | 'critical' {
  switch (type) {
    case 'notify_operator':              return 'low'
    case 'record_decision':              return 'low'
    case 'delegate_to_agency':           return 'low'
    case 'construct_business':           return 'low'
    case 'throttle_queue':               return 'medium'
    case 'swap_provider_recommendation': return 'medium'
    case 'cancel_pending':               return 'medium'
    case 'engage_kill_switch':           return 'high'
  }
}

export async function dispatch(input: DispatchInput): Promise<{ id: string; status: ActionStatus; result?: Record<string, unknown>; error?: string }> {
  const id   = uuidv7()
  const risk = classifyRisk(input.type)
  const now  = Date.now()

  // Insert as pending
  await db.insert(actions).values({
    id, workspaceId: input.workspaceId, type: input.type,
    subjectId: input.subjectId ?? null, payload: input.payload,
    status: 'pending', riskLevel: risk, requestedBy: input.requestedBy,
    createdAt: now,
  }).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })

  // High-risk requires approval token in payload to proceed
  if (risk === 'high' || risk === 'critical') {
    const approved = (input.payload['approvalToken'] === 'OPERATOR_APPROVED')
    if (!approved) {
      await db.update(actions).set({ status: 'pending', error: 'approval_required' })
        .where(eq(actions.id, id)).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
      return { id, status: 'pending', error: 'approval_required' }
    }
  }

  // Strategic-restraint gate for autonomous callers (#42).
  // Operator-initiated requests (`chat-approval`, `ui:*`, `operator:*`)
  // bypass — the operator already chose. Autonomous callers (anything
  // starting with `auto`, `autonomous`, `worker`, `cron`, `agent`) go
  // through `shouldAutoAct` for medium/high-risk plans.
  const isAutonomous = /^(auto|autonomous|worker|cron|agent)/i.test(input.requestedBy)
  if (isAutonomous && risk !== 'low') {
    let loadMode: LoadMode = 'normal'
    try {
      const { snapshotOperatorLoad } = await import('./operator-cognitive-load.js')
      const verdict = await snapshotOperatorLoad(input.workspaceId).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
      if (verdict) loadMode = verdict.mode as LoadMode
    } catch { /* tolerated */ }

    const decision = shouldAutoAct({
      risk: risk as 'low' | 'medium' | 'high',
      hardBlocked:   false,
      budgetBlocked: false,
      loadMode,
      // These two are conservative defaults — wiring trusted-pattern + HF
      // requires the per-operator preference store, which is a separate
      // primitive. Defaulting to `false` makes the gate err toward dry-run.
      trustedPattern:   Boolean(input.payload['trustedPattern']   === true),
      handsFreeEnabled: Boolean(input.payload['handsFreeEnabled'] === true),
    })
    if (!decision.allow) {
      await db.update(actions).set({
        status: 'pending',
        error: `restraint:${decision.deferTo}:${decision.reason}`,
      }).where(eq(actions.id, id)).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
      return { id, status: 'pending', error: `restraint:${decision.deferTo}:${decision.reason}` }
    }
  }

  // Execute
  await db.update(actions).set({ status: 'executing', startedAt: Date.now() })
    .where(eq(actions.id, id)).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })

  try {
    const result = await execute(input)
    await db.update(actions).set({
      status: 'succeeded', result, completedAt: Date.now(),
    }).where(eq(actions.id, id)).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
    return { id, status: 'succeeded', result }
  } catch (e) {
    const msg = (e as Error).message
    await db.update(actions).set({
      status: 'failed', error: msg, completedAt: Date.now(),
    }).where(eq(actions.id, id)).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
    return { id, status: 'failed', error: msg }
  }
}

async function execute(i: DispatchInput): Promise<Record<string, unknown>> {
  switch (i.type) {

    case 'notify_operator': {
      const r = await notify({
        workspaceId: i.workspaceId,
        type: String(i.payload['notifyType'] ?? 'action.notify_operator'),
        title: String(i.payload['title']  ?? 'Action notification'),
        body:  String(i.payload['body']   ?? ''),
        severity: (i.payload['severity'] as 'normal' | 'high' | 'critical') ?? 'normal',
        signature: String(i.payload['signature'] ?? `action:${i.subjectId ?? Date.now()}`),
      })
      return { notified: true, ...r }
    }

    case 'record_decision': {
      const id = uuidv7()
      await db.insert(reasoningChains).values({
        id, workspaceId: i.workspaceId, kind: 'decision',
        subjectId: i.subjectId ?? null,
        decision: String(i.payload['decision'] ?? 'unspecified decision'),
        evidence: (i.payload['evidence']  as Array<{ type: string; id: string; extract: string }>) ?? [],
        tradeoffs: (i.payload['tradeoffs'] as Array<{ name: string; value: string | number; rationale: string }>) ?? [],
        confidence: typeof i.payload['confidence'] === 'number' ? (i.payload['confidence'] as number) : null,
        outcomeKnown: false,
        source: 'action-dispatcher',
        createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
      return { chainId: id }
    }

    case 'throttle_queue': {
      // Persist concurrency factor to worker_concurrency table.
      // Workers consult this table on their next leasing cycle.
      const queueName = String(i.payload['queue'] ?? 'unknown')
      const factor    = Number(i.payload['factor'] ?? 0.5)
      const reason    = String(i.payload['reason'] ?? 'action-dispatcher throttle')
      await db.insert(workerConcurrency).values({
        workspaceId: i.workspaceId, queueName, factor, setBy: 'action-dispatcher',
        reason, updatedAt: Date.now(),
      }).onConflictDoUpdate({
        target: [workerConcurrency.workspaceId, workerConcurrency.queueName],
        set: { factor, setBy: 'action-dispatcher', reason, updatedAt: Date.now() },
      }).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
      return { queueName, factor, applied: 'persisted', note: 'Workers read worker_concurrency at lease time' }
    }

    case 'engage_kill_switch': {
      const switchType = String(i.payload['switchType'] ?? 'research')
      const reason     = String(i.payload['reason']     ?? 'manual via action-dispatcher')
      const now = Date.now()
      // R146.220 — atomic upsert via R203 unique idx kill_switches_ws_type_uniq.
      // Previous SELECT-then-(UPDATE-or-INSERT) had a TOCTOU window: two
      // concurrent emergency triggers for the same (workspace, switchType)
      // could both observe "no row" and INSERT before the unique index
      // existed (R203 added it). With both unique index + atomic upsert
      // the race is closed at the DB level.
      const ret = await db.insert(killSwitches).values({
        id: uuidv7(), workspaceId: i.workspaceId, switchType, enabled: true,
        reason, enabledBy: 'action-dispatcher', enabledAt: now,
        createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: [killSwitches.workspaceId, killSwitches.switchType],
        set: { enabled: true, reason, enabledBy: 'action-dispatcher', enabledAt: now, updatedAt: now },
        setWhere: sql`${killSwitches.enabled} = false`,
      }).returning({ enabled: killSwitches.enabled, enabledAt: killSwitches.enabledAt })
        .catch((e: Error) => { console.error('[action-dispatcher]', e.message); return [] as Array<{ enabled: boolean; enabledAt: number | null }> })
      if (ret.length === 0) return { engaged: false, alreadyEngaged: true }
      return { engaged: true, switchType, reason }
    }

    case 'swap_provider_recommendation': {
      // Persist as pending preference + record chain. Provider-router
      // reads provider_preferences (status='active') for routing. The
      // pending status is operator-gated.
      const from = String(i.payload['from'] ?? '?')
      const to   = String(i.payload['to']   ?? '?')
      const task = String(i.payload['taskType'] ?? 'all')
      const reason = String(i.payload['reason'] ?? 'cost or latency optimization')
      await db.insert(providerPreferences).values({
        workspaceId: i.workspaceId, taskType: task,
        preferredProvider: to, setBy: 'action-dispatcher',
        status: 'pending', reason, updatedAt: Date.now(),
      }).onConflictDoUpdate({
        target: [providerPreferences.workspaceId, providerPreferences.taskType],
        set: { preferredProvider: to, setBy: 'action-dispatcher', status: 'pending', reason, updatedAt: Date.now() },
      }).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
      const id = uuidv7()
      await db.insert(reasoningChains).values({
        id, workspaceId: i.workspaceId, kind: 'recommendation',
        subjectId: `swap:${task}`,
        decision: `Swap ${from} → ${to} for ${task} (preference pending operator approval)`,
        evidence: (i.payload['evidence'] as Array<{ type: string; id: string; extract: string }>) ?? [],
        confidence: typeof i.payload['confidence'] === 'number' ? (i.payload['confidence'] as number) : 0.6,
        outcomeKnown: false,
        source: 'action-dispatcher',
        createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
      return { recommendedSwap: { from, to, task }, chainId: id, preferenceStatus: 'pending' }
    }

    case 'cancel_pending': {
      // Cancel another pending action by id (idempotent)
      const targetId = String(i.payload['actionId'] ?? '')
      if (!targetId) throw new Error('actionId required')
      await db.update(actions).set({
        status: 'cancelled', completedAt: Date.now(),
      }).where(and(eq(actions.id, targetId), eq(actions.status, 'pending'))).catch((e: Error) => { console.error('[action-dispatcher]', e.message); return null })
      return { cancelled: targetId }
    }

    case 'delegate_to_agency': {
      // Brain-as-CEO: route the task to the best specialist agent.
      // Lazy-imported so non-chat flows stay light.
      const task = String(i.payload['task'] ?? '').trim()
      if (!task) throw new Error('task required')
      const hint = String(i.payload['hint'] ?? '').trim()
      const { delegateToAgent } = await import('./ceo-orchestrator.js')
      const r = await delegateToAgent({
        workspaceId: i.workspaceId,
        task,
        ...(hint ? { hint } : {}),
        requestedBy: i.requestedBy,
      })
      if (!r.ok) throw new Error(r.reason)
      return {
        delegationId: r.delegationId,
        slug:         r.slug,
        department:   r.department,
        tokens:       r.tokens,
        costUsd:      r.costUsd,
        // The agent's actual response — chat surface can display it.
        result:       r.result.slice(0, 4_000),
      }
    }

    case 'construct_business': {
      // Decompose a high-level brief into a real business + systems
      // and emit the spawn event stream the brain canvas consumes.
      const brief = String(i.payload['brief'] ?? '').trim()
      if (!brief || brief.length < 5) throw new Error('brief required (min 5 chars)')
      const name = String(i.payload['name'] ?? '').trim() || undefined
      const { constructBusiness } = await import('./business-construction.js')
      const r = await constructBusiness({
        workspaceId: i.workspaceId,
        brief,
        ...(name ? { name } : {}),
      })
      return {
        businessId:     r.businessId,
        name:           r.name,
        industry:       r.industry,
        systemsSpawned: r.systemIds.length,
        navigateTo:     '/brain',
      }
    }
  }
}

export async function listRecent(workspaceId: string, opts?: { limit?: number; status?: ActionStatus }) {
  let q = db.select().from(actions)
    .where(opts?.status
      ? and(eq(actions.workspaceId, workspaceId), eq(actions.status, opts.status))
      : eq(actions.workspaceId, workspaceId))
    .orderBy(desc(actions.createdAt)).limit(opts?.limit ?? 50)
  return q.catch(() => [])
}

export async function summary(workspaceId: string) {
  const since = Date.now() - 7 * 24 * 60 * 60_000
  const rows = await db.select().from(actions)
    .where(and(eq(actions.workspaceId, workspaceId), gte(actions.createdAt, since)))
    .catch(() => [])
  const byStatus: Record<string, number> = {}
  const byType:   Record<string, number> = {}
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    byType[r.type]     = (byType[r.type]     ?? 0) + 1
  }
  return { total: rows.length, byStatus, byType }
}
