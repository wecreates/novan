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
import type { FastifyRequest, FastifyReply } from 'fastify'
import cors                  from '@fastify/cors'
import helmet                from '@fastify/helmet'
import rateLimit             from '@fastify/rate-limit'
import jwt                   from '@fastify/jwt'
// Swagger lazy-imported below to survive Node 24's strict JSON parsing of @fastify/swagger-ui's csp.json
import { redisClient }       from './redis/client.js'
import { registerQueues }    from './queues/index.js'
import { healthRoutes }      from './routes/health.js'
import { workflowRoutes }    from './routes/workflows.js'
import { maintenanceRoutes } from './routes/maintenance.js'
import { pushRoutes }        from './routes/push.js'
import { quickLinkRoutes }   from './routes/quick-link.js'
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
import researchRoutes           from './routes/research.js'
import feedRoutes               from './routes/feeds.js'
import tokenStretcherRoutes     from './routes/token-stretcher.js'
import researchEngineRoutes     from './routes/research-engine.js'
import imageRoutes              from './routes/images.js'
import platformStatusRoutes     from './routes/platform-status.js'
import operatorRoutes           from './routes/operator.js'
import intelligenceRoutes       from './routes/intelligence.js'
import { governanceRoutes, explainRoutes } from './routes/governance.js'
import enhancementRoutes        from './routes/enhancements.js'
import studioRoutes             from './routes/image-studio.js'
import capabilityRoutes         from './routes/capability.js'
import { cognitionRoutes, executiveRoutes, skillsRoutes } from './routes/cognition.js'
import intelEffRoutes           from './routes/intelligence-efficiency.js'
import truthRoutes              from './routes/truth.js'
import economyRoutes            from './routes/economy.js'
import autonomyRoutes           from './routes/autonomy.js'
import runtimeStatusRoutes      from './routes/runtime-status.js'
import selfAwareRoutes          from './routes/self-aware.js'
import promptsRoutes            from './routes/prompts.js'
import issuesRoutes              from './routes/issues.js'
import ideasRoutes               from './routes/ideas.js'
import skillLibraryRoutes        from './routes/skill-library.js'
import connectorsRoutes          from './routes/connectors.js'
import recapRoutes               from './routes/recap.js'
import identityRoutes            from './routes/identity.js'
import missionRoutes              from './routes/mission.js'
import simRoutes                  from './routes/sim.js'
import { worldGraphRoutes, priorityRoutes } from './routes/world-graph.js'
import commerceRoutes           from './routes/commerce.js'
import fabricRoutes             from './routes/fabric.js'
import chatRoutes               from './routes/chat.js'
import brainRoutes              from './routes/brain.js'
import platformRoutes           from './routes/platform.js'
import voiceRoutes              from './routes/voice.js'
import intelOpsRoutes           from './routes/intel-ops.js'
import ttsRoutes                from './routes/tts.js'
import agencyRoutes             from './routes/agency.js'
import { validateEnvOrThrow }   from './services/secrets-vault.js'
import { startLearningCron, bootKick } from './services/learning-cron.js'
import { registerAutonomousWorker } from './services/autonomous-orchestrator.js'
import { startAgentHeartbeatTicker, stopAgentHeartbeatTicker } from './services/agent-state-sync.js'
import { startHeartbeat }          from './services/runtime-heartbeat.js'

