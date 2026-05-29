/**
 * blueprint.ts — HTTP API for the round 116-118 features the operator UI
 * reads from. Five subtrees:
 *
 *   /cartographer/snapshot      → latest codebase map
 *   /knowledge/proposals        → curator-proposed patterns awaiting approval
 *   /knowledge/proposals/:id/{approve|reject}
 *   /evals                      → eval set CRUD + runs
 *   /policy/rules               → operator-editable policy rule CRUD
 *   /simulation/dry-run         → run a plan in dry-run mode
 *   /portfolios                 → holding-co tier CRUD
 *   /youtube/*                  → YouTube connector ops (auth-gated)
 */
import type { FastifyPluginAsync } from 'fastify'
import { db } from '../db/client.js'
import {
  evalSets, evalCases, evalRuns,
  policyRules, approvedPatterns, cartographerSnapshots,
  portfolios,
} from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const blueprintRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Cartographer snapshot ────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/cartographer/snapshot', async (req, reply) => {
    const ws = req.query.workspace_id ?? 'system'
    const rows = await db.select().from(cartographerSnapshots)
      .where(eq(cartographerSnapshots.workspaceId, ws))
      .orderBy(desc(cartographerSnapshots.generatedAt))
      .limit(1)
      .catch(() => [])
    if (rows.length === 0) return reply.code(404).send({ success: false, error: 'no snapshot yet — wait for next cartographer cron tick (24h) or call brain.task cartographer.snapshot manually' })
    return { success: true, data: rows[0]!.snapshot }
  })

  fastify.post<{ Body: { workspace_id?: string; root_path?: string } }>('/cartographer/snapshot', async (req, reply) => {
    const ws = req.body?.workspace_id ?? 'system'
    const { generateSnapshot } = await import('../services/codebase-cartographer.js')
    const snap = await generateSnapshot(req.body?.root_path).catch((e: Error) => ({ error: e.message }))
    if ('error' in snap) return reply.code(500).send({ success: false, error: snap.error })
    await db.insert(cartographerSnapshots).values({
      id:           uuidv7(),
      workspaceId:  ws,
      rootPath:     snap.rootPath,
      fileCount:    snap.fileCount,
      snapshot:     snap as unknown as Record<string, unknown>,
      generatedAt:  snap.generatedAt,
    }).catch(() => null)
    return { success: true, data: snap }
  })

  // ── Knowledge curator proposals ──────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; days?: string } }>('/knowledge/proposals', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { curate } = await import('../services/knowledge-curator.js')
    const proposals = await curate(ws, req.query.days ? { days: Number(req.query.days) } : undefined)
    return { success: true, data: proposals }
  })

  fastify.post<{ Body: { workspace_id?: string; pattern_id?: string; approved_by?: string; pattern_data?: Record<string, unknown> } }>('/knowledge/approve', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.workspace_id || !b.pattern_id) return reply.code(400).send({ success: false, error: 'workspace_id + pattern_id required' })
    // Persist into approved_patterns.
    const data = (b.pattern_data ?? {}) as {
      source?: string; title?: string; description?: string; appliesTo?: string[]; evidence?: unknown; confidence?: number
    }
    await db.insert(approvedPatterns).values({
      id:           b.pattern_id,
      workspaceId:  b.workspace_id,
      source:       data.source ?? 'manual',
      title:        data.title ?? '(untitled)',
      description:  data.description ?? '',
      appliesTo:    data.appliesTo ?? [],
      evidence:     (data.evidence ?? []) as unknown[],
      confidence:   data.confidence ?? 0.7,
      approvedBy:   b.approved_by ?? 'operator',
      approvedAt:   Date.now(),
      archived:     false,
    } as never).catch(() => null)
    const { approvePattern } = await import('../services/knowledge-curator.js')
    await approvePattern({ workspaceId: b.workspace_id, patternId: b.pattern_id, approvedBy: b.approved_by ?? 'operator', patternData: data as never })
    return { success: true }
  })

  fastify.post<{ Body: { workspace_id?: string; pattern_id?: string; reason?: string } }>('/knowledge/reject', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.workspace_id || !b.pattern_id) return reply.code(400).send({ success: false, error: 'workspace_id + pattern_id required' })
    const { rejectPattern } = await import('../services/knowledge-curator.js')
    await rejectPattern({ workspaceId: b.workspace_id, patternId: b.pattern_id, reason: b.reason ?? '' })
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/knowledge/approved', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await db.select().from(approvedPatterns)
      .where(and(eq(approvedPatterns.workspaceId, ws), eq(approvedPatterns.archived, false)))
      .orderBy(desc(approvedPatterns.approvedAt))
      .limit(200)
      .catch(() => [])
    return { success: true, data: rows }
  })

  // ── Eval sets + runs ─────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/evals/sets', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await db.select().from(evalSets)
      .where(and(eq(evalSets.workspaceId, ws), eq(evalSets.archived, false)))
      .orderBy(desc(evalSets.updatedAt))
      .catch(() => [])
    return { success: true, data: rows }
  })

  fastify.post<{ Body: { workspace_id?: string; name?: string; description?: string; target_subject?: string; baseline_pass_rate?: number; tags?: string[] } }>('/evals/sets', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.workspace_id || !b.name || !b.target_subject) {
      return reply.code(400).send({ success: false, error: 'workspace_id + name + target_subject required' })
    }
    const id = uuidv7()
    const now = Date.now()
    await db.insert(evalSets).values({
      id, workspaceId: b.workspace_id, name: b.name,
      description: b.description ?? null,
      targetSubject: b.target_subject,
      baselinePassRate: b.baseline_pass_rate ?? 0.80,
      tags: b.tags ?? [],
      archived: false, createdAt: now, updatedAt: now,
    } as never).catch(() => null)
    return { success: true, data: { id } }
  })

  fastify.get<{ Params: { setId: string } }>('/evals/sets/:setId/cases', async (req) => {
    const rows = await db.select().from(evalCases)
      .where(eq(evalCases.evalSetId, req.params.setId))
      .catch(() => [])
    return { success: true, data: rows }
  })

  fastify.post<{ Params: { setId: string }; Body: { input?: string; expected_behavior?: string; tags?: string[]; known_failure?: boolean; notes?: string } }>('/evals/sets/:setId/cases', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.input || !b.expected_behavior) return reply.code(400).send({ success: false, error: 'input + expected_behavior required' })
    const id = uuidv7()
    await db.insert(evalCases).values({
      id, evalSetId: req.params.setId,
      input: b.input, expectedBehavior: b.expected_behavior,
      tags: b.tags ?? [], knownFailure: b.known_failure ?? false,
      notes: b.notes ?? null, createdAt: Date.now(),
    } as never).catch(() => null)
    return { success: true, data: { id } }
  })

  fastify.get<{ Params: { setId: string }; Querystring: { limit?: string } }>('/evals/sets/:setId/runs', async (req) => {
    const limit = Math.min(50, Number(req.query.limit ?? 20))
    const rows = await db.select().from(evalRuns)
      .where(eq(evalRuns.evalSetId, req.params.setId))
      .orderBy(desc(evalRuns.createdAt))
      .limit(limit)
      .catch(() => [])
    return { success: true, data: rows }
  })

  // ── Policy rules ────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/policy/rules', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    // Return BOTH the built-in defaults (read-only) AND the operator
    // overrides from the DB.
    const { listRules } = await import('../services/policy-engine.js')
    const defaults = listRules()
    const overrides = await db.select().from(policyRules)
      .where(eq(policyRules.workspaceId, ws))
      .orderBy(desc(policyRules.priority))
      .catch(() => [])
    return { success: true, data: { defaults, overrides } }
  })

  fastify.post<{ Body: { workspace_id?: string; id?: string; kind?: string; description?: string; params?: Record<string, unknown>; priority?: number; enabled?: boolean } }>('/policy/rules', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.workspace_id || !b.id || !b.kind || !b.description || !b.params) {
      return reply.code(400).send({ success: false, error: 'workspace_id + id + kind + description + params required' })
    }
    const now = Date.now()
    // Upsert keyed on (workspace_id, id).
    await db.insert(policyRules).values({
      id: b.id, workspaceId: b.workspace_id, kind: b.kind,
      description: b.description, params: b.params,
      priority: b.priority ?? 100, enabled: b.enabled ?? true,
      createdAt: now, updatedAt: now,
    } as never).onConflictDoUpdate({
      target: [policyRules.workspaceId, policyRules.id],
      set: {
        kind: b.kind, description: b.description, params: b.params,
        priority: b.priority ?? 100, enabled: b.enabled ?? true,
        updatedAt: now,
      },
    }).catch(() => null)
    const { invalidateOperatorRules } = await import('../services/policy-engine.js')
    invalidateOperatorRules(b.workspace_id)
    return { success: true }
  })

  fastify.delete<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/policy/rules/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await db.delete(policyRules)
      .where(and(eq(policyRules.workspaceId, ws), eq(policyRules.id, req.params.id)))
      .catch(() => null)
    const { invalidateOperatorRules } = await import('../services/policy-engine.js')
    invalidateOperatorRules(ws)
    return { success: true }
  })

  // ── Portfolios (holding-co tier) ─────────────────────────────────
  fastify.get('/portfolios', async () => {
    const rows = await db.select().from(portfolios)
      .where(eq(portfolios.archived, false))
      .orderBy(desc(portfolios.updatedAt))
      .catch(() => [])
    return { success: true, data: rows }
  })

  fastify.post<{ Body: { name?: string; slug?: string; description?: string; owner_user_id?: string; config?: Record<string, unknown> } }>('/portfolios', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.name || !b.slug) return reply.code(400).send({ success: false, error: 'name + slug required' })
    const id = uuidv7()
    const now = Date.now()
    await db.insert(portfolios).values({
      id, name: b.name, slug: b.slug.toLowerCase(),
      description: b.description ?? null,
      ownerUserId: b.owner_user_id ?? null,
      config: b.config ?? {}, archived: false,
      createdAt: now, updatedAt: now,
    } as never).catch(() => null)
    return { success: true, data: { id, slug: b.slug.toLowerCase() } }
  })

  // ── Simulation dry-run + counterfactual ──────────────────────────
  fastify.post<{ Body: { workspace_id?: string; caller?: string; plan?: Array<{ op: string; params?: Record<string, unknown>; risk?: string }> } }>('/simulation/dry-run', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.workspace_id || !Array.isArray(b.plan)) return reply.code(400).send({ success: false, error: 'workspace_id + plan[] required' })
    const { dryRun } = await import('../services/simulation.js')
    const r = await dryRun({
      workspaceId: b.workspace_id,
      caller: (b.caller as 'operator' | 'agent' | 'cron' | 'mcp' | 'session') ?? 'operator',
      plan: b.plan as never,
    })
    return { success: true, data: r }
  })

  // ── Holding-co quick views ───────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/holding-co/portfolio-strategy', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { portfolioStrategy } = await import('../services/holding-co.js')
    return { success: true, data: await portfolioStrategy(ws) }
  })

  fastify.post<{ Body: { workspace_id?: string; pool_usd?: number } }>('/holding-co/allocate-capital', async (req, reply) => {
    const b = req.body ?? {}
    if (!b.workspace_id || !b.pool_usd) return reply.code(400).send({ success: false, error: 'workspace_id + pool_usd required' })
    const { allocateCapital } = await import('../services/holding-co.js')
    return { success: true, data: await allocateCapital({ workspaceId: b.workspace_id, allocationPoolUsd: Number(b.pool_usd) }) }
  })

  // ── Pipeline adapters ────────────────────────────────────────────
  fastify.get('/pipelines', async () => {
    const { listPipelineAdapters } = await import('../services/pipeline-adapters.js')
    return { success: true, data: listPipelineAdapters() }
  })

  // ── Round 122: self-improvement health + shortform + acquisition + compliance ──
  fastify.get<{ Querystring: { workspace_id?: string } }>('/self-improvement/health', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { runAllImprovementHealthChecks } = await import('../services/self-improvement.js')
    return { success: true, data: await runAllImprovementHealthChecks(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; days?: string } }>('/self-improvement/recent-alerts', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const hours = Math.min(168, Number(req.query.days ?? 7) * 24)
    const { db: _db } = await import('../db/client.js')
    const { events: _events } = await import('../db/schema.js')
    const { and: _and, eq: _eq, gte: _gte, desc: _desc, sql: _sql } = await import('drizzle-orm')
    const rows = await _db.select().from(_events)
      .where(_and(
        _eq(_events.workspaceId, ws),
        _sql`${_events.type} IN ('governance.stability_alert', 'self_improvement.health_check', 'cron.self_improvement_health')`,
        _gte(_events.createdAt, Date.now() - hours * 60 * 60_000),
      ))
      .orderBy(_desc(_events.createdAt))
      .limit(100)
      .catch(() => [])
    return { success: true, data: rows.map(r => ({ type: r.type, createdAt: Number(r.createdAt), payload: r.payload })) }
  })

  fastify.get('/shortform/hook-patterns', async () => {
    const { listHookPatterns } = await import('../services/shortform-engine.js')
    return { success: true, data: listHookPatterns() }
  })

  fastify.get<{ Querystring: { platform?: string } }>('/shortform/platform-guidance', async (req, reply) => {
    const platform = req.query.platform
    if (!platform) return reply.code(400).send({ success: false, error: 'platform required' })
    const { getPlatformGuidance } = await import('../services/shortform-engine.js')
    return { success: true, data: getPlatformGuidance(platform as never) }
  })

  fastify.get('/acquisition/diligence-checklist', async () => {
    const { dueDiligenceChecklist } = await import('../services/channel-acquisition.js')
    return { success: true, data: dueDiligenceChecklist() }
  })

  fastify.get('/compliance/viable-configurations', async () => {
    const { VIABLE_CONFIGURATIONS, NON_VIABLE_CONFIGURATIONS, COST_DESTROYERS, PAYBACK_ACCELERATORS } = await import('../services/financial-model.js')
    return { success: true, data: { viable: VIABLE_CONFIGURATIONS, nonViable: NON_VIABLE_CONFIGURATIONS, costDestroyers: COST_DESTROYERS, accelerators: PAYBACK_ACCELERATORS } }
  })

  // ── Round 130: Maturity + coordination feeds for new UI tabs ────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/maturity/assess', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { assessMaturity } = await import('../services/maturity-stage.js')
    return { success: true, data: await assessMaturity(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; board_key?: string; limit?: string } }>('/coordination/blackboard', async (req, reply) => {
    const ws = req.query.workspace_id
    const key = req.query.board_key
    if (!ws || !key) return reply.code(400).send({ success: false, error: 'workspace_id + board_key required' })
    const { blackboardRead, blackboardDetectInconsistencies } = await import('../services/agent-coordination.js')
    const [entries, inconsistencies] = await Promise.all([
      blackboardRead({ workspaceId: ws, boardKey: key, limit: Math.min(200, Number(req.query.limit ?? 50)) }),
      blackboardDetectInconsistencies({ workspaceId: ws, boardKey: key }),
    ])
    return { success: true, data: { entries, inconsistencies } }
  })

  fastify.get<{ Querystring: { workspace_id?: string; hours?: string } }>('/coordination/escalations', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const hours = Math.min(168, Number(req.query.hours ?? 24))
    const { db: _db } = await import('../db/client.js')
    const { events: _events } = await import('../db/schema.js')
    const { and: _and, eq: _eq, gte: _gte, desc: _desc } = await import('drizzle-orm')
    const rows = await _db.select().from(_events)
      .where(_and(
        _eq(_events.workspaceId, ws),
        _eq(_events.type, 'agent.escalation'),
        _gte(_events.createdAt, Date.now() - hours * 60 * 60_000),
      ))
      .orderBy(_desc(_events.createdAt))
      .limit(100)
      .catch(() => [])
    return { success: true, data: rows.map(r => r.payload) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; hours?: string } }>('/coordination/loops', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const hours = Math.min(168, Number(req.query.hours ?? 24))
    const { db: _db } = await import('../db/client.js')
    const { events: _events } = await import('../db/schema.js')
    const { and: _and, eq: _eq, gte: _gte, desc: _desc } = await import('drizzle-orm')
    const rows = await _db.select().from(_events)
      .where(_and(
        _eq(_events.workspaceId, ws),
        _eq(_events.type, 'brain_task.loop_detected'),
        _gte(_events.createdAt, Date.now() - hours * 60 * 60_000),
      ))
      .orderBy(_desc(_events.createdAt))
      .limit(100)
      .catch(() => [])
    return { success: true, data: rows.map(r => r.payload) }
  })

  // ── Round 124: Architecture overview — 12 tabs + crons + connectors + health
  fastify.get<{ Querystring: { workspace_id?: string } }>('/architecture/overview', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const { db: _db2 } = await import('../db/client.js')
    const { events: _events2 } = await import('../db/schema.js')
    const { and: _and2, eq: _eq2, gte: _gte2, sql: _sql2, desc: _desc2 } = await import('drizzle-orm')

    const since24h = Date.now() - 24 * 60 * 60_000
    const cronRows = await _db2.execute(_sql2`
      SELECT type, MAX(created_at)::bigint AS last_fired, COUNT(*)::int AS count_24h
      FROM ${_events2}
      WHERE type LIKE 'cron.%' AND created_at >= ${since24h}
      GROUP BY type
      ORDER BY last_fired DESC
      LIMIT 50
    `).catch(() => ({ rows: [] }))
    const crons = ((cronRows as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(r => ({
      task:      String(r['type'] ?? '').replace(/^cron\./, ''),
      lastFired: Number(r['last_fired'] ?? 0),
      count24h:  Number(r['count_24h'] ?? 0),
    }))

    const { listConnectorSpecs } = await import('../services/connector-base.js')
    const connectors = listConnectorSpecs().map(s => ({
      id: s.id, name: s.name, ready: s.ready, missingEnv: s.missingEnv,
    }))

    let healthVerdict = 'unknown'
    try {
      const { runAllImprovementHealthChecks } = await import('../services/self-improvement.js')
      const v = await runAllImprovementHealthChecks(ws)
      healthVerdict = v.overallVerdict
    } catch { /* */ }

    let maturityStage = 0
    try {
      const { assessMaturity } = await import('../services/maturity-stage.js')
      const m = await assessMaturity(ws)
      maturityStage = m.currentStage
    } catch { /* */ }

    const recentAlerts = await _db2.select({ type: _events2.type, createdAt: _events2.createdAt }).from(_events2)
      .where(_and2(
        _eq2(_events2.workspaceId, ws),
        _sql2`${_events2.type} IN ('governance.stability_alert', 'brain_task.loop_detected', 'cron.error')`,
        _gte2(_events2.createdAt, since24h),
      ))
      .orderBy(_desc2(_events2.createdAt))
      .limit(30)
      .catch(() => [])

    // Round 122 — surface the new self-maintaining + compliance + drift +
    // media event streams as standalone badges so the operator sees them
    // on the same Architecture overview that already shows the 12 tabs.
    // These are workspace=null (system-wide) events, so we query separately.
    const sysSignals = await _db2.execute(_sql2`
      SELECT type, MAX(created_at)::bigint AS last_at, COUNT(*)::int AS n_24h
      FROM ${_events2}
      WHERE type IN (
        'lock_integrity.tamper_detected',
        'lock_integrity.baseline_recorded',
        'compliance.evidence_collected',
        'compliance.cve_scan_completed',
        'compliance.access_review_due',
        'ai.drift_detected',
        'media.image_analyzed',
        'media.video_job_submitted'
      ) AND created_at >= ${since24h}
      GROUP BY type
    `).catch(() => ({ rows: [] }))
    const sysRows = ((sysSignals as { rows?: Array<Record<string, unknown>> }).rows ?? [])
    const sysCount = (t: string) => Number(sysRows.find(r => r['type'] === t)?.['n_24h'] ?? 0)
    const tampered = sysCount('lock_integrity.tamper_detected') > 0
    const drifting = sysCount('ai.drift_detected') > 0

    return {
      success: true,
      data: {
        tabs: [
          { id: 'maturity',     label: 'Maturity',     status: maturityStage >= 4 ? 'ok' : maturityStage >= 2 ? 'partial' : 'early' },
          { id: 'health',       label: 'Health',       status: healthVerdict === 'healthy' ? 'ok' : healthVerdict === 'investigate' ? 'partial' : 'alert' },
          { id: 'cartographer', label: 'Cartographer', status: 'ok' },
          { id: 'knowledge',    label: 'Knowledge',    status: 'ok' },
          { id: 'evals',        label: 'Evals',        status: 'ok' },
          { id: 'policy',       label: 'Policy',       status: 'ok' },
          { id: 'sim',          label: 'Simulation',   status: 'ok' },
          { id: 'coordination', label: 'Coordination', status: recentAlerts.some(a => a.type === 'brain_task.loop_detected') ? 'partial' : 'ok' },
          { id: 'shortform',    label: 'Short-form',   status: 'ok' },
          { id: 'acquisition',  label: 'Acquisition',  status: 'ok' },
          { id: 'compliance',   label: 'Compliance',   status: 'ok' },
          { id: 'holding',      label: 'Holding-Co',   status: 'ok' },
        ],
        crons,
        connectors,
        healthVerdict,
        maturityStage,
        recentAlerts: recentAlerts.map(a => ({ type: a.type, createdAt: Number(a.createdAt) })),
        // Round 122 — system-wide signal badges.
        systemSignals: {
          lockIntegrity: { status: tampered ? 'alert' : 'ok', tamperDetections24h: sysCount('lock_integrity.tamper_detected') },
          compliance:    {
            status: 'ok',
            evidenceCollections24h: sysCount('compliance.evidence_collected'),
            cveScans24h:            sysCount('compliance.cve_scan_completed'),
            accessReviewsDue:       sysCount('compliance.access_review_due'),
          },
          aiDrift:       { status: drifting ? 'partial' : 'ok', detections24h: sysCount('ai.drift_detected') },
          media:         {
            status: 'ok',
            imageAnalyses24h: sysCount('media.image_analyzed'),
            videoJobs24h:     sysCount('media.video_job_submitted'),
          },
        },
      },
    }
  })
}

export default blueprintRoutes
