// TODO: Register in server.ts:
// import { exportRoutes } from './routes/export.js'
// await app.register(exportRoutes, { prefix: '/api/v1/export' })

/**
 * Data export routes — CSV/JSON export of platform data.
 *
 * GET /api/v1/export/events        — export events as CSV or JSON
 * GET /api/v1/export/risks         — export risks
 * GET /api/v1/export/goals         — export strategic goals
 * GET /api/v1/export/insights      — export insights
 * GET /api/v1/export/opportunities — export opportunities
 * GET /api/v1/export/ai-usage      — export AI usage records
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq, and, gte } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  events,
  risks,
  strategicGoals,
  insights,
  opportunities,
  aiUsage,
} from '../db/schema.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ws = (req: unknown): string =>
  ((req as { workspaceId?: string }).workspaceId ?? 'default')

const ExportQuery = z.object({
  format: z.enum(['csv', 'json']).default('json'),
  since:  z.coerce.number().int().optional(),
  limit:  z.coerce.number().int().min(1).max(10_000).default(1_000),
})

function toCsv(rows: Record<string, unknown>[], fields: string[]): string {
  const header = fields.join(',')
  const lines = rows.map(r => fields.map(f => {
    const v = r[f]
    if (v === null || v === undefined) return ''
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }).join(','))
  return [header, ...lines].join('\n')
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export const exportRoutes: FastifyPluginAsync = async (app) => {

  // GET /events
  app.get('/events', async (req, reply) => {
    const { format, since, limit } = ExportQuery.parse(req.query)
    const workspaceId = ws(req)

    const conditions = [eq(events.workspaceId, workspaceId)]
    if (since !== undefined) conditions.push(gte(events.createdAt, since))

    const rows = await db.select().from(events)
      .where(and(...conditions))
      .limit(limit) as Record<string, unknown>[]

    const fields = ['id', 'type', 'workspaceId', 'source', 'version', 'traceId', 'correlationId', 'causationId', 'payload', 'createdAt']

    if (format === 'csv') {
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="events-export.csv"')
        .send(toCsv(rows, fields))
    }
    return reply.send({ success: true, data: rows, count: rows.length })
  })

  // GET /risks
  app.get('/risks', async (req, reply) => {
    const { format, since, limit } = ExportQuery.parse(req.query)
    const workspaceId = ws(req)

    const conditions = [eq(risks.workspaceId, workspaceId)]
    if (since !== undefined) conditions.push(gte(risks.createdAt, since))

    const rows = await db.select().from(risks)
      .where(and(...conditions))
      .limit(limit) as Record<string, unknown>[]

    const fields = ['id', 'workspaceId', 'businessId', 'title', 'description', 'severity', 'probability', 'impact', 'riskScore', 'category', 'status', 'mitigations', 'detectedAt', 'resolvedAt', 'createdAt', 'updatedAt']

    if (format === 'csv') {
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="risks-export.csv"')
        .send(toCsv(rows, fields))
    }
    return reply.send({ success: true, data: rows, count: rows.length })
  })

  // GET /goals
  app.get('/goals', async (req, reply) => {
    const { format, since, limit } = ExportQuery.parse(req.query)
    const workspaceId = ws(req)

    const conditions = [eq(strategicGoals.workspaceId, workspaceId)]
    if (since !== undefined) conditions.push(gte(strategicGoals.createdAt, since))

    const rows = await db.select().from(strategicGoals)
      .where(and(...conditions))
      .limit(limit) as Record<string, unknown>[]

    const fields = ['id', 'workspaceId', 'businessId', 'parentGoalId', 'title', 'description', 'status', 'horizon', 'targetDate', 'progress', 'keyResults', 'owners', 'tags', 'completedAt', 'createdAt', 'updatedAt']

    if (format === 'csv') {
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="goals-export.csv"')
        .send(toCsv(rows, fields))
    }
    return reply.send({ success: true, data: rows, count: rows.length })
  })

  // GET /insights
  app.get('/insights', async (req, reply) => {
    const { format, since, limit } = ExportQuery.parse(req.query)
    const workspaceId = ws(req)

    const conditions = [eq(insights.workspaceId, workspaceId)]
    if (since !== undefined) conditions.push(gte(insights.createdAt, since))

    const rows = await db.select({
      id:         insights.id,
      workspaceId: insights.workspaceId,
      title:      insights.title,
      body:       insights.body,
      category:   insights.category,
      confidence: insights.confidence,
      source:     insights.source,
      sourceRef:  insights.sourceRef,
      tags:       insights.tags,
      dismissed:  insights.dismissed,
      actedOn:    insights.actedOn,
      expiresAt:  insights.expiresAt,
      createdAt:  insights.createdAt,
    }).from(insights)
      .where(and(...conditions))
      .limit(limit) as Record<string, unknown>[]

    const fields = ['id', 'workspaceId', 'title', 'body', 'category', 'confidence', 'source', 'sourceRef', 'tags', 'dismissed', 'actedOn', 'expiresAt', 'createdAt']

    if (format === 'csv') {
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="insights-export.csv"')
        .send(toCsv(rows, fields))
    }
    return reply.send({ success: true, data: rows, count: rows.length })
  })

  // GET /opportunities
  app.get('/opportunities', async (req, reply) => {
    const { format, since, limit } = ExportQuery.parse(req.query)
    const workspaceId = ws(req)

    const conditions = [eq(opportunities.workspaceId, workspaceId)]
    if (since !== undefined) conditions.push(gte(opportunities.createdAt, since))

    const rows = await db.select().from(opportunities)
      .where(and(...conditions))
      .limit(limit) as Record<string, unknown>[]

    const fields = ['id', 'workspaceId', 'businessId', 'title', 'description', 'type', 'status', 'priority', 'valuePotential', 'confidence', 'category', 'evidence', 'tags', 'estimatedROI', 'estimatedEffort', 'riskLevel', 'strategicAlignment', 'score', 'scoreBreakdown', 'linkedMemoryIds', 'linkedWorkflowIds', 'convertedRunId', 'convertedWorkflowId', 'convertedAt', 'acceptedAt', 'rejectedAt', 'dueDate', 'closedAt', 'createdAt', 'updatedAt']

    if (format === 'csv') {
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="opportunities-export.csv"')
        .send(toCsv(rows, fields))
    }
    return reply.send({ success: true, data: rows, count: rows.length })
  })

  // GET /ai-usage
  app.get('/ai-usage', async (req, reply) => {
    const { format, since, limit } = ExportQuery.parse(req.query)
    const workspaceId = ws(req)

    const conditions = [eq(aiUsage.workspaceId, workspaceId)]
    if (since !== undefined) conditions.push(gte(aiUsage.timestamp, since))

    const rows = await db.select().from(aiUsage)
      .where(and(...conditions))
      .limit(limit) as Record<string, unknown>[]

    const fields = ['id', 'workspaceId', 'provider', 'model', 'promptTokens', 'outputTokens', 'costUsd', 'latencyMs', 'cached', 'taskType', 'timestamp']

    if (format === 'csv') {
      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="ai-usage-export.csv"')
        .send(toCsv(rows, fields))
    }
    return reply.send({ success: true, data: rows, count: rows.length })
  })
}
