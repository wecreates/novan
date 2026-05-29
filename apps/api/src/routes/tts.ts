/**
 * TTS routes — voice profile CRUD + synthesize proxy.
 *
 * Mounted at /api/v1/tts.
 *
 *   GET  /sidecar/health                       sidecar reachability
 *   GET  /profiles                             list profiles for ws
 *   POST /profiles                             create / register
 *   POST /profiles/:id/activate                set as the active voice
 *   POST /profiles/:id/consent                 attest consent (audit)
 *   DEL  /profiles/:id                         remove
 *   POST /synthesize                           text → audio/wav stream
 *
 * Honest scope:
 *   - Reference audio files are uploaded out-of-band into
 *     data/voice-refs/<workspace>/ — the API only registers the
 *     metadata. This avoids an oversized multipart upload pipeline
 *     and matches the way the sidecar reads from disk.
 *   - No celebrity presets are shipped. Operators provide their own
 *     audio and self-attest consent for any voices they upload.
 */
import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 } from 'uuid'
import { and, eq, desc } from 'drizzle-orm'
import { db } from '../db/client.js'
import { voiceProfiles } from '../db/schema.js'
import {
  probeSidecar, synthesize,
  validateRefPath, validateProfileName, isSupportedLanguage,
  resolveRefPath,
} from '../services/tts-bridge.js'
import fs from 'node:fs/promises'

const ttsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Sidecar health ─────────────────────────────────────────────────
  fastify.get('/sidecar/health', async () => {
    const h = await probeSidecar()
    return { success: true, data: h }
  })

  // ── List profiles ──────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/profiles', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await db.select().from(voiceProfiles)
      .where(eq(voiceProfiles.workspaceId, ws))
      .orderBy(desc(voiceProfiles.createdAt))
      .catch(() => [])
    return { success: true, data: rows }
  })

  // ── Register a profile (audio file must already be on disk) ────────
  fastify.post<{ Body: {
    workspace_id?:     string
    name?:             string
    ref_audio_path?:   string
    language?:         string
    notes?:            string
    consent_attested?: boolean
  } }>('/profiles', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const n = validateProfileName(b.name ?? '')
    if (!n.ok) return reply.code(400).send({ success: false, error: n.reason })

    const p = validateRefPath(b.ref_audio_path ?? '')
    if (!p.ok) return reply.code(400).send({ success: false, error: p.reason })

    // Existence check — the sidecar will also verify, but a 404 here is
    // friendlier than a sidecar-side error after the row is written.
    try { await fs.access(p.abs!) }
    catch { return reply.code(404).send({ success: false, error: `ref audio not on disk: ${p.rel}` }) }

    const lang = (b.language ?? 'en').toLowerCase()
    if (!isSupportedLanguage(lang)) {
      return reply.code(400).send({ success: false, error: `unsupported language: ${lang}` })
    }

    const id  = uuidv7()
    const now = Date.now()
    await db.insert(voiceProfiles).values({
      id, workspaceId: b.workspace_id,
      name: (b.name ?? '').trim(),
      refAudioPath: p.rel!,
      language: lang,
      consentAttested: Boolean(b.consent_attested),
      isActive: false,
      notes: (b.notes ?? '').slice(0, 500) || null,
      createdAt: now, updatedAt: now,
    }).catch((e: Error) => { console.error('[tts]', e.message); return null })

    return reply.code(201).send({ success: true, data: { id } })
  })

  // ── Activate (mark as the workspace's default voice) ───────────────
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/profiles/:id/activate', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const row = await db.select().from(voiceProfiles)
      .where(and(eq(voiceProfiles.workspaceId, ws), eq(voiceProfiles.id, req.params.id)))
      .limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[tts]', e.message); return null })
    if (!row) return reply.code(404).send({ success: false, error: 'profile not found' })
    if (!row.consentAttested) {
      return reply.code(400).send({ success: false, error: 'consent must be attested before activation' })
    }

    // Single-active-per-workspace invariant
    await db.update(voiceProfiles)
      .set({ isActive: false, updatedAt: Date.now() })
      .where(eq(voiceProfiles.workspaceId, ws)).catch((e: Error) => { console.error('[tts]', e.message); return null })
    await db.update(voiceProfiles)
      .set({ isActive: true, updatedAt: Date.now() })
      .where(eq(voiceProfiles.id, req.params.id)).catch((e: Error) => { console.error('[tts]', e.message); return null })

    return { success: true }
  })

  // ── Consent attestation ────────────────────────────────────────────
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; attested?: boolean } }>('/profiles/:id/consent', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await db.update(voiceProfiles)
      .set({ consentAttested: req.body.attested !== false, updatedAt: Date.now() })
      .where(and(eq(voiceProfiles.workspaceId, ws), eq(voiceProfiles.id, req.params.id)))
      .catch((e: Error) => { console.error('[tts]', e.message); return null })
    return { success: true }
  })

  // ── Delete a profile (does NOT remove the audio file) ──────────────
  fastify.delete<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/profiles/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await db.delete(voiceProfiles)
      .where(and(eq(voiceProfiles.workspaceId, ws), eq(voiceProfiles.id, req.params.id)))
      .catch((e: Error) => { console.error('[tts]', e.message); return null })
    return { success: true }
  })

  // ── Synthesize ─────────────────────────────────────────────────────
  // Body:
  //   workspace_id  required
  //   text          required
  //   profile_id    optional — when omitted, uses workspace's active profile
  //   language      optional override
  //   speed         optional (0.5..1.5)
  fastify.post<{ Body: {
    workspace_id?: string
    text?:         string
    profile_id?:   string
    language?:     string
    speed?:        number
  } }>('/synthesize', {
    // ElevenLabs / OpenAI TTS bill per character — cap at 30/min/IP.
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    if (!b.text || b.text.trim().length === 0) {
      return reply.code(400).send({ success: false, error: 'text required' })
    }

    // Resolve profile → either the named one or the active default.
    let speakerWav: string | undefined
    let language   = b.language ?? 'en'
    if (b.profile_id) {
      const row = await db.select().from(voiceProfiles)
        .where(and(eq(voiceProfiles.workspaceId, b.workspace_id), eq(voiceProfiles.id, b.profile_id)))
        .limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[tts]', e.message); return null })
      if (!row) return reply.code(404).send({ success: false, error: 'profile not found' })
      if (!row.consentAttested) {
        return reply.code(400).send({ success: false, error: 'profile consent not attested' })
      }
      speakerWav = row.refAudioPath
      if (!b.language) language = row.language
    } else {
      const row = await db.select().from(voiceProfiles)
        .where(and(eq(voiceProfiles.workspaceId, b.workspace_id), eq(voiceProfiles.isActive, true)))
        .limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[tts]', e.message); return null })
      if (row) {
        speakerWav = row.refAudioPath
        if (!b.language) language = row.language
      }
      // If no active profile, the sidecar will pick a default speaker.
    }

    const result = await synthesize({
      text: b.text,
      ...(speakerWav   ? { speakerWav } : {}),
      language,
      ...(typeof b.speed === 'number' ? { speed: b.speed } : {}),
    })
    if (!result.ok) {
      const code = result.fallback === 'sidecar_unreachable' ? 503
        : result.fallback === 'invalid_input' ? 400
        : 502
      return reply.code(code).send({ success: false, error: result.error, fallback: result.fallback })
    }
    reply.header('Content-Type', result.mime ?? 'audio/wav')
    reply.header('X-Voice-Profile', speakerWav ?? 'default')
    return reply.send(Buffer.from(result.audio!))
  })

  // Convenience: resolve where an audio file should live on disk so the
  // UI can show the operator the expected location without exposing
  // arbitrary fs reads.
  fastify.get<{ Querystring: { workspace_id?: string; name?: string } }>('/profiles/expected-path', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const filename = (req.query.name ?? 'voice').replace(/[^a-z0-9._-]/gi, '_')
    const rel = `${ws}/${filename}.wav`
    return { success: true, data: { ref_audio_path: rel, abs_hint: resolveRefPath(rel) } }
  })
}

export default ttsRoutes
