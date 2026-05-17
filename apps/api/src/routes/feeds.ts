/**
 * Feed management routes.
 *
 * POST /feeds                     — register a new RSS/Atom feed
 * GET  /feeds                     — list configured feeds
 * POST /feeds/:id/poll            — manually trigger one feed
 * POST /feeds/:id/enable          — toggle enabled=true
 * POST /feeds/:id/disable         — toggle enabled=false
 * POST /poll-all                  — poll every due feed (also called by cron)
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  addFeed, listFeeds, pollFeed, pollDueFeeds, setFeedEnabled,
}                          from '../services/feed-ingester.js'

const feedRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.post<{
    Body: {
      workspace_id?:       string
      feed_url?:           string
      name?:               string
      tags?:               string[]
      interval_seconds?:   number
      max_items_per_poll?: number
    }
  }>('/feeds', async (req, reply) => {
    const { workspace_id, feed_url, name, tags, interval_seconds, max_items_per_poll } = req.body
    if (!workspace_id || !feed_url || !name) {
      return reply.code(400).send({ success: false, error: 'workspace_id, feed_url, name required' })
    }
    const input: Parameters<typeof addFeed>[0] = {
      workspaceId: workspace_id, feedUrl: feed_url, name,
    }
    if (tags) input.tags = tags
    if (interval_seconds !== undefined) input.intervalSeconds = interval_seconds
    if (max_items_per_poll !== undefined) input.maxItemsPerPoll = max_items_per_poll
    const id = await addFeed(input)
    return { success: true, data: { id } }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/feeds', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listFeeds(ws)
    return { success: true, data }
  })

  fastify.post<{ Params: { id: string } }>('/feeds/:id/poll', async (req, reply) => {
    try {
      const r = await pollFeed(req.params.id)
      return { success: true, data: r }
    } catch (e) {
      return reply.code(404).send({ success: false, error: (e as Error).message })
    }
  })

  fastify.post<{ Params: { id: string } }>('/feeds/:id/enable', async (req) => {
    await setFeedEnabled(req.params.id, true)
    return { success: true }
  })

  fastify.post<{ Params: { id: string } }>('/feeds/:id/disable', async (req) => {
    await setFeedEnabled(req.params.id, false)
    return { success: true }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/poll-all', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const r = await pollDueFeeds(ws)
    return { success: true, data: r }
  })
}

export default feedRoutes
