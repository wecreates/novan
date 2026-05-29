/**
 * Metrics route — Prometheus-compatible /metrics endpoint.
 * Exposes queue depths, runtime stats, API health, AND the R119
 * counter/gauge registry (cron ticks, media analyses, etc.).
 */
import type { FastifyPluginAsync } from 'fastify'
import { getQueueMetrics }         from '../queues/index.js'

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (_req, reply) => {
    const queueMetrics = await getQueueMetrics()

    const queueLines: string[] = [
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

    // R119 counter/gauge registry (cron tick metrics, media analyses,
    // recovery executor, etc.). Loaded lazily so this route works even
    // if the metrics module fails to load for any reason.
    let registryLines = ''
    try {
      const { renderMetrics } = await import('../services/metrics.js')
      registryLines = renderMetrics()
    } catch { /* tolerated — registry metrics are best-effort */ }

    reply.header('Content-Type', 'text/plain; version=0.0.4')
    return reply.send(queueLines.join('\n') + (registryLines ? '\n' + registryLines : ''))
  })
}
