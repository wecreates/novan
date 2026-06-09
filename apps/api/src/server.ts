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
import { timingSafeEqual }   from 'node:crypto'
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
import { registerGumroadWebhook } from './routes/gumroad-webhook.js'  // R389
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
import r328PublicRoutes         from './routes/r328-public.js'
import r329BrainOpRoutes        from './routes/r329-brain-op.js'
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
import freeVoiceRoutes          from './routes/free-voice.js'
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
      // R146.306 — scriptSrc was just ['self'], which blocks inline
      // <script> blocks. /brain.html and /console.html each ship one
      // self-contained inline <script> for their operator UI (no
      // external bundler), so the previous CSP silently broke them in
      // every browser. Verified via `curl /brain.html` + checking the
      // emitted CSP header — `script-src 'self'` + 1 inline <script> in
      // the body = blocked.
      // 'unsafe-inline' regresses CSP protection on these two routes;
      // mitigations: (1) both routes are public allowlist but operator-
      // token-required to do anything material, (2) R294 hardened the
      // console XSS — every interpolation now goes through esc(),
      // (3) the only callers are the operator's PWA/browser over
      // Tailscale, not internet-facing. Trade is acceptable until/unless
      // we move to a per-response nonce or extract the inline JS to
      // /<route>/script.js files.
      scriptSrc:  [`'self'`, `'unsafe-inline'`],
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

