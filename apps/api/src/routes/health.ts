import type { FastifyPluginAsync } from 'fastify'
import { db }          from '../db/client.js'
import { redisClient } from '../redis/client.js'
import { sql }         from 'drizzle-orm'

export const healthRoutes: FastifyPluginAsync = async (app) => {

  /** GET /health — liveness probe */
  app.get('/', { schema: { tags: ['health'], summary: 'Liveness probe' } }, async (_req, reply) => {
    return reply.send({ status: 'ok', timestamp: Date.now() })
  })

  /** GET /health/ready — readiness probe (checks all dependencies) */
  app.get('/ready', { schema: { tags: ['health'], summary: 'Readiness probe' } }, async (_req, reply) => {
    const checks = await Promise.allSettled([
      db.execute(sql`SELECT 1`),
      redisClient.ping(),
    ])

    const dbOk    = checks[0]?.status === 'fulfilled'
    const redisOk = checks[1]?.status === 'fulfilled'
    const allOk   = dbOk && redisOk

    const queueMetrics = await import('../queues/index.js').then((m) => m.getQueueMetrics()).catch((e: Error) => { console.error('[health]', e.message); return null })

    const body = {
      status:    allOk ? 'ready' : 'not_ready',
      timestamp: Date.now(),
      checks: {
        database: { status: dbOk ? 'healthy' : 'unhealthy',
                    latencyMs: 0 },
        redis:    { status: redisOk ? 'healthy' : 'unhealthy' },
      },
      queues: queueMetrics,
    }

    return reply.status(allOk ? 200 : 503).send(body)
  })

  /** GET /health/live — kubernetes liveness probe */
  app.get('/live', { schema: { tags: ['health'], summary: 'Kubernetes liveness probe' } }, async (_req, reply) => {
    return reply.send({ status: 'live' })
  })
}
