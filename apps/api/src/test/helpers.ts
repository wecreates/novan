/**
 * Test app factory — builds a Fastify instance with all routes registered
 * but with mocked infrastructure (no real DB, Redis, or queues).
 *
 * vi.mock() calls are hoisted by Vitest — they must live in the test file.
 * This helper just wires up the Fastify app using the same plugin/route
 * registration order as server.ts, minus the real listen() call.
 */

import Fastify, { type FastifyInstance } from 'fastify'
import cors       from '@fastify/cors'
import helmet     from '@fastify/helmet'
import rateLimit  from '@fastify/rate-limit'
import jwt        from '@fastify/jwt'
import swagger    from '@fastify/swagger'
import swaggerUi  from '@fastify/swagger-ui'

import { authPlugin }           from '../plugins/auth.js'
import { requestContextPlugin } from '../plugins/requestContext.js'
import { errorHandlerPlugin }   from '../plugins/errorHandler.js'
import { auditPlugin }          from '../plugins/audit.js'

import { healthRoutes }       from '../routes/health.js'
import { workflowRoutes }     from '../routes/workflows.js'
import { memoryRoutes }       from '../routes/memory.js'
import { eventRoutes }        from '../routes/events.js'
import { approvalRoutes }     from '../routes/approvals.js'
import { metricsRoutes }      from '../routes/metrics.js'
import { workflowRunRoutes }  from '../routes/workflow-runs.js'
import { browserRoutes }      from '../routes/browser.js'
import { briefingRoutes }     from '../routes/briefings.js'
import { opportunityRoutes }  from '../routes/opportunities.js'
import { risksRoutes }        from '../routes/risks.js'
import { insightsRoutes }     from '../routes/insights.js'
import { goalsRoutes }        from '../routes/goals.js'
import { agentsRoutes }       from '../routes/agents.js'
import { businessesRoutes }   from '../routes/businesses.js'
import { analyticsRoutes }    from '../routes/analytics.js'
import { deadLetterRoutes }   from '../routes/dead-letter.js'
import { aiUsageRoutes }      from '../routes/ai-usage.js'
import { streamRoutes }       from '../routes/stream.js'
import { notificationsRoutes } from '../routes/notifications.js'
import { authRoutes }         from '../routes/auth.js'
import { schedulerRoutes }    from '../routes/scheduler.js'
import { searchRoutes }       from '../routes/search.js'
import { webhooksRoutes }     from '../routes/webhooks.js'
import { workersRoutes }      from '../routes/workers.js'
import { exportRoutes }       from '../routes/export.js'
import { workspacesRoutes }   from '../routes/workspaces.js'
import aiRouterRoutes         from '../routes/ai-router.js'
import costGovernorRoutes     from '../routes/cost-governor.js'
import runtimeRegistryRoutes  from '../routes/runtime-registry.js'
import protectionRoutes       from '../routes/protection.js'
import recoveryRoutes         from '../routes/recovery.js'
import cloudRuntimeRoutes     from '../routes/cloud-runtime.js'
import stabilityRoutes        from '../routes/stability.js'
import launchRoutes           from '../routes/launch.js'
import engAgentsRoutes        from '../routes/eng-agents.js'

/** Shared JWT secret used for signing test tokens. */
export const TEST_JWT_SECRET = 'test-secret-do-not-use-in-production'

/** Sign a test JWT for authenticated routes. */
export function makeTestToken(app: FastifyInstance, overrides: Record<string, unknown> = {}): string {
  return app.jwt.sign({ sub: 'user-test-001', wid: 'ws-test-001', ...overrides })
}

/** Build the full Fastify app with mocked infra. No listen() called. */
export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // silence logs in test output
    trustProxy: true,
  })

  // ── Plugins (same order as server.ts) ────────────────────────────────────
  await app.register(cors,      { origin: false })
  await app.register(helmet,    { contentSecurityPolicy: false })
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' })
  await app.register(jwt,       { secret: TEST_JWT_SECRET })

  await app.register(requestContextPlugin)
  await app.register(errorHandlerPlugin)
  await app.register(auditPlugin)
  await app.register(authPlugin)

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Novan API', version: '1.0.0', description: 'Test' },
    },
  })
  await app.register(swaggerUi, { routePrefix: '/docs' })

  // ── Routes (same order as server.ts) ─────────────────────────────────────
  await app.register(healthRoutes,        { prefix: '/health' })
  await app.register(workflowRoutes,      { prefix: '/api/v1/workflows' })
  await app.register(memoryRoutes,        { prefix: '/api/v1/memory' })
  await app.register(eventRoutes,         { prefix: '/api/v1/events' })
  await app.register(approvalRoutes,      { prefix: '/api/v1/approvals' })
  await app.register(workflowRunRoutes,   { prefix: '/api/v1/workflow-runs' })
  await app.register(browserRoutes,       { prefix: '/api/v1/browser' })
  await app.register(briefingRoutes,      { prefix: '/api/v1/briefings' })
  await app.register(opportunityRoutes,   { prefix: '/api/v1/opportunities' })
  await app.register(risksRoutes,         { prefix: '/api/v1/risks' })
  await app.register(insightsRoutes,      { prefix: '/api/v1/insights' })
  await app.register(goalsRoutes,         { prefix: '/api/v1/goals' })
  await app.register(agentsRoutes,        { prefix: '/api/v1/agents' })
  await app.register(businessesRoutes,    { prefix: '/api/v1/businesses' })
  await app.register(analyticsRoutes,     { prefix: '/api/v1/analytics' })
  await app.register(deadLetterRoutes,    { prefix: '/api/v1/dead-letter' })
  await app.register(aiUsageRoutes,       { prefix: '/api/v1/ai-usage' })
  await app.register(streamRoutes,        { prefix: '/api/v1/stream' })
  await app.register(notificationsRoutes, { prefix: '/api/v1/notifications' })
  await app.register(authRoutes,          { prefix: '/api/v1/auth' })
  await app.register(schedulerRoutes,     { prefix: '/api/v1/scheduler' })
  await app.register(searchRoutes,        { prefix: '/api/v1/search' })
  await app.register(webhooksRoutes,      { prefix: '/api/v1/webhooks' })
  await app.register(workersRoutes,       { prefix: '/api/v1/workers' })
  await app.register(exportRoutes,        { prefix: '/api/v1/export' })
  await app.register(workspacesRoutes,    { prefix: '/api/v1/workspaces' })
  await app.register(aiRouterRoutes,        { prefix: '/api/v1/ai-router' })
  await app.register(costGovernorRoutes,    { prefix: '/api/v1/governor' })
  await app.register(runtimeRegistryRoutes, { prefix: '/api/v1/runtime' })
  await app.register(protectionRoutes,      { prefix: '/api/v1/protection' })
  await app.register(recoveryRoutes,        { prefix: '/api/v1/recovery' })
  await app.register(cloudRuntimeRoutes,    { prefix: '/api/v1/cloud-runtime' })
  await app.register(stabilityRoutes,       { prefix: '/api/v1/stability' })
  await app.register(launchRoutes,          { prefix: '/api/v1/launch' })
  await app.register(engAgentsRoutes,       { prefix: '/api/v1/eng-agents' })
  await app.register(metricsRoutes,         { prefix: '/metrics' })

  await app.ready()
  return app
}