// Render/Heroku/Fly inject PORT; fall back to API_PORT for local dev.
// R143 — guard against non-numeric env values that would otherwise
// produce NaN and cause Fastify.listen to fail with a misleading error.
function _portNum(): number {
  for (const v of [process.env['PORT'], process.env['API_PORT']]) {
    if (v) {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return 3001
}
const PORT = _portNum()
const HOST = process.env['API_HOST'] ?? '0.0.0.0'

const app = Fastify({
  logger: {
    level: process.env['LOG_LEVEL'] ?? 'info',
    ...(process.env['NODE_ENV'] === 'development'
      ? { transport: { target: 'pino-pretty' } }
      : {}),
    // Pino redaction — strip credentials and PII fields from every log
    // line before serialization. Without this, fastify's automatic
    // request-logging dumps Authorization headers + Cookie values, and
    // any code that logs `req.body` accidentally captures passwords and
    // API keys.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers["set-cookie"]',
        'headers.authorization',
        'headers.cookie',
        'headers["x-api-key"]',
        '*.headers.authorization',
        '*.headers.cookie',
        '*.body.password',
        '*.body.token',
        '*.body.api_key',
        '*.body.apiKey',
        '*.body.client_secret',
        '*.body.refresh_token',
        '*.body.access_token',
        'body.password',
        'body.token',
        'body.api_key',
        'body.apiKey',
        'body.client_secret',
        'body.refresh_token',
        'body.access_token',
        'password',
        'token',
        'apiKey',
        'api_key',
        'access_token',
        'refresh_token',
      ],
      censor: '[REDACTED]',
    },
  },
  requestIdHeader:        'x-request-id',
  requestIdLogLabel:      'requestId',
  disableRequestLogging:  false,
  // R146.61 — trustProxy was wide-open `true`, which accepts
  // x-forwarded-for from ANY caller. Attackers connecting directly to
  // the API could spoof their client IP and bypass the per-IP rate
  // limits (R37 auth, R146.27 chat-stream, R146.51 /me, /verify, etc).
  // Restrict to: loopback (Caddy on the same host might proxy via
  // 127.0.0.1), Docker default-bridge networks 172.16.0.0/12, and the
  // overlay network 10.0.0.0/8. Tailscale clients hit the API directly
  // without a proxy so they're unaffected.
  trustProxy:             ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12'],
  // R146.28 — lower global JSON body limit from Fastify's 1MB default
  // to 256KB. 410 POST routes use Fastify; only 1 had an explicit
  // bodyLimit before R146.27. Between 256KB and 1MB every request was
  // fully parsed + handled even when the handler immediately rejected
  // — wasted JSON parsing, useless DB hits, the cost-DoS class R146.27
  // surfaced on /chat/stream applied generically. 256KB covers ~99%
  // of routes; the few that legitimately need more (image /reference
  // accepts up to ~4.5MB base64) opt in via per-route `bodyLimit`.
  bodyLimit: 256 * 1024,
})

// ─── Register plugins ──────────────────────────────────────────────────────────

// CORS — when CORS_ORIGINS env is unset, default to localhost dev ports
// (3000 web, 5173 vite) so OPTIONS preflight is handled and the browser
// can actually fetch from the API. Previously this defaulted to `false`,
// which disables CORS entirely → every preflight returned 404 → web UI
// couldn't load any data.
//
// PRODUCTION ASSERTIONS — refuse to boot in NODE_ENV=production without
// the explicit env vars that protect against credential leak + key
// rotation drift.
if (process.env['NODE_ENV'] === 'production') {
  const required: Array<{ name: string; reason: string }> = [
    { name: 'CORS_ORIGINS',          reason: 'CORS must allowlist real origins; localhost defaults are dev-only' },
    { name: 'VAULT_MASTER_KEY',      reason: 'Without it, secrets-vault uses pid+epoch fallback (recoverable)' },
    { name: 'CHANNEL_ENCRYPTION_KEY', reason: 'Without it, channel-manager uses hostname-derived key (recoverable)' },
    { name: 'AUTH_SECRET',           reason: 'Required for JWT signing' },
  ]
  const missing = required.filter(r => !process.env[r.name])
  if (missing.length > 0) {
    console.error('FATAL: refusing to boot in production without required env vars:')
    for (const m of missing) console.error(`  ${m.name} — ${m.reason}`)
    process.exit(1)
  }
}