// R146.301 — fail-fast on missing AUTH_SECRET. The previous `!` non-null
// assertion was a TS-only silencer; at runtime an unset env would pass
// `undefined` to @fastify/jwt and either crash on first verify or
// silently sign with the string 'undefined' depending on plugin version,
// making every JWT forgeable. Require explicit env, length ≥ 32 to
// reject obvious low-entropy values.
const _authSecret = process.env['AUTH_SECRET']
if (!_authSecret || _authSecret.length < 32) {
  throw new Error('[auth] AUTH_SECRET must be set and ≥ 32 chars before boot')
}
// R146.325 (#24) — JWT rotation support. AUTH_SECRET_PREVIOUS, if set, is
// tried as a fallback verifier so rotating the secret doesn't immediately
// invalidate every active token. Sign with current; verify against either.
// When we observe a previous-secret-hit we log so the operator knows when
// it's safe to drop AUTH_SECRET_PREVIOUS from env.
const _authSecretPrev = process.env['AUTH_SECRET_PREVIOUS']
await app.register(jwt, {
  secret: _authSecretPrev && _authSecretPrev.length >= 32
    ? { private: _authSecret, public: [_authSecret, _authSecretPrev] }
    : _authSecret,
})
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
  if (url === '/healthz'        || url.startsWith('/healthz/'))        return true  // R146.263 — k8s/probes expect /healthz
  if (url === '/ops/dashboard'   || url.startsWith('/ops/dashboard'))   return true  // R370 — dashboard + R418 actions have their own query-param token check
  if (url.startsWith('/ops/export/'))                                   return true  // R503 — CSV export, token in query
  if (url.startsWith('/ops/gdpr/'))                                     return true  // R515 — token in query
  if (url.startsWith('/ops/dmca/'))                                     return true  // R516 — token in query
  if (url === '/console.html' || url === '/console')                    return true
  if (url === '/brain.html'   || url === '/brain')                      return true
  if (url === '/api/v1/health'  || url.startsWith('/api/v1/health/'))  return true
  if (url === '/metrics'        || url.startsWith('/metrics/'))        return true
  if (url === '/docs'           || url.startsWith('/docs/'))           return true
  if (url.startsWith('/api/v1/auth/quick-link'))                       return true
  if (url === '/api/v1/auth/bootstrap')                                return true
  if (/^\/api\/v1\/webhooks\/[a-z0-9-]+\/trigger$/i.test(url))         return true
  if (url === '/api/v1/webhooks/gumroad/sale')                         return true  // R389 — token in query param
  if (url === '/api/v1/designs/upload')                                return true  // R464 — R438 upload, X-Novan-Token in header
  if (/^\/api\/v1\/designs\/[A-Za-z0-9._-]+\/file$/.test(url))         return true  // R464 — R438 GET (workspace-scoped reads, considered low-risk)
  // R146.188 — admin brain bridge has its own loopback+token auth.
  if (url === '/admin/brain' || url === '/admin/brain/ops')            return true
  // R146.332 — OAuth callbacks must be public. The provider redirects the
  // operator's browser here without our Bearer token; identity is recovered
  // from the HMAC-signed `state` param inside the handler.
  if (/^\/api\/v1\/oauth\/[a-z0-9_-]+\/callback$/i.test(url))          return true
  // R146.317 — intentionally-public ingest + asset routes that broke when
  // ENFORCE_GLOBAL_AUTH=true was flipped on. These are designed to be hit
  // anonymously from operator landing pages (funnel pixel), biometric
  // devices, short-URL redirects, and Mixcraft/CapCut import scripts.
  // workspaceId-shape validator (R146.58/R315) still runs on these, and
  // /t handler enforces a whitelisted `kind`. The blast radius is bounded
  // and these endpoints have been verified intended-public in code review.
  if (/^\/t\/[A-Za-z0-9_-]{1,64}$/i.test(url))                          return true   // funnel tracker
  if (/^\/bio\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/i.test(url))   return true   // biometric webhook
  if (/^\/r\/[A-Za-z0-9_-]{1,20}$/i.test(url))                          return true   // short-URL redirect
  if (/^\/mixcraft\/[A-Za-z0-9_-]+\//i.test(url))                       return true   // mixcraft adapter
  if (/^\/capcut\/[A-Za-z0-9_-]+\//i.test(url))                         return true   // capcut adapter
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

// R146.218 — HTTP timing histogram. Records p50/p95/p99 per route into
// the metrics registry so /metrics exposes operator-visible latency.
// Route label is the matched routerPath when available (so /admin/brain
// doesn't expand into 900 op-specific series), else the raw URL path.
app.addHook('onRequest', async (req) => {
  ;(req as unknown as { _startNs: bigint })._startNs = process.hrtime.bigint()
})
app.addHook('onResponse', async (req, reply) => {
  const start = (req as unknown as { _startNs?: bigint })._startNs
  if (start === undefined) return
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000
  // R146.302 — fallback to a SINGLE bucket label when Fastify hasn't matched
  // a routerPath (404 / probe traffic). The previous fallback was
  // req.url.split('?')[0] which expanded to the raw URL — an attacker
  // probing /api/v1/x-aaa, /api/v1/x-bbb, … created unbounded label
  // cardinality in the histogram's per-label Maps, growing memory
  // forever. The matched-route case still gets specific labels.
  const routerPath = (req as unknown as { routerPath?: string }).routerPath
  const route = routerPath || 'unmatched'
  // Drop tracking on internal Fastify cycles + healthcheck noise
  if (route === '/health' || route === '/health/ready' || route === '/metrics') return
  const status = String(reply.statusCode)
  try {
    const { observeHistogram } = await import('./services/metrics.js')
    observeHistogram('http_request_duration_ms', elapsedMs, { route, method: req.method, status }, undefined, 'HTTP request duration')
  } catch { /* tolerated */ }
})

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
  //
  // R146.308 — extend to camelCase. The guard previously only checked
  // `workspace_id` (snake_case). But 20+ routes accept `workspaceId`
  // (camelCase) from body — verified by grepping body.workspaceId
  // patterns across apps/api/src/routes. An attacker sending
  // {workspaceId: "victim"} (no snake_case) bypassed the guard entirely
  // and the route handler read body.workspaceId straight through.
  // Check BOTH key shapes; reject on either mismatch.
  const probeFromBody = body
    ? (('workspace_id' in body ? body['workspace_id'] : undefined)
        ?? ('workspaceId' in body ? body['workspaceId'] : undefined))
    : undefined
  const probeFromQuery = query
    ? (('workspace_id' in query ? query['workspace_id'] : undefined)
        ?? ('workspaceId' in query ? query['workspaceId'] : undefined))
    : undefined
  // R146.315 — extend to URL params. routes/runtime-registry.ts uses
  // `/scores/:workspaceId` etc., which the body+query guard misses.
  const params = (req.params as Record<string, unknown> | undefined) ?? undefined
  const probeFromParams = params
    ? (('workspace_id' in params ? params['workspace_id'] : undefined)
        ?? ('workspaceId' in params ? params['workspaceId'] : undefined))
    : undefined
  const probe = probeFromBody ?? probeFromQuery ?? probeFromParams
  if (probe !== undefined && (typeof probe !== 'string' || probe !== authWs)) {
    req.log.warn({ authWs, probeType: typeof probe, url }, '[auth] cross-workspace or type-confusion request rejected')
    return reply.code(403).send({
      success: false,
      error: 'cross-workspace request denied',
      detail: 'workspace_id / workspaceId must be a string matching the authenticated workspace',
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
  const params = (req.params as Record<string, unknown> | undefined) ?? undefined
  // R146.308 — check both snake and camel key shapes; same camelCase blind
  // spot the R30 guard had. R146.315 — extend to URL params.
  for (const src of [body, query, params]) {
    if (!src) continue
    for (const key of ['workspace_id', 'workspaceId']) {
      if (!(key in src)) continue
      const v = src[key]
      if (v === undefined || v === null) continue
      if (typeof v !== 'string' || !WORKSPACE_ID_RE.test(v)) {
        return reply.code(400).send({
          success: false,
          error: `${key} must match [A-Za-z0-9_-]{1,64}`,
        })
      }
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

// R370 — Operator dashboard. Read-only HTML, ops-token gated.
app.get<{ Querystring: { token?: string; workspace?: string } }>('/ops/dashboard', async (req, reply) => {
  const ops = process.env['NOVAN_OPS_TOKEN'] ?? process.env['OPERATOR_TOKEN'] ?? ''
  if (!req.query.token || (ops && req.query.token !== ops)) {
    reply.status(401).type('text/html').send('<h1>401</h1>Pass ?token=&lt;ops-token&gt;')
    return
  }
  const { renderDashboard } = await import('./services/r370-operator-dashboard.js')
  const html = await renderDashboard(req.query.workspace ?? 'default', req.query.token)
  reply.type('text/html').send(html)
})

// R432 — operator quick-action click dedup. Keys are (workspace|action),
// values are last-fired timestamp. R452 — periodic eviction. R495 — interval
// handle kept so graceful shutdown can clear it.
const ACTION_DEDUP = new Map<string, number>()
const ACTION_DEDUP_TTL_MS = 5 * 60_000
const ACTION_DEDUP_INTERVAL = setInterval(() => {
  const cutoff = Date.now() - ACTION_DEDUP_TTL_MS
  for (const [k, ts] of ACTION_DEDUP) if (ts < cutoff) ACTION_DEDUP.delete(k)
}, 60_000)
ACTION_DEDUP_INTERVAL.unref()
app.addHook('onClose', async () => { clearInterval(ACTION_DEDUP_INTERVAL) })

// R427 — register form-urlencoded parser at app scope so dashboard POST
// forms work whether or not the Gumroad webhook route registered it first.
if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      const params = new URLSearchParams(String(body))
      const obj: Record<string, string> = {}
      for (const [k, v] of params.entries()) obj[k] = v
      done(null, obj)
    } catch (e) { done(e as Error, undefined) }
  })
}

// R418/R427 — operator quick-action endpoint. POST-only to prevent CSRF via
// image tags / cross-site links / referrer leak. Token must be in body, not
// just query. Sec-Fetch-Site verifies same-origin.
app.post<{ Querystring: { token?: string; workspace?: string; action?: string }; Body: { token?: string; workspace?: string; action?: string } }>('/ops/dashboard/action', async (req, reply) => {
  const sfs = req.headers['sec-fetch-site']
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return reply.code(403).type('text/plain').send('cross-site posts blocked')
  }
  const body = req.body ?? {}
  const tokenInput = body.token ?? req.query.token  // body wins
  const workspace  = body.workspace ?? req.query.workspace ?? 'default'
  const actionInput = body.action ?? req.query.action
  const ops = process.env['NOVAN_OPS_TOKEN'] ?? process.env['OPERATOR_TOKEN'] ?? ''
  if (!tokenInput || (ops && tokenInput !== ops)) {
    return reply.code(401).type('text/plain').send('unauthorized')
  }
  const ws = workspace
  const action = String(actionInput ?? '')
  const ALLOWED: Record<string, () => Promise<unknown>> = {
    'daily_cron':           async () => { const { runDailyCron } = await import('./services/r382-droplet-daily-cron.js'); return runDailyCron(ws, { force: true }) },
    'replenish_queue':      async () => { const { autoReplenishLowQueues } = await import('./services/r400-queue-auto-replenish.js'); return autoReplenishLowQueues() },
    'auto_variants':        async () => { const { runAutoVariantsForWinners } = await import('./services/r401-auto-variants-for-winners.js'); return runAutoVariantsForWinners() },
    'auto_cross_list':      async () => { const { autoCrossListWinners } = await import('./services/r411-auto-cross-list.js'); return autoCrossListWinners() },
    'push_next_action':     async () => { const { pushNextActions } = await import('./services/r386-next-action-pusher.js'); return pushNextActions() },
    'requeue_failed':       async () => { const { requeueFailedUploads } = await import('./services/r402-failed-upload-auto-requeue.js'); return requeueFailedUploads() },
    'pacing_auto_loosen':   async () => { const { autoLoosenPacing } = await import('./services/r387-pacing-auto-loosen.js'); return autoLoosenPacing() },
    'relist_zero_sales':    async () => { const { relistZeroSaleListings } = await import('./services/r417-zero-sale-relisting.js'); return relistZeroSaleListings() },
    'webhook_self_test':    async () => { const { selfTestGumroadWebhook } = await import('./services/r502-webhook-test.js'); return selfTestGumroadWebhook() },
  }
  const fn = ALLOWED[action]
  if (!fn) return reply.code(400).type('text/plain').send(`unknown action; allowed: ${Object.keys(ALLOWED).join(', ')}`)
  // R432 — server-side dedup so double-click doesn't double-fire (esp. for
  // push_next_action which would dupe notifications). 5s window per action.
  const dedupKey = `${ws}|${action}`
  const last = ACTION_DEDUP.get(dedupKey) ?? 0
  if (Date.now() - last < 5_000) {
    return reply.type('text/html').send(`<!doctype html><meta http-equiv="refresh" content="2;url=/ops/dashboard?token=${encodeURIComponent(tokenInput)}"><body style="font-family:system-ui;background:#0a0a0b;color:#e5e7eb;padding:20px"><h2>⊘ ${action} skipped (deduped within 5s)</h2></body>`)
  }
  ACTION_DEDUP.set(dedupKey, Date.now())
  try {
    const result = await fn()
    reply.type('text/html').send(`<!doctype html><meta http-equiv="refresh" content="2;url=/ops/dashboard?token=${encodeURIComponent(tokenInput)}"><body style="font-family:system-ui;background:#0a0a0b;color:#e5e7eb;padding:20px"><h2>✓ ${action} fired</h2><pre style="background:#18181b;padding:12px;border-radius:6px;overflow:auto;max-width:800px">${JSON.stringify(result, null, 2).slice(0, 4000)}</pre><p>Returning to dashboard…</p></body>`)
  } catch (e) {
    reply.code(500).type('text/plain').send(`error: ${(e as Error).message}`)
  }
})

// R146.159 — Public knowledge garden. Serves chunks operator has published
// via garden.publish. No auth — public by definition. Returns rendered HTML.
app.get<{ Params: { slug: string } }>('/garden/:slug', async (req, reply) => {
  const slug = req.params.slug
  if (!slug || slug.length > 200) return reply.code(404).send('Not found')
  try {
    const { db } = await import('./db/client.js')
    const { publicPublishes } = await import('./db/schema.js')
    const { and, eq, sql } = await import('drizzle-orm')
    const [row] = await db.select().from(publicPublishes)
      .where(and(eq(publicPublishes.slug, slug), sql`${publicPublishes.unpublishedAt} IS NULL`))
      .limit(1)
    if (!row) return reply.code(404).type('text/html').send('<h1>Not found</h1><p>This page does not exist or has been unpublished.</p>')
    // Increment view count (fire-and-forget)
    db.update(publicPublishes).set({ viewCount: sql`${publicPublishes.viewCount} + 1` }).where(eq(publicPublishes.id, row.id)).catch(() => null)
    const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(row.title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.6}h1{font-size:1.8rem;margin-bottom:0.5rem}pre{background:#f4f4f4;padding:0.8rem;border-radius:4px;overflow:auto}code{background:#f4f4f4;padding:0.1rem 0.3rem;border-radius:3px}hr{border:none;border-top:1px solid #e0e0e0;margin:2rem 0}footer{color:#888;font-size:0.85rem}</style></head><body><article><pre style="background:none;padding:0">${escape(row.body)}</pre></article><hr><footer>Published ${new Date(row.publishedAt).toISOString().slice(0, 10)} · ${row.viewCount + 1} views</footer></body></html>`
    return reply.type('text/html').send(html)
  } catch (e) {
    return reply.code(500).send(`Error: ${(e as Error).message}`)
  }
})
// R146.162 — Public lead-magnet landing page.
// URL: /m/:workspaceId/:slug  → renders magnet body + opt-in form.
// POST /m/:workspaceId/:slug → captures the email (idempotent dedupe).
app.get<{ Params: { workspaceId: string; slug: string } }>('/m/:workspaceId/:slug', async (req, reply) => {
  const { workspaceId, slug } = req.params
  if (!workspaceId || !slug || slug.length > 200) return reply.code(404).send('Not found')
  try {
    const { magnetGetBySlug } = await import('./services/r162-owned-audience.js')
    const m = await magnetGetBySlug(workspaceId, slug)
    if (!m) return reply.code(404).type('text/html').send('<h1>Not found</h1>')
    const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escape(m.title)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.55}h1{font-size:1.8rem;margin-bottom:0.5rem}pre{white-space:pre-wrap;font-family:inherit;background:none;padding:0}form{display:flex;flex-direction:column;gap:0.5rem;margin-top:1.5rem;padding:1rem;border:1px solid #e0e0e0;border-radius:6px}input{padding:0.6rem;border:1px solid #ccc;border-radius:4px;font-size:1rem}button{padding:0.7rem;background:#1a1a1a;color:white;border:none;border-radius:4px;font-size:1rem;cursor:pointer}button:hover{background:#000}.msg{color:#0a7;margin-top:0.5rem}</style></head><body><article><h1>${escape(m.title)}</h1><pre>${escape(m.body)}</pre></article><form method="POST" action=""><label>Email to get this</label><input type="email" name="email" required placeholder="you@example.com"><input type="text" name="name" placeholder="Name (optional)"><button type="submit">Send it</button></form></body></html>`
    return reply.type('text/html').send(html)
  } catch (e) {
    return reply.code(500).send(`Error: ${(e as Error).message}`)
  }
})

app.post<{ Params: { workspaceId: string; slug: string }; Body: { email?: string; name?: string } }>('/m/:workspaceId/:slug', async (req, reply) => {
  const { workspaceId, slug } = req.params
  const body = (req.body ?? {}) as { email?: string; name?: string }
  if (!body.email) return reply.code(400).type('text/html').send('<p>Email required. <a href="">Back</a></p>')
  try {
    const { magnetGetBySlug, captureCreate } = await import('./services/r162-owned-audience.js')
    const m = await magnetGetBySlug(workspaceId, slug)
    if (!m) return reply.code(404).send('Not found')
    await captureCreate(workspaceId, { email: body.email, ...(body.name ? { name: body.name } : {}), magnetId: m.id, source: 'page', sourceRef: slug })
    const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return reply.type('text/html').send(`<!doctype html><html><body style="font-family:system-ui;max-width:560px;margin:3rem auto;padding:0 1rem;text-align:center"><h1>Check your email</h1><p>Sent to <strong>${escape(body.email)}</strong>. (If you don't see it, check spam.)</p></body></html>`)
  } catch (e) {
    return reply.code(500).send(`Error: ${(e as Error).message}`)
  }
})

// R146.164 — Public funnel tracking endpoint.
// POST /t/:workspaceId  body: { sessionId, kind, source?, ... }
// Cheap, CORS-open, ingests view/click/signup/purchase events from any page.
app.post<{ Params: { workspaceId: string }; Body: Record<string, unknown> }>('/t/:workspaceId', async (req, reply) => {
  reply.header('access-control-allow-origin', '*')
  reply.header('access-control-allow-headers', 'content-type')
  const ws = req.params.workspaceId
  const body = (req.body ?? {}) as Record<string, unknown>
  if (!body['sessionId'] || !body['kind']) return reply.code(400).send({ error: 'sessionId + kind required' })
  if (typeof body['kind'] !== 'string' || !['view', 'click', 'signup', 'purchase', 'custom'].includes(body['kind'])) {
    return reply.code(400).send({ error: 'invalid kind' })
  }
  try {
    const { eventTrack } = await import('./services/r164-funnel-cro.js')
    const r = await eventTrack(ws, body as unknown as Parameters<typeof eventTrack>[1])
    return reply.send({ ok: true, id: r.id })
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message })
  }
})
app.options<{ Params: { workspaceId: string } }>('/t/:workspaceId', async (_req, reply) => {
  reply.header('access-control-allow-origin', '*')
  reply.header('access-control-allow-headers', 'content-type')
  reply.header('access-control-allow-methods', 'POST, OPTIONS')
  return reply.code(204).send()
})

// R146.172 — Mixcraft bundle download endpoints.
//   GET /mixcraft/:workspaceId/:bundleId/manifest.json — Mixcraft import spec
//   GET /mixcraft/:workspaceId/:bundleId/import.ps1    — PowerShell driver
//   GET /mixcraft/:workspaceId/controller.js           — MIDI controller script
app.get<{ Params: { workspaceId: string; bundleId: string } }>('/mixcraft/:workspaceId/:bundleId/manifest.json', async (req, reply) => {
  const { workspaceId, bundleId } = req.params
  try {
    const { manifestFor } = await import('./services/r172-mixcraft-adapter.js')
    const m = await manifestFor(workspaceId, bundleId)
    if (!m) return reply.code(404).send({ error: 'bundle not found' })
    return reply.type('application/json').send(m)
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message })
  }
})

