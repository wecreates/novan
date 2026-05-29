/**
 * intel-ops routes — /api/v1/intel-ops/*
 *
 * Mounted at /api/v1/intel-ops. Surface the four operational
 * intelligence primitives shipped under migration 0034:
 *
 *   GET  /load                  current cognitive load + snapshot
 *   POST /load/snapshot         force a new snapshot
 *   POST /self-heal/scan        run the recovery scanner
 *   GET  /self-heal/actions     recent recovery actions
 *   POST /anomalies/scan        re-score behavioral anomalies
 *   GET  /anomalies             recent anomaly signals
 *   POST /anomalies/:id/ack     mark an anomaly acknowledged
 *   GET  /why-chain             build a why-chain around an anchor
 */
import type { FastifyPluginAsync } from 'fastify'
import { snapshotOperatorLoad } from '../services/operator-cognitive-load.js'
import { scanAndHeal, listSelfHealActions } from '../services/self-healing.js'
import { scanAnomalies, listAnomalies, ackAnomaly } from '../services/anomaly-detection.js'
import { buildWhyChain } from '../services/voice-why-chain.js'
import { inspectWorkspace, exportWorkspace, deleteWorkspaceData, exportOrg, type GovernanceScope } from '../services/data-governance.js'
import { forecastEventVolume, forecastBreachTime, bucketize } from '../services/predictive-forecast.js'
import { snapshotConcurrency, setProviderCap, getProviderCap, getProviderInflight } from '../services/provider-concurrency.js'
import { runMemoryHygiene } from '../services/memory-hygiene.js'
import { rollupProviderTrust, detectDegradation } from '../services/model-governance.js'
import { summarizeRecentActivity } from '../services/narrative-intelligence.js'
import { scanRepoFiles, analyzeRoutes, analyzeUi, type RouteSignal } from '../services/simplicity-engine.js'
import { observeSelf } from '../services/self-observation.js'
import { analyzeWorkspaceRhythm } from '../services/time-aware-intelligence.js'
import { runFailoverHealthCheck, getLastFailoverState } from '../services/db-failover.js'
import { validateManifest, checkPermission, listSupportedPermissions, type PluginManifest, type PluginPermission } from '../services/plugin-sandbox.js'
import path from 'node:path'
import { db as _db } from '../db/client.js'
import { events as _events } from '../db/schema.js'
import { and as _and, eq as _eq, gte as _gte } from 'drizzle-orm'
import { currentReleaseHealth, scoreReleaseHealth } from '../services/release-health.js'
import { shouldNotifyOperator, shouldAutoAct, type Severity, type LoadMode } from '../services/strategic-restraint.js'