const corsOrigin: string[] | boolean = process.env['CORS_ORIGINS']
  ? process.env['CORS_ORIGINS'].split(',').map(s => s.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173']
await app.register(cors, {
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['content-type', 'authorization', 'x-workspace-id', 'x-trace-id'],
})
// R146.43 — CSP was disabled wholesale. Most API responses are JSON
// (Content-Type: application/json), so CSP is moot for them — but a
// handful of routes return HTML directly: /api/v1/enhancements/briefing.html,
// the OAuth redirect templates in connectors.ts, the /docs Swagger UI.
// A reflected-XSS slip in any of those would otherwise execute with full
// privilege. The SPA itself is served by the separate novan-web-1
// container with its own headers and is not affected by this policy.
//
// Defaults are tight: no inline scripts, no eval, no remote origins for
// scripts/styles. 'unsafe-inline' is permitted on styles only because
// the Swagger UI ships inline <style> blocks; if /docs is removed the
// styleSrc can drop back to 'self'.
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: [`'self'`],
      scriptSrc:  [`'self'`],
      styleSrc:   [`'self'`, `'unsafe-inline'`],
      imgSrc:     [`'self'`, 'data:', 'https:'],
      connectSrc: [`'self'`],
      fontSrc:    [`'self'`, 'data:'],
      objectSrc:  [`'none'`],
      frameAncestors: [`'none'`],
      baseUri:    [`'self'`],
      formAction: [`'self'`],
    },
  },
})
await app.register(rateLimit,   { max: 200, timeWindow: '1 minute' })

await app.register(jwt,         { secret: process.env['AUTH_SECRET']! })
await app.register(requestContextPlugin)
await app.register(errorHandlerPlugin)
await app.register(auditPlugin)
await app.register(authPlugin)

// R146.25 — global auth enforcement, env-gated. Off by default so
// existing deployments keep working unchanged; flip ENFORCE_GLOBAL_AUTH=true
// in .env once /setup has been used to mint an operator token (R146.24)
// and the PWA's localStorage contains it. The hook then routes every
// request through `app.authenticate` unless the path matches a public
// prefix. Failed attempt history: R146.23 enabled this unconditionally
// and broke chat because the PWA hadn't been bootstrapped yet — see
// runbook gotcha #11 for the full lesson.
// R146.27 — public path predicates. Original R146.25 used a flat
// string-prefix list, which over-exempted `/api/v1/webhooks` —
// matching the public `/trigger` sub-path also matched `POST /`
// (create), `GET /` (list), `DELETE /:id`, etc, leaving the CRUD
// surface unauthenticated. Now each rule is a predicate: webhooks
// explicitly only exempts paths ending in `/trigger`.
const isPublic = (url: string): boolean => {
  if (url === '/health'         || url.startsWith('/health/'))         return true
  if (url === '/api/v1/health'  || url.startsWith('/api/v1/health/'))  return true
  if (url === '/metrics'        || url.startsWith('/metrics/'))        return true
  if (url === '/docs'           || url.startsWith('/docs/'))           return true
  if (url.startsWith('/api/v1/auth/quick-link'))                       return true
  if (url === '/api/v1/auth/bootstrap')                                return true
  if (/^\/api\/v1\/webhooks\/[a-z0-9-]+\/trigger$/i.test(url))         return true
  return false
}

if (process.env['ENFORCE_GLOBAL_AUTH'] === 'true') {
  type AuthFn = (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  const authenticate = (app as unknown as { authenticate: AuthFn }).authenticate
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0] ?? ''
    if (isPublic(url)) return
    await authenticate(req, reply)
  })
  app.log.info('[auth] global auth enforcement ENABLED via ENFORCE_GLOBAL_AUTH=true')
}