app.get<{ Params: { workspaceId: string; bundleId: string } }>('/mixcraft/:workspaceId/:bundleId/import.ps1', async (req, reply) => {
  const { workspaceId, bundleId } = req.params
  try {
    const { manifestFor, importScriptPs1 } = await import('./services/r172-mixcraft-adapter.js')
    const m = await manifestFor(workspaceId, bundleId)
    if (!m) return reply.code(404).type('text/plain').send('# bundle not found')
    const script = importScriptPs1(m)
    return reply.type('text/plain; charset=utf-8').header('content-disposition', `attachment; filename="novan-mixcraft-${bundleId.slice(0, 8)}.ps1"`).send(script)
  } catch (e) {
    return reply.code(500).type('text/plain').send(`# error: ${(e as Error).message}`)
  }
})

app.get<{ Params: { workspaceId: string } }>('/mixcraft/:workspaceId/controller.js', async (_req, reply) => {
  try {
    const { controllerScriptJs } = await import('./services/r172-mixcraft-adapter.js')
    return reply.type('text/javascript; charset=utf-8').header('content-disposition', 'attachment; filename="novan-mixcraft-controller.js"').send(controllerScriptJs())
  } catch (e) {
    return reply.code(500).type('text/plain').send(`// error: ${(e as Error).message}`)
  }
})

