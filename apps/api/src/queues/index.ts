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
import { Queue }              from 'bullmq'
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

export async function registerQueues(): Promise<void> {
  // Await queue initialization (validates Redis connection)
  for (const [name, queue] of Object.entries(queues)) {
    await queue.waitUntilReady()
    console.info(`Queue ready: ${name}`)
  }
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
