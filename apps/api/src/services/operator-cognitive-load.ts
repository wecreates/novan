/**
 * operator-cognitive-load.ts — score operator stress / overload (#18).
 *
 * Pure scorer over recent telemetry: event volume + alert density +
 * pending-approval count + interruption rate. Returns a load score in
 * [0, 1] and a recommended UI mode (calm / normal / deep / overload).
 *
 * Pure function tested with fixtures; the DB wrapper composes the
 * inputs from `events`, `approvals`, `voice_dry_runs`, `voice_events`.
 */
import { db } from '../db/client.js'
import { events, approvals, voiceDryRuns, voiceEvents, operatorLoadSnapshots } from '../db/schema.js'
import { and, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type LoadMode = 'calm' | 'normal' | 'deep' | 'overload'

export interface LoadInputs {
  eventVolume:      number   // total events in window
  alertVolume:      number   // high+critical alerts in window
  pendingCount:     number   // approvals + dry-runs awaiting confirmation
  interruptionRate: number   // 0..1
  windowMs:         number
}

export interface LoadVerdict {
  loadScore:        number   // 0..1
  mode:             LoadMode
  recommendation:   string
}

/** Pure scorer. */
export function scoreCognitiveLoad(input: LoadInputs): LoadVerdict {
  // Normalize each axis against soft caps tuned to a single-operator
  // workstation. Caps chosen so a calm workspace scores ~0.1 and a
  // mid-incident workspace scores ~0.7.
  const eventNorm    = Math.min(1, input.eventVolume   / 300)        // 300 events / 30min → 1.0
  const alertNorm    = Math.min(1, input.alertVolume   / 10)         // 10 alerts → 1.0
  const pendingNorm  = Math.min(1, input.pendingCount  / 8)          // 8 pending → 1.0
  const interrupt    = Math.max(0, Math.min(1, input.interruptionRate))

  // Composite weights — alerts + pending dominate operator attention
  const loadScore = Number((
    0.20 * eventNorm
  + 0.30 * alertNorm
  + 0.30 * pendingNorm
  + 0.20 * interrupt
  ).toFixed(3))

  let mode: LoadMode = 'normal'
  let recommendation = 'Standard density.'
  if (loadScore >= 0.75)      { mode = 'overload';     recommendation = 'Suppress non-critical alerts; show only must-act items.' }
  else if (loadScore >= 0.50) { mode = 'deep';         recommendation = 'Surface fewer items per panel; lean on summaries.' }
  else if (loadScore <= 0.10) { mode = 'calm';         recommendation = 'Headroom available — expanded detail is safe.' }

  return { loadScore, mode, recommendation }
}

export async function snapshotOperatorLoad(workspaceId: string, opts: { windowMs?: number; userId?: string } = {}): Promise<LoadVerdict & { id: string; inputs: LoadInputs }> {
  const windowMs = opts.windowMs ?? 30 * 60_000
  const since = Date.now() - windowMs

  const [{ events: ev }, { alerts }, { pendingApprovals, pendingDryRuns }, { interrupts, turns }] = await Promise.all([
    db.select({ events: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since)))
      .then(r => r[0] ?? { events: 0 }).catch(() => ({ events: 0 })),
    db.select({ alerts: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since), sql`payload->>'severity' IN ('high','critical')`))
      .then(r => r[0] ?? { alerts: 0 }).catch(() => ({ alerts: 0 })),
    db.select({
      pendingApprovals: sql<number>`(SELECT count(*)::int FROM ${approvals} WHERE workspace_id = ${workspaceId} AND status = 'pending')`,
      pendingDryRuns:   sql<number>`(SELECT count(*)::int FROM ${voiceDryRuns} WHERE workspace_id = ${workspaceId} AND status = 'pending')`,
    }).from(approvals).limit(1).then(r => r[0] ?? { pendingApprovals: 0, pendingDryRuns: 0 }).catch(() => ({ pendingApprovals: 0, pendingDryRuns: 0 })),
    db.select({
      interrupts: sql<number>`count(*) FILTER (WHERE kind IN ('barge_in','stop'))::int`,
      turns:      sql<number>`count(*)::int`,
    }).from(voiceEvents)
      .where(and(eq(voiceEvents.workspaceId, workspaceId), gte(voiceEvents.createdAt, since)))
      .then(r => r[0] ?? { interrupts: 0, turns: 0 }).catch(() => ({ interrupts: 0, turns: 0 })),
  ])

  const inputs: LoadInputs = {
    eventVolume:      Number(ev) || 0,
    alertVolume:      Number(alerts) || 0,
    pendingCount:     (Number(pendingApprovals) || 0) + (Number(pendingDryRuns) || 0),
    interruptionRate: turns === 0 ? 0 : Number(interrupts) / Number(turns),
    windowMs,
  }
  const verdict = scoreCognitiveLoad(inputs)
  const id = uuidv7()
  await db.insert(operatorLoadSnapshots).values({
    id, workspaceId,
    userId: opts.userId ?? null,
    windowMs,
    eventVolume:      inputs.eventVolume,
    alertVolume:      inputs.alertVolume,
    pendingCount:     inputs.pendingCount,
    interruptionRate: Number(inputs.interruptionRate.toFixed(3)),
    loadScore:        verdict.loadScore,
    mode:             verdict.mode,
    recommendation:   verdict.recommendation,
    createdAt:        Date.now(),
  }).catch((e: Error) => { console.error('[operator-cognitive-load]', e.message); return null })
  return { id, inputs, ...verdict }
}
