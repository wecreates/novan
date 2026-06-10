/**
 * R600 — LTX-2 / LTX-Video adapter for Novan's AI video generator.
 *
 * LTX-2 (Lightricks) is a DiT-based audio+video foundation model with
 * synchronized audio and video. The official 22B weights need a Hopper/
 * Blackwell GPU; for production we route through Replicate which hosts
 * the LTX-Video family (and will host LTX-2 as it rolls out).
 *
 * Modes:
 *   - text2video        — prompt → mp4
 *   - image2video       — start image + prompt → mp4
 *   - keyframe          — start image + end image + prompt → mp4
 *   - audio2video       — audio file + prompt → mp4 with synced visuals (LTX-2 only)
 *
 * Env:
 *   REPLICATE_API_TOKEN     required
 *   LTX_REPLICATE_VERSION   override default Replicate model version
 *   LTX_REPLICATE_AUDIO_VERSION  override audio2video model version
 *
 * Records into R581 connector health as `replicate` (existing connector).
 */
import { Buffer } from 'node:buffer'

const REPLICATE_BASE = 'https://api.replicate.com/v1'

// Defaults point to the current production Lightricks LTX-Video Replicate model.
// LTX-2 audio-video model versions can be overridden via env when the API
// goes public on Replicate. Until then, audio2video falls back to LTX-Video.
const DEFAULT_LTX_VERSION       = process.env['LTX_REPLICATE_VERSION']       ?? '0a6cc6a1f76dc6f74cd64e64f2c9a0d2c9b97a0a9b3a9e89d97b1d68f23a5e6e' // placeholder; operator should override with the latest official LTX-Video hash
const DEFAULT_LTX_AUDIO_VERSION = process.env['LTX_REPLICATE_AUDIO_VERSION'] ?? DEFAULT_LTX_VERSION

function repToken(): string {
  const k = process.env['REPLICATE_API_TOKEN']
  if (!k) throw new Error('REPLICATE_API_TOKEN not set — set it in .env or platform env to use LTX-2')
  return k
}

async function recordHealth(workspaceId: string | undefined, ok: boolean, err?: string): Promise<void> {
  if (!workspaceId) return
  try {
    const mod = await import('./r581-connector-health.js')
    if (ok) await mod.recordConnectorOk(workspaceId, 'replicate')
    else    await mod.recordConnectorFail(workspaceId, 'replicate', err ?? 'unknown')
  } catch { /* tolerated */ }
}

async function pollPrediction(id: string, maxMs = 8 * 60_000): Promise<{ ok: boolean; output?: string | string[]; error?: string }> {
  const token = repToken()
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000))
    const r = await fetch(`${REPLICATE_BASE}/predictions/${id}`, { headers: { Authorization: `Token ${token}` } })
    if (!r.ok) continue
    const j = await r.json() as { status?: string; output?: string | string[]; error?: string }
    if (j.status === 'succeeded') return { ok: true, output: j.output }
    if (j.status === 'failed' || j.status === 'canceled') return { ok: false, error: j.error ?? 'replicate failed' }
  }
  return { ok: false, error: 'replicate poll timeout' }
}

interface SubmitInput {
  version: string
  input:   Record<string, unknown>
}

async function submit(s: SubmitInput, workspaceId?: string): Promise<{ ok: boolean; url?: string; predictionId?: string; error?: string; durationMs: number }> {
  const t0 = Date.now()
  try {
    const r = await fetch(`${REPLICATE_BASE}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Token ${repToken()}`, 'content-type': 'application/json', Prefer: 'wait=60' },
      body: JSON.stringify(s),
      signal: AbortSignal.timeout(120_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      const err = `replicate ${r.status} ${text.slice(0, 200)}`
      await recordHealth(workspaceId, false, err)
      return { ok: false, error: err, durationMs: Date.now() - t0 }
    }
    const j = await r.json() as { id?: string; output?: string | string[]; status?: string }
    let url: string | undefined
    if (j.output) url = Array.isArray(j.output) ? j.output[0] : j.output
    if (!url && j.id) {
      const polled = await pollPrediction(j.id)
      if (!polled.ok) {
        await recordHealth(workspaceId, false, polled.error)
        return { ok: false, error: polled.error, predictionId: j.id, durationMs: Date.now() - t0 }
      }
      url = Array.isArray(polled.output) ? polled.output?.[0] : (polled.output as string | undefined)
    }
    if (!url) {
      await recordHealth(workspaceId, false, 'no output url')
      return { ok: false, error: 'no replicate output url', predictionId: j.id, durationMs: Date.now() - t0 }
    }
    await recordHealth(workspaceId, true)
    const out: { ok: boolean; url: string; predictionId?: string; durationMs: number } = { ok: true, url, durationMs: Date.now() - t0 }
    if (j.id) out.predictionId = j.id
    return out
  } catch (e) {
    const err = (e as Error).message
    await recordHealth(workspaceId, false, err)
    return { ok: false, error: err, durationMs: Date.now() - t0 }
  }
}

// ─── Mode adapters ──────────────────────────────────────────────────────────

