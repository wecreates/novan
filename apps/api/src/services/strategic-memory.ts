/**
 * strategic-memory.ts — Read-only facade over existing memory tables.
 *
 * Unified view of operator's persistent strategic state:
 *   - active missions (strategic_goals)
 *   - successful fixes (successful_fixes)
 *   - failure patterns to avoid (failure_memory)
 *   - past incidents (incidents)
 *   - preferred providers (runtime_settings + provider_health_log)
 *   - roadmap (roadmap_tasks)
 *
 * Pure SELECTs. No new schema, no LLM call.
 */
import { db }                          from '../db/client.js'
import {
  strategicGoals, successfulFixes, failureMemory, incidents,
  roadmapTasks, providerHealthLog,
} from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'

export interface StrategicSnapshot {
  workspaceId: string
  capturedAt:  number
  missions: {
    active:    Array<{ id: string; title: string; horizon: string; progress: number; targetDate: number | null }>
    completed: number
    total:     number
  }
  successfulPatterns: Array<{ signature: string; description: string; applied: number }>
  recurringFailures:  Array<{ signature: string; type: string; occurrences: number; blocked: boolean }>
  recentIncidents:    Array<{ title: string; severity: string; status: string; detectedAt: number }>
  preferredProviders: Array<{ provider: string; healthyProbes: number; degradedProbes: number; downProbes: number }>
  roadmap:            Array<{ phase: string; status: string; count: number }>
}

const DAY = 24 * 60 * 60_000

export async function snapshot(workspaceId: string): Promise<StrategicSnapshot> {
  const week = Date.now() - 7 * DAY
  const [
    activeMissions, completedMissions, totalMissions,
    topFixes, topFailures, recentInc, providerStats, roadmapAgg,
  ] = await Promise.all([
    db.select({
      id: strategicGoals.id, title: strategicGoals.title,
      horizon: strategicGoals.horizon, progress: strategicGoals.progress,
      targetDate: strategicGoals.targetDate,
    }).from(strategicGoals)
      .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'active')))
      .orderBy(strategicGoals.targetDate).limit(10).catch(() => []),

    db.select({ c: sql<number>`count(*)::int` }).from(strategicGoals)
      .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'completed')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({ c: sql<number>`count(*)::int` }).from(strategicGoals)
      .where(eq(strategicGoals.workspaceId, workspaceId))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({
      signature:   successfulFixes.failureSignature,
      description: successfulFixes.fixDescription,
      applied:     successfulFixes.successCount,
    }).from(successfulFixes)
      .where(eq(successfulFixes.workspaceId, workspaceId))
      .orderBy(desc(successfulFixes.successCount)).limit(8).catch(() => []),

    db.select({
      signature:   failureMemory.signature,
      type:        failureMemory.failureType,
      occurrences: failureMemory.occurrenceCount,
      blocked:     failureMemory.blocked,
    }).from(failureMemory)
      .where(eq(failureMemory.workspaceId, workspaceId))
      .orderBy(desc(failureMemory.occurrenceCount)).limit(8).catch(() => []),

    db.select({
      title:      incidents.title,
      severity:   incidents.severity,
      status:     incidents.status,
      detectedAt: incidents.detectedAt,
    }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), gte(incidents.detectedAt, week)))
      .orderBy(desc(incidents.detectedAt)).limit(10).catch(() => []),

    db.select({
      provider: providerHealthLog.providerId,
      healthy:  sql<number>`count(*) filter (where ${providerHealthLog.status} = 'healthy')::int`,
      degraded: sql<number>`count(*) filter (where ${providerHealthLog.status} = 'degraded')::int`,
      down:     sql<number>`count(*) filter (where ${providerHealthLog.status} = 'down')::int`,
    }).from(providerHealthLog)
      .where(and(eq(providerHealthLog.workspaceId, workspaceId), gte(providerHealthLog.checkedAt, week)))
      .groupBy(providerHealthLog.providerId)
      .orderBy(desc(sql`count(*) filter (where ${providerHealthLog.status} = 'healthy')`))
      .limit(10).catch(() => []),

    db.select({
      phase:  roadmapTasks.phase,
      status: roadmapTasks.status,
      c:      sql<number>`count(*)::int`,
    }).from(roadmapTasks)
      .where(eq(roadmapTasks.workspaceId, workspaceId))
      .groupBy(roadmapTasks.phase, roadmapTasks.status).catch(() => []),
  ])

  return {
    workspaceId, capturedAt: Date.now(),
    missions: {
      active: activeMissions.map(m => ({
        id: m.id, title: m.title, horizon: m.horizon,
        progress: Number(m.progress ?? 0),
        targetDate: m.targetDate as number | null,
      })),
      completed: completedMissions,
      total:     totalMissions,
    },
    successfulPatterns: topFixes.map(f => ({
      signature:   String(f.signature ?? ''),
      description: String(f.description ?? ''),
      applied:     Number(f.applied ?? 0),
    })),
    recurringFailures: topFailures.map(f => ({
      signature:   String(f.signature ?? ''),
      type:        String(f.type ?? ''),
      occurrences: Number(f.occurrences ?? 0),
      blocked:     !!f.blocked,
    })),
    recentIncidents: recentInc.map(i => ({
      title:      String(i.title ?? ''),
      severity:   String(i.severity ?? ''),
      status:     String(i.status ?? ''),
      detectedAt: Number(i.detectedAt ?? 0),
    })),
    preferredProviders: providerStats.map(p => ({
      provider:      String(p.provider),
      healthyProbes: Number(p.healthy ?? 0),
      degradedProbes: Number(p.degraded ?? 0),
      downProbes:    Number(p.down ?? 0),
    })),
    roadmap: roadmapAgg.map(r => ({ phase: String(r.phase), status: String(r.status), count: Number(r.c) })),
  }
}
