/**
 * recovery-executor.ts — Consumer for `recovery.playbook_suggested` events.
 *
 * Closes the loop on the recovery-playbook registry (R120) by acting on
 * suggestions. Honest scope:
 *   - Only `service_crashed` (the single autoRecoverable=true playbook)
 *     triggers automatic action. Action = log + emit
 *     `recovery.auto_executed` so the operator can see what happened.
 *     Actual process-supervisor restart sits in deployment/ops layer,
 *     not in-process.
 *   - Every other playbook (lock-tamper, kill-switch, budget, provider
 *     outage, DB lag, deployment regression) is HUMAN-gated per spec.
 *     We emit `recovery.escalation_required` + push to brain-broadcast
 *     so the operator gets the playbook handoff on the dashboard.
 *   - Loop detection: if the same failure mode has triggered
 *     `recovery.escalation_required` 3+ times in the last hour, we
 *     suppress further auto-emissions and emit a stability_alert
 *     instead (no point spamming the operator).
 */

import { v7 as uuidv7 } from 'uuid'
import { incCounter } from './metrics.js'

interface SuggestedEvent {
  eventId:      string
  mode:         string
  playbookTitle: string
  runbook:      string
  autoRecoverable: boolean
  context:      Record<string, unknown>
  createdAt:    number
}

const ESCALATION_RATE_LIMIT = 3   // max escalations per (mode, hour)

async function recentSuggestions(windowMs: number): Promise<SuggestedEvent[]> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { sql, desc } = await import('drizzle-orm')
    const since = Date.now() - windowMs
    const rows = await db.select({ id: events.id, payload: events.payload, createdAt: events.createdAt })
      .from(events)
      .where(sql`${events.type} = 'recovery.playbook_suggested' AND ${events.createdAt} >= ${since}`)
      .orderBy(desc(events.createdAt))
      .limit(100)
      .catch(() => [])
    const out: SuggestedEvent[] = []
    for (const r of rows) {
      const p = r.payload as {
        mode?: string; playbook?: string; runbook?: string
        autoRecoverable?: boolean; context?: Record<string, unknown>
      }
      if (!p.mode) continue
      out.push({
        eventId: r.id, mode: p.mode,
        playbookTitle: p.playbook ?? '', runbook: p.runbook ?? '',
        autoRecoverable: Boolean(p.autoRecoverable),
        context: p.context ?? {},
        createdAt: Number(r.createdAt),
      })
    }
    return out
  } catch { return [] }
}

/** Count how many `recovery.escalation_required` events of a given mode
 *  fired in the last hour. Used for rate limiting. */
async function escalationCount(mode: string): Promise<number> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { sql } = await import('drizzle-orm')
    const since = Date.now() - 60 * 60_000
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(events)
      .where(sql`${events.type} = 'recovery.escalation_required'
                 AND ${events.createdAt} >= ${since}
                 AND ${events.payload}->>'mode' = ${mode}`)
      .catch(() => [{ n: 0 }])
    return rows[0]?.n ?? 0
  } catch { return 0 }
}

async function emit(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    await db.insert(events).values({
      id: uuidv7(), type, workspaceId: null, payload,
      traceId: uuidv7(), correlationId: null, causationId: null,
      source: 'recovery-executor', version: 1, createdAt: Date.now(),
    } as never).catch((e: Error) => { console.error('[recovery-executor]', e.message); return null })
  } catch { /* tolerated */ }
}

/** Has this specific suggestion already been acknowledged?
 *  We use `recovery.acknowledged` events keyed by source eventId. */
async function alreadyHandled(eventId: string): Promise<boolean> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { sql } = await import('drizzle-orm')
    const rows = await db.select({ id: events.id }).from(events)
      .where(sql`${events.type} IN ('recovery.auto_executed', 'recovery.escalation_required', 'recovery.acknowledged')
                 AND ${events.payload}->>'sourceEventId' = ${eventId}`)
      .limit(1)
      .catch(() => [])
    return rows.length > 0
  } catch { return false }
}

/** Cron tick — react to new suggestions. */
export async function runRecoveryExecutor(): Promise<{
  examined:    number
  autoExecuted: number
  escalated:   number
  suppressed:  number
}> {
  const suggestions = await recentSuggestions(60 * 60_000)
  let autoExecuted = 0, escalated = 0, suppressed = 0

  for (const s of suggestions) {
    if (await alreadyHandled(s.eventId)) continue

    if (s.autoRecoverable && s.mode === 'service_crashed') {
      // The single auto path. Surface what was done; do NOT actually
      // restart processes in-band — that belongs to the deployment
      // supervisor (k8s / pm2 / systemd).
      await emit('recovery.auto_executed', {
        sourceEventId: s.eventId,
        mode: s.mode, playbook: s.playbookTitle,
        action: 'logged_for_supervisor',
        note: 'In-process service does not auto-restart workers. External supervisor handles the restart; this event records the suggestion.',
      })
      autoExecuted++
      incCounter('recovery_auto_executed_total', { mode: s.mode })
      continue
    }

    // Human-gated: rate-limit escalations so the operator isn't spammed.
    const recentCount = await escalationCount(s.mode)
    if (recentCount >= ESCALATION_RATE_LIMIT) {
      await emit('governance.stability_alert', {
        reason: 'recovery_escalation_rate_limit',
        mode: s.mode, recentCount, threshold: ESCALATION_RATE_LIMIT,
      })
      suppressed++
      incCounter('recovery_escalation_suppressed_total', { mode: s.mode })
      continue
    }

    await emit('recovery.escalation_required', {
      sourceEventId: s.eventId,
      mode: s.mode, playbook: s.playbookTitle, runbook: s.runbook,
      context: s.context,
    })
    escalated++
    incCounter('recovery_escalation_emitted_total', { mode: s.mode })
  }

  return { examined: suggestions.length, autoExecuted, escalated, suppressed }
}
