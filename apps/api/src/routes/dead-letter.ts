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
import { eq, and, desc, sql, isNull } from 'drizzle-orm'
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
  }).catch((e: Error) => { console.error('[dead-letter]', e.message); return null })
}

// ─── Query schemas ────────────────────────────────────────────────────────────

const ListQuery = z.object({
  queue: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(30),
})

// ─── BullMQ queue accessor (lazy, keyed by queue name) ───────────────────────

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
const queueCache = new Map<string, Queue>()

/** Canonical queue names — must match queues/index.ts AND have an active
 *  worker. 'notifications' was removed per R75 (no producers). 'briefing'
 *  was removed per R146.279 (producer was zombie-job-leaking; no worker
 *  generator exists). Retrying into either queue would re-create the
 *  silent-drop hazard that R75/R279 fixed. */
const KNOWN_QUEUES = new Set([
  'workflow', 'browser', 'memory', 'analytics', 'recovery',
  'optimization', 'learning', 'autonomous',
])
const RETIRED_QUEUES = new Set(['notifications', 'briefing'])

/** Legacy queueName aliases that ended up in the dead_letter_jobs table
 *  from old code. Map to current names so DLQ retry doesn't create a
 *  phantom queue with no consumer (jobs sit forever). */
const QUEUE_ALIASES: Record<string, string> = {
  'workflow-runs': 'workflow',
}

function normalizeQueueName(name: string): string {
  return QUEUE_ALIASES[name] ?? name
}

function getQueue(name: string): Queue {
  const canonical = normalizeQueueName(name)
  if (RETIRED_QUEUES.has(canonical)) {
    throw new Error(`retired queue "${canonical}" — no consumer exists; discard instead of retrying`)
  }
  if (!KNOWN_QUEUES.has(canonical)) {
    throw new Error(`unknown queue "${name}" — refusing to create phantom queue with no consumer`)
  }
  let q = queueCache.get(canonical)
  if (!q) {
    q = new Queue(canonical, {
      connection: { url: REDIS_URL },
    })
    queueCache.set(canonical, q)
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

    // R146.40 — single-replay guard. Without this, an auth'd caller in
    // the same workspace can call /replay N times on a single DLQ job
    // and re-enqueue N copies (replayRunId differs each call, so BullMQ
    // jobId `dlq-retry-${replayRunId}` doesn't dedupe). That's a cost
    // amplification class — a single dead letter becomes worker capacity
    // exhaustion + N× LLM calls if the job hits a model.
    if (job.replayedAt) {
      return reply.code(409).send({
        success: false,
        error: 'job already replayed',
        detail: `replayed at ${new Date(job.replayedAt).toISOString()} (runId ${job.replayRunId ?? 'unknown'})`,
      })
    }

    const replayRunId = uuidv7()
    const now         = Date.now()

    // Mark as replayed in DB — atomic guard against a race with another
    // concurrent /replay request on the same job: the UPDATE must match
    // a row where replayedAt is still NULL, otherwise the parallel call
    // already won. The follow-up enqueue only happens if our update wins.
    const upd = await db
      .update(deadLetterJobs)
      .set({ replayedAt: now, replayedBy: 'api', replayRunId })
      .where(and(eq(deadLetterJobs.id, id), isNull(deadLetterJobs.replayedAt)))
      .returning({ id: deadLetterJobs.id })
    if (upd.length === 0) {
      return reply.code(409).send({ success: false, error: 'job already replayed (race)' })
    }

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
