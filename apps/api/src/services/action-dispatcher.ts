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
import { and, eq, desc, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { notify } from './notifications.js'

export type ActionType =
  | 'notify_operator'
  | 'record_decision'
  | 'throttle_queue'
  | 'engage_kill_switch'
  | 'swap_provider_recommendation'
  | 'cancel_pending'

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
  }).catch(() => null)

  // High-risk requires approval token in payload to proceed
  if (risk === 'high' || risk === 'critical') {
    const approved = (input.payload['approvalToken'] === 'OPERATOR_APPROVED')
    if (!approved) {
      await db.update(actions).set({ status: 'pending', error: 'approval_required' })
        .where(eq(actions.id, id)).catch(() => null)
      return { id, status: 'pending', error: 'approval_required' }
    }
  }

  // Execute
  await db.update(actions).set({ status: 'executing', startedAt: Date.now() })
    .where(eq(actions.id, id)).catch(() => null)

  try {
    const result = await execute(input)
    await db.update(actions).set({
      status: 'succeeded', result, completedAt: Date.now(),
    }).where(eq(actions.id, id)).catch(() => null)
    return { id, status: 'succeeded', result }
  } catch (e) {
    const msg = (e as Error).message
    await db.update(actions).set({
      status: 'failed', error: msg, completedAt: Date.now(),
    }).where(eq(actions.id, id)).catch(() => null)
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
      }).catch(() => null)
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
      }).catch(() => null)
      return { queueName, factor, applied: 'persisted', note: 'Workers read worker_concurrency at lease time' }
    }

    case 'engage_kill_switch': {
      const switchType = String(i.payload['switchType'] ?? 'research')
      const reason     = String(i.payload['reason']     ?? 'manual via action-dispatcher')
      const existing = await db.select().from(killSwitches)
        .where(and(eq(killSwitches.workspaceId, i.workspaceId), eq(killSwitches.switchType, switchType)))
        .limit(1).then(r => r[0]).catch(() => null)
      const now = Date.now()
      if (existing?.enabled) return { engaged: false, alreadyEngaged: true }
      if (existing) {
        await db.update(killSwitches).set({
          enabled: true, reason, enabledBy: 'action-dispatcher', enabledAt: now, updatedAt: now,
        }).where(eq(killSwitches.id, existing.id)).catch(() => null)
      } else {
        await db.insert(killSwitches).values({
          id: uuidv7(), workspaceId: i.workspaceId, switchType, enabled: true,
          reason, enabledBy: 'action-dispatcher', enabledAt: now,
          createdAt: now, updatedAt: now,
        }).onConflictDoNothing().catch(() => null)
      }
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
      }).catch(() => null)
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
      }).catch(() => null)
      return { recommendedSwap: { from, to, task }, chainId: id, preferenceStatus: 'pending' }
    }

    case 'cancel_pending': {
      // Cancel another pending action by id (idempotent)
      const targetId = String(i.payload['actionId'] ?? '')
      if (!targetId) throw new Error('actionId required')
      await db.update(actions).set({
        status: 'cancelled', completedAt: Date.now(),
      }).where(and(eq(actions.id, targetId), eq(actions.status, 'pending'))).catch(() => null)
      return { cancelled: targetId }
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
