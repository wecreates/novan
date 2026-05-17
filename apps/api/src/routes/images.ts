/**
 * AI Image Generator routes — /api/v1/images
 *
 *   POST /generate            generate an image (cost-guarded, safety-gated)
 *   GET  /                    list workspace generation history
 *   GET  /:id                 single generation
 *   POST /quote               cost estimate (no generation)
 *   GET  /providers           list providers that have keys configured
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  generateImage, listGenerations, getGeneration,
  quoteCost, listAvailableProviders, type ImageProvider,
} from '../services/image-generator.js'

const VALID_PROVIDERS: ImageProvider[] = ['openai', 'stability', 'replicate', 'fal']

const imageRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get('/providers', async () => {
    return { success: true, data: { available: listAvailableProviders(), all: VALID_PROVIDERS } }
  })

  fastify.post<{
    Body: {
      provider?:        string
      width?:           number
      height?:          number
      model?:           string
    }
  }>('/quote', async (req, reply) => {
    const p = req.body.provider as ImageProvider | undefined
    if (!p || !VALID_PROVIDERS.includes(p)) {
      return reply.code(400).send({ success: false, error: `provider must be one of ${VALID_PROVIDERS.join(',')}` })
    }
    const quote = quoteCost(p, {
      ...(req.body.width  !== undefined ? { width:  req.body.width }  : {}),
      ...(req.body.height !== undefined ? { height: req.body.height } : {}),
      ...(req.body.model  !== undefined ? { model:  req.body.model }  : {}),
    })
    return { success: true, data: { provider: p, estimateUsd: quote } }
  })

  fastify.post<{
    Body: {
      workspace_id?:     string
      prompt?:           string
      negative_prompt?:  string
      provider?:         string
      model?:            string
      style_preset?:     string
      aspect_ratio?:     string
      width?:            number
      height?:           number
      budget_cap_usd?:   number
      created_by?:       string
    }
  }>('/generate', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.prompt || !b.provider) {
      return reply.code(400).send({ success: false, error: 'workspace_id, prompt, provider required' })
    }
    if (!VALID_PROVIDERS.includes(b.provider as ImageProvider)) {
      return reply.code(400).send({ success: false, error: `provider must be one of ${VALID_PROVIDERS.join(',')}` })
    }
    const result = await generateImage({
      workspaceId: b.workspace_id,
      prompt:      b.prompt,
      provider:    b.provider as ImageProvider,
      ...(b.negative_prompt !== undefined ? { negativePrompt: b.negative_prompt } : {}),
      ...(b.model           !== undefined ? { model:          b.model }           : {}),
      ...(b.style_preset    !== undefined ? { stylePreset:    b.style_preset }    : {}),
      ...(b.aspect_ratio    !== undefined ? { aspectRatio:    b.aspect_ratio }    : {}),
      ...(b.width           !== undefined ? { width:          b.width }           : {}),
      ...(b.height          !== undefined ? { height:         b.height }          : {}),
      ...(b.budget_cap_usd  !== undefined ? { budgetCapUsd:   b.budget_cap_usd }  : {}),
      ...(b.created_by      !== undefined ? { createdBy:      b.created_by }      : {}),
    })
    const status = result.status === 'succeeded' ? 200 : result.status === 'blocked' ? 403 : 502
    return reply.code(status).send({ success: result.status === 'succeeded', data: result })
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const limit = req.query.limit ? Number(req.query.limit) : 50
    return { success: true, data: await listGenerations(ws, limit) }
  })

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await getGeneration(req.params.id)
    if (!row) return reply.code(404).send({ success: false, error: 'not found' })
    return { success: true, data: row }
  })
}

export default imageRoutes
