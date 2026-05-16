/**
 * Cost + Safety Governor Routes
 *
 * Budget rules, kill switches, runaway job management,
 * per-provider / per-worker spend, and budget alerts.
 *
 * Prefix: /api/v1/governor
 */

import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 } from 'uuid'
import { and, desc, eq } from 'drizzle-orm'
import { db }  from '../db/client.js'
import {
  events, providerBudgets, killSwitches, runawayJobs, budgetAlerts,
  endpointUsageLogs, providerFailures,
} from '../db/schema.js'
import {
  checkJobAllowed, getThrottleLevel, checkBudgetAlerts,
  DEFAULT_BUDGET_RULES,
} from '@ops/ai-router'
import type { JobType, KillSwitchType, SpendState, BudgetRules } from '@ops/ai-router'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SWITCH_TYPES: KillSwitchType[] = ['remote_worker', 'provider', 'browser_job', 'ai_request']

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/cost-governor', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

/** Load budget row, returning defaults if not found */
async function loadBudget(workspaceId: string) {
  const rows = await db.select().from(providerBudgets)
    .where(eq(providerBudgets.workspaceId, workspaceId)).limit(1)
  return rows[0] ?? null
}

/** Build BudgetRules from DB row or defaults */
function rowToRules(row: typeof providerBudgets.$inferSelect | null): BudgetRules {
  if (!row) return DEFAULT_BUDGET_RULES
  return {
    dailyLimitUsd:         row.dailyLimitUsd,
    weeklyLimitUsd:        row.weeklyLimitUsd,
    monthlyLimitUsd:       row.monthlyLimitUsd,
    maxPerJobUsd:          row.maxPerJobUsd,
    maxBrowserSessionSecs: row.maxBrowserSessionSecs,
    maxAiRequestSecs:      row.maxAiRequestSecs,
    maxRetries:            row.maxRetries,
    maxConcurrentRemote:   row.maxConcurrentRemote,
    hardStop:              row.hardStop,
    alertThreshold:        row.alertThreshold,
  }
}