// R146.30 — workspace-ID injection (IDOR) guard, promoted to always-on.
// R146.29 was gated by ENFORCE_GLOBAL_AUTH=true; with the flag off
// (current operator state for PWA continuity) the guard didn't fire and
// any Bearer-token caller could still forge cross-workspace requests.
//
// This preHandler is now always installed. It self-skips when
// `req.workspaceId` is unset — which covers the un-authed Tailscale-only
// dev path that the operator's PWA currently uses. When auth IS present
// (Bearer token or JWT), it compares the auth-claim workspace against
// any workspace_id in body or query and 403s on mismatch. So the IDOR
// is closed for any authenticated caller regardless of the flag state.
app.addHook('preHandler', async (req, reply) => {
  const url = req.url.split('?')[0] ?? ''
  if (isPublic(url)) return
  const authWs = (req as unknown as { workspaceId?: string }).workspaceId
  if (!authWs) return   // unauthenticated — body/query trust falls to per-route logic
  const body  = (req.body  as Record<string, unknown> | undefined) ?? undefined
  const query = (req.query as Record<string, unknown> | undefined) ?? undefined
  // R146.32 — tighten guard against type-confusion bypass. The original
  // R146.30 form only inspected workspace_id when it was a string, so
  // sending `workspace_id: ["global"]`, `{x:"global"}`, or `99` bypassed
  // the check entirely (Drizzle coerced them on insert and rows landed
  // in arbitrary workspaces). Now ANY presence of workspace_id triggers
  // the check: only an exact string-equal-to-authWs is allowed; any
  // other shape (non-string, mismatched string) → 403.
  const probe = body && 'workspace_id' in body
    ? body['workspace_id']
    : (query && 'workspace_id' in query ? query['workspace_id'] : undefined)
  if (probe !== undefined && (typeof probe !== 'string' || probe !== authWs)) {
    req.log.warn({ authWs, probeType: typeof probe, url }, '[auth] cross-workspace or type-confusion request rejected')
    return reply.code(403).send({
      success: false,
      error: 'cross-workspace request denied',
      detail: 'workspace_id must be a string matching the authenticated workspace',
    })
  }
})

// R146.58 — workspace_id shape validator. Runs BEFORE the R146.30 IDOR
// guard and BEFORE per-route handlers. Any presence of workspace_id in
// body or query must match [A-Za-z0-9_-]{1,64} — alphanumeric + dash +
// underscore. Catches NUL bytes, control characters, oversized strings,
// non-ASCII workspace IDs that would otherwise reach DB INSERTs and
// pollute the workspace dimension. Fires regardless of auth state, so
// even with ENFORCE_GLOBAL_AUTH=false the surface is consistent.
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
app.addHook('preHandler', async (req, reply) => {
  const url = req.url.split('?')[0] ?? ''
  if (isPublic(url)) return
  const body  = (req.body  as Record<string, unknown> | undefined) ?? undefined
  const query = (req.query as Record<string, unknown> | undefined) ?? undefined
  for (const src of [body, query]) {
    if (!src || !('workspace_id' in src)) continue
    const v = src['workspace_id']
    if (v === undefined || v === null) continue
    if (typeof v !== 'string' || !WORKSPACE_ID_RE.test(v)) {
      return reply.code(400).send({
        success: false,
        error: 'workspace_id must match [A-Za-z0-9_-]{1,64}',
      })
    }
  }
})

