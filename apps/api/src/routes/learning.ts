/**
 * Learning routes — signal ingestion, patterns, insights, feedback, scores.
 *
 * GET    /api/v1/learning/signals          — list signals (paginated)
 * POST   /api/v1/learning/signals          — create manual signal
 * GET    /api/v1/learning/patterns         — list patterns (paginated, filtered)
 * GET    /api/v1/learning/patterns/:id     — get single pattern
 * PATCH  /api/v1/learning/patterns/:id     — update status (resolve/ignore)
 * GET    /api/v1/learning/insights         — list insights (paginated)
 * GET    /api/v1/learning/insights/:id     — get single insight
 * POST   /api/v1/learning/insights/:id/approve  — approve insight
 * POST   /api/v1/learning/insights/:id/reject   — reject insight
 * GET    /api/v1/learning/feedback         — list feedback (paginated)
 * POST   /api/v1/learning/feedback         — record feedback
 * GET    /api/v1/learning/scores           — list quality scores (filtered)
 * GET    /api/v1/learning/health           — learning system health summary
 * POST   /api/v1/learning/trigger/:job     — manually trigger a learning job
 */
import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 }            from 'uuid'
import { db }                      from '../db/client.js'
import { queues }                  from '../queues/index.js'
import { safeInt }                 from '../util/safe-int.js'
import {
  learningSignals,
  learningPatterns,
  learningInsights,
  learningFeedback,
  learningScores,
  events,
} from '../db/schema.js'
import { eq, and, desc, sql, gte } from 'drizzle-orm'
import { EVENT_SCHEMA_VERSION }    from '@ops/event-contracts'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emitEvent(type: string, workspaceId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(events).values({
      id:            uuidv7(),
      type,
      workspaceId,
      payload,
      traceId:       uuidv7(),
      correlationId: uuidv7(),
      causationId:   null,
      source:        'api',
      version:       EVENT_SCHEMA_VERSION,
      createdAt:     Date.now(),
    })
  } catch { /* non-blocking */ }
}

// ─── Route plugin ─────────────────────────────────────────────────────────────

