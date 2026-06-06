/**
 * R146.262 — Persisted brain.health snapshots for trend history.
 *
 * R255 already ticks brain.health every 15min — extend that tick to
 * also INSERT into brain_health_snapshots. ~96 rows/day/workspace; not
 * a storage concern. Pruned alongside events (90-day default).
 */
import { db } from '../db/client.js'
import { brainHealthSnapshots } from '../db/schema.js'
import { and, eq, gte, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { BrainHealth } from './r253-brain-health.js'

export async function persistSnapshot(workspaceId: string, h: BrainHealth): Promise<void> {
  await db.insert(brainHealthSnapshots).values({
    id: uuidv7(),
    workspaceId,
    overall:       h.overall,
    costSpent:     h.cost.spent,
    costCap:       h.cost.cap,
    backupStatus:  h.backup.status,
    applierStatus: h.applier.status,
    cronMissing:   h.cron.missing,
    errors1h:      h.errors.last1h,
    skillsTotal:   h.skills.total,
    snapshot:      h as unknown as Record<string, unknown>,
    createdAt:     h.at,
  }).catch(() => null)
}

export interface HistoryRow {
  overall:       string
  costSpent:     number
  cronMissing:   number
  errors1h:      number
  createdAt:     number
}

/** Returns last N snapshots, newest first. */
export async function readHistory(workspaceId: string, sinceMs = 24 * 60 * 60_000, limit = 200): Promise<HistoryRow[]> {
  const cutoff = Date.now() - sinceMs
  const rows = await db.select({
    overall:     brainHealthSnapshots.overall,
    costSpent:   brainHealthSnapshots.costSpent,
    cronMissing: brainHealthSnapshots.cronMissing,
    errors1h:    brainHealthSnapshots.errors1h,
    createdAt:   brainHealthSnapshots.createdAt,
  }).from(brainHealthSnapshots)
    .where(and(
      eq(brainHealthSnapshots.workspaceId, workspaceId),
      gte(brainHealthSnapshots.createdAt, cutoff),
    ))
    .orderBy(desc(brainHealthSnapshots.createdAt))
    .limit(limit)
    .catch(() => [])
  return rows
}

/** Aggregated counts for the period: how many ticks in each state, max spent. */
export async function readSummary(workspaceId: string, sinceMs = 24 * 60 * 60_000): Promise<{
  ticks: number
  healthy: number
  degraded: number
  critical: number
  maxCostSpent: number
  maxCronMissing: number
}> {
  const cutoff = Date.now() - sinceMs
  const rows = await db.select({
    overall:     brainHealthSnapshots.overall,
    costSpent:   brainHealthSnapshots.costSpent,
    cronMissing: brainHealthSnapshots.cronMissing,
  }).from(brainHealthSnapshots)
    .where(and(
      eq(brainHealthSnapshots.workspaceId, workspaceId),
      gte(brainHealthSnapshots.createdAt, cutoff),
    ))
    .catch(() => [])
  let healthy = 0, degraded = 0, critical = 0
  let maxCost = 0, maxCron = 0
  for (const r of rows) {
    if (r.overall === 'healthy') healthy++
    else if (r.overall === 'degraded') degraded++
    else if (r.overall === 'critical') critical++
    if (Number(r.costSpent) > maxCost) maxCost = Number(r.costSpent)
    if (Number(r.cronMissing) > maxCron) maxCron = Number(r.cronMissing)
  }
  return { ticks: rows.length, healthy, degraded, critical, maxCostSpent: maxCost, maxCronMissing: maxCron }
}

// Prevent unused-import warnings (sql kept for future window-fn query)
void sql