// R146.41 — token-scope enforcement. The scopes column on apiTokens has
// been stored + displayed since R35, but no route ever checked it. An
// operator minting a 'read'-only token would still get full write power.
// R146.24 bootstrap grants ['read','write'] so no current token is
// affected; this gate just makes future read-only tokens behave
// correctly when minted.
//
// JWT-auth and dev-auto-auth requests have no scopes attached
// (req.scopes === undefined) and bypass — they represent the operator
// with implicit full privilege.
app.addHook('preHandler', async (req, reply) => {
  const url = req.url.split('?')[0] ?? ''
  if (isPublic(url)) return
  const scopes = (req as unknown as { scopes?: string[] }).scopes
  if (!scopes) return
  const m = req.method
  const isWrite = m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
  if (isWrite && !scopes.includes('write')) {
    req.log.warn({ scopes, method: m, url }, '[auth] token-scope: write denied')
    return reply.code(403).send({ success: false, error: 'token lacks write scope' })
  }
  if (!isWrite && scopes.length > 0 && !scopes.includes('read')) {
    return reply.code(403).send({ success: false, error: 'token lacks read scope' })
  }
})

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
// Alias under /api/v1/health so the web's useApiLiveness hook + any
// `/api/v1/*` proxy can reach the liveness probe without a separate
// Vite proxy rule for /health.
await app.register(healthRoutes,   { prefix: '/api/v1/health' })
// /healthz alias — k8s/UptimeRobot convention
app.get('/healthz', async (_req, reply) => reply.send({ status: 'ok', timestamp: Date.now() }))
// /metrics is registered by metricsRoutes plugin (queue depths + R119 registry).
await app.register(workflowRoutes, { prefix: '/api/v1/workflows' })
await app.register(maintenanceRoutes, { prefix: '/api/v1' })
await app.register(pushRoutes,        { prefix: '/api/v1/push' })
await app.register(quickLinkRoutes,   { prefix: '/api/v1/auth/quick-link' })
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
await app.register(researchRoutes,         { prefix: '/api/v1/research' })
await app.register(feedRoutes,             { prefix: '/api/v1/research' })
await app.register(tokenStretcherRoutes,   { prefix: '/api/v1/token-stretcher' })
await app.register(researchEngineRoutes,   { prefix: '/api/v1/research-engine' })
await app.register(imageRoutes,            { prefix: '/api/v1/images' })
await app.register(platformStatusRoutes,   { prefix: '/api/v1/platform' })
await app.register(operatorRoutes,         { prefix: '/api/v1/operator' })
await app.register(intelligenceRoutes,     { prefix: '/api/v1/intelligence' })
await app.register(governanceRoutes,       { prefix: '/api/v1/governance' })
await app.register(explainRoutes,          { prefix: '/api/v1/explain' })
await app.register(enhancementRoutes,      { prefix: '/api/v1/x' })
await app.register(studioRoutes,           { prefix: '/api/v1/studio' })
await app.register(capabilityRoutes,       { prefix: '/api/v1/capability' })
await app.register(cognitionRoutes,        { prefix: '/api/v1/cognition' })
await app.register(executiveRoutes,        { prefix: '/api/v1/executive' })
await app.register(skillsRoutes,           { prefix: '/api/v1/skills' })
await app.register(intelEffRoutes,         { prefix: '/api/v1/intel-eff' })
await app.register(truthRoutes,            { prefix: '/api/v1/truth' })
await app.register(economyRoutes,          { prefix: '/api/v1/economy' })
await app.register(autonomyRoutes,         { prefix: '/api/v1/autonomy' })
await app.register(runtimeStatusRoutes,    { prefix: '/api/v1/runtime' })
await app.register(selfAwareRoutes,        { prefix: '/api/v1/self' })
await app.register(promptsRoutes,          { prefix: '/api/v1/prompts' })
await app.register(issuesRoutes,           { prefix: '/api/v1/issues' })
await app.register(ideasRoutes,            { prefix: '/api/v1/ideas' })
await app.register(skillLibraryRoutes,     { prefix: '/api/v1/skill-library' })
await app.register(connectorsRoutes,       { prefix: '/api/v1/connectors' })
await app.register(recapRoutes,            { prefix: '/api/v1/recap' })
await app.register(identityRoutes,          { prefix: '/api/v1/identity' })
await app.register(missionRoutes,           { prefix: '/api/v1/mission' })
await app.register(simRoutes,               { prefix: '/api/v1/sim' })
await app.register(worldGraphRoutes,       { prefix: '/api/v1/world-graph' })
await app.register(priorityRoutes,         { prefix: '/api/v1/priority' })