const learningRoutes: FastifyPluginAsync = async (app) => {

  // GET /signals
  app.get('/signals', async (req, reply) => {
    const query = req.query as Record<string, string>
    const workspaceId = query['workspace_id'] ?? 'default'
    const limit  = safeInt(query['limit'], 50, { min: 1, max: 200 })
    const offset = safeInt(query['offset'], 0, { min: 0 })
    const source = query['source']
    const status = query['status']

    const where = and(
      eq(learningSignals.workspaceId, workspaceId),
      ...(source ? [eq(learningSignals.source, source)] : []),
      ...(status ? [eq(learningSignals.status, status)] : []),
    )

    const [rows, countResult] = await Promise.all([
      db.select().from(learningSignals).where(where).orderBy(desc(learningSignals.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(learningSignals).where(where),
    ])

    return reply.send({ success: true, data: rows, meta: { count: countResult[0]?.count ?? 0, limit, offset, hasMore: (countResult[0]?.count ?? 0) > offset + limit } })
  })

  // POST /signals — manual signal creation
  app.post('/signals', async (req, reply) => {
    const body = req.body as Record<string, unknown>
    const workspaceId = (body['workspace_id'] as string) ?? 'default'
    const now  = Date.now()

    const signal = {
      id:           uuidv7(),
      workspaceId,
      source:       (body['source'] as string) ?? 'manual',
      signal:       body['signal'] as string,
      evidence:     (body['evidence'] as Record<string, unknown>) ?? {},
      confidence:   (body['confidence'] as number) ?? 1.0,
      status:       'new' as const,
      reviewRequired: (body['review_required'] as boolean) ?? true,
      createdAt:    now,
      updatedAt:    now,
    }

    if (!signal.signal) return reply.status(400).send({ success: false, error: 'signal field is required', code: 'MISSING_FIELD', requestId: req.id })

    const [created] = await db.insert(learningSignals).values(signal).returning()
    await emitEvent('learning.signal.created', workspaceId, { signalId: created!.id, source: signal.source })

    return reply.status(201).send({ success: true, data: created })
  })

  // GET /patterns
  app.get('/patterns', async (req, reply) => {
    const query = req.query as Record<string, string>
    const workspaceId   = query['workspace_id'] ?? 'default'
    const limit         = safeInt(query['limit'], 50, { min: 1, max: 200 })
    const offset        = safeInt(query['offset'], 0, { min: 0 })
    const patternType   = query['pattern_type']
    const status        = query['status']

    const where = and(
      eq(learningPatterns.workspaceId, workspaceId),
      ...(patternType ? [eq(learningPatterns.patternType, patternType)] : []),
      ...(status      ? [eq(learningPatterns.status, status)]           : []),
    )

    const [rows, countResult] = await Promise.all([
      db.select().from(learningPatterns).where(where).orderBy(desc(learningPatterns.confidence), desc(learningPatterns.lastSeenAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(learningPatterns).where(where),
    ])

    return reply.send({ success: true, data: rows, meta: { count: countResult[0]?.count ?? 0, limit, offset, hasMore: (countResult[0]?.count ?? 0) > offset + limit } })
  })

  // GET /patterns/:id
  app.get('/patterns/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [row] = await db.select().from(learningPatterns).where(eq(learningPatterns.id, id))
    if (!row) return reply.status(404).send({ success: false, error: 'Pattern not found', code: 'NOT_FOUND', requestId: req.id })
    return reply.send({ success: true, data: row })
  })

  // PATCH /patterns/:id
  app.patch('/patterns/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body   = req.body as { status?: string }
    const status = body.status
    const [updated] = await db.update(learningPatterns)
      .set({ updatedAt: Date.now(), ...(status !== undefined ? { status } : {}) })
      .where(eq(learningPatterns.id, id))
      .returning()
    if (!updated) return reply.status(404).send({ success: false, error: 'Pattern not found', code: 'NOT_FOUND', requestId: req.id })
    return reply.send({ success: true, data: updated })
  })

  // GET /insights
  app.get('/insights', async (req, reply) => {
    const query       = req.query as Record<string, string>
    const workspaceId = query['workspace_id'] ?? 'default'
    const limit       = safeInt(query['limit'], 50, { min: 1, max: 200 })
    const offset      = safeInt(query['offset'], 0, { min: 0 })
    const status      = query['status']
    const category    = query['category']

    const where = and(
      eq(learningInsights.workspaceId, workspaceId),
      ...(status   ? [eq(learningInsights.status, status)]     : []),
      ...(category ? [eq(learningInsights.category, category)] : []),
    )

    const [rows, countResult] = await Promise.all([
      db.select({
        id: learningInsights.id, workspaceId: learningInsights.workspaceId,
        title: learningInsights.title, body: learningInsights.body,
        category: learningInsights.category, confidence: learningInsights.confidence,
        evidence: learningInsights.evidence, actionRequired: learningInsights.actionRequired,
        approved: learningInsights.approved, status: learningInsights.status,
        patternId: learningInsights.patternId,
        createdAt: learningInsights.createdAt, updatedAt: learningInsights.updatedAt,
      }).from(learningInsights).where(where).orderBy(desc(learningInsights.confidence), desc(learningInsights.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(learningInsights).where(where),
    ])

    return reply.send({ success: true, data: rows, meta: { count: countResult[0]?.count ?? 0, limit, offset, hasMore: (countResult[0]?.count ?? 0) > offset + limit } })
  })

  // GET /insights/:id
  app.get('/insights/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [row] = await db.select({
      id: learningInsights.id, workspaceId: learningInsights.workspaceId,
      title: learningInsights.title, body: learningInsights.body,
      category: learningInsights.category, confidence: learningInsights.confidence,
      evidence: learningInsights.evidence, actionRequired: learningInsights.actionRequired,
      approved: learningInsights.approved, approvedBy: learningInsights.approvedBy,
      approvedAt: learningInsights.approvedAt, status: learningInsights.status,
      patternId: learningInsights.patternId,
      createdAt: learningInsights.createdAt, updatedAt: learningInsights.updatedAt,
    }).from(learningInsights).where(eq(learningInsights.id, id))
    if (!row) return reply.status(404).send({ success: false, error: 'Insight not found', code: 'NOT_FOUND', requestId: req.id })
    return reply.send({ success: true, data: row })
  })

  // POST /insights/:id/approve
  app.post('/insights/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body   = req.body as { approved_by?: string } | undefined
    const now    = Date.now()
    const [updated] = await db.update(learningInsights)
      .set({ approved: true, approvedBy: body?.approved_by ?? 'user', approvedAt: now, status: 'approved', updatedAt: now })
      .where(eq(learningInsights.id, id))
      .returning()
    if (!updated) return reply.status(404).send({ success: false, error: 'Insight not found', code: 'NOT_FOUND', requestId: req.id })
    await emitEvent('learning.insight.approved', updated.workspaceId, { insightId: id })
    return reply.send({ success: true, data: updated })
  })

  // POST /insights/:id/reject
  app.post('/insights/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body   = req.body as { reason?: string; rejected_by?: string } | undefined
    const now    = Date.now()
    const [updated] = await db.update(learningInsights)
      .set({ approved: false, approvedBy: body?.rejected_by ?? 'user', approvedAt: now, status: 'rejected', updatedAt: now })
      .where(eq(learningInsights.id, id))
      .returning()
    if (!updated) return reply.status(404).send({ success: false, error: 'Insight not found', code: 'NOT_FOUND', requestId: req.id })
    await emitEvent('learning.insight.rejected', updated.workspaceId, { insightId: id, reason: body?.reason })
    return reply.send({ success: true, data: updated })
  })

  // GET /feedback
  app.get('/feedback', async (req, reply) => {
    const query       = req.query as Record<string, string>
    const workspaceId = query['workspace_id'] ?? 'default'
    const limit       = safeInt(query['limit'], 50, { min: 1, max: 200 })
    const offset      = safeInt(query['offset'], 0, { min: 0 })

    const where = eq(learningFeedback.workspaceId, workspaceId)
    const [rows, countResult] = await Promise.all([
      db.select().from(learningFeedback).where(where).orderBy(desc(learningFeedback.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(learningFeedback).where(where),
    ])

    return reply.send({ success: true, data: rows, meta: { count: countResult[0]?.count ?? 0, limit, offset, hasMore: (countResult[0]?.count ?? 0) > offset + limit } })
  })

  // POST /feedback
  app.post('/feedback', async (req, reply) => {
    const body        = req.body as Record<string, unknown>
    const workspaceId = (body['workspace_id'] as string) ?? 'default'
    const now = Date.now()

    const record = {
      id:               uuidv7(),
      workspaceId,
      recommendationId: body['recommendation_id'] as string,
      insightId:        (body['insight_id'] as string | null | undefined) ?? null,
      action:           body['action'] as string,
      outcome:          (body['outcome'] as string | null | undefined) ?? null,
      outcomeNotes:     (body['outcome_notes'] as string | null | undefined) ?? null,
      userId:           (body['user_id'] as string | null | undefined) ?? null,
      deltaMetric:      (body['delta_metric'] as number | null | undefined) ?? null,
      metricName:       (body['metric_name'] as string | null | undefined) ?? null,
      createdAt:        now,
      updatedAt:        now,
    }

    if (!record.recommendationId || !record.action) {
      return reply.status(400).send({ success: false, error: 'recommendation_id and action are required', code: 'MISSING_FIELD', requestId: req.id })
    }

    const [created] = await db.insert(learningFeedback).values(record).returning()
    await emitEvent('learning.feedback.recorded', workspaceId, { feedbackId: created!.id, action: record.action })

    return reply.status(201).send({ success: true, data: created })
  })

  // GET /scores
  app.get('/scores', async (req, reply) => {
    const query       = req.query as Record<string, string>
    const workspaceId = query['workspace_id'] ?? 'default'
    const entityType  = query['entity_type']
    const scoreType   = query['score_type']
    const limit       = safeInt(query['limit'], 100, { min: 1, max: 500 })

    const where = and(
      eq(learningScores.workspaceId, workspaceId),
      ...(entityType ? [eq(learningScores.entityType, entityType)] : []),
      ...(scoreType  ? [eq(learningScores.scoreType, scoreType)]   : []),
    )

    const rows = await db.select({
      id: learningScores.id, entityType: learningScores.entityType,
      entityId: learningScores.entityId, scoreType: learningScores.scoreType,
      scoreValue: learningScores.scoreValue, sampleCount: learningScores.sampleCount,
      updatedAt: learningScores.updatedAt,
    }).from(learningScores).where(where).orderBy(desc(learningScores.scoreValue)).limit(limit)

    return reply.send({ success: true, data: rows })
  })

  // GET /health — learning system health summary
  app.get('/health', async (req, reply) => {
    const workspaceId = (req.query as Record<string, string>)['workspace_id'] ?? 'default'
    const since       = Date.now() - 24 * 3600_000

    const [signalCount, patternCount, insightCount, pendingReviewCount, feedbackCount] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(learningSignals).where(and(eq(learningSignals.workspaceId, workspaceId), gte(learningSignals.createdAt, since))).then((r) => r[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(learningPatterns).where(and(eq(learningPatterns.workspaceId, workspaceId), eq(learningPatterns.status, 'active'))).then((r) => r[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(learningInsights).where(eq(learningInsights.workspaceId, workspaceId)).then((r) => r[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(learningInsights).where(and(eq(learningInsights.workspaceId, workspaceId), eq(learningInsights.status, 'pending_review'))).then((r) => r[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(learningFeedback).where(eq(learningFeedback.workspaceId, workspaceId)).then((r) => r[0]?.count ?? 0),
    ])

    return reply.send({
      success: true,
      data: {
        signalsLast24h:    signalCount,
        activePatterns:    patternCount,
        totalInsights:     insightCount,
        pendingReview:     pendingReviewCount,
        totalFeedback:     feedbackCount,
        status:            'active',
        checkedAt:         Date.now(),
      },
    })
  })

  // POST /trigger/:job — manually trigger a learning job
  app.post('/trigger/:job', async (req, reply) => {
    const { job } = req.params as { job: string }
    const body    = req.body as Record<string, unknown> | undefined
    const validJobs = [
      'ingest_learning_signals', 'detect_patterns', 'score_memories',
      'generate_insights', 'rank_recommendations', 'compress_memory',
      'decay_stale_memory', 'merge_duplicates', 'update_quality_scores',
    ]
    if (!validJobs.includes(job)) {
      return reply.status(400).send({ success: false, error: `Unknown job: ${job}`, code: 'INVALID_JOB', requestId: req.id })
    }

    const bullJob = await queues.learning.add(job, body ?? {}, { priority: 1 })
    return reply.status(202).send({ success: true, data: { jobId: bullJob.id, jobName: job } })
  })
}

export default learningRoutes