// R146.174 — CapCut bundle endpoints.
app.get<{ Params: { workspaceId: string; projectId: string } }>('/capcut/:workspaceId/:projectId/draft_content.json', async (req, reply) => {
  const { workspaceId, projectId } = req.params
  try {
    const { draftContentJson } = await import('./services/r174-capcut-adapter.js')
    const j = await draftContentJson(workspaceId, projectId)
    if (!j) return reply.code(404).send({ error: 'project not found' })
    return reply.type('application/json').send(j)
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message })
  }
})
app.get<{ Params: { workspaceId: string; projectId: string } }>('/capcut/:workspaceId/:projectId/import.ps1', async (req, reply) => {
  const { workspaceId, projectId } = req.params
  try {
    const { projectGet, importScriptPs1 } = await import('./services/r174-capcut-adapter.js')
    const r = await projectGet(workspaceId, projectId)
    if (!r) return reply.code(404).type('text/plain').send('# project not found')
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http'
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost'
    const baseUrl = `${proto}://${host}/capcut/${workspaceId}/${projectId}`
    const script = importScriptPs1(projectId, r.project.name, baseUrl)
    return reply.type('text/plain; charset=utf-8').header('content-disposition', `attachment; filename="novan-capcut-${projectId.slice(0, 8)}.ps1"`).send(script)
  } catch (e) {
    return reply.code(500).type('text/plain').send(`# error: ${(e as Error).message}`)
  }
})