const intelOpsRoutes: FastifyPluginAsync = async (fastify) => {
  // ─── Cognitive load ───────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; window_min?: string; user_id?: string } }>('/load', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_min ? Number(req.query.window_min) * 60_000 : 30 * 60_000
    return { success: true, data: await snapshotOperatorLoad(ws, { windowMs, ...(req.query.user_id ? { userId: req.query.user_id } : {}) }) }
  })
  fastify.post<{ Body: { workspace_id?: string; window_min?: number; user_id?: string } }>('/load/snapshot', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await snapshotOperatorLoad(ws, {
      windowMs: req.body.window_min ? req.body.window_min * 60_000 : 30 * 60_000,
      ...(req.body.user_id ? { userId: req.body.user_id } : {}),
    }) }
  })

  // ─── Self-healing scanner ─────────────────────────────────────────
  fastify.post('/self-heal/scan', async () => {
    return { success: true, data: await scanAndHeal() }
  })
  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/self-heal/actions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listSelfHealActions(ws, req.query.limit ? Number(req.query.limit) : 50) }
  })

  // ─── Anomaly detection ────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; window_min?: number } }>('/anomalies/scan', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await scanAnomalies(ws, { windowMs: req.body.window_min ? req.body.window_min * 60_000 : 15 * 60_000 }) }
  })
  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/anomalies', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listAnomalies(ws, req.query.limit ? Number(req.query.limit) : 50) }
  })
  fastify.post<{ Params: { id: string }, Body: { workspace_id?: string } }>('/anomalies/:id/ack', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await ackAnomaly(req.params.id, ws)
    return { success: true }
  })

  // ─── Why-chain ─────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; root_event_id?: string; anchor_at?: string; window_min?: string } }>('/why-chain', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const chain = await buildWhyChain({
      workspaceId: ws,
      ...(req.query.root_event_id ? { rootEventId: req.query.root_event_id } : {}),
      ...(req.query.anchor_at ? { anchorAt: Number(req.query.anchor_at) } : {}),
      ...(req.query.window_min ? { windowMs: Number(req.query.window_min) * 60_000 } : {}),
    })
    if (!chain) return reply.code(404).send({ success: false, error: 'anchor not found' })
    return { success: true, data: chain }
  })

  // ─── Data governance (#32) ─────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/data/inspect', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await inspectWorkspace(ws) }
  })

  fastify.post<{ Body: { workspace_id?: string; scopes?: GovernanceScope[] } }>('/data/export', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await exportWorkspace(ws, req.body.scopes) }
  })

  fastify.post<{ Body: { workspace_id?: string; scopes?: GovernanceScope[]; confirm?: boolean; reason?: string; actor?: string } }>('/data/delete', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const r = await deleteWorkspaceData({
      workspaceId: ws,
      ...(req.body.scopes ? { scopes: req.body.scopes } : {}),
      confirm: !!req.body.confirm,
      reason:  req.body.reason ?? '',
      ...(req.body.actor ? { actor: req.body.actor } : {}),
    })
    if (!r.ok) return reply.code(400).send({ success: false, error: r.reason ?? 'refused' })
    return { success: true, data: r }
  })

  // ─── Release health (#31) ──────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; window_hours?: string } }>('/release/health', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_hours ? Number(req.query.window_hours) * 60 * 60_000 : 24 * 60 * 60_000
    return { success: true, data: await currentReleaseHealth(ws, { windowMs }) }
  })
  fastify.post<{ Body: Parameters<typeof scoreReleaseHealth>[0] }>('/release/score', async (req) => {
    return { success: true, data: scoreReleaseHealth(req.body) }
  })

  // ─── Strategic restraint (#42) ─────────────────────────────────────
  fastify.post<{ Body: { severity?: Severity; loadScore?: number; loadMode?: LoadMode; recentNotifications?: number; msSinceLastAck?: number; duplicateSignature?: boolean } }>('/restraint/should-notify', async (req, reply) => {
    const b = req.body
    if (!b.severity || !b.loadMode || typeof b.loadScore !== 'number')
      return reply.code(400).send({ success: false, error: 'severity, loadMode, loadScore required' })
    return { success: true, data: shouldNotifyOperator(b.severity, {
      loadScore: b.loadScore,
      loadMode: b.loadMode,
      recentNotifications: b.recentNotifications ?? 0,
      msSinceLastAck:      b.msSinceLastAck ?? 0,
      duplicateSignature:  !!b.duplicateSignature,
    }) }
  })
  fastify.post<{ Body: Parameters<typeof shouldAutoAct>[0] }>('/restraint/should-act', async (req) => {
    return { success: true, data: shouldAutoAct(req.body) }
  })

  // ─── Org-wide compliance export ───────────────────────────────────
  fastify.post<{ Body: { workspace_ids?: string[]; scopes?: GovernanceScope[]; actor?: string; reason?: string } }>('/data/export-org', async (req, reply) => {
    const b = req.body
    if (!Array.isArray(b.workspace_ids) || b.workspace_ids.length === 0)
      return reply.code(400).send({ success: false, error: 'workspace_ids non-empty array required' })
    const r = await exportOrg({
      workspaceIds: b.workspace_ids,
      ...(b.scopes ? { scopes: b.scopes } : {}),
      actor:        b.actor ?? '',
      reason:       b.reason ?? '',
    })
    if (!r.ok) return reply.code(400).send({ success: false, error: r.reason })
    return { success: true, data: r.bundle }
  })

  // ─── Predictive forecasting ───────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; window_min?: string; horizon_min?: string; buckets?: string } }>('/forecast/event-volume', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs  = req.query.window_min  ? Number(req.query.window_min) * 60_000  : 60 * 60_000
    const horizonMs = req.query.horizon_min ? Number(req.query.horizon_min) * 60_000 : 30 * 60_000
    const bucketN   = req.query.buckets ? Math.min(60, Math.max(4, Number(req.query.buckets))) : 20
    const end = Date.now(), start = end - windowMs
    const rows = await _db.select({ createdAt: _events.createdAt }).from(_events)
      .where(_and(_eq(_events.workspaceId, ws), _gte(_events.createdAt, start)))
      .limit(20_000).catch(() => [])
    const buckets = bucketize(rows.map(r => r.createdAt), start, end, bucketN)
    return { success: true, data: { buckets, forecast: forecastEventVolume(buckets, horizonMs) } }
  })

  fastify.post<{ Body: { buckets?: Array<{ t: number; value: number }>; threshold?: number } }>('/forecast/breach', async (req, reply) => {
    const b = req.body
    if (!Array.isArray(b.buckets) || typeof b.threshold !== 'number')
      return reply.code(400).send({ success: false, error: 'buckets[] and threshold required' })
    return { success: true, data: forecastBreachTime(b.buckets, b.threshold) }
  })

  // ─── Provider concurrency caps ────────────────────────────────────
  fastify.get('/concurrency', async () => {
    return { success: true, data: snapshotConcurrency() }
  })
  // ─── Plugin sandbox (#3 Tier 1) ───────────────────────────────────
  fastify.get('/plugins/permissions', async () => {
    return { success: true, data: listSupportedPermissions() }
  })
  fastify.post<{ Body: { manifest?: unknown } }>('/plugins/validate', async (req, reply) => {
    const r = validateManifest(req.body.manifest)
    if (!r.ok) return reply.code(400).send({ success: false, error: r.reason })
    return { success: true, data: r.manifest }
  })
  fastify.post<{ Body: { manifest?: PluginManifest; action?: PluginPermission; host?: string } }>('/plugins/check-permission', async (req, reply) => {
    if (!req.body.manifest || !req.body.action) return reply.code(400).send({ success: false, error: 'manifest + action required' })
    return { success: true, data: checkPermission(req.body.manifest, { action: req.body.action, ...(req.body.host ? { host: req.body.host } : {}) }) }
  })

  // ─── DB failover health (multi-region readiness) ──────────────────
  fastify.get('/failover/health', async () => {
    return { success: true, data: await runFailoverHealthCheck() }
  })
  fastify.get('/failover/state', async () => {
    const last = getLastFailoverState()
    return { success: true, data: last ?? { recommendation: 'unknown', reason: 'no probe yet' } }
  })

  // ─── Time-aware intelligence (#59) ────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string; tz?: string } }>('/rhythm', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_days ? Number(req.query.window_days) * 86_400_000 : 28 * 86_400_000
    // Validate IANA tz against the runtime — fall back to UTC on garbage
    // input rather than crashing the route. Browsers + Node both support
    // Intl.supportedValuesOf('timeZone'); when unavailable, the
    // Intl.DateTimeFormat constructor will throw on a bad zone and the
    // service catches it (hourInZone falls back to UTC).
    const tz = (req.query.tz && req.query.tz.length < 64) ? req.query.tz : 'UTC'
    return { success: true, data: await analyzeWorkspaceRhythm(ws, { windowMs, tz }) }
  })

  // ─── Self-observation (#63) ───────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/self/observe', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_days ? Number(req.query.window_days) * 86_400_000 : 7 * 86_400_000
    return { success: true, data: await observeSelf(ws, { windowMs }) }
  })

  // ─── Simplicity engine (#56) ──────────────────────────────────────
  fastify.get<{ Querystring: { root?: string; limit?: string } }>('/simplicity/repo', async (req) => {
    // Default to the api app's src directory — operators can override
    // to scan a sibling package (e.g. apps/web/src).
    const root = req.query.root ?? path.join(process.cwd(), 'apps', 'api', 'src')
    const limit = req.query.limit ? Number(req.query.limit) : 10
    return { success: true, data: await scanRepoFiles(root, { limit }) }
  })
  fastify.post<{ Body: { routes?: RouteSignal[] } }>('/simplicity/routes', async (req, reply) => {
    if (!Array.isArray(req.body.routes)) return reply.code(400).send({ success: false, error: 'routes[] required' })
    return { success: true, data: analyzeRoutes(req.body.routes) }
  })
  fastify.post<{ Body: { pages?: number; palette_entries?: number; app_routes?: number; pages_never_visited?: string[] } }>('/simplicity/ui', async (req, reply) => {
    const b = req.body
    if (typeof b.pages !== 'number' || typeof b.palette_entries !== 'number' || typeof b.app_routes !== 'number')
      return reply.code(400).send({ success: false, error: 'pages, palette_entries, app_routes required' })
    return { success: true, data: analyzeUi({
      pages: b.pages, paletteEntries: b.palette_entries, appRoutes: b.app_routes,
      pagesNeverVisited: b.pages_never_visited ?? [],
    }) }
  })

  // ─── Narrative intelligence (#48) ─────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; window_min?: string; topic?: string } }>('/narrative/recent', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_min ? Number(req.query.window_min) * 60_000 : 60 * 60_000
    return { success: true, data: await summarizeRecentActivity(ws, { windowMs, ...(req.query.topic ? { typeFilter: req.query.topic } : {}) }) }
  })

  // ─── Model governance (#46) ───────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/models/trust', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_days ? Number(req.query.window_days) * 86_400_000 : 7 * 86_400_000
    return { success: true, data: await rollupProviderTrust(ws, { windowMs }) }
  })
  fastify.get<{ Querystring: { workspace_id?: string } }>('/models/degradation', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const now = await rollupProviderTrust(ws, { windowMs: 7 * 86_400_000 })
    const prior = await rollupProviderTrust(ws, { windowMs: 14 * 86_400_000 })
    return { success: true, data: detectDegradation(now, prior) }
  })

  // ─── Memory hygiene (#45) ─────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; apply?: boolean } }>('/memory/hygiene/scan', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await runMemoryHygiene(ws, { apply: !!req.body.apply }) }
  })

  fastify.post<{ Body: { provider?: string; cap?: number } }>('/concurrency/cap', async (req, reply) => {
    if (!req.body.provider || typeof req.body.cap !== 'number')
      return reply.code(400).send({ success: false, error: 'provider + cap required' })
    setProviderCap(req.body.provider, req.body.cap)
    return { success: true, data: { provider: req.body.provider, cap: getProviderCap(req.body.provider), inflight: getProviderInflight(req.body.provider) } }
  })
}

export default intelOpsRoutes
