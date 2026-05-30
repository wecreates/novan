/**
 * BullMQ queue registry — one queue per worker type.
 *
 * Queue configuration:
 *   - defaultJobOptions: retry + backoff for all queues
 *   - workflow: critical path, priority 1-5
 *   - browser: bounded concurrency (Playwright sessions)
 *   - memory: batch processing, lower priority
 *   - analytics: fire-and-forget, lowest priority
 *   - recovery: dedicated, highest priority after workflow
 *   - optimization: background, lowest priority
 */
import { Queue, Worker }      from 'bullmq'
import type { QueueEvents }  from 'bullmq'
import { redisClient }        from '../redis/client.js'
import type { QueueName }     from '@ops/shared-types'

const QUEUE_DEFAULTS = {
  defaultJobOptions: {
    attempts:    3,
    backoff:     { type: 'exponential' as const, delay: 2_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail:     { count: 5_000 },
  },
} as const

// ─── Queue instances ──────────────────────────────────────────────────────────

export const queues: Record<QueueName, Queue> = {
  workflow:      new Queue('workflow',      { connection: redisClient, ...QUEUE_DEFAULTS }),
  browser:       new Queue('browser',       { connection: redisClient, ...QUEUE_DEFAULTS }),
  memory:        new Queue('memory',        { connection: redisClient, ...QUEUE_DEFAULTS }),
  analytics:     new Queue('analytics',     { connection: redisClient, ...QUEUE_DEFAULTS }),
  recovery:      new Queue('recovery',      { connection: redisClient, ...QUEUE_DEFAULTS }),
  optimization:  new Queue('optimization',  { connection: redisClient, ...QUEUE_DEFAULTS }),
  notifications: new Queue('notifications', { connection: redisClient, ...QUEUE_DEFAULTS }),
  briefing:      new Queue('briefing',      { connection: redisClient, ...QUEUE_DEFAULTS }),
  learning:      new Queue('learning',      { connection: redisClient, ...QUEUE_DEFAULTS }),
  autonomous:    new Queue('autonomous',    { connection: redisClient, ...QUEUE_DEFAULTS }),
}

// ─── Queue events (observability) ────────────────────────────────────────────

export const queueEvents: Partial<Record<QueueName, QueueEvents>> = {}

// Passive drain workers for queues whose producer side is live but
// whose consumer was never registered. Without these, queues.X.add()
// silently grows the Redis waiting list forever.
//
// notifications: handled inline via services/notifications.ts; legacy
//   call sites still .add()
// workflow: R146.54 — five routes call queues.workflow.add('execute-workflow')
//   (approvals, briefings, opportunities, webhooks /trigger, workflows /run)
//   but no consumer was ever wired. Webhook /trigger is the highest-rate
//   producer; on a busy account that's hundreds of orphan jobs per hour.
let _notificationsDrain: Worker | null = null
let _workflowDrain:      Worker | null = null

export async function registerQueues(): Promise<void> {
  // Await queue initialization (validates Redis connection)
  for (const [name, queue] of Object.entries(queues)) {
    await queue.waitUntilReady()
    console.info(`Queue ready: ${name}`)
  }
  // Attach passive drain on notifications queue
  if (!_notificationsDrain) {
    _notificationsDrain = new Worker('notifications', async (job) => {
      console.warn(`[notifications-queue] unexpected job ${job.name} (id=${job.id}) — notifications are handled inline via services/notifications.ts, not via this queue. Draining without action.`)
      return { drained: true }
    }, { connection: redisClient, concurrency: 1 })
  }
  // R146.54 — workflow drain. Same pattern, same purpose.
  if (!_workflowDrain) {
    _workflowDrain = new Worker('workflow', async (job) => {
      console.warn(`[workflow-queue] unexpected job ${job.name} (id=${job.id}) — workflow execution is not implemented; ${job.data?.workflowId ?? 'unknown workflow'} dropped to prevent Redis backlog growth.`)
      return { drained: true }
    }, { connection: redisClient, concurrency: 4 })
  }
}

/** R146.54 — graceful shutdown for the passive drain Workers + Queues.
 *  Without this, the BullMQ Workers + Redis connections stay open after
 *  the API process tries to exit. Called from server.ts shutdown chain. */
export async function stopQueues(): Promise<void> {
  await Promise.allSettled([
    _notificationsDrain?.close(),
    _workflowDrain?.close(),
    ...Object.values(queues).map(q => q.close()),
    ...Object.values(queueEvents).filter((qe): qe is QueueEvents => !!qe).map(qe => qe.close()),
  ])
  _notificationsDrain = null
  _workflowDrain      = null
}

export async function getQueueMetrics(): Promise<Record<QueueName, {
  waiting: number; active: number; completed: number; failed: number; delayed: number
}>> {
  const metrics = {} as Record<string, unknown>
  for (const [name, queue] of Object.entries(queues)) {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ])
    metrics[name] = { waiting, active, completed, failed, delayed }
  }
  return metrics as ReturnType<typeof getQueueMetrics> extends Promise<infer T> ? T : never
}