// R146.179 — POD social-traffic short-URL redirect.
// GET /r/:short → look up route, increment click counter, redirect to UTM-stitched store URL.
app.get<{ Params: { short: string } }>('/r/:short', async (req, reply) => {
  const short = req.params.short
  if (!short || short.length > 20) return reply.code(404).send('Not found')
  try {
    const { routeResolve, routeRecordClick } = await import('./services/r179-pod-social.js')
    const r = await routeResolve(short)
    if (!r) return reply.code(404).send('Not found')
    routeRecordClick(r.routeId).catch(() => null)
    return reply.redirect(r.destination, 302)
  } catch (e) {
    return reply.code(500).send(`Error: ${(e as Error).message}`)
  }
})

// R146.184 — Biometric webhook ingestion. POST /bio/:workspaceId/:source
// body: { kind, value, unit?, recordedAt?, userId? } | array of same.
app.post<{ Params: { workspaceId: string; source: string }; Body: unknown }>('/bio/:workspaceId/:source', async (req, reply) => {
  reply.header('access-control-allow-origin', '*')
  const { workspaceId, source } = req.params
  try {
    const { bioIngest } = await import('./services/r184-physical-bridges.js')
    const body = req.body as { kind?: string; value?: unknown; unit?: string; recordedAt?: number; userId?: string } | Array<{ kind?: string; value?: unknown; unit?: string; recordedAt?: number; userId?: string }>
    const arr = Array.isArray(body) ? body : [body]
    const valid = arr.filter(e => e && typeof e.kind === 'string').map(e => ({
      source: source as 'apple_health' | 'garmin' | 'fitbit' | 'whoop' | 'oura' | 'manual',
      kind: e.kind as 'steps' | 'heart_rate' | 'hrv' | 'sleep' | 'workout' | 'stress' | 'spo2' | 'temp' | 'weight' | 'calories' | 'distance',
      value: (e.value ?? {}) as Record<string, unknown>,
      ...(e.unit ? { unit: e.unit } : {}),
      ...(e.recordedAt ? { recordedAt: e.recordedAt } : {}),
      ...(e.userId ? { userId: e.userId } : {}),
    }))
    const r = await bioIngest(workspaceId, valid)
    return reply.send(r)
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message })
  }
})

// R146.185 — XR scene viewer. GET /xr/:workspaceId/:sceneName → A-Frame HTML.
app.get<{ Params: { workspaceId: string; sceneName: string } }>('/xr/:workspaceId/:sceneName', async (req, reply) => {
  const { workspaceId, sceneName } = req.params
  try {
    const { xrSceneGet, xrAutoDashboard, renderXrHtml } = await import('./services/r185-tier-b.js')
    let scene = await xrSceneGet(workspaceId, sceneName)
    if (!scene && sceneName === 'dashboard') scene = await xrAutoDashboard(workspaceId)
    if (!scene) return reply.code(404).type('text/html').send('<h1>Scene not found</h1>')
    return reply.type('text/html').send(renderXrHtml(scene))
  } catch (e) {
    return reply.code(500).send(`Error: ${(e as Error).message}`)
  }
})

