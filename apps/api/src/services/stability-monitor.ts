/**
 * Stability Monitor
 * Computes a composite health score and alert list for the runtime.
 * All DB calls are fire-and-forget safe (errors degrade score but don't throw).
 */

import { db }                              from '../db/client.js'
import { workflowRuns, executionLeases, workerRegistry, killSwitches, budgetCaps } from '../db/schema.js'
import { eq, and, lt, ne, inArray }        from 'drizzle-orm'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HealthAlert {
  level:     'warning' | 'critical'
  component: 'queue' | 'provider' | 'worker' | 'budget' | 'lease'
  message:   string
  value?:    number
}

export interface ComponentScores {
  queue:    number
  provider: number
  worker:   number
  budget:   number
  lease:    number
}

export interface HealthReport {
  workspaceId:    string
  overall:        number
  components:     ComponentScores
  alerts:         HealthAlert[]
  checkedAt:      number
  stuckWorkflows: number
  orphanLeases:   number
  deadWorkers:    number
}

// ─── Implementation ───────────────────────────────────────────────────────────

export async function computeHealthScore(workspaceId: string): Promise<HealthReport> {
  const alerts: HealthAlert[] = []
  const now = Date.now()
  const thirtyMinAgo = now - 30 * 60 * 1000
  const twoMinAgo    = now - 2  * 60 * 1000

  let queueScore    = 100
  let providerScore = 100
  let workerScore   = 100
  let budgetScore   = 100
  let leaseScore    = 100

  let stuckWorkflows = 0
  let orphanLeases   = 0
  let deadWorkers    = 0

  // ── Queue: stuck workflows ────────────────────────────────────────────────
  try {
    const stuck = await db.select().from(workflowRuns).where(
      and(
        eq(workflowRuns.workspaceId, workspaceId),
        inArray(workflowRuns.status, ['running', 'pending']),
        lt(workflowRuns.triggeredAt, thirtyMinAgo),
      ),
    )
    stuckWorkflows = stuck.length

    if (stuckWorkflows > 3) {
      queueScore = 0
      alerts.push({ level: 'critical', component: 'queue', message: `${stuckWorkflows} stuck workflows detected`, value: stuckWorkflows })
    } else {
      queueScore = Math.max(0, 100 - stuckWorkflows * 10)
    }
  } catch {
    queueScore = 50
    alerts.push({ level: 'warning', component: 'queue', message: 'Failed to query workflow runs' })
  }

  // ── Lease: orphan leases ──────────────────────────────────────────────────
  try {
    const orphans = await db.select().from(executionLeases).where(
      and(
        eq(executionLeases.workspaceId, workspaceId),
        eq(executionLeases.status, 'active'),
        lt(executionLeases.expiresAt, now),
      ),
    )
    orphanLeases = orphans.length
    leaseScore   = Math.max(0, 100 - orphanLeases * 5)

    if (orphanLeases > 5) {
      alerts.push({ level: 'critical', component: 'lease', message: `${orphanLeases} orphan leases detected`, value: orphanLeases })
    }
  } catch {
    leaseScore = 50
    alerts.push({ level: 'warning', component: 'lease', message: 'Failed to query execution leases' })
  }

  // ── Worker: dead workers + kill switch ────────────────────────────────────
  try {
    const dead = await db.select().from(workerRegistry).where(
      and(
        eq(workerRegistry.workspaceId, workspaceId),
        ne(workerRegistry.status, 'offline'),
        lt(workerRegistry.lastHeartbeatAt, twoMinAgo),
      ),
    )
    deadWorkers = dead.length
    workerScore = Math.max(0, 100 - deadWorkers * 15)

    if (deadWorkers > 2) {
      alerts.push({ level: 'critical', component: 'worker', message: `${deadWorkers} dead workers detected`, value: deadWorkers })
    }
  } catch {
    workerScore = 50
    alerts.push({ level: 'warning', component: 'worker', message: 'Failed to query worker registry' })
  }

  // ── Kill switches ─────────────────────────────────────────────────────────
  try {
    const switches = await db.select().from(killSwitches).where(
      and(
        eq(killSwitches.workspaceId, workspaceId),
        eq(killSwitches.enabled, true),
      ),
    )

    for (const sw of switches) {
      if (sw.switchType === 'global') {
        workerScore = 0
        alerts.push({ level: 'critical', component: 'worker', message: 'Global kill switch active' })
      } else if (sw.switchType === 'provider') {
        providerScore = 50
      }
    }
  } catch {
    alerts.push({ level: 'warning', component: 'worker', message: 'Failed to query kill switches' })
  }

  // ── Budget caps ───────────────────────────────────────────────────────────
  try {
    const caps = await db.select().from(budgetCaps).where(
      and(
        eq(budgetCaps.workspaceId, workspaceId),
        eq(budgetCaps.enabled, true),
      ),
    )

    for (const cap of caps) {
      const daily    = cap.currentDailyUsd   ?? 0
      const maxDaily = cap.maxDailyUsd        ?? null

      if (maxDaily !== null && maxDaily > 0) {
        if (daily > maxDaily) {
          budgetScore = Math.max(0, budgetScore - 30)
          alerts.push({ level: 'critical', component: 'budget', message: 'Budget cap exceeded', value: daily })
        } else if (daily > maxDaily * 0.9) {
          alerts.push({ level: 'warning', component: 'budget', message: 'Budget near limit', value: daily })
        }
      }
    }
  } catch {
    budgetScore = 50
    alerts.push({ level: 'warning', component: 'budget', message: 'Failed to query budget caps' })
  }

  // ── Overall weighted score ─────────────────────────────────────────────────
  const overall = Math.round(
    queueScore    * 0.30 +
    providerScore * 0.25 +
    workerScore   * 0.20 +
    budgetScore   * 0.15 +
    leaseScore    * 0.10,
  )

  return {
    workspaceId,
    overall:    Math.max(0, Math.min(100, overall)),
    components: {
      queue:    Math.max(0, Math.min(100, queueScore)),
      provider: Math.max(0, Math.min(100, providerScore)),
      worker:   Math.max(0, Math.min(100, workerScore)),
      budget:   Math.max(0, Math.min(100, budgetScore)),
      lease:    Math.max(0, Math.min(100, leaseScore)),
    },
    alerts,
    checkedAt:      now,
    stuckWorkflows,
    orphanLeases,
    deadWorkers,
  }
}