/** Load all enabled kill switch types for a workspace */
async function loadActiveSwitches(workspaceId: string): Promise<KillSwitchType[]> {
  const rows = await db.select({ switchType: killSwitches.switchType })
    .from(killSwitches)
    .where(and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.enabled, true)))
  return rows.map((r) => r.switchType as KillSwitchType)
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const costGovernorRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /budgets/:workspaceId — full budget state + rules ─────────────────
  app.get<{ Params: { workspaceId: string } }>(
    '/budgets/:workspaceId',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const row = await loadBudget(workspaceId)
      const rules = rowToRules(row)

      const spend: SpendState = {
        dailySpendUsd:   row?.dailySpendUsd   ?? 0,
        weeklySpendUsd:  row?.weeklySpendUsd  ?? 0,
        monthlySpendUsd: row?.monthlySpendUsd ?? 0,
      }

      const throttle = getThrottleLevel(spend, rules)
      const activeSwitches = await loadActiveSwitches(workspaceId)

      return reply.send({
        success: true,
        data: { rules, spend, throttle, activeSwitches, hardStop: row?.hardStop ?? false },
      })
    },
  )

  // ── PUT /budgets/:workspaceId — upsert budget rules ───────────────────────
  app.put<{
    Params: { workspaceId: string }
    Body: {
      daily_limit_usd?: number
      weekly_limit_usd?: number
      monthly_limit_usd?: number
      max_per_job_usd?: number
      max_browser_session_secs?: number
      max_ai_request_secs?: number
      max_retries?: number
      max_concurrent_remote?: number
      alert_threshold?: number
      hard_stop?: boolean
    }
  }>(
    '/budgets/:workspaceId',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const b = req.body
      const now = Date.now()

      const existing = await loadBudget(workspaceId)
      const row = {
        id:                    existing?.id ?? uuidv7(),
        workspaceId,
        dailyLimitUsd:         b.daily_limit_usd          ?? existing?.dailyLimitUsd         ?? 10,
        weeklyLimitUsd:        b.weekly_limit_usd         ?? existing?.weeklyLimitUsd         ?? 0,
        monthlyLimitUsd:       b.monthly_limit_usd        ?? existing?.monthlyLimitUsd        ?? 100,
        dailySpendUsd:         existing?.dailySpendUsd    ?? 0,
        weeklySpendUsd:        existing?.weeklySpendUsd   ?? 0,
        monthlySpendUsd:       existing?.monthlySpendUsd  ?? 0,
        dailyResetAt:          existing?.dailyResetAt     ?? now,
        weeklyResetAt:         existing?.weeklyResetAt    ?? null,
        monthlyResetAt:        existing?.monthlyResetAt   ?? now,
        maxPerJobUsd:          b.max_per_job_usd          ?? existing?.maxPerJobUsd           ?? 0,
        maxBrowserSessionSecs: b.max_browser_session_secs ?? existing?.maxBrowserSessionSecs  ?? 0,
        maxAiRequestSecs:      b.max_ai_request_secs      ?? existing?.maxAiRequestSecs       ?? 0,
        maxRetries:            b.max_retries              ?? existing?.maxRetries              ?? 10,
        maxConcurrentRemote:   b.max_concurrent_remote    ?? existing?.maxConcurrentRemote     ?? 5,
        alertThreshold:        b.alert_threshold          ?? existing?.alertThreshold          ?? 0.8,
        hardStop:              b.hard_stop                ?? existing?.hardStop               ?? false,
        updatedAt:             now,
      }

      await db.insert(providerBudgets).values(row)
        .onConflictDoUpdate({ target: providerBudgets.workspaceId, set: { ...row } })

      await emit(workspaceId, 'budget.limit.created', {
        workspaceId,
        dailyLimitUsd:   row.dailyLimitUsd,
        weeklyLimitUsd:  row.weeklyLimitUsd,
        monthlyLimitUsd: row.monthlyLimitUsd,
        maxPerJobUsd:    row.maxPerJobUsd,
        hardStop:        row.hardStop,
      })

      return reply.status(200).send({ success: true, data: row })
    },
  )

  // ── POST /budgets/:workspaceId/check-job — pre-flight cost check ──────────
  app.post<{
    Params: { workspaceId: string }
    Body: { job_type: string; estimated_cost_usd: number }
  }>(
    '/budgets/:workspaceId/check-job',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const { job_type, estimated_cost_usd } = req.body

      const row = await loadBudget(workspaceId)
      const rules = rowToRules(row)
      const spend: SpendState = {
        dailySpendUsd:   row?.dailySpendUsd   ?? 0,
        weeklySpendUsd:  row?.weeklySpendUsd  ?? 0,
        monthlySpendUsd: row?.monthlySpendUsd ?? 0,
      }
      const activeSwitches = await loadActiveSwitches(workspaceId)

      const result = checkJobAllowed(
        job_type as JobType, estimated_cost_usd, spend, rules, activeSwitches,
      )

      await emit(workspaceId, 'cost.estimate.created', {
        workspaceId, jobType: job_type, estimatedCostUsd: estimated_cost_usd,
        allowed: result.allowed, throttle: result.throttle, reason: result.reason ?? null,
      })

      if (!result.allowed) {
        await emit(workspaceId, 'budget.job.blocked', {
          workspaceId, jobType: job_type, estimatedCostUsd: estimated_cost_usd,
          reason: result.reason,
        })
      }

      return reply.status(result.allowed ? 200 : 402).send({ success: result.allowed, data: result })
    },
  )

  // ── GET /kill-switches/:workspaceId — list all switches ──────────────────
  app.get<{ Params: { workspaceId: string } }>(
    '/kill-switches/:workspaceId',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const rows = await db.select().from(killSwitches)
        .where(eq(killSwitches.workspaceId, workspaceId))

      // Ensure all switch types exist in response
      const byType = Object.fromEntries(rows.map((r) => [r.switchType, r]))
      const switches = SWITCH_TYPES.map((t) => byType[t] ?? {
        id: null, workspaceId, switchType: t, enabled: false,
        reason: null, enabledBy: null, enabledAt: null, disabledAt: null,
      })

      return reply.send({ success: true, data: switches })
    },
  )

  // ── POST /kill-switches/:workspaceId/:type/enable ─────────────────────────
  app.post<{
    Params: { workspaceId: string; type: string }
    Body: { reason?: string }
  }>(
    '/kill-switches/:workspaceId/:type/enable',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId, type } = req.params
      const reason = req.body.reason ?? null
      const now = Date.now()

      const existing = await db.select().from(killSwitches).where(
        and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.switchType, type)),
      ).limit(1)

      const row = {
        id:          existing[0]?.id ?? uuidv7(),
        workspaceId, switchType: type,
        enabled:     true, reason,
        enabledBy:   null as string | null,
        enabledAt:   now,
        disabledAt:  null as number | null,
        createdAt:   existing[0]?.createdAt ?? now,
        updatedAt:   now,
      }

      await db.insert(killSwitches).values(row)
        .onConflictDoUpdate({
          target: [killSwitches.workspaceId, killSwitches.switchType],
          set: { enabled: true, reason, enabledAt: now, disabledAt: null, updatedAt: now },
        })

      await emit(workspaceId, 'remote.kill_switch.enabled', { workspaceId, switchType: type, reason })

      return reply.status(200).send({ success: true, data: row })
    },
  )

  // ── POST /kill-switches/:workspaceId/:type/disable ────────────────────────
  app.post<{ Params: { workspaceId: string; type: string } }>(
    '/kill-switches/:workspaceId/:type/disable',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId, type } = req.params
      const now = Date.now()

      await db.insert(killSwitches).values({
        id: uuidv7(), workspaceId, switchType: type,
        enabled: false, reason: null, enabledBy: null, enabledAt: null,
        disabledAt: now, createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: [killSwitches.workspaceId, killSwitches.switchType],
        set: { enabled: false, disabledAt: now, updatedAt: now },
      })

      await emit(workspaceId, 'remote.kill_switch.disabled', { workspaceId, switchType: type })

      return reply.status(200).send({ success: true })
    },
  )

  // ── GET /runaway-jobs/:workspaceId — list runaway jobs ────────────────────
  app.get<{ Params: { workspaceId: string }; Querystring: { stopped?: string } }>(
    '/runaway-jobs/:workspaceId',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const onlyActive = req.query.stopped !== 'true'

      const conditions = [eq(runawayJobs.workspaceId, workspaceId)]
      if (onlyActive) conditions.push(eq(runawayJobs.stopped, false))

      const rows = await db.select().from(runawayJobs)
        .where(and(...conditions))
        .orderBy(desc(runawayJobs.detectedAt))
        .limit(100)

      return reply.send({ success: true, data: rows })
    },
  )

  // ── POST /runaway-jobs/:workspaceId/report — record a detected runaway ────
  app.post<{
    Params: { workspaceId: string }
    Body: {
      job_id: string; job_type: string; cost_usd: number
      duration_ms: number; reason: string; endpoint_id?: string; provider_id?: string
    }
  }>(
    '/runaway-jobs/:workspaceId/report',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const { job_id, job_type, cost_usd, duration_ms, reason, endpoint_id, provider_id } = req.body
      const now = Date.now()

      const row = {
        id: uuidv7(), workspaceId, jobId: job_id, jobType: job_type,
        endpointId:  endpoint_id ?? null,
        providerId:  provider_id ?? null,
        costUsd: cost_usd, durationMs: duration_ms,
        reason, stopped: false, stoppedAt: null,
        detectedAt: now,
      }

      await db.insert(runawayJobs).values(row)
      await emit(workspaceId, 'runaway.job.detected', {
        workspaceId, jobId: job_id, jobType: job_type,
        costUsd: cost_usd, durationMs: duration_ms, reason,
      })

      return reply.status(201).send({ success: true, data: { id: row.id } })
    },
  )

  // ── POST /runaway-jobs/:id/stop — mark a runaway job as stopped ───────────
  app.post<{ Params: { id: string } }>(
    '/runaway-jobs/:id/stop',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params
      const now = Date.now()

      const rows = await db.select().from(runawayJobs).where(eq(runawayJobs.id, id)).limit(1)
      if (!rows[0]) return reply.status(404).send({ success: false, error: 'Not found' })

      await db.update(runawayJobs)
        .set({ stopped: true, stoppedAt: now })
        .where(eq(runawayJobs.id, id))

      const job = rows[0]
      await emit(job.workspaceId, 'remote.kill_switch.enabled', {
        workspaceId: job.workspaceId, jobId: job.jobId, reason: 'manual_stop',
      })

      return reply.send({ success: true })
    },
  )

  // ── GET /alerts/:workspaceId — list budget alerts ─────────────────────────
  app.get<{ Params: { workspaceId: string }; Querystring: { dismissed?: string } }>(
    '/alerts/:workspaceId',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const includeDismissed = req.query.dismissed === 'true'

      const conditions = [eq(budgetAlerts.workspaceId, workspaceId)]
      if (!includeDismissed) conditions.push(eq(budgetAlerts.dismissed, false))

      const rows = await db.select().from(budgetAlerts)
        .where(and(...conditions))
        .orderBy(desc(budgetAlerts.firedAt))
        .limit(200)

      return reply.send({ success: true, data: rows })
    },
  )

  // ── POST /alerts — fire a budget alert ────────────────────────────────────
  app.post<{
    Body: {
      workspace_id: string; alert_type: string
      threshold_pct: number; current_usd: number; limit_usd: number
    }
  }>(
    '/alerts',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspace_id, alert_type, threshold_pct, current_usd, limit_usd } = req.body
      const now = Date.now()

      const row = {
        id: uuidv7(), workspaceId: workspace_id,
        alertType: alert_type, thresholdPct: threshold_pct,
        currentUsd: current_usd, limitUsd: limit_usd,
        dismissed: false, dismissedAt: null, firedAt: now,
      }

      await db.insert(budgetAlerts).values(row)
      await emit(workspace_id, 'budget.limit.hit', {
        workspaceId: workspace_id, alertType: alert_type,
        thresholdPct: threshold_pct, currentUsd: current_usd, limitUsd: limit_usd,
      })

      return reply.status(201).send({ success: true, data: { id: row.id } })
    },
  )

  // ── POST /alerts/:id/dismiss — dismiss an alert ───────────────────────────
  app.post<{ Params: { id: string } }>(
    '/alerts/:id/dismiss',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { id } = req.params
      await db.update(budgetAlerts)
        .set({ dismissed: true, dismissedAt: Date.now() })
        .where(eq(budgetAlerts.id, id))
      return reply.send({ success: true })
    },
  )

  // ── GET /usage/providers/:workspaceId — per-provider spend breakdown ───────
  app.get<{ Params: { workspaceId: string }; Querystring: { days?: string } }>(
    '/usage/providers/:workspaceId',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const days   = parseInt(req.query.days ?? '30', 10)
      const since  = Date.now() - days * 86_400_000

      // Use providerFailures (has createdAt + costUsd) for provider cost aggregation
      const rows = await db.select().from(providerFailures)
        .where(and(
          eq(providerFailures.workspaceId, workspaceId),
        ))
        .orderBy(desc(providerFailures.createdAt))
        .limit(2000)

      // Aggregate by providerId
      const byProvider: Record<string, { costUsd: number; requests: number; lastUsed: number }> = {}
      for (const r of rows) {
        if (r.createdAt < since) continue
        const key = r.providerId
        if (!byProvider[key]) byProvider[key] = { costUsd: 0, requests: 0, lastUsed: 0 }
        byProvider[key]!.costUsd  += r.costUsd ?? 0
        byProvider[key]!.requests += 1
        byProvider[key]!.lastUsed  = Math.max(byProvider[key]!.lastUsed, r.createdAt)
      }

      const data = Object.entries(byProvider).map(([providerId, stats]) => ({ providerId, ...stats }))
        .sort((a, b) => b.costUsd - a.costUsd)

      return reply.send({ success: true, data })
    },
  )

  // ── GET /usage/endpoints/:workspaceId — per-endpoint spend breakdown ───────
  app.get<{ Params: { workspaceId: string }; Querystring: { days?: string } }>(
    '/usage/endpoints/:workspaceId',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const days   = parseInt(req.query.days ?? '30', 10)
      const since  = Date.now() - days * 86_400_000

      const rows = await db.select().from(endpointUsageLogs)
        .where(and(
          eq(endpointUsageLogs.workspaceId, workspaceId),
        ))
        .orderBy(desc(endpointUsageLogs.createdAt))
        .limit(1000)

      // Aggregate by endpointId
      const byEndpoint: Record<string, {
        costUsd: number; requests: number; promptTokens: number
        outputTokens: number; failedRequests: number; lastUsed: number
      }> = {}

      for (const r of rows) {
        if (r.createdAt < since) continue
        const key = r.endpointId
        if (!byEndpoint[key]) {
          byEndpoint[key] = { costUsd: 0, requests: 0, promptTokens: 0, outputTokens: 0, failedRequests: 0, lastUsed: 0 }
        }
        byEndpoint[key]!.costUsd        += r.costUsd
        byEndpoint[key]!.requests       += 1
        byEndpoint[key]!.promptTokens   += r.promptTokens
        byEndpoint[key]!.outputTokens   += r.outputTokens
        byEndpoint[key]!.failedRequests += r.success ? 0 : 1
        byEndpoint[key]!.lastUsed        = Math.max(byEndpoint[key]!.lastUsed, r.createdAt)
      }

      const data = Object.entries(byEndpoint)
        .map(([endpointId, stats]) => ({ endpointId, ...stats }))
        .sort((a, b) => b.costUsd - a.costUsd)

      return reply.send({ success: true, data })
    },
  )

  // ── POST /usage/record — record cost spend (from workers/jobs) ────────────
  app.post<{
    Body: {
      workspace_id: string; job_type: string; cost_usd: number
      endpoint_id?: string; provider_id?: string; model?: string
    }
  }>(
    '/usage/record',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspace_id, job_type, cost_usd, endpoint_id, provider_id, model } = req.body
      const now = Date.now()

      // Update daily/weekly/monthly spend in providerBudgets
      const existing = await loadBudget(workspace_id)
      if (existing) {
        await db.update(providerBudgets).set({
          dailySpendUsd:   existing.dailySpendUsd   + cost_usd,
          weeklySpendUsd:  existing.weeklySpendUsd  + cost_usd,
          monthlySpendUsd: existing.monthlySpendUsd + cost_usd,
          updatedAt:       now,
        }).where(eq(providerBudgets.workspaceId, workspace_id))
      }

      await emit(workspace_id, 'cost.usage.recorded', {
        workspaceId: workspace_id, jobType: job_type,
        costUsd: cost_usd, endpointId: endpoint_id ?? null,
        providerId: provider_id ?? null, model: model ?? null,
      })

      // Check if any budget alerts should fire
      if (existing) {
        const rules = rowToRules(existing)
        const newSpend: SpendState = {
          dailySpendUsd:   existing.dailySpendUsd   + cost_usd,
          weeklySpendUsd:  existing.weeklySpendUsd  + cost_usd,
          monthlySpendUsd: existing.monthlySpendUsd + cost_usd,
        }
        const fired = checkBudgetAlerts(newSpend, rules, {})
        for (const a of fired) {
          await db.insert(budgetAlerts).values({
            id: uuidv7(), workspaceId: workspace_id,
            alertType: a.alertType, thresholdPct: a.pct,
            currentUsd: a.currentUsd, limitUsd: a.limitUsd,
            dismissed: false, dismissedAt: null, firedAt: now,
          }).catch(() => null)
          await emit(workspace_id, 'budget.limit.hit', {
            workspaceId: workspace_id, alertType: a.alertType,
            thresholdPct: a.pct, currentUsd: a.currentUsd, limitUsd: a.limitUsd,
          })
        }
      }

      return reply.status(201).send({ success: true })
    },
  )

  // ── POST /workers/:workspaceId/idle-shutdown — record idle shutdown ────────
  app.post<{
    Params: { workspaceId: string }
    Body: { worker_id: string; worker_type: string; idle_ms: number }
  }>(
    '/workers/:workspaceId/idle-shutdown',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const { worker_id, worker_type, idle_ms } = req.body

      await emit(workspaceId, 'worker.auto_shutdown', {
        workspaceId, workerId: worker_id, workerType: worker_type, idleMs: idle_ms,
      })

      return reply.status(200).send({ success: true })
    },
  )

  // ── POST /providers/:workspaceId/auto-disable — record auto-disable ───────
  app.post<{
    Params: { workspaceId: string }
    Body: { provider_id: string; reason: string }
  }>(
    '/providers/:workspaceId/auto-disable',
    { onRequest: [app.authenticate] },
    async (req, reply) => {
      const { workspaceId } = req.params
      const { provider_id, reason } = req.body

      await emit(workspaceId, 'provider.auto_disabled', {
        workspaceId, providerId: provider_id, reason,
      })

      return reply.status(200).send({ success: true })
    },
  )
}

export default costGovernorRoutes
