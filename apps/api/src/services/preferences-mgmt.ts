/**
 * preferences-mgmt.ts — Operator-facing CRUD for pending provider preferences
 * and worker concurrency overrides. Closes the "wired but dead" gap.
 */
import { db } from '../db/client.js'
import { providerPreferences, workerConcurrency, events } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'

export async function listProviderPreferences(workspaceId: string, status?: 'pending' | 'active' | 'rejected') {
  const conds = [eq(providerPreferences.workspaceId, workspaceId)]
  if (status) conds.push(eq(providerPreferences.status, status))
  return db.select().from(providerPreferences).where(and(...conds))
    .orderBy(desc(providerPreferences.updatedAt)).catch(() => [])
}

export async function setProviderPreferenceStatus(
  workspaceId: string, taskType: string, status: 'pending' | 'active' | 'rejected',
): Promise<void> {
  await db.update(providerPreferences).set({ status, updatedAt: Date.now() })
    .where(and(eq(providerPreferences.workspaceId, workspaceId), eq(providerPreferences.taskType, taskType)))
    .catch((e: Error) => { console.error('[preferences-mgmt]', e.message); return null })
}

export async function listWorkerConcurrency(workspaceId: string) {
  return db.select().from(workerConcurrency)
    .where(eq(workerConcurrency.workspaceId, workspaceId))
    .orderBy(desc(workerConcurrency.updatedAt)).catch(() => [])
}

export async function setWorkerConcurrency(workspaceId: string, queueName: string, factor: number, reason?: string): Promise<void> {
  await db.insert(workerConcurrency).values({
    workspaceId, queueName, factor,
    setBy: 'operator', reason: reason ?? null, updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [workerConcurrency.workspaceId, workerConcurrency.queueName],
    set: { factor, setBy: 'operator', reason: reason ?? null, updatedAt: Date.now() },
  }).catch((e: Error) => { console.error('[preferences-mgmt]', e.message); return null })
}

/** Cron failure summary — reads cron.error events from last N hours. */
export async function cronFailureSummary(hours = 24): Promise<{
  total: number
  byTask: Record<string, number>
  recent: Array<{ task: string; error: string; at: number }>
}> {
  const since = Date.now() - hours * 60 * 60_000
  const rows = await db.select({ payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.type, 'cron.error'), gte(events.createdAt, since)))
    .orderBy(desc(events.createdAt))
    .limit(200).catch(() => [])
  const byTask: Record<string, number> = {}
  const recent: Array<{ task: string; error: string; at: number }> = []
  for (const r of rows) {
    const p = r.payload as { task?: string; error?: string } | null
    const task = p?.task ?? 'unknown'
    byTask[task] = (byTask[task] ?? 0) + 1
    if (recent.length < 20) recent.push({ task, error: p?.error ?? '', at: r.createdAt })
  }
  return { total: rows.length, byTask, recent }
}
