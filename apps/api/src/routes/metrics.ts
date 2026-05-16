/**
 * Metrics route — Prometheus-compatible /metrics endpoint.
 * Exposes queue depths, runtime stats, and API health.
 */
import type { FastifyPluginAsync } from 'fastify'
import { getQueueMetrics }         from '../queues/index.js'

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (_req, reply) => {
    const queueMetrics = await getQueueMetrics()

    const lines: string[] = [
      '# HELP ops_queue_waiting Number of waiting jobs per queue',
      '# TYPE ops_queue_waiting gauge',
      ...Object.entries(queueMetrics).map(([name, m]) =>
        `ops_queue_waiting{queue="${name}"} ${m.waiting}`),
      '',
      '# HELP ops_queue_active Number of active jobs per queue',
      '# TYPE ops_queue_active gauge',
      ...Object.entries(queueMetrics).map(([name, m]) =>
        `ops_queue_active{queue="${name}"} ${m.active}`),
      '',
      '# HELP ops_queue_failed Number of failed jobs per queue',
      '# TYPE ops_queue_failed gauge',
      ...Object.entries(queueMetrics).map(([name, m]) =>
        `ops_queue_failed{queue="${name}"} ${m.failed}`),
      '',
    ]

    reply.header('Content-Type', 'text/plain; version=0.0.4')
    return reply.send(lines.join('\n'))
  })
}
