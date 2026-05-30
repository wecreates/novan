/**
 * image-studio.ts — Routes for the Image Studio (premium generation UI).
 *
 * Mounted at /api/v1/studio
 *
 * Endpoints:
 *   POST /generate           single image via smart router (provider optional)
 *   POST /batch              generate N images with seed sweep
 *   POST /rate               rate 1..5 — feeds back into router
 *   POST /favorite           toggle favorite
 *   GET  /history            workspace image history with filters
 *   GET  /router/scores      transparent provider scores
 *   GET  /templates          list prompt templates
 *   POST /templates          create template
 *   POST /templates/:id/use  bump useCount + return template
 *   DELETE /templates/:id    delete template
 */
import type { FastifyPluginAsync } from 'fastify'
import { db }                      from '../db/client.js'
import { imageGenerations, promptTemplates } from '../db/schema.js'
import { and, desc, eq, sql }      from 'drizzle-orm'
import { v7 as uuidv7 }            from 'uuid'
import {
  generateImage, generateBatch, rateImage, setFavorite,
  listAvailableProviders, type ImageProvider,
} from '../services/image-generator.js'
import { selectProvider, providerScores } from '../services/image-router.js'
import { rewritePrompt }           from '../services/prompt-rewriter.js'
import { reviewGeneration, reviewBatch, creativeMetrics, improvePrompt, makePromptPremium, safetyCheck } from '../services/image-creative.js'
import { scorePrompt } from '../services/image-quality.js'

const VALID: ImageProvider[] = ['openai', 'stability', 'replicate', 'fal']

const studioRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.post<{
    Body: {
      workspace_id?: string; prompt?: string; negative_prompt?: string
      provider?: string; model?: string; aspect_ratio?: string
      width?: number; height?: number; seed?: number
      source_image_url?: string; brand_category?: string
      style_preset?: string; budget_cap_usd?: number
      enhance_prompt?: boolean
    }
  }>('/generate', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.prompt) {
      return reply.code(400).send({ success: false, error: 'workspace_id, prompt required' })
    }

    // Optional prompt enhancement
    let enhanced: string | undefined
    if (b.enhance_prompt) {
      const r = await rewritePrompt(b.workspace_id, b.prompt, 'image')
      if (!('error' in r)) enhanced = r.improved
    }

    // Router resolves provider when not pinned
    const pinned = b.provider && VALID.includes(b.provider as ImageProvider) ? (b.provider as ImageProvider) : undefined
    let chosen: ImageProvider, estimateUsd: number, provenance: 'auto' | 'user_pinned', reasons: string[]
    try {
      const route = await selectProvider({
        workspaceId: b.workspace_id,
        ...(pinned        !== undefined ? { pinned } : {}),
        ...(b.width       !== undefined ? { width:  b.width  } : {}),
        ...(b.height      !== undefined ? { height: b.height } : {}),
        ...(b.model       !== undefined ? { model:  b.model  } : {}),
        ...(b.aspect_ratio !== undefined ? { aspectRatio: b.aspect_ratio } : {}),
        ...(b.brand_category !== undefined ? { brandCategory: b.brand_category } : {}),
      })
      chosen = route.provider; estimateUsd = route.estimateUsd
      provenance = route.provenance; reasons = route.reasons
    } catch (e) {
      return reply.code(503).send({ success: false, error: (e as Error).message })
    }

    const result = await generateImage({
      workspaceId: b.workspace_id,
      prompt:      b.prompt,
      provider:    chosen,
      routerProvenance: provenance,
      ...(enhanced            !== undefined ? { enhancedPrompt: enhanced } : {}),
      ...(b.negative_prompt   !== undefined ? { negativePrompt: b.negative_prompt } : {}),
      ...(b.model             !== undefined ? { model:        b.model        } : {}),
      ...(b.style_preset      !== undefined ? { stylePreset:  b.style_preset } : {}),
      ...(b.aspect_ratio      !== undefined ? { aspectRatio:  b.aspect_ratio } : {}),
      ...(b.width             !== undefined ? { width:        b.width        } : {}),
      ...(b.height            !== undefined ? { height:       b.height       } : {}),
      ...(b.seed              !== undefined ? { seed:         b.seed         } : {}),
      ...(b.source_image_url  !== undefined ? { sourceImageUrl: b.source_image_url } : {}),
      ...(b.brand_category    !== undefined ? { brandCategory: b.brand_category } : {}),
      ...(b.budget_cap_usd    !== undefined ? { budgetCapUsd: b.budget_cap_usd } : {}),
    })
    const code = result.status === 'succeeded' ? 200 : result.status === 'blocked' ? 403 : 502
    return reply.code(code).send({
      success: result.status === 'succeeded',
      data: { ...result, router: { provenance, reasons, estimateUsd } },
    })
  })

  fastify.post<{
    Body: {
      workspace_id?: string; prompt?: string; count?: number
      provider?: string; model?: string; aspect_ratio?: string
      base_seed?: number; brand_category?: string
      enhance_prompt?: boolean
    }
  }>('/batch', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.prompt || !b.count) {
      return reply.code(400).send({ success: false, error: 'workspace_id, prompt, count required' })
    }

    let enhanced: string | undefined
    if (b.enhance_prompt) {
      const r = await rewritePrompt(b.workspace_id, b.prompt, 'image')
      if (!('error' in r)) enhanced = r.improved
    }

    const pinned = b.provider && VALID.includes(b.provider as ImageProvider) ? (b.provider as ImageProvider) : undefined
    let chosen: ImageProvider
    try {
      const route = await selectProvider({
        workspaceId: b.workspace_id,
        ...(pinned         !== undefined ? { pinned } : {}),
        ...(b.aspect_ratio !== undefined ? { aspectRatio: b.aspect_ratio } : {}),
        ...(b.model        !== undefined ? { model:       b.model        } : {}),
      })
      chosen = route.provider
    } catch (e) { return reply.code(503).send({ success: false, error: (e as Error).message }) }

    const out = await generateBatch({
      workspaceId: b.workspace_id,
      prompt:      b.prompt,
      provider:    chosen,
      routerProvenance: pinned ? 'user_pinned' : 'auto',
      count:       b.count,
      ...(enhanced       !== undefined ? { enhancedPrompt: enhanced } : {}),
      ...(b.model        !== undefined ? { model:       b.model        } : {}),
      ...(b.aspect_ratio !== undefined ? { aspectRatio: b.aspect_ratio } : {}),
      ...(b.base_seed    !== undefined ? { baseSeed:    b.base_seed    } : {}),
      ...(b.brand_category !== undefined ? { brandCategory: b.brand_category } : {}),
    })
    return { success: true, data: out }
  })

  fastify.post<{ Body: { workspace_id?: string; id?: string; rating?: number } }>('/rate', async (req, reply) => {
    const { workspace_id, id, rating } = req.body
    if (!workspace_id || !id || typeof rating !== 'number') {
      return reply.code(400).send({ success: false, error: 'workspace_id, id, rating required' })
    }
    return { success: true, data: await rateImage(workspace_id, id, rating) }
  })

  fastify.post<{ Body: { workspace_id?: string; id?: string; favorite?: boolean } }>('/favorite', async (req, reply) => {
    const { workspace_id, id, favorite } = req.body
    if (!workspace_id || !id || typeof favorite !== 'boolean') {
      return reply.code(400).send({ success: false, error: 'workspace_id, id, favorite required' })
    }
    return { success: true, data: await setFavorite(workspace_id, id, favorite) }
  })

  fastify.get<{
    Querystring: { workspace_id?: string; limit?: string; status?: string; favorites?: string; brand_category?: string }
  }>('/history', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const limit = req.query.limit ? Math.min(200, Number(req.query.limit)) : 50
    const conds = [eq(imageGenerations.workspaceId, ws)]
    if (req.query.status)         conds.push(eq(imageGenerations.status, req.query.status))
    if (req.query.favorites === 'true') conds.push(eq(imageGenerations.isFavorite, true))
    if (req.query.brand_category) conds.push(eq(imageGenerations.brandCategory, req.query.brand_category))
    const rows = await db.select().from(imageGenerations)
      .where(and(...conds))
      .orderBy(desc(imageGenerations.createdAt))
      .limit(limit).catch(() => [])
    return { success: true, data: rows }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/router/scores', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return {
      success: true,
      data: {
        available: listAvailableProviders(),
        scores:    await providerScores(ws),
      },
    }
  })

  // ─── Prompt templates ──────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string; category?: string } }>('/templates', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const conds = [eq(promptTemplates.workspaceId, ws)]
    if (req.query.category) conds.push(eq(promptTemplates.category, req.query.category))
    return {
      success: true,
      data: await db.select().from(promptTemplates).where(and(...conds))
        .orderBy(desc(promptTemplates.useCount), desc(promptTemplates.updatedAt))
        .catch(() => []),
    }
  })

  fastify.post<{
    Body: {
      workspace_id?: string; name?: string; category?: string
      brand_category?: string; prompt?: string; negative_prompt?: string
      default_provider?: string; default_model?: string
      default_aspect_ratio?: string; tags?: string[]
    }
  }>('/templates', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.name || !b.prompt) {
      return reply.code(400).send({ success: false, error: 'workspace_id, name, prompt required' })
    }
    const id = uuidv7()
    const now = Date.now()
    await db.insert(promptTemplates).values({
      id, workspaceId: b.workspace_id,
      name: b.name, category: b.category ?? 'image',
      brandCategory: b.brand_category ?? null,
      prompt: b.prompt,
      negativePrompt: b.negative_prompt ?? null,
      defaultProvider: b.default_provider ?? null,
      defaultModel: b.default_model ?? null,
      defaultAspectRatio: b.default_aspect_ratio ?? null,
      tags: b.tags ?? [],
      createdAt: now, updatedAt: now,
    }).catch((e: Error) => { console.error('[image-studio]', e.message); return null })
    return { success: true, data: { id } }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/templates/:id/use', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await db.update(promptTemplates)
      .set({ useCount: sql`${promptTemplates.useCount} + 1`, updatedAt: Date.now() })
      .where(and(eq(promptTemplates.id, req.params.id), eq(promptTemplates.workspaceId, ws)))
      .catch((e: Error) => { console.error('[image-studio]', e.message); return null })
    // R146.34 — defense-in-depth scope. The UPDATE above is workspace-scoped,
    // but the readback was eq(id) only, which would return any workspace's
    // template if the caller knew the UUID. Scope the SELECT too.
    const t = await db.select().from(promptTemplates).where(and(eq(promptTemplates.id, req.params.id), eq(promptTemplates.workspaceId, ws))).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[image-studio]', e.message); return null })
    return { success: true, data: t }
  })

  fastify.delete<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/templates/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await db.delete(promptTemplates)
      .where(and(eq(promptTemplates.id, req.params.id), eq(promptTemplates.workspaceId, ws)))
      .catch((e: Error) => { console.error('[image-studio]', e.message); return null })
    return { success: true }
  })

  // ─── War Room aggregate (image stats) ──────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/stats', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const dayAgo = Date.now() - 24 * 60 * 60_000
    const weekAgo = Date.now() - 7 * 24 * 60 * 60_000
    const [today, week, failed, favs, byProvider] = await Promise.all([
      db.select({
        n: sql<number>`count(*)::int`,
        spend: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float`,
      }).from(imageGenerations)
        .where(and(eq(imageGenerations.workspaceId, ws), sql`${imageGenerations.createdAt} >= ${dayAgo}`))
        .then(r => r[0]).catch(() => ({ n: 0, spend: 0 })),
      db.select({
        n: sql<number>`count(*)::int`,
        spend: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float`,
      }).from(imageGenerations)
        .where(and(eq(imageGenerations.workspaceId, ws), sql`${imageGenerations.createdAt} >= ${weekAgo}`))
        .then(r => r[0]).catch(() => ({ n: 0, spend: 0 })),
      db.select({ n: sql<number>`count(*)::int` }).from(imageGenerations)
        .where(and(eq(imageGenerations.workspaceId, ws), eq(imageGenerations.status, 'failed'), sql`${imageGenerations.createdAt} >= ${dayAgo}`))
        .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
      db.select({ n: sql<number>`count(*)::int` }).from(imageGenerations)
        .where(and(eq(imageGenerations.workspaceId, ws), eq(imageGenerations.isFavorite, true)))
        .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
      db.select({
        provider: imageGenerations.provider,
        n:        sql<number>`count(*)::int`,
        spend:    sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float`,
        avgRating: sql<number>`coalesce(avg(${imageGenerations.userRating}), 0)::float`,
      }).from(imageGenerations)
        .where(and(eq(imageGenerations.workspaceId, ws), sql`${imageGenerations.createdAt} >= ${weekAgo}`))
        .groupBy(imageGenerations.provider).catch(() => []),
    ])
    return {
      success: true,
      data: {
        today: { count: Number(today?.n ?? 0), spendUsd: Number(Number(today?.spend ?? 0).toFixed(4)) },
        week:  { count: Number(week?.n  ?? 0), spendUsd: Number(Number(week?.spend  ?? 0).toFixed(4)) },
        failed24h: failed,
        favorites: favs,
        byProvider: byProvider.map(p => ({
          provider: p.provider, count: Number(p.n),
          spendUsd: Number(Number(p.spend).toFixed(4)),
          avgRating: Number(Number(p.avgRating).toFixed(2)),
        })),
      },
    }
  })

  // ─── Reference uploads (sketches, mockups, screenshots) ─────────────
  // Accepts a data URL or remote URL. We do NOT decode + persist binary
  // here — the reference is stored as a URL on the generation row so the
  // selected provider can pull it. Operators paste / drop images in the
  // workspace; the canvas converts them to data URLs client-side.
  // R146.28 — per-route bodyLimit override. Server global is 256KB
  // (set in server.ts) which works for everything else; reference
  // uploads can be up to 4.5MB base64 image data.
  fastify.post<{ Body: { workspace_id?: string; data_url?: string; url?: string; kind?: string } }>('/reference', {
    bodyLimit: 5 * 1024 * 1024,
  }, async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const src = req.body.data_url ?? req.body.url
    if (!src) return reply.code(400).send({ success: false, error: 'data_url or url required' })
    if (src.length > 4_500_000) return reply.code(413).send({ success: false, error: 'reference too large (max ~3 MB base64)' })
    if (!/^data:image\/(png|jpe?g|webp|gif)/.test(src) && !/^https?:\/\//.test(src)) {
      return reply.code(400).send({ success: false, error: 'must be a data:image/* URL or http(s) URL' })
    }
    // Audit the reference attachment but don't store the body server-side —
    // the client passes the URL on the next generate call.
    return { success: true, data: { ref: src, kind: req.body.kind ?? 'reference' } }
  })

  // ─── Creative graph (prompt clusters / remix trees / quality heat) ───
  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string; limit?: string } }>('/creative/graph', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_days ? Number(req.query.window_days) * 86_400_000 : 30 * 86_400_000
    const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 200
    const { buildCreativeGraph } = await import('../services/image-creative-graph.js')
    return { success: true, data: await buildCreativeGraph(ws, { windowMs, limit }) }
  })

  // ─── Creative Director: scoring, anti-slop, originality ──────────────
  fastify.post<{ Body: { prompt?: string } }>('/creative/score-prompt', async (req, reply) => {
    const p = (req.body.prompt ?? '').toString()
    if (!p.trim()) return reply.code(400).send({ success: false, error: 'prompt required' })
    return { success: true, data: scorePrompt(p) }
  })

  fastify.post<{ Body: { prompt?: string } }>('/creative/safety', async (req, reply) => {
    const p = (req.body.prompt ?? '').toString()
    if (!p.trim()) return reply.code(400).send({ success: false, error: 'prompt required' })
    return { success: true, data: safetyCheck(p) }
  })

  fastify.post<{ Body: { prompt?: string } }>('/creative/improve-prompt', async (req, reply) => {
    const p = (req.body.prompt ?? '').toString()
    if (!p.trim()) return reply.code(400).send({ success: false, error: 'prompt required' })
    return { success: true, data: improvePrompt(p) }
  })

  fastify.post<{ Body: { prompt?: string } }>('/creative/make-premium', async (req, reply) => {
    const p = (req.body.prompt ?? '').toString()
    if (!p.trim()) return reply.code(400).send({ success: false, error: 'prompt required' })
    return { success: true, data: makePromptPremium(p) }
  })

  fastify.post<{ Body: { workspace_id?: string; generation_id?: string; reviewer?: string } }>('/creative/review', async (req, reply) => {
    const { workspace_id, generation_id, reviewer } = req.body
    if (!workspace_id || !generation_id) return reply.code(400).send({ success: false, error: 'workspace_id, generation_id required' })
    const v = await reviewGeneration(workspace_id, generation_id, reviewer)
    if (!v) return reply.code(404).send({ success: false, error: 'generation not found' })
    return { success: true, data: v }
  })

  fastify.post<{ Body: { workspace_id?: string; limit?: number } }>('/creative/review-batch', async (req, reply) => {
    const { workspace_id, limit } = req.body
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await reviewBatch(workspace_id, limit ?? 50) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/creative/metrics', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const windowMs = req.query.window_days ? Number(req.query.window_days) * 86_400_000 : 7 * 86_400_000
    return { success: true, data: await creativeMetrics(ws, { windowMs }) }
  })
}

export default studioRoutes
