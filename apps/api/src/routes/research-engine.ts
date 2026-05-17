/**
 * Research Learning Engine routes — /api/v1/research-engine
 *
 *   POST   /topics                 create topic
 *   GET    /topics                 list topics
 *   POST   /topics/:id/run         manually run a topic
 *   POST   /topics/:id/pause       set status=paused
 *   POST   /topics/:id/resume      set status=active
 *   POST   /topics/:id/kill        set status=killed
 *   GET    /findings               list findings (?topic_id=...&limit=...)
 *   DELETE /findings/:id           delete a finding
 *   POST   /run-due                run every due topic (also called by cron)
 *   POST   /seed-agents            register the 10 research agents
 *   GET    /agents                 list registered research agents
 */
import type { FastifyPluginAsync } from 'fastify'
import { db }                      from '../db/client.js'
import { agents }                  from '../db/schema.js'
import { eq, inArray }             from 'drizzle-orm'
import {
  createTopic, listTopics, setTopicStatus, runTopic, runDueTopics,
  listFindings, deleteFinding, seedResearchAgents, RESEARCH_AGENT_DEFS,
} from '../services/research-engine.js'

const researchEngineRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.post<{
    Body: {
      workspace_id?:      string
      topic?:             string
      description?:       string
      approved_sources?:  string[]
      approved_agents?:   string[]
      poll_interval_sec?: number
      created_by?:        string
    }
  }>('/topics', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.topic) {
      return reply.code(400).send({ success: false, error: 'workspace_id, topic required' })
    }
    const id = await createTopic({
      workspaceId:     b.workspace_id,
      topic:           b.topic,
      ...(b.description       !== undefined ? { description:     b.description }       : {}),
      ...(b.approved_sources  !== undefined ? { approvedSources: b.approved_sources }  : {}),
      ...(b.approved_agents   !== undefined ? { approvedAgents:  b.approved_agents }   : {}),
      ...(b.poll_interval_sec !== undefined ? { pollIntervalSec: b.poll_interval_sec } : {}),
      ...(b.created_by        !== undefined ? { createdBy:       b.created_by }        : {}),
    })
    return { success: true, data: { id } }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/topics', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listTopics(ws) }
  })

  fastify.post<{ Params: { id: string } }>('/topics/:id/run', async (req) => {
    return { success: true, data: await runTopic(req.params.id) }
  })

  fastify.post<{ Params: { id: string } }>('/topics/:id/pause', async (req) => {
    await setTopicStatus(req.params.id, 'paused')
    return { success: true }
  })
  fastify.post<{ Params: { id: string } }>('/topics/:id/resume', async (req) => {
    await setTopicStatus(req.params.id, 'active')
    return { success: true }
  })
  fastify.post<{ Params: { id: string } }>('/topics/:id/kill', async (req) => {
    await setTopicStatus(req.params.id, 'killed')
    return { success: true }
  })

  fastify.get<{
    Querystring: { workspace_id?: string; topic_id?: string; limit?: string }
  }>('/findings', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { topicId?: string; limit?: number } = {}
    if (req.query.topic_id) opts.topicId = req.query.topic_id
    if (req.query.limit)    opts.limit   = Number(req.query.limit)
    return { success: true, data: await listFindings(ws, opts) }
  })

  fastify.delete<{
    Params: { id: string }
    Querystring: { workspace_id?: string }
  }>('/findings/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await deleteFinding(req.params.id, ws)
    return { success: true }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/run-due', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await runDueTopics(ws) }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/seed-agents', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await seedResearchAgents(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/agents', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const types = RESEARCH_AGENT_DEFS.map(d => d.type)
    const rows = await db.select().from(agents)
      .where(eq(agents.workspaceId, ws))
      .then(rs => rs.filter(r => types.includes(r.type as typeof types[number])))
    return { success: true, data: rows }
  })
}

export default researchEngineRoutes
