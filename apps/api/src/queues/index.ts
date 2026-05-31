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

// R146.75 — both passive drains REMOVED.
//
// History: R146.54 added in-API "passive drain" Workers for the
// `notifications` and `workflow` queues, under the belief their real
// consumers were never wired. BullMQ load-balances jobs across every
// Worker bound to a queue, so the drains were silently winning a share
// of real jobs and acknowledging them with `{ drained: true }`. For the
// workflow queue this meant ~1/N of every workflow execution (where N =
// 1 in-API drain + 1 real workers/workflow-worker process) was silently
// dropped. Webhook-triggered automations vanishing on a fraction of
// invocations is exactly the "I quietly broke a workflow nobody's run
// yet" failure the gates were supposed to prevent.
//
// Truth on the ground (verified R146.75 audit):
//   - workflow queue: workers/workflow-worker/src/worker.ts:103 binds a
//     real Worker on QUEUE_NAMES.WORKFLOW handling 'execute-workflow'
//     and 'resume-workflow' via executeWorkflowRun. The drain was
//     stealing from this worker.
//   - notifications queue: zero remaining callers of
//     queues.notifications.add() across the entire repo. The legacy-
//     caller justification no longer applies.
//
// Both drains are deleted. If a future caller resurrects either queue
// without wiring a real consumer, the operator will see waiting-count
// growth in /api/v1/observability/queue-metrics — visible by design
// instead of silently dropped.

export async function registerQueues(): Promise<void> {
  // Await queue initialization (validates Redis connection)
  for (const [name, queue] of Object.entries(queues)) {
    await queue.waitUntilReady()
    console.info(`Queue ready: ${name}`)
  }
}

/** Graceful shutdown for the Queues themselves. Worker shutdown is the
 *  responsibility of whichever module registers each Worker (e.g.
 *  workers/workflow-worker handles its own SIGTERM; autonomous-
 *  orchestrator's Worker is closed via server.ts shutdown chain). */
export async function stopQueues(): Promise<void> {
  await Promise.allSettled([
    ...Object.values(queues).map(q => q.close()),
    ...Object.values(queueEvents).filter((qe): qe is QueueEvents => !!qe).map(qe => qe.close()),
  ])
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