// Seed connector registry + register in-process action descriptors.
// Runs in background — boot doesn't wait on DB write. Errors surface
// in logs instead of silently disappearing.
import('./services/connectors.js').then(async ({ seedConnectorRegistry }) => {
  const { FIRST_CONNECTOR_DEFS, registerFirstConnectorDescriptors } =
    await import('./services/connector-defs.js')
  registerFirstConnectorDescriptors()
  await seedConnectorRegistry(FIRST_CONNECTOR_DEFS)
}).catch((e: unknown) => {
  app.log.error({ err: (e as Error).message }, 'connector registry seed failed')
})
await app.register(commerceRoutes,         { prefix: '/api/v1/commerce' })
await app.register(fabricRoutes,           { prefix: '/api/v1' })
await app.register(chatRoutes,             { prefix: '/api/v1/chat' })
await app.register(brainRoutes,            { prefix: '/api/v1/brain' })
await app.register(platformRoutes,         { prefix: '/api/v1/platform' })
await app.register(voiceRoutes,            { prefix: '/api/v1/voice' })
await app.register(intelOpsRoutes,         { prefix: '/api/v1/intel-ops' })
await app.register(ttsRoutes,              { prefix: '/api/v1/tts' })
await app.register(agencyRoutes,           { prefix: '/api/v1/agency' })
// MCP (Model Context Protocol) — exposes Novan ops as tools for external
// agents (Claude Desktop, Cursor, Cline, custom GPTs). Mounted at /mcp
// with no /api/v1 prefix so clients can use the natural MCP URL shape.
const { default: mcpRoutes } = await import('./routes/mcp.js')
await app.register(mcpRoutes,              { prefix: '/mcp' })
// Blueprint persistence routes — cartographer/knowledge/evals/policy/portfolios/sim.
const { default: blueprintRoutes } = await import('./routes/blueprint.js')
await app.register(blueprintRoutes,        { prefix: '/api/v1/blueprint' })

// Environment validation — fails fast in production if VAULT_MASTER_KEY missing/invalid
validateEnvOrThrow()

// Start the closed learning loop: periodic incident/improvement/suspicious scans + sweeps
startLearningCron()
// 24/7 self-monitoring + cron re-arm on drift
startHeartbeat(60_000)
// Kick the autonomous mind on boot so cold start isn't silent. Errors
// here are recoverable — if the cold-start research scan fails, the
// next learning-cron tick will retry it.
void (async () => {
  try { await bootKick() } catch (e) {
    app.log.error({ err: (e as Error).message }, 'bootKick failed')
  }
})()
await app.register(docsRedirectRoute)

// ─── Init infrastructure ───────────────────────────────────────────────────────

// db connection is lazy (postgres-js connects on first query)
await redisClient.ping()
await registerQueues()
registerAutonomousWorker()
startAgentHeartbeatTicker('default', 60_000)   // bridge all agent registries

// Boot-time workspace seed — fills the operator-baseline tables that
// otherwise sit empty (provider_configs, kill_switches, runtime_nodes,
// setup_state, notification_prefs). Idempotent.
void (async () => {
  try {
    const { bootstrapWorkspace } = await import('./services/workspace-bootstrap.js')
    const result = await bootstrapWorkspace('default')
    app.log.info({ result }, 'workspace bootstrap complete')
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, 'workspace bootstrap skipped')
  }
})()

// Boot-time: sync the agency catalog (markdown agent definitions) into
// the DB if the directory exists. Idempotent — re-running is a no-op
// for unchanged files (checksum-based dedup inside syncAgentCatalog).
void (async () => {
  try {
    const { existsSync } = await import('node:fs')
    const root = process.env['AGENCY_CATALOG_ROOT']
    if (!root || !existsSync(root)) return
    const { syncAgentCatalog } = await import('./services/agency-catalog.js')
    const result = await syncAgentCatalog('default', root)
    app.log.info({ result }, 'agency catalog synced at boot')
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, 'agency catalog sync skipped')
  }
})()

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Received shutdown signal')
  stopAgentHeartbeatTicker()
  // Stop the learning-cron interval cluster — 50+ self-rescheduling
  // setTimeouts that would otherwise hold the event loop open past
  // app.close() and force a SIGKILL after the grace period.
  try {
    const { stopLearningCron, drainLearningCron } = await import('./services/learning-cron.js')
    stopLearningCron()
    // R146.15 — wait for any tick already mid-flight to finish before
    // we close the DB pool / redis client. Bounded 5s so a stuck tick
    // can't hang shutdown forever; any tag still running past the
    // deadline gets logged for forensics.
    const drain = await drainLearningCron(5_000)
    if (!drain.drained) {
      app.log.warn({ remaining: drain.remaining }, '[shutdown] learning-cron drain timeout — tick(s) still running')
    }
  } catch { /* */ }
  try {
    const { stopConnectorOauthReaper } = await import('./services/connector-oauth.js')
    stopConnectorOauthReaper()
  } catch { /* */ }
  // R146.54 — drain Workers + close Queues. Without this the BullMQ
  // worker process stays connected to Redis after SIGTERM and the
  // graceful shutdown hangs until forced.
  try {
    const { stopQueues } = await import('./queues/index.js')
    await stopQueues()
  } catch { /* */ }
  // R146.13 — runtime-heartbeat fires a DB write every 60s. The timer
  // was .unref()'d so it doesn't block exit, but during the SIGTERM
  // drain it keeps firing inserts against a closing pool. Stop it
  // explicitly before app.close() runs.
  try {
    const { stopHeartbeat } = await import('./services/runtime-heartbeat.js')
    stopHeartbeat()
  } catch { /* */ }
  // Close any open playwright sessions + the shared browser. Without
  // this, restarts leak chrome processes on Windows.
  try {
    const { shutdownAllBrowserSessions } = await import('./services/brain-task-browser.js')
    await shutdownAllBrowserSessions()
  } catch { /* */ }
  try {
    const { shutdownFetcher } = await import('./services/playwright-fetcher.js')
    await shutdownFetcher()
  } catch { /* */ }
  await app.close()
  await redisClient.quit()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT',  () => void shutdown('SIGINT'))

