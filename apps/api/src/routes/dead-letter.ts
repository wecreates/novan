/**
 * Dead Letter Queue monitor routes.
 *
 * GET  /                 — list DLQ jobs for workspace (filter: queue?, limit)
 * POST /:id/retry        — mark retrying, re-enqueue job
 * POST /:id/discard      — mark discarded
 * GET  /stats            — count by queue and status
 */

import type { FastifyPluginAsync } from 'fastify'
import { z }                       from 'zod'
import { eq, and, desc, sql }      from 'drizzle-orm'
import { Queue }                   from 'bullmq'
import { v7 as uuidv7 }            from 'uuid'
import { db }                      from '../db/client.js'
import { deadLetterJobs, events }  from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

// ─── Event helper ─────────────────────────────────────────────────────────────

async function emit(type: string, workspaceId: string, payload: unknown): Promise<void> {
  await db.insert(events).values({
    id:            uuidv7(),
    type,
    workspaceId,
    payload:       payload as Record<string, unknown>,
    traceId:       uuidv7(),
    correlationId: uuidv7(),
    causationId:   null,
    source:        'api/dead-letter',
    version:       1,
    createdAt:     Date.now(),
  }).catch(() => null)
}

// ─── Query schemas ────────────────────────────────────────────────────────────

const ListQuery = z.object({
  queue: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(30),
})

// ─── BullMQ queue accessor (lazy, keyed by queue name) ───────────────────────

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
const queueCache = new Map<string, Queue>()

function getQueue(name: string): Queue {
  let q = queueCache.get(name)
  if (!q) {
    q = new Queue(name, {
      connection: { url: REDIS_URL },
    })
    queueCache.set(name, q)
  }
  return q
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const deadLetterRoutes: FastifyPluginAsync = async (app) => {

  // GET / — list dead letter jobs
  app.get('/', async (req) => {
    const { queue, limit } = ListQuery.parse(req.query)
    const workspaceId = ws(req)

    const conditions = [eq(deadLetterJobs.workspaceId, workspaceId)]
    if (queue) conditions.push(eq(deadLetterJobs.queueName, queue))

    const rows = await db
      .select()
      .from(deadLetterJobs)
      .where(and(...conditions))
      .orderBy(desc(deadLetterJobs.deadLetteredAt))
      .limit(limit)

    return { success: true, data: rows }
  })

  // GET /stats — counts by queue and status
  app.get('/stats', async (req) => {
    const workspaceId = ws(req)

    // DLQ jobs don't have an explicit status column; we derive status from
    // replayedAt / replayRunId presence. We count by queue with those buckets.
    const rows = await db
      .select({
        queueName:  deadLetterJobs.queueName,
        total:      sql<number>`count(*)::int`,
        replayed:   sql<number>`count(*) filter (where ${deadLetterJobs.replayedAt} is not null)::int`,
        pending:    sql<number>`count(*) filter (where ${deadLetterJobs.replayedAt} is null)::int`,
      })
      .from(deadLetterJobs)
      .where(eq(deadLetterJobs.workspaceId, workspaceId))
      .groupBy(deadLetterJobs.queueName)

    return { success: true, data: rows }
  })

  // POST /:id/retry — re-enqueue the original job
  app.post('/:id/retry', async (req, reply) => {
    const workspaceId = ws(req)
    const { id } = req.params as { id: string }

    const [job] = await db
      .select()
      .from(deadLetterJobs)
      .where(and(eq(deadLetterJobs.id, id), eq(deadLetterJobs.workspaceId, workspaceId)))
      .limit(1)

    if (!job) {
      return reply.code(404).send({ success: false, error: 'Dead letter job not found' })
    }

    const replayRunId = uuidv7()
    const now         = Date.now()

    // Mark as replayed in DB
    await db
      .update(deadLetterJobs)
      .set({ replayedAt: now, replayedBy: 'api', replayRunId })
      .where(eq(deadLetterJobs.id, id))

    // Re-enqueue into original queue
    const queue = getQueue(job.queueName)
    await queue.add(job.jobName, {
      ...job.payload,
      _dlqRetry:    true,
      _dlqJobId:    job.id,
      _replayRunId: replayRunId,
    }, {
      jobId:    `dlq-retry-${replayRunId}`,
      attempts: 3,
      backoff:  { type: 'exponential', delay: 2_000 },
    })

    await emit('dlq.job.retried', workspaceId, {
      dlqJobId:    id,
      queueName:   job.queueName,
      jobName:     job.jobName,
      replayRunId,
    })

    return { success: true, data: { id, replayRunId, retriedAt: now } }
  })

  // POST /:id/discard — mark as discarded
  app.post('/:id/discard', async (req, reply) => {
    const workspaceId = ws(req)
    const { id } = req.params as { id: string }

    const [job] = await db
      .select({ id: deadLetterJobs.id, queueName: deadLetterJobs.queueName, jobName: deadLetterJobs.jobName, replayedAt: deadLetterJobs.replayedAt })
      .from(deadLetterJobs)
      .where(and(eq(deadLetterJobs.id, id), eq(deadLetterJobs.workspaceId, workspaceId)))
      .limit(1)

    if (!job) {
      return reply.code(404).send({ success: false, error: 'Dead letter job not found' })
    }

    const discardedAt = Date.now()

    // We reuse replayedAt=null guard — already replayed jobs can still be discarded
    // (record the discard via replayedBy field repurposed as disposition marker)
    await db
      .update(deadLetterJobs)
      .set({ replayedBy: 'discarded', replayedAt: job.replayedAt ?? discardedAt })
      .where(eq(deadLetterJobs.id, id))

    await emit('dlq.job.discarded', workspaceId, {
      dlqJobId:    id,
      queueName:   job.queueName,
      jobName:     job.jobName,
      discardedAt,
    })

    return { success: true, data: { id, discardedAt } }
  })
}
