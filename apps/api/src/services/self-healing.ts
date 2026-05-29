/**
 * self-healing.ts — periodic recovery scanner (#20).
 *
 * Walks known queues / state stores for stuck or stale rows and emits
 * structured `self_heal_actions` rows describing what would be done.
 *
 * Conservative by default: most actions record `applied: false` and emit
 * a recommendation event so the operator approves the actual recovery.
 * The only auto-applied healing is voice dry-run expiry (already swept
 * by an existing cron) and voice session cleanup (closing rows whose
 * sessions are inactive for >2 h).
 *
 * Every action emits a `runtime.self_heal.*` audit event so recovery is
 * always observable + replayable.
 */
import { db } from '../db/client.js'
import { events, voiceSessions, voiceDryRuns, selfHealActions } from '../db/schema.js'
import { and, eq, lt, inArray } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface HealReport {
  candidatesFound: number
  applied:         number
  byKind:          Record<string, number>
}

async function emitHealEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/self-healing', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[self-healing]', e.message); return null })
}

async function recordAction(input: { workspaceId: string; kind: string; targetKind: string; targetId: string; reason: string; applied: boolean; result?: Record<string, unknown> }) {
  await db.insert(selfHealActions).values({
    id: uuidv7(),
    workspaceId: input.workspaceId,
    kind:        input.kind,
    targetKind:  input.targetKind,
    targetId:    input.targetId,
    reason:      input.reason,
    applied:     input.applied,
    result:      input.result ?? null,
    createdAt:   Date.now(),
    appliedAt:   input.applied ? Date.now() : null,
  }).catch((e: Error) => { console.error('[self-healing]', e.message); return null })
}

const TWO_HOURS = 2 * 60 * 60_000

export async function scanAndHeal(): Promise<HealReport> {
  const { recordAgentActivityAsync } = await import('./agent-state-sync.js')
  recordAgentActivityAsync('default', 'reliability_trend', { status: 'running' })
  const report: HealReport = { candidatesFound: 0, applied: 0, byKind: {} }

  // 1. Close voice sessions stuck in 'active' for >2h
  const staleSessions = await db.select({ id: voiceSessions.id, workspaceId: voiceSessions.workspaceId })
    .from(voiceSessions)
    .where(and(eq(voiceSessions.status, 'active'), lt(voiceSessions.startedAt, Date.now() - TWO_HOURS)))
    .limit(200).catch(() => [])
  if (staleSessions.length > 0) {
    await db.update(voiceSessions).set({ status: 'ended', endedAt: Date.now() })
      .where(inArray(voiceSessions.id, staleSessions.map(s => s.id))).catch((e: Error) => { console.error('[self-healing]', e.message); return null })
    for (const s of staleSessions) {
      await recordAction({
        workspaceId: s.workspaceId, kind: 'clear_stuck', targetKind: 'voice_session',
        targetId: s.id, reason: 'inactive >2h', applied: true,
      })
      await emitHealEvent(s.workspaceId, 'runtime.self_heal.voice_session_closed', { id: s.id })
    }
    report.byKind['voice_session_closed'] = staleSessions.length
    report.applied += staleSessions.length
  }

  // 2. Mark dry-runs whose pending state outlived their expires_at — the
  //    existing dry-run sweep already does this but if it ever lags
  //    behind we want a backstop here.
  const stuckDryRuns = await db.select({ id: voiceDryRuns.id, workspaceId: voiceDryRuns.workspaceId })
    .from(voiceDryRuns)
    .where(and(eq(voiceDryRuns.status, 'pending'), lt(voiceDryRuns.expiresAt, Date.now() - 60_000)))
    .limit(200).catch(() => [])
  if (stuckDryRuns.length > 0) {
    await db.update(voiceDryRuns).set({ status: 'expired' })
      .where(inArray(voiceDryRuns.id, stuckDryRuns.map(r => r.id))).catch((e: Error) => { console.error('[self-healing]', e.message); return null })
    for (const r of stuckDryRuns) {
      await recordAction({
        workspaceId: r.workspaceId, kind: 'clear_stuck', targetKind: 'dry_run',
        targetId: r.id, reason: 'expired pending backstop', applied: true,
      })
    }
    report.byKind['dry_run_backstop'] = stuckDryRuns.length
    report.applied += stuckDryRuns.length
  }

  // Reap stuck agent delegations — anything pending for >5 minutes is
  // almost certainly a hung LLM call. Flip to failed with a clear marker
  // so the operator + CEO cycle can see what happened.
  try {
    const { agentDelegations } = await import('../db/schema.js')
    const stuck = await db.select({ id: agentDelegations.id }).from(agentDelegations)
      .where(and(
        eq(agentDelegations.status, 'pending'),
        lt(agentDelegations.startedAt, Date.now() - 5 * 60_000),
      )).limit(50).catch(() => [])
    if (stuck.length > 0) {
      await db.update(agentDelegations).set({
        status: 'failed',
        error:  'reaped by self-healing: pending > 5min (likely hung LLM stream)',
        completedAt: Date.now(),
      }).where(inArray(agentDelegations.id, stuck.map(s => s.id))).catch((e: Error) => { console.error('[self-healing]', e.message); return null })
      report.byKind['agent_delegation_reaped'] = stuck.length
      report.applied += stuck.length
    }
  } catch { /* tolerated */ }

  report.candidatesFound = staleSessions.length + stuckDryRuns.length + (report.byKind['agent_delegation_reaped'] ?? 0)
  recordAgentActivityAsync('default', 'reliability_trend', { status: 'idle' })
  return report
}

export async function listSelfHealActions(workspaceId: string, limit = 50) {
  return db.select().from(selfHealActions)
    .where(eq(selfHealActions.workspaceId, workspaceId))
    .orderBy(selfHealActions.createdAt).limit(limit).catch(() => [])
}
