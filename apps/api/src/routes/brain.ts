/**
 * Brain routes — /api/v1/brain/*
 * Graph, node detail, actions, live SSE stream.
 */
import type { FastifyPluginAsync } from 'fastify'
import { buildGraph, getNodeDetail, type BrainTemplate, type LODMode } from '../services/brain-graph.js'
import { performBrainAction } from '../services/brain-actions.js'
import { timelineSummary, replayAt, decisionPath, searchBrain, searchHistorical } from '../services/brain-timeline.js'
import { saveView, listSavedViews, deleteSavedView } from '../services/brain-persistence.js'
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, eq, gte, desc } from 'drizzle-orm'

// Short in-memory cache per workspace+template (5 s)
const cache = new Map<string, { at: number; data: unknown }>()
const CACHE_MS = 5_000

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
    const graph = await buildGraph(ws, template, { lod, ...(focus ? { focusSystem: focus } : {}) })
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

  // SSE stream — relays recent global events for the brain UI
  fastify.get<{ Querystring: { workspace_id?: string } }>('/stream', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let last = Date.now()
    let alive = true
    req.raw.on('close', () => { alive = false })

    // Initial graph snapshot
    const graph = await buildGraph(ws, 'neural')
    reply.raw.write(`event: graph\n`)
    reply.raw.write(`data: ${JSON.stringify({ generatedAt: graph.generatedAt, systemCount: graph.systems.length, nodeCount: graph.nodes.length })}\n\n`)

    while (alive) {
      await new Promise(r => setTimeout(r, 4_000))
      if (!alive) break
      // Pull events since 'last' for this workspace AND global
      const recent = await db.select().from(events)
        .where(and(gte(events.createdAt, last)))
        .orderBy(desc(events.createdAt)).limit(20).catch(() => [])
      const relevant = recent.filter(e => e.workspaceId === ws || e.workspaceId === 'global')
      if (relevant.length > 0) {
        last = recent[0]!.createdAt
        for (const e of relevant) {
          reply.raw.write(`event: runtime\n`)
          reply.raw.write(`data: ${JSON.stringify({
            type: e.type, source: e.source, createdAt: e.createdAt,
            payload: e.payload,
          })}\n\n`)
        }
      } else {
        // Heartbeat
        reply.raw.write(`event: heartbeat\n`)
        reply.raw.write(`data: ${JSON.stringify({ at: Date.now() })}\n\n`)
      }
    }
    reply.raw.end()
  })
}

export default brainRoutes
