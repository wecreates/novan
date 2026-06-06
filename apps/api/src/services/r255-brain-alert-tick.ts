/**
 * R146.255 — Brain health alert tick.
 *
 * Runs brain.health every 15min per workspace. If overall is non-healthy,
 * emits 'brain.degraded' or 'brain.critical'. R212 event hooks subscribe
 * to these — operator gets web-push, slack, etc. without writing custom
 * watchers per subsystem.
 *
 * State transitions are tracked in workspace_memory under
 * key='_brainHealthState' so we only fire on *changes* (healthy→degraded,
 * degraded→critical, *→healthy) — no alert spam every 15min.
 */
import { db } from '../db/client.js'
import { workspaceMemory } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { brainHealth, type Health } from './r253-brain-health.js'
import { incCounter } from './metrics.js'

const STATE_KEY = '_brainHealthState'

async function readPrev(workspaceId: string): Promise<Health | null> {
  const [row] = await db.select({ value: workspaceMemory.value })
    .from(workspaceMemory)
    .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.key, STATE_KEY)))
    .limit(1)
    .catch(() => [])
  const v = row?.value
  if (v === 'healthy' || v === 'degraded' || v === 'critical') return v
  return null
}

async function writeState(workspaceId: string, h: Health): Promise<void> {
  const now = Date.now()
  await db.insert(workspaceMemory).values({
    workspaceId, key: STATE_KEY, value: h,
    scope: 'system', importance: 90,  // system-managed, near-promoted floor
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [workspaceMemory.workspaceId, workspaceMemory.key],
    set: { value: h, updatedAt: now },
  }).catch(() => null)
}

export interface BrainAlertResult { workspaceId: string; prev: Health | null; now: Health; emitted: string | null }

export async function tickBrainHealthAlert(workspaceId: string): Promise<BrainAlertResult> {
  const snap = await brainHealth(workspaceId).catch(() => null)
  if (!snap) return { workspaceId, prev: null, now: 'healthy', emitted: null }
  // R146.262 — persist snapshot for trend history. Fire-and-forget; null on failure.
  void import('./r262-brain-health-history.js').then(m => m.persistSnapshot(workspaceId, snap)).catch(() => null)
  const prev = await readPrev(workspaceId)
  let emitted: string | null = null
  if (prev !== snap.overall) {
    if (snap.overall === 'critical')      emitted = 'brain.critical'
    else if (snap.overall === 'degraded') emitted = 'brain.degraded'
    else if (prev !== null)               emitted = 'brain.healthy'  // recovered
    if (emitted) {
      // R146.259 — counter so Prometheus can graph state-transition rate.
      incCounter('brain_health_transition_total', { to: snap.overall, from: prev ?? 'unknown' }, 1, 'Brain.health overall state transitions by from→to')
      const { hookDispatch } = await import('./r211-workplace.js')
      await hookDispatch(workspaceId, emitted, {
        prev: prev ?? 'unknown',
        now: snap.overall,
        cost: snap.cost,
        backup: snap.backup,
        applier: snap.applier,
        cron: snap.cron,
        errors: snap.errors,
      }).catch(() => null)
    }
    await writeState(workspaceId, snap.overall)
  }
  return { workspaceId, prev, now: snap.overall, emitted }
}
