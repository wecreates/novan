/**
 * Analytics routes — AI usage stats and operational health summaries.
 *
 * GET /api/v1/analytics/ai-usage         — aggregate AI usage
 * GET /api/v1/analytics/ai-usage/history — time-series by day
 * GET /api/v1/analytics/summary          — operational health snapshot
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq, and, gte, desc } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiUsage, events, workflowRuns } from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

const AiUsageQuery = z.object({
  windowMs: z.coerce.number().int().min(1).default(86_400_000),
})

const HistoryQuery = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
})

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  // GET /ai-usage — aggregate
  app.get('/ai-usage', async (req, reply) => {
    const { windowMs } = AiUsageQuery.parse(req.query)
    const workspaceId = ws(req)
    const since = Date.now() - windowMs

    const rows = await db.select().from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))

    let totalPromptTokens = 0
    let totalOutputTokens = 0
    let totalCostUsd = 0
    let totalRequests = 0
    let cachedRequests = 0
    let totalLatencyMs = 0
    let latencyCount = 0

    const byProvider: Record<string, { requests: number; promptTokens: number; outputTokens: number; costUsd: number }> = {}
    const byModel: Record<string, { requests: number; costUsd: number }> = {}
    const byTaskType: Record<string, number> = {}

    for (const row of rows) {
      const promptTokens = row.promptTokens ?? 0
      const outputTokens = row.outputTokens ?? 0
      const costUsd = row.costUsd ?? 0
      const cached = row.cached ?? false
      const latencyMs = row.latencyMs ?? null

      totalRequests++
      totalPromptTokens += promptTokens
      totalOutputTokens += outputTokens
      totalCostUsd += costUsd
      if (cached) cachedRequests++
      if (latencyMs !== null) { totalLatencyMs += latencyMs; latencyCount++ }

      const provider = row.provider ?? 'unknown'
      byProvider[provider] ??= { requests: 0, promptTokens: 0, outputTokens: 0, costUsd: 0 }
      byProvider[provider].requests++
      byProvider[provider].promptTokens += promptTokens
      byProvider[provider].outputTokens += outputTokens
      byProvider[provider].costUsd += costUsd

      const model = row.model ?? 'unknown'
      byModel[model] ??= { requests: 0, costUsd: 0 }
      byModel[model].requests++
      byModel[model].costUsd += costUsd

      const taskType = row.taskType ?? 'unknown'
      byTaskType[taskType] = (byTaskType[taskType] ?? 0) + 1
    }

    return reply.send({
      success: true,
      data: {
        totalPromptTokens,
        totalOutputTokens,
        totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
        totalRequests,
        cachedRequests,
        avgLatencyMs: latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : null,
        byProvider,
        byModel,
        byTaskType,
      },
    })
  })

  // GET /ai-usage/history — time-series by day
  app.get('/ai-usage/history', async (req, reply) => {
    const { days } = HistoryQuery.parse(req.query)
    const workspaceId = ws(req)
    const since = Date.now() - days * 86_400_000

    const rows = await db.select().from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
      .orderBy(aiUsage.timestamp)

    const dayMap: Record<string, { date: string; requests: number; tokens: number; costUsd: number }> = {}

    for (const row of rows) {
      const date = new Date(row.timestamp).toISOString().slice(0, 10)
      dayMap[date] ??= { date, requests: 0, tokens: 0, costUsd: 0 }
      dayMap[date].requests++
      dayMap[date].tokens += (row.promptTokens ?? 0) + (row.outputTokens ?? 0)
      dayMap[date].costUsd += row.costUsd ?? 0
    }

    const series = Object.values(dayMap).map((d) => ({
      ...d,
      costUsd: Math.round(d.costUsd * 1_000_000) / 1_000_000,
    }))

    return reply.send({ success: true, data: series })
  })

  // GET /summary — operational health
  app.get('/summary', async (req, reply) => {
    const workspaceId = ws(req)
    const now = Date.now()
    const last24h = now - 86_400_000
    const last1h = now - 3_600_000

    const [runRows, eventRows] = await Promise.all([
      db.select().from(workflowRuns)
        .where(and(eq(workflowRuns.workspaceId, workspaceId), gte(workflowRuns.triggeredAt, last24h))),
      db.select().from(events)
        .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, last1h)))
        .orderBy(desc(events.createdAt))
        .limit(5_000),
    ])

    const workflowRunCounts: Record<string, number> = {}
    for (const run of runRows) {
      const status = run.status ?? 'unknown'
      workflowRunCounts[status] = (workflowRunCounts[status] ?? 0) + 1
    }

    const typeCounts: Record<string, number> = {}
    for (const evt of eventRows) {
      const type = evt.type ?? 'unknown'
      typeCounts[type] = (typeCounts[type] ?? 0) + 1
    }

    const recentEvents = Object.entries(typeCounts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    return reply.send({
      success: true,
      data: {
        workflowRuns: workflowRunCounts,
        recentEvents,
      },
    })
  })
}
