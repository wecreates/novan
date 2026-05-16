/**
 * Worker health routes.
 *
 * GET /api/v1/workers/health   — queue depths + worker counts
 * GET /api/v1/workers/queues  — detailed per-queue stats
 */
import type { FastifyPluginAsync } from 'fastify'
import { Queue } from 'bullmq'
import { redisClient } from '../redis/client.js'

const QUEUE_NAMES = ['workflow', 'recovery', 'memory', 'browser', 'analytics', 'briefing', 'optimization'] as const

// Lazy queue cache
const queueCache = new Map<string, Queue>()
function getQueue(name: string): Queue {
  if (!queueCache.has(name)) {
    queueCache.set(name, new Queue(name, { connection: redisClient }))
  }
  return queueCache.get(name)!
}

export const workersRoutes: FastifyPluginAsync = async (app) => {
  // GET /health — summary
  app.get('/health', async (_req, reply) => {
    const stats = await Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const q = getQueue(name)
        const [waiting, active, completed, failed, delayed] = await Promise.all([
          q.getWaitingCount(),
          q.getActiveCount(),
          q.getCompletedCount(),
          q.getFailedCount(),
          q.getDelayedCount(),
        ])
        return { name, waiting, active, completed, failed, delayed }
      })
    )

    const totals = stats.reduce(
      (acc, s) => ({
        waiting:   acc.waiting   + s.waiting,
        active:    acc.active    + s.active,
        completed: acc.completed + s.completed,
        failed:    acc.failed    + s.failed,
      }),
      { waiting: 0, active: 0, completed: 0, failed: 0 }
    )

    return reply.send({ success: true, data: { queues: stats, totals } })
  })

  // GET /queues — detailed with job listings (last 10 failed)
  app.get('/queues', async (_req, reply) => {
    const details = await Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const q = getQueue(name)
        const [waiting, active, failed] = await Promise.all([
          q.getWaitingCount(),
          q.getActiveCount(),
          q.getJobs(['failed'], 0, 9),
        ])
        return {
          name,
          waiting,
          active,
          recentFailures: failed.map(j => ({
            id:           j.id,
            name:         j.name,
            failedReason: j.failedReason,
            attemptsMade: j.attemptsMade,
            timestamp:    j.timestamp,
          })),
        }
      })
    )
    return reply.send({ success: true, data: details })
  })
}
