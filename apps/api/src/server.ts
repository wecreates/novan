/**
 * Novan — Fastify API server entrypoint.
 *
 * Boot order:
 *   1. Telemetry (OpenTelemetry) — before any requires
 *   2. Database pool (Drizzle + Postgres)
 *   3. Redis client (ioredis)
 *   4. BullMQ queues
 *   5. Fastify app + plugins
 *   6. Route registration
 *   7. Graceful shutdown handlers
 */
import './telemetry.js'
import Fastify               from 'fastify'
import cors                  from '@fastify/cors'
import helmet                from '@fastify/helmet'
import rateLimit             from '@fastify/rate-limit'
import jwt                   from '@fastify/jwt'
// Swagger lazy-imported below to survive Node 24's strict JSON parsing of @fastify/swagger-ui's csp.json
import { redisClient }       from './redis/client.js'
import { registerQueues }    from './queues/index.js'
import { healthRoutes }      from './routes/health.js'
import { workflowRoutes }    from './routes/workflows.js'
import { memoryRoutes }      from './routes/memory.js'
import { eventRoutes }       from './routes/events.js'
import { approvalRoutes }    from './routes/approvals.js'
import { metricsRoutes }     from './routes/metrics.js'
import { workflowRunRoutes } from './routes/workflow-runs.js'
import { browserRoutes }     from './routes/browser.js'
import { briefingRoutes }       from './routes/briefings.js'
import { opportunityRoutes }    from './routes/opportunities.js'
import { risksRoutes }          from './routes/risks.js'
import { insightsRoutes }       from './routes/insights.js'
import { goalsRoutes }          from './routes/goals.js'
import { agentsRoutes }         from './routes/agents.js'
import { businessesRoutes }     from './routes/businesses.js'
import { analyticsRoutes }      from './routes/analytics.js'
import { deadLetterRoutes }     from './routes/dead-letter.js'
import { aiUsageRoutes }        from './routes/ai-usage.js'
import { streamRoutes }         from './routes/stream.js'
import { notificationsRoutes }   from './routes/notifications.js'
import { authRoutes }            from './routes/auth.js'
import { schedulerRoutes }       from './routes/scheduler.js'
import { searchRoutes }          from './routes/search.js'
import { webhooksRoutes }        from './routes/webhooks.js'
import { workersRoutes }        from './routes/workers.js'
import { authPlugin }           from './plugins/auth.js'
import { requestContextPlugin } from './plugins/requestContext.js'
import { errorHandlerPlugin }   from './plugins/errorHandler.js'
import { auditPlugin }          from './plugins/audit.js'
import { exportRoutes }         from './routes/export.js'
import { workspacesRoutes }     from './routes/workspaces.js'
import { docsRedirectRoute }    from './routes/docs-redirect.js'
import learningRoutes           from './routes/learning.js'
import aiRouterRoutes           from './routes/ai-router.js'
import costGovernorRoutes       from './routes/cost-governor.js'
import runtimeRegistryRoutes    from './routes/runtime-registry.js'
import protectionRoutes         from './routes/protection.js'
import recoveryRoutes           from './routes/recovery.js'
import cloudRuntimeRoutes       from './routes/cloud-runtime.js'
import stabilityRoutes          from './routes/stability.js'
import launchRoutes             from './routes/launch.js'
import engAgentsRoutes          from './routes/eng-agents.js'
import autonomousRoutes         from './routes/autonomous.js'
import auditRoutes              from './routes/audit.js'
import patchApprovalsRoutes     from './routes/patch-approvals.js'
import sandboxRoutes            from './routes/sandbox.js'
import incidentRoutes           from './routes/incidents.js'
import learningRuntimeRoutes    from './routes/learning-runtime.js'
import orchestratorRoutes       from './routes/orchestrator.js'
import productionReadinessRoutes from './routes/production-readiness.js'
import improvementRoutes        from './routes/improvement.js'
import billingRoutes            from './routes/billing.js'
import securityRoutes           from './routes/security.js'
import securityTeamRoutes       from './routes/security-team.js'
import launchTonightRoutes      from './routes/launch-tonight.js'
import { validateEnvOrThrow }   from './services/secrets-vault.js'
import { startLearningCron }    from './services/learning-cron.js'
import { registerAutonomousWorker } from './services/autonomous-orchestrator.js'

