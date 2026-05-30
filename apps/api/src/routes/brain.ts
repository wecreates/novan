/**
 * Brain routes — /api/v1/brain/*
 * Graph, node detail, actions, live SSE stream.
 */
import type { FastifyPluginAsync } from 'fastify'
import { buildGraph, getNodeDetail, type BrainTemplate, type LODMode } from '../services/brain-graph.js'
import { performBrainAction } from '../services/brain-actions.js'
import { executePlan, listAvailableOperations, type TaskOperation } from '../services/brain-task.js'
import { planTaskFromText } from '../services/brain-task-planner.js'
import { timelineSummary, replayAt, decisionPath, searchBrain, searchHistorical } from '../services/brain-timeline.js'
import { saveView, listSavedViews, deleteSavedView } from '../services/brain-persistence.js'
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, eq, gte, desc } from 'drizzle-orm'

// Short in-memory cache per workspace+template (5 s)
// R146.13 — bounded LRU. Without eviction the map grew once per unique
// `${ws}:${template}:${lod}:${focus}` combination — `focus` is a free
// user-controlled node id so a GET-spam attacker (or normal exploration
// across thousands of brain nodes) could grow this map without bound.
// Now: stale-on-read deletion + hard 500-entry FIFO cap on insert.
const cache = new Map<string, { at: number; data: unknown }>()
const CACHE_MS = 5_000
const CACHE_MAX = 500

const brainRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get<{ Querystring: { workspace_id?: string; template?: string; lod?: string; focus?: string } }>('/graph', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const template = (req.query.template ?? 'neural') as BrainTemplate
    const lod = (req.query.lod ?? 'systems') as LODMode
    const focus = req.query.focus
    const key = `${ws}:${template}:${lod}:${focus ?? ''}`
    const cached = cache.get(key)
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return { success: true, data: cached.data, cached: true }
    }
    if (cached) cache.delete(key)   // stale → drop instead of overwrite
    const graph = await buildGraph(ws, template, { lod, ...(focus ? { focusSystem: focus } : {}) })
    // FIFO drop oldest entry when at the size cap. Map iteration order is
    // insertion order in JS, so .keys().next() yields the oldest.
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, { at: Date.now(), data: graph })
    return { success: true, data: graph, cached: false }
  })

  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/nodes/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const detail = await getNodeDetail(ws, req.params.id)
    if (!detail) return reply.code(404).send({ success: false, error: 'node not found' })
    return { success: true, data: detail }
  })

  fastify.post<{
    Body: { workspace_id?: string; action_id?: string; node_id?: string; payload?: Record<string, unknown>; approval_token?: string }
  }>('/actions', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.action_id || !b.node_id) {
      return reply.code(400).send({ success: false, error: 'workspace_id, action_id, node_id required' })
    }
    const r = await performBrainAction({
      workspaceId: b.workspace_id,
      actionId: b.action_id as Parameters<typeof performBrainAction>[0]['actionId'],
      nodeId: b.node_id,
      payload: b.payload ?? {},
      ...(b.approval_token ? { approvalToken: b.approval_token } : {}),
    })
    if (!r.ok) return reply.code(400).send({ success: false, ...r })
    return { success: true, data: r }
  })

  // ── Task: natural-language directive interface ─────────────────────
  // The operator says "do X" — the planner converts the text into an
  // ordered list of whitelisted operations and runs them.
  //
  // Modes:
  //   { task: "plain english", auto_execute: true }  → plan + execute
  //   { task: "plain english", auto_execute: false } → plan only
  //   { plan: [{op, params}, ...] }                  → execute explicit
  //
  // High-risk operations require approval_token=OPERATOR_APPROVED.
  fastify.post<{ Body: {
    workspace_id?: string
    task?:         string
    plan?:         TaskOperation[]
    auto_execute?: boolean
    approval_token?: string
  } }>('/task', {
    // Brain task execution dispatches arbitrary ops (LLM, workers,
    // high-risk actions) — cap at 30/min/IP independent of the global limit.
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const b = req.body
    const ws = b.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    // Explicit plan path — skip the planner.
    if (Array.isArray(b.plan) && b.plan.length > 0) {
      const result = await executePlan(ws, b.task ?? '(direct plan)', b.plan, b.approval_token, 'direct plan from operator')
      return { success: true, data: result }
    }

    const task = (b.task ?? '').trim()
    if (!task) return reply.code(400).send({ success: false, error: 'task or plan required' })

    const planned = await planTaskFromText(task)
    if (b.auto_execute === false) {
      return { success: true, data: { task, plan: planned.plan, reason: planned.reason } }
    }
    if (planned.plan.length === 0) {
      return { success: true, data: { task, plan: [], reason: planned.reason, results: [], summary: `Could not plan: ${planned.reason}` } }
    }
    const result = await executePlan(ws, task, planned.plan, b.approval_token, planned.reason)
    return { success: true, data: { ...result, plannerReason: planned.reason } }
  })

  // List the operations the brain can perform.
  fastify.get('/task/operations', async () => {
    return { success: true, data: listAvailableOperations() }
  })

  // ── Error ingest — operator never sees raw errors. Brain does. ─────
  // UI mutations, API caught exceptions, worker crashes — all funnel
  // here. Brain diagnoses, dedups, fires the auto-loop on low-risk
  // known patterns, and returns a short operator-facing message.
  fastify.post<{ Body: {
    workspace_id?: string
    source?:       'ui' | 'api' | 'worker' | 'cron' | 'voice' | 'chat'
    error_message?: string
    error_name?:   string
    stack?:        string
    url?:          string
    method?:       string
    status_code?:  number
    payload?:      Record<string, unknown>
    user_agent?:   string
    conversation_id?: string
    delegation_id?:   string
    task_id?:         string
  } }>('/errors', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.error_message) {
      return reply.code(400).send({ success: false, error: 'workspace_id + error_message required' })
    }
    const { reportError } = await import('../services/brain-error-ingest.js')
    const result = await reportError({
      workspaceId:    b.workspace_id,
      source:         b.source ?? 'ui',
      errorMessage:   b.error_message,
      ...(b.error_name      ? { errorName:  b.error_name } : {}),
      ...(b.stack           ? { stack:      b.stack } : {}),
      ...(b.url             ? { url:        b.url } : {}),
      ...(b.method          ? { method:     b.method } : {}),
      ...(b.status_code     ? { statusCode: b.status_code } : {}),
      ...(b.payload         ? { payload:    b.payload } : {}),
      ...(b.user_agent      ? { userAgent:  b.user_agent } : {}),
      ...(b.conversation_id ? { conversationId: b.conversation_id } : {}),
      ...(b.delegation_id   ? { delegationId:   b.delegation_id } : {}),
      ...(b.task_id         ? { taskId:         b.task_id } : {}),
    })
    return { success: true, data: result }
  })

  // Recent errors the brain has ingested (for /brain/errors dashboard)
  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/errors', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { recentErrors } = await import('../services/brain-error-ingest.js')
    return { success: true, data: await recentErrors(ws, Math.min(Number(req.query.limit ?? 30), 100)) }
  })

  // ── Timeline ───────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; from?: string; to?: string; bucket_ms?: string } }>('/timeline', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const to = req.query.to ? Number(req.query.to) : Date.now()
    const from = req.query.from ? Number(req.query.from) : to - 60 * 60_000
    const bucket = req.query.bucket_ms ? Number(req.query.bucket_ms) : 60_000
    return { success: true, data: await timelineSummary(ws, from, to, bucket) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; at?: string; template?: string } }>('/replay', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws || !req.query.at) return reply.code(400).send({ success: false, error: 'workspace_id, at required' })
    const at = Number(req.query.at)
    if (!Number.isFinite(at)) return reply.code(400).send({ success: false, error: 'at must be a number (ms)' })
    return { success: true, data: await replayAt(ws, at, (req.query.template ?? 'neural') as BrainTemplate) }
  })

  fastify.get<{ Params: { key: string }; Querystring: { workspace_id?: string; window_minutes?: string } }>('/decision-path/:key', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const wm = req.query.window_minutes ? Number(req.query.window_minutes) : 5
    return { success: true, data: await decisionPath(ws, req.params.key, wm) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; q?: string; limit?: string; historical?: string; from?: string; to?: string } }>('/search', async (req, reply) => {
    const ws = req.query.workspace_id
    const q  = req.query.q
    if (!ws || !q) return reply.code(400).send({ success: false, error: 'workspace_id, q required' })
    const limit = req.query.limit ? Number(req.query.limit) : 20
    if (req.query.historical === '1' || req.query.historical === 'true') {
      const to = req.query.to ? Number(req.query.to) : Date.now()
      const from = req.query.from ? Number(req.query.from) : to - 7 * 24 * 60 * 60_000
      return { success: true, data: await searchHistorical(ws, q, from, to, limit) }
    }
    return { success: true, data: await searchBrain(ws, q, limit) }
  })

  // ── Saved views ──────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/saved-views', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listSavedViews(ws, req.query.limit ? Number(req.query.limit) : 20) }
  })

  fastify.post<{
    Body: { workspace_id?: string; operator_id?: string; name?: string; template?: string;
            focus_system?: string | null; camera_position?: { x: number; y: number; z: number; tx: number; ty: number; tz: number };
            lod?: string }
  }>('/saved-views', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.name || !b.template) return reply.code(400).send({ success: false, error: 'workspace_id, name, template required' })
    const id = await saveView({
      workspaceId: b.workspace_id,
      ...(b.operator_id ? { operatorId: b.operator_id } : {}),
      name: b.name, template: b.template,
      focusSystem: b.focus_system ?? null,
      cameraPosition: b.camera_position ?? null,
      ...(b.lod ? { lod: b.lod } : {}),
    })
    return reply.code(201).send({ success: true, data: { id } })
  })

  fastify.delete<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/saved-views/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await deleteSavedView(ws, req.params.id)
    return { success: true }
  })

  // SSE stream — relays workspace events for the brain UI.
  //
  // Dual-mode delivery:
  //   1. Postgres LISTEN on `events_changed_<workspaceId>` — the
  //      business-construction service NOTIFYs after every insert,
  //      which lets us flush new events within ~50 ms instead of
  //      waiting for the 4 s poll. The wake-up just triggers a fresh
  //      "since `last`" query; we never trust the NOTIFY payload.
  //   2. A slow 4 s safety poll catches anything that didn't NOTIFY
  //      (the events table is written from many places — improvement
  //      cron, agent dispatcher, etc. — most of which don't notify).
  fastify.get<{ Querystring: { workspace_id?: string } }>('/stream', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    // R146.38 — global SSE concurrent-stream cap.
    const { sseSlots } = await import('../services/sse-limit.js')
    if (!sseSlots.tryAcquire()) {
      return reply.code(503).send({ success: false, error: 'too many open streams, retry shortly' })
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let last = Date.now()
    let alive = true
    req.raw.on('close', () => { alive = false; sseSlots.release() })

    // Initial graph snapshot
    const graph = await buildGraph(ws, 'neural')
    reply.raw.write(`event: graph\n`)
    reply.raw.write(`data: ${JSON.stringify({ generatedAt: graph.generatedAt, systemCount: graph.systems.length, nodeCount: graph.nodes.length })}\n\n`)

    // Flush helper — pulls events since `last` and writes any relevant
    // ones. Idempotent + safe to call from both the timer and the
    // LISTEN callback.
    let flushing = false
    async function flush() {
      if (!alive || flushing) return
      flushing = true
      try {
        const recent = await db.select().from(events)
          .where(and(gte(events.createdAt, last)))
          .orderBy(desc(events.createdAt)).limit(50).catch(() => [])
        const relevant = recent.filter(e => e.workspaceId === ws || e.workspaceId === 'global')
        if (relevant.length > 0) {
          last = recent[0]!.createdAt + 1   // exclusive so we don't re-emit
          // Write in chronological order (recent[0] is newest; reverse)
          for (let i = relevant.length - 1; i >= 0; i--) {
            const e = relevant[i]!
            reply.raw.write(`event: runtime\n`)
            reply.raw.write(`data: ${JSON.stringify({
              type: e.type, source: e.source, createdAt: e.createdAt,
              payload: e.payload,
            })}\n\n`)
          }
        }
      } finally { flushing = false }
    }

    // ── 1. LISTEN setup ────────────────────────────────────────────
    // We import lazily so this route stays import-cost-free for
    // non-stream callers, and so a LISTEN setup failure never blocks
    // the slower poll path.
    let unlisten: (() => Promise<void>) | null = null
    try {
      const { pg } = await import('../db/client.js')
      const channel = `events_changed_${ws.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`
      const sub = await pg.listen(channel, () => { void flush() })
      unlisten = sub.unlisten
    } catch { /* LISTEN unavailable — poll path still works */ }

    // ── 2. Slow safety poll + heartbeat ────────────────────────────
    while (alive) {
      await new Promise(r => setTimeout(r, 4_000))
      if (!alive) break
      await flush()
      // Re-check alive — the client may have disconnected during the
      // await above. Writing to a closed socket throws; swallow it.
      if (!alive) break
      try {
        reply.raw.write(`event: heartbeat\n`)
        reply.raw.write(`data: ${JSON.stringify({ at: Date.now() })}\n\n`)
      } catch { alive = false; break }
    }

    if (unlisten) { try { await unlisten() } catch { /* */ } }
    reply.raw.end()
  })
}

export default brainRoutes
