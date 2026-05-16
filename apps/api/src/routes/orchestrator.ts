/**
 * Orchestrator Routes — /api/v1/orchestrator
 *
 * Agents
 * - POST /agents/register
 * - POST /agents/:id/heartbeat
 * - POST /agents/:id/restart
 * - GET  /agents
 *
 * Assignments
 * - POST /assignments              — assign single task
 * - POST /assignments/batch        — parallel batch dispatch
 * - POST /assignments/:id/start
 * - POST /assignments/:id/complete
 * - GET  /assignments
 * - GET  /graph                    — dependency graph
 *
 * Locks
 * - GET  /locks                    — active locks
 * - POST /locks/recover            — sweep stale locks
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  registerAgent, heartbeat, restartAgent,
  listAgents, listAssignments, getDependencyGraph,
  assignTask, dispatchBatch,
  markAssignmentStarted, markAssignmentComplete,
}                          from '../services/orchestrator.js'
import { listActiveLocks, recoverStaleLocks } from '../services/lock-manager.js'
import type { LockKind }   from '../services/lock-manager.js'

const orchestratorRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Agents ───────────────────────────────────────────────────────────────
  fastify.post<{
    Body: { agent_id?: string; workspace_id?: string; agent_name?: string; capabilities?: string[] }
  }>('/agents/register', async (req, reply) => {
    const { agent_id, workspace_id, agent_name, capabilities } = req.body
    if (!agent_id || !workspace_id || !agent_name) {
      return reply.code(400).send({ success: false, error: 'agent_id, workspace_id, agent_name required' })
    }
    await registerAgent({ agentId: agent_id, workspaceId: workspace_id, agentName: agent_name, capabilities: capabilities ?? [] })
    return { success: true, data: { agentId: agent_id } }
  })

  fastify.post<{ Params: { id: string } }>('/agents/:id/heartbeat', async (req) => {
    await heartbeat(req.params.id)
    return { success: true, data: { agentId: req.params.id, ts: Date.now() } }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/agents/:id/restart', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await restartAgent(req.params.id, ws)
    return { success: true, data: { agentId: req.params.id, status: 'restarting' } }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/agents', async (req, reply) => {
    const { workspace_id } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listAgents(workspace_id)
    return { success: true, data }
  })

  // ── Assignments ──────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; task_kind?: string; task_ref?: string
      required_capability?: string; priority?: number
      depends_on?: string[]; lock_requests?: Array<{ kind: LockKind; key: string }>
    }
  }>('/assignments', async (req, reply) => {
    const { workspace_id, task_kind, task_ref, required_capability, priority, depends_on, lock_requests } = req.body
    if (!workspace_id || !task_kind || !task_ref || !required_capability) {
      return reply.code(400).send({ success: false, error: 'workspace_id, task_kind, task_ref, required_capability required' })
    }
    const input: Parameters<typeof assignTask>[0] = {
      workspaceId:       workspace_id,
      taskKind:          task_kind,
      taskRef:           task_ref,
      requiredCapability: required_capability,
    }
    if (priority !== undefined) input.priority = priority
    if (depends_on) input.dependsOn = depends_on
    if (lock_requests) input.lockRequests = lock_requests

    const result = await assignTask(input)
    if (!result.ok) return reply.code(409).send({ success: false, error: result.reason })
    return { success: true, data: result }
  })

  fastify.post<{
    Body: {
      workspace_id?: string
      tasks?: Array<{
        task_kind: string; task_ref: string; required_capability: string
        priority?: number; depends_on?: string[]
        lock_requests?: Array<{ kind: LockKind; key: string }>
      }>
    }
  }>('/assignments/batch', async (req, reply) => {
    const { workspace_id, tasks } = req.body
    if (!workspace_id || !tasks || tasks.length === 0) {
      return reply.code(400).send({ success: false, error: 'workspace_id and non-empty tasks required' })
    }
    const result = await dispatchBatch(workspace_id, tasks.map((t) => {
      const out: Parameters<typeof dispatchBatch>[1][number] = {
        taskKind:          t.task_kind,
        taskRef:           t.task_ref,
        requiredCapability: t.required_capability,
      }
      if (t.priority !== undefined) out.priority = t.priority
      if (t.depends_on) out.dependsOn = t.depends_on
      if (t.lock_requests) out.lockRequests = t.lock_requests
      return out
    }))
    return { success: true, data: result }
  })

  fastify.post<{ Params: { id: string } }>('/assignments/:id/start', async (req) => {
    await markAssignmentStarted(req.params.id)
    return { success: true, data: { assignmentId: req.params.id, status: 'running' } }
  })

  fastify.post<{
    Params: { id: string }
    Body:   { success?: boolean; error_message?: string }
  }>('/assignments/:id/complete', async (req) => {
    await markAssignmentComplete(req.params.id, req.body.success !== false, req.body.error_message)
    return { success: true, data: { assignmentId: req.params.id, success: req.body.success !== false } }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: string } }>('/assignments', async (req, reply) => {
    const { workspace_id, status } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listAssignments(workspace_id, status)
    return { success: true, data }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/graph', async (req, reply) => {
    const { workspace_id } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await getDependencyGraph(workspace_id)
    return { success: true, data }
  })

  // ── Locks ────────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/locks', async (req, reply) => {
    const { workspace_id } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listActiveLocks(workspace_id)
    return { success: true, data }
  })

  fastify.post<{
    Body: { workspace_id?: string }
  }>('/locks/recover', async (req, reply) => {
    const { workspace_id } = req.body
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const recovered = await recoverStaleLocks(workspace_id)
    return { success: true, data: { recovered } }
  })
}

export default orchestratorRoutes