export interface LtxText2VideoInput {
  prompt:      string
  durationSec?:number  // 4..10 typical
  width?:      number
  height?:     number
  fps?:        number
  seed?:       number
  negativePrompt?: string
}

export async function ltxText2Video(input: LtxText2VideoInput, workspaceId?: string): Promise<{ ok: boolean; url?: string; predictionId?: string; error?: string; durationMs: number }> {
  if (!input.prompt) throw new Error('prompt required')
  return submit({
    version: DEFAULT_LTX_VERSION,
    input: {
      prompt: input.prompt.slice(0, 1500),
      ...(input.negativePrompt ? { negative_prompt: input.negativePrompt.slice(0, 500) } : {}),
      ...(input.durationSec ? { num_frames: Math.round(Math.max(4, Math.min(10, input.durationSec)) * (input.fps ?? 24)) } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      ...(input.fps ? { frame_rate: input.fps } : {}),
      ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
    },
  }, workspaceId)
}

export interface LtxImage2VideoInput {
  prompt:      string
  imageUrl:    string
  durationSec?:number
  fps?:        number
  seed?:       number
}

export async function ltxImage2Video(input: LtxImage2VideoInput, workspaceId?: string): Promise<{ ok: boolean; url?: string; predictionId?: string; error?: string; durationMs: number }> {
  if (!input.prompt) throw new Error('prompt required')
  if (!input.imageUrl) throw new Error('imageUrl required')
  return submit({
    version: DEFAULT_LTX_VERSION,
    input: {
      prompt: input.prompt.slice(0, 1500),
      image: input.imageUrl,
      ...(input.durationSec ? { num_frames: Math.round(Math.max(4, Math.min(10, input.durationSec)) * (input.fps ?? 24)) } : {}),
      ...(input.fps ? { frame_rate: input.fps } : {}),
      ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
    },
  }, workspaceId)
}

export interface LtxKeyframeInput {
  prompt:      string
  startImageUrl: string
  endImageUrl:   string
  durationSec?:number
  fps?:        number
  seed?:       number
}

export async function ltxKeyframe(input: LtxKeyframeInput, workspaceId?: string): Promise<{ ok: boolean; url?: string; predictionId?: string; error?: string; durationMs: number }> {
  if (!input.prompt) throw new Error('prompt required')
  if (!input.startImageUrl || !input.endImageUrl) throw new Error('startImageUrl + endImageUrl required')
  return submit({
    version: DEFAULT_LTX_VERSION,
    input: {
      prompt: input.prompt.slice(0, 1500),
      first_image: input.startImageUrl,
      last_image: input.endImageUrl,
      ...(input.durationSec ? { num_frames: Math.round(Math.max(4, Math.min(10, input.durationSec)) * (input.fps ?? 24)) } : {}),
      ...(input.fps ? { frame_rate: input.fps } : {}),
      ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
    },
  }, workspaceId)
}

export interface LtxAudio2VideoInput {
  prompt:      string
  audioUrl:    string
  durationSec?:number
  fps?:        number
  seed?:       number
}

export async function ltxAudio2Video(input: LtxAudio2VideoInput, workspaceId?: string): Promise<{ ok: boolean; url?: string; predictionId?: string; error?: string; durationMs: number }> {
  if (!input.prompt) throw new Error('prompt required')
  if (!input.audioUrl) throw new Error('audioUrl required')
  return submit({
    version: DEFAULT_LTX_AUDIO_VERSION,
    input: {
      prompt: input.prompt.slice(0, 1500),
      audio: input.audioUrl,
      ...(input.durationSec ? { num_frames: Math.round(Math.max(4, Math.min(10, input.durationSec)) * (input.fps ?? 24)) } : {}),
      ...(input.fps ? { frame_rate: input.fps } : {}),
      ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
    },
  }, workspaceId)
}

export async function ltxHealth(workspaceId?: string): Promise<{ ok: boolean; reason?: string; configured: boolean }> {
  if (!process.env['REPLICATE_API_TOKEN']) return { ok: false, configured: false, reason: 'REPLICATE_API_TOKEN not set' }
  try {
    const r = await fetch(`${REPLICATE_BASE}/account`, { headers: { Authorization: `Token ${process.env['REPLICATE_API_TOKEN']}` }, signal: AbortSignal.timeout(8_000) })
    const ok = r.ok
    await recordHealth(workspaceId, ok, ok ? undefined : `replicate /account ${r.status}`)
    return { ok, configured: true, ...(ok ? {} : { reason: `replicate /account ${r.status}` }) }
  } catch (e) {
    const reason = (e as Error).message
    await recordHealth(workspaceId, false, reason)
    return { ok: false, configured: true, reason }
  }
}

/** Download a generated video URL into a Buffer for downstream pipelines. */
export async function fetchVideo(url: string): Promise<{ ok: boolean; buf?: Buffer; bytes?: number; error?: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!r.ok) return { ok: false, error: `fetch ${r.status}` }
    const ab = await r.arrayBuffer()
    const buf = Buffer.from(ab)
    return { ok: true, buf, bytes: buf.length }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}
