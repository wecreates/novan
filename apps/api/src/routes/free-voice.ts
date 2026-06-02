/**
 * Free voice routes — R146.110 — catalog + preview + speak proxy.
 *
 * Mounted at /api/v1/free-voice.
 *
 *   GET  /catalog                 list all free voices grouped by source
 *   GET  /preview/:id             stream cached preview audio for a voice
 *   POST /speak                   synthesize arbitrary text { voiceId, text }
 *   GET  /sample-line             return the canonical preview-line string
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  listFreeVoices, getCachedPreview, synthesizeWithFreeVoice, previewLine,
} from '../services/voice-free-catalog.js'

const freeVoiceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/catalog', async () => {
    const all = listFreeVoices()
    const bySource: Record<string, typeof all> = {}
    for (const v of all) (bySource[v.source] ??= []).push(v)
    return {
      success: true,
      data: {
        total: all.length,
        bySource,
        previewLine: previewLine(),
        sources: Object.entries(bySource).map(([source, voices]) => ({
          source,
          count: voices.length,
          needsKey: voices.some(v => v.needsKey),
        })),
      },
    }
  })

  fastify.get('/sample-line', async () => ({ success: true, data: { line: previewLine() } }))

  fastify.get<{ Params: { id: string } }>('/preview/:id', async (req, reply) => {
    // Accept the colon-bearing voice id as a single param via URL-encoding.
    const id = decodeURIComponent(req.params.id)
    const r = await getCachedPreview(id)
    if ('error' in r) return reply.code(502).send({ success: false, error: r.error })
    return reply.type(r.contentType).header('cache-control', 'public, max-age=300').send(r.bytes)
  })

  fastify.post<{ Body: { voiceId?: string; text?: string } }>('/speak', async (req, reply) => {
    const voiceId = req.body?.voiceId
    const text = req.body?.text
    if (!voiceId || !text) return reply.code(400).send({ success: false, error: 'voiceId and text required' })
    if (text.length > 2000) return reply.code(400).send({ success: false, error: 'text exceeds 2000 chars' })
    const r = await synthesizeWithFreeVoice(voiceId, text)
    if (!r.ok || !r.bytes) return reply.code(502).send({ success: false, error: r.error })
    return reply.type(r.contentType ?? 'audio/mpeg').send(r.bytes)
  })
}

export default freeVoiceRoutes