// R146.187 — Localhost-only admin bridge for SSH-shell collaboration.
// Auth: requires X-Admin-Token header == env ADMIN_LOOPBACK_TOKEN
// AND remoteAddress in {127.0.0.1, ::1, 172.x.0.1 (docker)}.
// Lets the operator (or me via SSH) invoke any registered brain op
// without a full JWT. Disabled if ADMIN_LOOPBACK_TOKEN is unset.
// R146.190 — in-process rate limit (30 req/min) + audit log every call.
const _adminBrainRate: { ts: number; count: number } = { ts: Date.now(), count: 0 }
app.post<{ Body: { op?: string; workspaceId?: string; params?: Record<string, unknown> } }>('/admin/brain', async (req, reply) => {
  const token = process.env['ADMIN_LOOPBACK_TOKEN']
  if (!token) return reply.code(404).send({ error: 'admin bridge disabled' })
  const remote = req.ip ?? req.socket?.remoteAddress ?? ''
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || /^172\.\d+\.0\.1$/.test(remote)
  if (!isLoopback) return reply.code(403).send({ error: 'loopback only' })
  // R146.314 — constant-time compare to defeat byte-by-byte timing oracle.
  // Even though endpoint is loopback-only, an attacker on the docker bridge
  // (e.g. compromised sidecar) could still measure timing.
  const given = String(req.headers['x-admin-token'] ?? '')
  const a = Buffer.from(given), b = Buffer.from(token)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: 'bad token' })

  // Rate limit: 30 calls per rolling minute.
  const now = Date.now()
  if (now - _adminBrainRate.ts > 60_000) { _adminBrainRate.ts = now; _adminBrainRate.count = 0 }
  _adminBrainRate.count += 1
  if (_adminBrainRate.count > 30) return reply.code(429).send({ error: 'admin bridge rate limit (30/min)' })

  const body = req.body ?? {}
  if (!body.op || !body.workspaceId) return reply.code(400).send({ error: 'op + workspaceId required' })
  try {
    const { OPERATIONS } = await import('./services/brain-task.js')
    const spec = (OPERATIONS as Record<string, { handler: (ws: string, params: Record<string, unknown>) => Promise<unknown>; risk?: string }>)[body.op]
    if (!spec) return reply.code(404).send({ error: `unknown op: ${body.op}` })

    // Audit log: persist to events table before execution.
    try {
      const { db } = await import('./db/client.js')
      const { events } = await import('./db/schema.js')
      const { v7: uuidv7 } = await import('uuid')
      await db.insert(events).values({
        id: uuidv7(),
        workspaceId: body.workspaceId,
        type: 'admin_brain.invoked',
        payload: { op: body.op, risk: spec.risk ?? 'low', remote, paramsKeys: Object.keys(body.params ?? {}) },
        traceId: req.id ?? 'admin', correlationId: req.id ?? 'admin', source: 'admin-bridge',
        createdAt: Date.now(),
      }).catch(() => null)
    } catch { /* audit is best-effort */ }

    const result = await spec.handler(body.workspaceId, body.params ?? {})
    return reply.send({ ok: true, op: body.op, result })
  } catch (e) {
    return reply.code(500).send({ ok: false, error: (e as Error).message.slice(0, 500) })
  }
})

app.get('/admin/brain/ops', async (req, reply) => {
  const token = process.env['ADMIN_LOOPBACK_TOKEN']
  if (!token) return reply.code(404).send({ error: 'admin bridge disabled' })
  const remote = req.ip ?? req.socket?.remoteAddress ?? ''
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || /^172\.\d+\.0\.1$/.test(remote)
  if (!isLoopback) return reply.code(403).send({ error: 'loopback only' })
  // R146.314 — constant-time compare to defeat byte-by-byte timing oracle.
  // Even though endpoint is loopback-only, an attacker on the docker bridge
  // (e.g. compromised sidecar) could still measure timing.
  const given = String(req.headers['x-admin-token'] ?? '')
  const a = Buffer.from(given), b = Buffer.from(token)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: 'bad token' })
  const { OPERATIONS } = await import('./services/brain-task.js')
  const ops = Object.entries(OPERATIONS).map(([name, spec]: [string, unknown]) => ({
    name, description: (spec as { description?: string }).description ?? '', risk: (spec as { risk?: string }).risk ?? 'low',
  }))
  return reply.send({ count: ops.length, ops })
})

// R146.194 — Novan Console (single-page operator UI).
app.get('/console.html', async (_req, reply) => {
  const { novanConsoleHtml } = await import('./routes/novan-console.js')
  return reply.type('text/html').send(novanConsoleHtml())
})
app.get('/console', async (_req, reply) => reply.redirect('/console.html', 302))

// R146.215 — Novan Brain agentic chat UI.
app.get('/brain.html', async (_req, reply) => {
  const { novanBrainChatHtml } = await import('./routes/novan-brain-chat.js')
  return reply.type('text/html').send(novanBrainChatHtml())
})
app.get('/brain', async (_req, reply) => reply.redirect('/brain.html', 302))

// R146.191 — Cron health endpoint. Returns the catalogue of cron families
// observed in the last 48h with last-fire timestamp + count. Useful for
// confirming that every scheduled job is alive.
app.get('/healthz/cron', async (_req, reply) => {
  try {
    const { db } = await import('./db/client.js')
    const { sql } = await import('drizzle-orm')
    const since = Date.now() - 48 * 60 * 60_000
    const rows = await db.execute(sql`
      SELECT type, count(*)::int AS count, max(created_at)::bigint AS last_at
      FROM events
      WHERE type LIKE 'cron.%' AND created_at >= ${since}
      GROUP BY type
      ORDER BY type
    `)
    const list = (rows as unknown as { rows?: Array<{ type: string; count: number; last_at: number }> }).rows
      ?? (rows as unknown as Array<{ type: string; count: number; last_at: number }>)
    const now = Date.now()
    return reply.send({
      ok: true,
      windowHours: 48,
      jobs: (Array.isArray(list) ? list : []).map(j => ({
        type: j.type,
        count: Number(j.count),
        lastAt: Number(j.last_at),
        lastAgoSec: Math.round((now - Number(j.last_at)) / 1000),
      })),
    })
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message })
  }
})

