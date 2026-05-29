/**
 * Fabric + identity + simulation routes — /api/v1/fabric/*, /identity/*, /sim/*
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  registerNode, heartbeat, listNodes, setNodeStatus,
  sweepStaleNodes, recordScalingEvent, runScalingCycle,
  recentScalingEvents, fabricSnapshot, decideScale,
  type NodeRole, type NodeStatus,
} from '../services/runtime-fabric.js'
import {
  audit, recordAudit, getProfile, updateTraits, identityDriftReport,
  CORE_TRAITS, type OutputType, type TraitKey,
  fmtIncident, fmtRecommendation, fmtForecast,
} from '../services/identity-core.js'
import {
  buildScenario, listScenarios, recordObservedOutcome,
  simulationAccuracy, simulationWarRoom, compareDecisions,
  type ScenarioKind, type DecisionOption,
} from '../services/simulation-engine.js'
import { CHARTER, CHARTER_HASH, adherenceReport } from '../services/mission-charter.js'

const fabricRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Runtime fabric ───────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string; node_id?: string; region?: string; role?: string; capacity?: number; endpoint?: string } }>('/fabric/nodes/register', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.node_id || !b.region || !b.role) return reply.code(400).send({ success: false, error: 'workspace_id, node_id, region, role required' })
    await registerNode({
      workspaceId: b.workspace_id, nodeId: b.node_id,
      region: b.region, role: b.role as NodeRole,
      ...(b.capacity !== undefined ? { capacity: b.capacity } : {}),
      ...(b.endpoint !== undefined ? { endpoint: b.endpoint } : {}),
    })
    return { success: true }
  })

  fastify.post<{ Body: { workspace_id?: string; node_id?: string; active_load?: number; queue_depth?: number; metadata?: Record<string, unknown> } }>('/fabric/nodes/heartbeat', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.node_id) return reply.code(400).send({ success: false, error: 'workspace_id, node_id required' })
    await heartbeat(b.workspace_id, b.node_id, {
      ...(b.active_load !== undefined ? { activeLoad: b.active_load } : {}),
      ...(b.queue_depth !== undefined ? { queueDepth: b.queue_depth } : {}),
      ...(b.metadata !== undefined ? { metadata: b.metadata } : {}),
    })
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/fabric/nodes', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listNodes(ws) }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; status?: string; reason?: string } }>('/fabric/nodes/:id/status', async (req, reply) => {
    const { workspace_id, status, reason } = req.body
    if (!workspace_id || !status || !reason) return reply.code(400).send({ success: false, error: 'workspace_id, status, reason required' })
    await setNodeStatus(workspace_id, req.params.id, status as NodeStatus, reason)
    return { success: true }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/fabric/sweep-stale', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await sweepStaleNodes(ws) }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/fabric/scaling/run', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await runScalingCycle(ws) }
  })

  fastify.post<{ Body: { role?: string; healthy_nodes?: number; total_queue_depth?: number; avg_utilization?: number } }>('/fabric/scaling/decide', async (req, reply) => {
    const b = req.body
    if (!b.role || typeof b.healthy_nodes !== 'number' || typeof b.total_queue_depth !== 'number' || typeof b.avg_utilization !== 'number') return reply.code(400).send({ success: false, error: 'role, healthy_nodes, total_queue_depth, avg_utilization required' })
    return { success: true, data: decideScale(b.role as NodeRole, {
      healthyNodes: b.healthy_nodes, totalQueueDepth: b.total_queue_depth, avgUtilization: b.avg_utilization,
    }) }
  })

  fastify.post<{ Body: { workspace_id?: string; kind?: string; target?: string; before?: number; after?: number; reason?: string; approved_by?: string } }>('/fabric/scaling/record', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.kind || !b.target || !b.reason) return reply.code(400).send({ success: false, error: 'workspace_id, kind, target, reason required' })
    const id = await recordScalingEvent(b.workspace_id, {
      kind: b.kind as 'scale_up' | 'scale_down' | 'throttle' | 'noop',
      target: b.target,
      before: b.before ?? 0, after: b.after ?? 0,
      reason: b.reason,
    }, b.approved_by ?? 'operator')
    return reply.code(201).send({ success: true, data: { id } })
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/fabric/scaling/events', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentScalingEvents(ws, req.query.limit ? Number(req.query.limit) : 50) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/fabric/snapshot', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await fabricSnapshot(ws) }
  })

  // ── Identity ─────────────────────────────────────────────────────────
  // Moved to dedicated routes/identity.ts mounted at /api/v1/identity.
  // The legacy duplicates here caused FST_ERR_DUPLICATED_ROUTE on boot.

  // /identity/audit/record + /identity/drift moved to routes/identity.ts.

  // Format helpers (server-side templates any client/agent can call)
  fastify.post<{ Body: { kind?: string; opts?: Record<string, unknown> } }>('/identity/format', async (req, reply) => {
    const { kind, opts } = req.body
    if (!kind || !opts) return reply.code(400).send({ success: false, error: 'kind, opts required' })
    try {
      let text: string
      switch (kind) {
        case 'incident':      text = fmtIncident      (opts as Parameters<typeof fmtIncident>[0]); break
        case 'recommendation': text = fmtRecommendation(opts as Parameters<typeof fmtRecommendation>[0]); break
        case 'forecast':      text = fmtForecast      (opts as Parameters<typeof fmtForecast>[0]); break
        default: return reply.code(400).send({ success: false, error: `unknown kind: ${kind}` })
      }
      return { success: true, data: { text } }
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })

  // Simulation routes moved to routes/sim.ts.
  // Mission routes moved to routes/mission.ts.
  // Legacy duplicates here caused FST_ERR_DUPLICATED_ROUTE on boot.
}

export default fabricRoutes