// Render/Heroku/Fly inject PORT; fall back to API_PORT for local dev
const PORT = Number(process.env['PORT'] ?? process.env['API_PORT'] ?? 3001)
const HOST = process.env['API_HOST'] ?? '0.0.0.0'

const app = Fastify({
  logger: {
    level: process.env['LOG_LEVEL'] ?? 'info',
    ...(process.env['NODE_ENV'] === 'development'
      ? { transport: { target: 'pino-pretty' } }
      : {}),
  },
  requestIdHeader:        'x-request-id',
  requestIdLogLabel:      'requestId',
  disableRequestLogging:  false,
  trustProxy:             true,
})

// ─── Register plugins ──────────────────────────────────────────────────────────

await app.register(cors,        { origin: process.env['CORS_ORIGINS']?.split(',') ?? false })
await app.register(helmet,      { contentSecurityPolicy: false })
await app.register(rateLimit,   { max: 200, timeWindow: '1 minute' })

await app.register(jwt,         { secret: process.env['AUTH_SECRET']! })
await app.register(requestContextPlugin)
await app.register(errorHandlerPlugin)
await app.register(auditPlugin)
await app.register(authPlugin)

// Swagger is optional — wrap so a CJS/JSON quirk in @fastify/swagger-ui doesn't crash boot
try {
  const { default: swagger }   = await import('@fastify/swagger')
  const { default: swaggerUi } = await import('@fastify/swagger-ui')
  await app.register(swagger, {
  openapi: {
    openapi: '3.1.0',
    info: {
      title: 'Novan API',
      version: '1.0.0',
      description: 'Novan — autonomous operational intelligence platform',
    },
    tags: [
      { name: 'health',        description: 'Health checks and status' },
      { name: 'workflows',     description: 'Workflow definitions and execution' },
      { name: 'workflow-runs', description: 'Workflow run history and management' },
      { name: 'memory',        description: 'Semantic memory storage and retrieval' },
      { name: 'events',        description: 'Event bus and timeline' },
      { name: 'approvals',     description: 'Human-in-the-loop approval workflows' },
      { name: 'opportunities', description: 'Business opportunity tracking' },
      { name: 'risks',         description: 'Risk register and management' },
      { name: 'insights',      description: 'AI-generated insights' },
      { name: 'goals',         description: 'Strategic goals and OKRs' },
      { name: 'agents',        description: 'AI agent registry' },
      { name: 'businesses',    description: 'Business directory' },
      { name: 'analytics',     description: 'Usage analytics and metrics' },
      { name: 'briefings',     description: 'AI-generated briefings' },
      { name: 'stream',        description: 'Real-time SSE event stream' },
      { name: 'notifications', description: 'Notification management' },
      { name: 'auth',          description: 'Authentication and API tokens' },
      { name: 'search',        description: 'Global search' },
      { name: 'webhooks',      description: 'Inbound webhook triggers' },
      { name: 'scheduler',     description: 'Cron-based workflow triggers' },
      { name: 'workers',       description: 'Worker health and queue monitoring' },
      { name: 'dead-letter',   description: 'Dead letter queue management' },
      { name: 'ai-usage',      description: 'AI usage recording' },
      { name: 'export',        description: 'Data export (CSV/JSON)' },
      { name: 'workspaces',    description: 'Workspace management' },
      { name: 'metrics',       description: 'Prometheus metrics' },
      { name: 'learning',      description: 'Learning runtime — signals, patterns, insights, feedback' },
      { name: 'ai-router',    description: 'AI provider router — chat, embed, budget, health' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http' as const,
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token from /api/v1/auth or API token (ops_xxx)',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
})
  await app.register(swaggerUi, { routePrefix: '/docs' })
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[swagger] disabled (non-fatal):', (err as Error).message)
}

// ─── Register routes ───────────────────────────────────────────────────────────

await app.register(healthRoutes,   { prefix: '/health' })
await app.register(workflowRoutes, { prefix: '/api/v1/workflows' })
await app.register(memoryRoutes,   { prefix: '/api/v1/memory' })
await app.register(eventRoutes,    { prefix: '/api/v1/events' })
await app.register(approvalRoutes,    { prefix: '/api/v1/approvals' })
await app.register(workflowRunRoutes, { prefix: '/api/v1/workflow-runs' })
await app.register(browserRoutes,     { prefix: '/api/v1/browser' })
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
await app.register(metricsRoutes,       { prefix: '/metrics' })
await app.register(learningRoutes,      { prefix: '/api/v1/learning' })
await app.register(aiRouterRoutes,         { prefix: '/api/v1/ai-router' })
await app.register(costGovernorRoutes,     { prefix: '/api/v1/governor' })
await app.register(runtimeRegistryRoutes,  { prefix: '/api/v1/runtime' })
await app.register(protectionRoutes,       { prefix: '/api/v1/protection' })
await app.register(recoveryRoutes,         { prefix: '/api/v1/recovery' })
await app.register(cloudRuntimeRoutes,     { prefix: '/api/v1/cloud-runtime' })
await app.register(stabilityRoutes,        { prefix: '/api/v1/stability' })
await app.register(launchRoutes,           { prefix: '/api/v1/launch' })
await app.register(engAgentsRoutes,        { prefix: '/api/v1/eng-agents' })
await app.register(autonomousRoutes,       { prefix: '/api/v1/autonomous' })
await app.register(auditRoutes,            { prefix: '/api/v1/audit' })
await app.register(patchApprovalsRoutes,   { prefix: '/api/v1/patch-approvals' })
await app.register(sandboxRoutes,          { prefix: '/api/v1/sandbox' })
await app.register(incidentRoutes,         { prefix: '/api/v1/incidents' })
await app.register(learningRuntimeRoutes,  { prefix: '/api/v1/learning-runtime' })
await app.register(orchestratorRoutes,     { prefix: '/api/v1/orchestrator' })
await app.register(productionReadinessRoutes, { prefix: '/api/v1/production-readiness' })
await app.register(improvementRoutes,      { prefix: '/api/v1/improvement' })
await app.register(billingRoutes,          { prefix: '/api/v1/billing' })
await app.register(securityRoutes,         { prefix: '/api/v1/security' })
await app.register(securityTeamRoutes,     { prefix: '/api/v1/security-team' })
await app.register(launchTonightRoutes,    { prefix: '/api/v1/launch-tonight' })

// Environment validation — fails fast in production if VAULT_MASTER_KEY missing/invalid
validateEnvOrThrow()

// Start the closed learning loop: periodic incident/improvement/suspicious scans + sweeps
startLearningCron()
await app.register(docsRedirectRoute)

// ─── Init infrastructure ───────────────────────────────────────────────────────

// db connection is lazy (postgres-js connects on first query)
await redisClient.ping()
await registerQueues()
registerAutonomousWorker()

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Received shutdown signal')
  await app.close()
  await redisClient.quit()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT',  () => void shutdown('SIGINT'))

// ─── Start ─────────────────────────────────────────────────────────────────────

try {
  await app.listen({ port: PORT, host: HOST })
  app.log.info({ port: PORT, host: HOST, docs: `http://${HOST}:${PORT}/docs` }, 'API server started')
} catch (err) {
  app.log.error(err, 'Failed to start server')
  process.exit(1)
}
