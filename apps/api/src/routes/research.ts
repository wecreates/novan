/**
 * Research routes — outbound web learning surface.
 *
 * POST  /fetch        — fetch a URL into external_knowledge
 * GET   /knowledge    — list recent external knowledge rows
 * GET   /knowledge/:id — single row
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  webFetch, listExternalKnowledge, getExternalKnowledge,
}                          from '../services/web-fetch.js'
import type { FetchSource } from '../services/web-fetch.js'

const researchRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.post<{
    Body: {
      workspace_id?: string
      url?:          string
      source?:       FetchSource
      tags?:         string[]
      ttl_ms?:       number
      force_refresh?: boolean
    }
  }>('/fetch', async (req, reply) => {
    const { workspace_id, url, source, tags, ttl_ms, force_refresh } = req.body
    if (!workspace_id || !url) {
      return reply.code(400).send({ success: false, error: 'workspace_id and url required' })
    }
    try {
      const input: Parameters<typeof webFetch>[0] = {
        workspaceId: workspace_id, url,
      }
      if (source) input.source = source
      if (tags) input.tags = tags
      if (ttl_ms !== undefined) input.ttlMs = ttl_ms
      if (force_refresh) input.forceRefresh = true
      const r = await webFetch(input)
      return { success: true, data: r }
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })

  fastify.get<{
    Querystring: { workspace_id?: string; limit?: string }
  }>('/knowledge', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listExternalKnowledge(ws, req.query.limit ? Number(req.query.limit) : 50)
    return { success: true, data }
  })

  fastify.get<{ Params: { id: string } }>('/knowledge/:id', async (req, reply) => {
    const row = await getExternalKnowledge(req.params.id)
    if (!row) return reply.code(404).send({ success: false, error: 'not found' })
    return { success: true, data: row }
  })
}

export default researchRoutes
