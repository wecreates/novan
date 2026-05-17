/**
 * Platform status — single pane for provider health, governor state,
 * coordinator dedup, and the daily review.
 *
 * GET  /providers           — every provider + feature flags
 * GET  /governor            — current rate-limit state for a workspace
 * GET  /coordinator         — dedup claims + priority decisions
 * POST /daily-review        — generate (or fetch cached) daily review
 */
import type { FastifyPluginAsync } from 'fastify'
import { validateProviders, isResearchEnabled, isImageGenerationEnabled, defaultImageProvider, searchProvider } from '../services/provider-validation.js'
import { snapshot as governorSnapshot, currentLimits } from '../services/resource-governor.js'
import { coordinatorSnapshot, recentPriorityDecisions } from '../services/agent-coordinator.js'
import { runDailyReview, generateDailyReview } from '../services/daily-review.js'
import { listAvailableProviders } from '../services/image-generator.js'

const platformStatusRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get<{ Querystring: { workspace_id?: string } }>('/providers', async (req, reply) => {
    const ws = req.query.workspace_id ?? 'default'
    const probe = await validateProviders(ws)
    return {
      success: true,
      data: {
        ...probe,
        imageProvidersWithKey: listAvailableProviders(),
        flags: {
          researchEnabled:        isResearchEnabled(),
          imageGenerationEnabled: isImageGenerationEnabled(),
          defaultImageProvider:   defaultImageProvider(),
          searchProvider:         searchProvider(),
        },
      },
    }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/governor', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await governorSnapshot(ws) }
  })

  fastify.get('/coordinator', async () => {
    return {
      success: true,
      data: {
        ...coordinatorSnapshot(),
        recentPriorityDecisions: recentPriorityDecisions(20),
      },
    }
  })

  fastify.post<{ Body: { workspace_id?: string; force?: boolean } }>('/daily-review', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts = req.body.force ? { force: true } : {}
    const review = await runDailyReview(ws, opts)
    if (review === null) {
      const cached = await generateDailyReview(ws)
      return { success: true, data: { cached: true, review: cached } }
    }
    return { success: true, data: { cached: false, review } }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/limits', async (_req) => {
    return { success: true, data: currentLimits() }
  })
}

export default platformStatusRoutes
