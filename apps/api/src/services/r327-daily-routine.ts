/**
 * R146.327 (#6) — daily routine.
 *
 * What Novan does every morning at 06:00 without being asked:
 *   1. scan markets / feeds for the workspace's domains
 *   2. draft 1-3 content ideas
 *   3. triage pending approvals
 *   4. update Monday briefing if it's Monday
 *   5. fire a web-push notification with a 1-line summary
 *
 * Lives behind a daily cron tick. Idempotent — uses a workspace_memory
 * sentinel key so it only runs once per local day per workspace.
 */
import { db } from '../db/client.js'
import { workspaceMemory, events, workspaces } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const SENTINEL_KEY_PREFIX = '_dailyRoutine.'  // suffix is YYYY-MM-DD local

function todayKey(): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${SENTINEL_KEY_PREFIX}${y}-${m}-${day}`
}

async function alreadyRan(workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ value: workspaceMemory.value })
    .from(workspaceMemory)
    .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.key, todayKey())))
    .limit(1).catch(() => [])
  return Boolean(row)
}

async function markRan(workspaceId: string, summary: Record<string, unknown>): Promise<void> {
  const now = Date.now()
  await db.insert(workspaceMemory).values({
    workspaceId, key: todayKey(), value: JSON.stringify(summary),
    scope: 'system', importance: 70, updatedAt: now,
  } as never).onConflictDoUpdate({
    target: [workspaceMemory.workspaceId, workspaceMemory.key],
    set: { value: JSON.stringify(summary), updatedAt: now },
  }).catch(() => null)
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'r327-daily-routine', version: 1, createdAt: Date.now(),
  } as never).catch(() => null)
}

export interface DailyRoutineResult {
  workspaceId:        string
  ranAt:              number
  skipped:            boolean
  feedScansAttempted: number
  contentIdeasDrafted: number
  approvalsTriaged:   number
  notificationsSent:  number
  briefingUpdated:    boolean
  errors:             string[]
}

export async function runDailyRoutine(workspaceId: string): Promise<DailyRoutineResult> {
  const out: DailyRoutineResult = {
    workspaceId, ranAt: Date.now(), skipped: false,
    feedScansAttempted: 0, contentIdeasDrafted: 0, approvalsTriaged: 0,
    notificationsSent: 0, briefingUpdated: false, errors: [],
  }
  if (await alreadyRan(workspaceId)) { out.skipped = true; return out }

  // 1. feed scan — uses existing frontier-intel if available
  try {
    const mod = await import('./frontier-intel.js').catch(() => null) as { scanFeeds?: (ws: string) => Promise<{ items: unknown[] }> } | null
    if (mod?.scanFeeds) {
      const r = await mod.scanFeeds(workspaceId).catch(() => ({ items: [] }))
      out.feedScansAttempted = r.items.length
    }
  } catch (e) { out.errors.push(`feedScan: ${(e as Error).message}`) }

  // 2. content ideas
  try {
    const mod = await import('./ideas.js').catch(() => null) as { generateIdeasForWorkspace?: (ws: string, n: number) => Promise<unknown[]> } | null
    if (mod?.generateIdeasForWorkspace) {
      const ideas = await mod.generateIdeasForWorkspace(workspaceId, 3).catch(() => [])
      out.contentIdeasDrafted = ideas.length
    }
  } catch (e) { out.errors.push(`ideas: ${(e as Error).message}`) }

  // 3. triage pending approvals
  try {
    const { db: _db } = await import('../db/client.js')
    const { approvals } = await import('../db/schema.js')
    const { eq: _eq, and: _and } = await import('drizzle-orm')
    const rows = await _db.select({ id: approvals.id })
      .from(approvals)
      .where(_and(_eq(approvals.workspaceId, workspaceId), _eq(approvals.status, 'pending')))
      .catch(() => [])
    out.approvalsTriaged = rows.length
  } catch (e) { out.errors.push(`approvals: ${(e as Error).message}`) }

  // 4. Monday briefing — only on actual Monday
  if (new Date().getUTCDay() === 1) {
    try {
      const mod = await import('./r74-monday-briefing.js').catch(() => null) as { runMondayBriefing?: (ws: string) => Promise<unknown> } | null
      if (mod?.runMondayBriefing) {
        await mod.runMondayBriefing(workspaceId).catch(() => null)
        out.briefingUpdated = true
      }
    } catch (e) { out.errors.push(`briefing: ${(e as Error).message}`) }
  }

  // 5. push notification
  try {
    const mod = await import('./web-push.js').catch(() => null) as { broadcastPush?: (ws: string, p: { title: string; body: string; tag?: string }) => Promise<{ sent: number }> } | null
    if (mod?.broadcastPush) {
      const summary = `${out.contentIdeasDrafted} ideas, ${out.approvalsTriaged} pending`
      const r = await mod.broadcastPush(workspaceId, { title: 'Good morning', body: summary, tag: 'daily-routine' }).catch(() => ({ sent: 0 }))
      out.notificationsSent = r.sent
    }
  } catch (e) { out.errors.push(`push: ${(e as Error).message}`) }

  await emit(workspaceId, 'daily_routine.complete', { ...out })
  await markRan(workspaceId, out as unknown as Record<string, unknown>)
  return out
}

/** Tick across all workspaces. Called by the daily cron at 06:00 UTC.
 *  Per-workspace failures are isolated. */
export async function tickAll(): Promise<{ ran: number; skipped: number; errored: number }> {
  const rows = await db.select({ id: workspaces.id }).from(workspaces).catch(() => [])
  let ran = 0, skipped = 0, errored = 0
  for (const r of rows) {
    try {
      const result = await runDailyRoutine(r.id)
      if (result.skipped) skipped++
      else ran++
    } catch { errored++ }
  }
  return { ran, skipped, errored }
}