// Process-level safety net. Without these, an unhandled promise rejection
// or synchronous throw in any background task (cron, worker callback, SSE
// generator) silently kills the API. Log + emit a brain.error event so
// the operator sees it in /events, then keep running — Node will not
// auto-exit on unhandledRejection but warns; we make it actionable.
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  const msg = (reason as Error)?.message ?? String(reason)
  app.log.error({ err: msg, promise: String(promise) }, '[unhandledRejection]')
  // Best-effort brain ingest so the autonomous repair loop can react.
  void (async () => {
    try {
      const { reportError } = await import('./services/brain-error-ingest.js')
      const stack = (reason as Error)?.stack
      await reportError({
        workspaceId:  'system',
        source:       'api',
        errorMessage: `unhandledRejection: ${msg}`,
        errorName:    'UnhandledRejection',
        ...(stack ? { stack } : {}),
      })
    } catch { /* tolerated */ }
  })()
})

process.on('uncaughtException', (err: Error) => {
  app.log.fatal({ err: err.message, stack: err.stack }, '[uncaughtException] — exiting')
  // Best-effort log flush then exit. Cannot reliably recover from a
  // synchronous throw outside any handler.
  setTimeout(() => process.exit(1), 250).unref()
})

// ─── Start ─────────────────────────────────────────────────────────────────────

/**
 * Port-clearing guard: on Windows, tsx watch's "kill child + spawn new"
 * cycle can leave the old child's TCP listener hanging for tens of
 * seconds, during which the new child fails to bind (EADDRINUSE) AND
 * the operator sees intermittent request hangs. Before listening, we
 * probe the port; if something else owns it, we wait up to 10s for it
 * to free, then attempt to listen. Production (no watch) never hits
 * this path.
 */
async function waitForPortFree(port: number, host: string): Promise<void> {
  const net = await import('node:net')
  const isFree = () => new Promise<boolean>((resolve) => {
    const probe = net.default.createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })
  for (let i = 0; i < 20; i++) {       // 20 × 500ms = 10s budget
    if (await isFree()) return
    await new Promise(r => setTimeout(r, 500))
  }
  // Best-effort signal: if it's still busy, the listen() below will
  // throw with a clear EADDRINUSE — better than silent hang.
}

try {
  await waitForPortFree(PORT, HOST).catch((e: Error) => { console.error('[server]', e.message); return null })
  await app.listen({ port: PORT, host: HOST })
  app.log.info({ port: PORT, host: HOST, docs: `http://${HOST}:${PORT}/docs` }, 'API server started')
} catch (err) {
  app.log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'Failed to start server')
  process.exit(1)
}
