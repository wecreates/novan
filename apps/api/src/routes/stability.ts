/**
 * Stability Routes
 *
 * Health score, alerts, and chaos simulation endpoints.
 *
 * Prefix: /api/v1/stability
 */

import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 }           from 'uuid'
import { db }                      from '../db/client.js'
import { events }                  from '../db/schema.js'
import { computeHealthScore }      from '../services/stability-monitor.js'

// ─── Plugin ───────────────────────────────────────────────────────────────────

const stabilityRoutes: FastifyPluginAsync = async (app) => {

  /** GET /health?workspaceId= — full health report */
  app.get<{ Querystring: { workspaceId: string } }>('/health', {
    schema: {
      tags: ['stability'],
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const report = await computeHealthScore(req.query.workspaceId)
    return { report }
  })

  /** GET /alerts?workspaceId= — alerts + overall score */
  app.get<{ Querystring: { workspaceId: string } }>('/alerts', {
    schema: {
      tags: ['stability'],
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const report = await computeHealthScore(req.query.workspaceId)
    return { alerts: report.alerts, overall: report.overall }
  })

  /** POST /chaos/simulate — emit a chaos event (dev/test only) */
  app.post<{
    Body: {
      workspaceId: string
      scenario:    'budget_exhaustion' | 'provider_outage' | 'worker_death' | 'queue_flood'
    }
  }>('/chaos/simulate', {
    schema: {
      tags: ['stability'],
      body: {
        type: 'object',
        required: ['workspaceId', 'scenario'],
        properties: {
          workspaceId: { type: 'string' },
          scenario: {
            type: 'string',
            enum: ['budget_exhaustion', 'provider_outage', 'worker_death', 'queue_flood'],
          },
        },
      },
    },
  }, async (req) => {
    const { workspaceId, scenario } = req.body

    await db.insert(events).values({
      id:            uuidv7(),
      type:          'chaos.simulation.started',
      workspaceId,
      payload:       { scenario },
      traceId:       uuidv7(),
      correlationId: uuidv7(),
      causationId:   null,
      source:        'api/stability',
      version:       1,
      createdAt:     Date.now(),
    }).catch((e: Error) => { console.error('[stability]', e.message); return null })

    return {
      simulated: true,
      scenario,
      note: 'This endpoint emits a chaos event only — actual simulation is handled by the test harness.',
    }
  })
}

export default stabilityRoutes
