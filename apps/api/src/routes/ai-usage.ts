/**
 * AI usage recording and summary routes.
 *
 * POST /         — record a single AI usage event from a worker/service
 * GET  /summary  — aggregate stats for the last 24 h
 */

import type { FastifyPluginAsync } from 'fastify'
import { z }                       from 'zod'
import { eq, and, gte }            from 'drizzle-orm'
import { v7 as uuidv7 }            from 'uuid'
import { db }                      from '../db/client.js'
import { aiUsage }                 from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

// ─── Schemas ──────────────────────────────────────────────────────────────────

const RecordBody = z.object({
  provider:     z.string().min(1),
  model:        z.string().min(1),
  promptTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd:      z.number().min(0),
  latencyMs:    z.number().int().min(0),
  cached:       z.boolean().optional().default(false),
  taskType:     z.string().min(1),
})

// ─── Routes ───────────────────────────────────────────────────────────────────

export const aiUsageRoutes: FastifyPluginAsync = async (app) => {

  // POST / — record one usage event
  app.post('/', async (req, reply) => {
    const body        = RecordBody.parse(req.body)
    const workspaceId = ws(req)
    const id          = uuidv7()

    await db.insert(aiUsage).values({
      id,
      workspaceId,
      provider:     body.provider,
      model:        body.model,
      promptTokens: body.promptTokens,
      outputTokens: body.outputTokens,
      costUsd:      body.costUsd,
      latencyMs:    body.latencyMs,
      cached:       body.cached,
      taskType:     body.taskType,
      timestamp:    Date.now(),
    })

    return reply.code(201).send({ success: true, data: { id } })
  })

  // GET /summary — aggregate last 24 h
  app.get('/summary', async (req) => {
    const workspaceId = ws(req)
    const since       = Date.now() - 86_400_000

    const rows = await db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))

    let totalRequests    = 0
    let cachedRequests   = 0
    let totalPromptTokens  = 0
    let totalOutputTokens  = 0
    let totalCostUsd     = 0
    let totalLatencyMs   = 0
    let latencyCount     = 0

    const byProvider: Record<string, { requests: number; promptTokens: number; outputTokens: number; costUsd: number }> = {}
    const byModel:    Record<string, { requests: number; costUsd: number }> = {}
    const byTaskType: Record<string, number> = {}

    for (const row of rows) {
      totalRequests++
      totalPromptTokens  += row.promptTokens
      totalOutputTokens  += row.outputTokens
      totalCostUsd       += row.costUsd
      if (row.cached) cachedRequests++
      if (row.latencyMs !== null) { totalLatencyMs += row.latencyMs; latencyCount++ }

      const p = byProvider[row.provider] ?? (byProvider[row.provider] = { requests: 0, promptTokens: 0, outputTokens: 0, costUsd: 0 })
      p.requests++; p.promptTokens += row.promptTokens; p.outputTokens += row.outputTokens; p.costUsd += row.costUsd

      const m = byModel[row.model] ?? (byModel[row.model] = { requests: 0, costUsd: 0 })
      m.requests++; m.costUsd += row.costUsd

      byTaskType[row.taskType] = (byTaskType[row.taskType] ?? 0) + 1
    }

    return {
      success: true,
      data: {
        windowMs:          86_400_000,
        totalRequests,
        cachedRequests,
        cacheHitRate:      totalRequests > 0 ? cachedRequests / totalRequests : 0,
        totalPromptTokens,
        totalOutputTokens,
        totalTokens:       totalPromptTokens + totalOutputTokens,
        totalCostUsd:      Math.round(totalCostUsd * 1_000_000) / 1_000_000,
        avgLatencyMs:      latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : null,
        byProvider,
        byModel,
        byTaskType,
      },
    }
  })
}