// /metrics is registered by metricsRoutes plugin (queue depths + R119 registry).
await app.register(workflowRoutes, { prefix: '/api/v1/workflows' })
await app.register(maintenanceRoutes, { prefix: '/api/v1' })
await app.register(pushRoutes,        { prefix: '/api/v1/push' })
await app.register(r328PublicRoutes,  { prefix: '/api/v1' })
await app.register(r329BrainOpRoutes, { prefix: '/api/v1' })
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
await registerGumroadWebhook(app)        // R389 — public, token-gated POST /api/v1/webhooks/gumroad/sale

// R503 — CSV export of business_revenue for accountant / Schedule C
app.get<{ Querystring: { token?: string; workspace?: string; since?: string; until?: string } }>('/ops/export/revenue.csv', async (req, reply) => {
  const ops = process.env['NOVAN_OPS_TOKEN'] ?? process.env['OPERATOR_TOKEN'] ?? ''
  if (!req.query.token || (ops && req.query.token !== ops)) return reply.code(401).type('text/plain').send('unauthorized')
  const ws = req.query.workspace ?? 'default'
  const opts: { sinceMs?: number; untilMs?: number } = {}
  if (req.query.since) opts.sinceMs = Date.parse(req.query.since)
  if (req.query.until) opts.untilMs = Date.parse(req.query.until)
  const { exportRevenueCsv } = await import('./services/r503-csv-export.js')
  const csv = await exportRevenueCsv(ws, opts)
  return reply
    .type('text/csv')
    .header('Content-Disposition', `attachment; filename="novan-revenue-${ws}-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(csv)
})

// R515 — GDPR / CCPA buyer-email deletion endpoint.
app.post<{ Querystring: { token?: string; workspace?: string }; Body: { email?: string } }>('/ops/gdpr/delete', async (req, reply) => {
  const ops = process.env['NOVAN_OPS_TOKEN'] ?? process.env['OPERATOR_TOKEN'] ?? ''
  if (!req.query.token || (ops && req.query.token !== ops)) return reply.code(401).send({ error: 'unauthorized' })
  const ws = req.query.workspace ?? 'default'
  const email = String(req.body?.email ?? '').trim()
  if (!email) return reply.code(400).send({ error: 'email required in body' })
  const { gdprDeleteEmail } = await import('./services/r515-gdpr-delete.js')
  return reply.send(await gdprDeleteEmail(ws, email))
})

// R516 — DMCA takedown drafter.
app.post<{ Querystring: { token?: string; workspace?: string }; Body: { offendingUrl?: string; platform?: string; originalDesignId?: string } }>('/ops/dmca/file', async (req, reply) => {
  const ops = process.env['NOVAN_OPS_TOKEN'] ?? process.env['OPERATOR_TOKEN'] ?? ''
  if (!req.query.token || (ops && req.query.token !== ops)) return reply.code(401).send({ error: 'unauthorized' })
  const ws = req.query.workspace ?? 'default'
  const url = String(req.body?.offendingUrl ?? '').trim()
  if (!url) return reply.code(400).send({ error: 'offendingUrl required in body' })
  const { fileDmcaClaim } = await import('./services/r516-dmca.js')
  const r = await fileDmcaClaim({
    workspaceId: ws, offendingUrl: url,
    platform: req.body?.platform, originalDesignId: req.body?.originalDesignId,
  })
  return reply.send(r)
})

// R438 — design file store. POST uploads a file body for a design id; GET serves it.
// R448 — token + design_id + workspace_id come from HEADERS instead of query
// so they don't leak via Referer. Body is the raw image bytes.
app.post<{ Body: Buffer }>('/api/v1/designs/upload', { bodyLimit: 30 * 1024 * 1024 }, async (req, reply) => {
  const ops = process.env['NOVAN_OPS_TOKEN'] ?? process.env['OPERATOR_TOKEN'] ?? ''
  const token = String(req.headers['x-novan-token'] ?? '')
  if (!token || (ops && token !== ops)) return reply.code(401).send({ error: 'unauthorized' })
  // R479 — friendlier message than fastify's default 415.
  const ct = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!/^image\/(png|jpe?g|webp)(;|$)/i.test(ct)) {
    return reply.code(415).send({ error: 'Content-Type must be image/png, image/jpeg, or image/webp' })
  }
  const ws = String(req.headers['x-novan-workspace'] ?? 'default')
  const designId = String(req.headers['x-novan-design-id'] ?? '').trim()
  if (!designId) return reply.code(400).send({ error: 'X-Novan-Design-Id header required' })
  const mime = String(req.headers['content-type'] ?? 'application/octet-stream')
  const filename = String(req.headers['x-novan-filename'] ?? 'design.bin')
  const expectSha = String(req.headers['x-novan-sha256'] ?? '').toLowerCase()
  const { storeDesignFile } = await import('./services/r438-design-file-store.js')
  const buf = req.body as Buffer
  // R487 — verify expected sha256 if operator supplied it
  if (expectSha) {
    const crypto = await import('node:crypto')
    const actual = crypto.createHash('sha256').update(buf).digest('hex')
    if (actual !== expectSha) return reply.code(400).send({ error: 'sha256 mismatch', expected: expectSha, actual })
  }
  const r = await storeDesignFile({ workspaceId: ws, designId, filename, mime, bytes: buf })
  return reply.code(r.ok ? 200 : 400).send(r)
})
app.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/api/v1/designs/:id/file', async (req, reply) => {
  const ws = req.query.workspace_id ?? 'default'
  const { readDesignFile } = await import('./services/r438-design-file-store.js')
  const f = await readDesignFile(ws, req.params.id)
  if (!f) return reply.code(404).send({ error: 'not found' })
  try {
    const stream = (await import('node:fs')).createReadStream(f.path)
    // R474 — design files are immutable per design_id (we overwrite on
    // upload but the URL changes only if the operator re-uploads). Browser+
    // dashboard can safely cache for 1h.
    reply.type(f.mime)
      .header('Content-Disposition', `inline; filename="${f.filename}"`)
      .header('Cache-Control', 'public, max-age=3600')
    return reply.send(stream)
  } catch (e) {
    return reply.code(500).send({ error: (e as Error).message })
  }
})
// R466 — delete a stored design file
app.delete<{ Params: { id: string } }>('/api/v1/designs/:id/file', async (req, reply) => {
  const ops = process.env['NOVAN_OPS_TOKEN'] ?? process.env['OPERATOR_TOKEN'] ?? ''
  const token = String(req.headers['x-novan-token'] ?? '')
  if (!token || (ops && token !== ops)) return reply.code(401).send({ error: 'unauthorized' })
  const ws = String(req.headers['x-novan-workspace'] ?? 'default')
  const { deleteDesignFile } = await import('./services/r438-design-file-store.js')
  const r = await deleteDesignFile(ws, req.params.id)
  return reply.code(r.ok ? 200 : 400).send(r)
})

// Add raw octet-stream content type parser for the upload route
if (!app.hasContentTypeParser('application/octet-stream')) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
}
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp']
for (const m of IMAGE_MIMES) {
  if (!app.hasContentTypeParser(m)) {
    app.addContentTypeParser(m, { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
  }
}

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
await app.register(freeVoiceRoutes,         { prefix: '/api/v1/free-voice' })
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

// R146.108 — Frontier intel startup key check: warn if no embedding /
// distill provider is configured, otherwise the loop silently no-ops.
;(() => {
  const hasEmbed   = Boolean(process.env['OLLAMA_URL'] || process.env['OPENAI_API_KEY'] || process.env['GEMINI_API_KEY'])
  const hasDistill = Boolean(process.env['GROQ_API_KEY'] || process.env['GEMINI_API_KEY'] || process.env['ANTHROPIC_API_KEY'])
  if (!hasEmbed)   app.log.warn('[frontier-intel] NO embedding provider — findings will not get embeddings. Set OLLAMA_URL or OPENAI_API_KEY or GEMINI_API_KEY.')
  if (!hasDistill) app.log.warn('[frontier-intel] NO LLM provider for distillation/advancement — frontier loop will scan but not distill. Set GROQ_API_KEY (free tier) or GEMINI_API_KEY or ANTHROPIC_API_KEY.')
  if (!process.env['HF_API_TOKEN']) app.log.warn('[video-free-realistic] HF_API_TOKEN not set — free realistic video will only produce stills (no SVD img2vid). Set HF_API_TOKEN (free signup).')
})()

// R146.108 — serve generated media files (free realistic video output).
// Path-traversal guarded; only allows files matching the safe-name pattern.
{
  const mediaRoot = process.env['MEDIA_LOCAL_DIR'] ?? '/data/media'
  const mediaPrefix = (process.env['MEDIA_PUBLIC_BASE'] ?? '/media').replace(/\/$/, '')
  app.get(`${mediaPrefix}/:filename`, async (req, reply) => {
    const fname = (req.params as { filename: string }).filename
    // Strict allow-list: only video files we wrote, no traversal.
    if (!/^[a-z0-9-]+\.(mp4|webm)$/i.test(fname)) return reply.code(404).send()
    const full = `${mediaRoot}/${fname}`
    try {
      const fs = await import('node:fs/promises')
      const buf = await fs.readFile(full)
      const ext = fname.endsWith('.webm') ? 'video/webm' : 'video/mp4'
      return reply.type(ext).header('cache-control', 'public, max-age=31536000, immutable').send(buf)
    } catch { return reply.code(404).send() }
  })
}

// Start the closed learning loop: periodic incident/improvement/suspicious scans + sweeps
startLearningCron()
// R146.123 — Ensure the War Room agent roster is seeded for the system
// workspace on first boot. Idempotent: r115 agentSeedDefaults checks
// existing rows by shortName before inserting.
void (async () => {
  try {
    const { agentSeedDefaults } = await import('./services/r115-build-batch.js')
    await agentSeedDefaults('system')
  } catch (e) { app.log.warn({ err: (e as Error).message }, '[boot] agent seed failed (non-fatal)') }
})()
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
  // R146.281 — close the pg pool last (after every other component has
  // stopped issuing queries). 5s grace lets any LISTEN connection or
  // in-flight cron query exit cleanly instead of cutting mid-stream.
  try {
    const { closeDb } = await import('./db/client.js')
    await closeDb(5)
  } catch { /* */ }
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
  // R146.325 (#20) — startup mode banner. Makes auth misconfiguration
  // obvious in logs instead of silently shipping dev-mode auto-auth to prod.
  const authMode = process.env['ENFORCE_GLOBAL_AUTH'] === 'true'
    ? 'enforced'
    : 'DEV-OPEN — DO NOT RUN IN PROD'
  app.log.info({ port: PORT, host: HOST, docs: `http://${HOST}:${PORT}/docs`, authMode }, 'API server started')
  if (authMode !== 'enforced' && process.env['NODE_ENV'] === 'production') {
    app.log.error({ authMode }, '[boot] AUTH IS OPEN IN PRODUCTION — set ENFORCE_GLOBAL_AUTH=true')
  }
} catch (err) {
  app.log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'Failed to start server')
  process.exit(1)
}
