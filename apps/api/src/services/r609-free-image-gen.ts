/**
 * R609 — Free / open-source image generation.
 *
 * Operator decided to skip paid image-gen APIs (Stability, OpenAI DALL-E,
 * fal, Cloudflare). This service routes to free + open-source paths only:
 *
 *   Tier 1 — HuggingFace Inference API (HF_TOKEN already in .env)
 *     - black-forest-labs/FLUX.1-schnell (Apache 2.0, ~1024² @ 1-4 steps,
 *       photoreal + text rendering, the best free model right now)
 *     - stabilityai/stable-diffusion-xl-base-1.0 (CreativeML OpenRAIL-M)
 *
 *   Tier 2 — Pollinations.ai (zero auth, zero env, FLUX-backed)
 *     - URL-only: https://image.pollinations.ai/prompt/{encoded}?width=W&height=H&seed=S
 *     - Best reliability fallback when HF rate-limits or is cold-starting
 *       a model. No account, no token, no rate limit advertised. Donates
 *       compute back as a public good — credit them in shipped artifacts
 *       when commercially significant.
 *
 * Both are non-commercial-friendly for outputs (FLUX-schnell is Apache 2.0
 * weights → outputs are fully unencumbered; Pollinations passes through to
 * the same model). Operator can sell POD products derived from outputs.
 *
 * Records into R581 connector health as 'huggingface' (existing).
 */
import { Buffer } from 'node:buffer'

// R609 — HuggingFace migrated serverless inference from api-inference.huggingface.co
// to router.huggingface.co/hf-inference in 2025. The old host returns ENOTFOUND.
const HF_BASE = 'https://router.huggingface.co/hf-inference/models'

const HF_MODELS = {
  flux_schnell: 'black-forest-labs/FLUX.1-schnell',
  flux_dev:     'black-forest-labs/FLUX.1-dev',
  sdxl:         'stabilityai/stable-diffusion-xl-base-1.0',
  sd3_medium:   'stabilityai/stable-diffusion-3-medium',
}

export type HfModel = keyof typeof HF_MODELS

export interface FreeImageInput {
  prompt:        string
  negativePrompt?: string
  width?:        number   // 512 / 768 / 1024
  height?:       number
  seed?:         number
  model?:        HfModel  // default flux_schnell
  steps?:        number   // 1-4 for schnell, ~28 for dev/sdxl
}

export interface FreeImageResult {
  ok:         boolean
  provider:   'huggingface' | 'pollinations' | null
  model?:     string
  bytes?:     number
  mime?:      string
  imageBase64?: string
  durationMs: number
  error?:     string
}

async function recordHealth(workspaceId: string | undefined, connector: string, ok: boolean, err?: string): Promise<void> {
  if (!workspaceId) return
  try {
    const mod = await import('./r581-connector-health.js')
    if (ok) await mod.recordConnectorOk(workspaceId, connector)
    else    await mod.recordConnectorFail(workspaceId, connector, err ?? 'unknown')
  } catch { /* tolerated */ }
}

// ─── Tier 1: HuggingFace ─────────────────────────────────────────────────────

async function tryHuggingFace(input: FreeImageInput, workspaceId?: string): Promise<FreeImageResult> {
  const token = process.env['HF_TOKEN']
  const t0 = Date.now()
  if (!token) return { ok: false, provider: null, durationMs: Date.now() - t0, error: 'HF_TOKEN not set' }
  const model = HF_MODELS[input.model ?? 'flux_schnell']
  const body: Record<string, unknown> = {
    inputs: input.prompt.slice(0, 2000),
    parameters: {
      ...(input.negativePrompt ? { negative_prompt: input.negativePrompt.slice(0, 500) } : {}),
      ...(input.width  ? { width:  Math.max(256, Math.min(1536, input.width))  } : { width: 1024 }),
      ...(input.height ? { height: Math.max(256, Math.min(1536, input.height)) } : { height: 1024 }),
      ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
      num_inference_steps: input.steps ?? (input.model === 'flux_schnell' || !input.model ? 4 : 28),
    },
  }
  try {
    const r = await fetch(`${HF_BASE}/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'image/png' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      const err = `huggingface ${r.status} ${text.slice(0, 200)}`
      await recordHealth(workspaceId, 'huggingface', false, err)
      return { ok: false, provider: 'huggingface', model, durationMs: Date.now() - t0, error: err }
    }
    const ab = await r.arrayBuffer()
    const buf = Buffer.from(ab)
    if (buf.length < 200) {
      const err = 'huggingface: empty/error response'
      await recordHealth(workspaceId, 'huggingface', false, err)
      return { ok: false, provider: 'huggingface', model, durationMs: Date.now() - t0, error: err }
    }
    await recordHealth(workspaceId, 'huggingface', true)
    return { ok: true, provider: 'huggingface', model, bytes: buf.length, mime: r.headers.get('content-type') ?? 'image/png', imageBase64: buf.toString('base64'), durationMs: Date.now() - t0 }
  } catch (e) {
    const err = (e as Error).message
    await recordHealth(workspaceId, 'huggingface', false, err)
    return { ok: false, provider: 'huggingface', model, durationMs: Date.now() - t0, error: err }
  }
}

// ─── Tier 2: Pollinations.ai (zero-auth) ────────────────────────────────────

async function tryPollinations(input: FreeImageInput, attempt = 1): Promise<FreeImageResult> {
  const t0 = Date.now()
  const w = Math.max(256, Math.min(1536, input.width ?? 1024))
  const h = Math.max(256, Math.min(1536, input.height ?? 1024))
  const seed = typeof input.seed === 'number' ? input.seed : Math.floor(t0 % 1_000_000)
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(input.prompt.slice(0, 2000))}?width=${w}&height=${h}&seed=${seed}&nologo=true`
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { accept: 'image/png,image/jpeg,image/webp' },
      signal: AbortSignal.timeout(120_000),
    })
    if (r.status === 402 && attempt < 3) {
      // Pollinations free tier caps 1 concurrent request per IP. Back off + retry.
      await new Promise(res => setTimeout(res, 2000 + attempt * 2000))
      return tryPollinations(input, attempt + 1)
    }
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return { ok: false, provider: 'pollinations', durationMs: Date.now() - t0, error: `pollinations ${r.status} ${text.slice(0, 200)}` }
    }
    const ab = await r.arrayBuffer()
    const buf = Buffer.from(ab)
    if (buf.length < 200) return { ok: false, provider: 'pollinations', durationMs: Date.now() - t0, error: 'pollinations: empty response' }
    return { ok: true, provider: 'pollinations', model: 'pollinations.ai', bytes: buf.length, mime: r.headers.get('content-type') ?? 'image/png', imageBase64: buf.toString('base64'), durationMs: Date.now() - t0 }
  } catch (e) { return { ok: false, provider: 'pollinations', durationMs: Date.now() - t0, error: (e as Error).message } }
}

// ─── Main: failover chain ────────────────────────────────────────────────────

export async function generateFreeImage(input: FreeImageInput, workspaceId?: string): Promise<FreeImageResult> {
  if (!input.prompt?.trim()) {
    return { ok: false, provider: null, durationMs: 0, error: 'prompt required' }
  }
  const t0 = Date.now()
  // Tier 1: HuggingFace
  const hf = await tryHuggingFace(input, workspaceId)
  if (hf.ok) return hf
  // Tier 2: Pollinations (no auth needed, always tries)
  const poll = await tryPollinations(input)
  if (poll.ok) return poll
  // Both failed — return composite error
  return {
    ok: false, provider: null,
    durationMs: Date.now() - t0,
    error: `all free providers failed — HF: ${hf.error ?? 'unknown'} | Pollinations: ${poll.error ?? 'unknown'}`,
  }
}

// ─── Health probe (used by R608 wire_check) ─────────────────────────────────

export async function freeImageHealth(workspaceId?: string): Promise<{ ok: boolean; providers: Array<{ name: string; ok: boolean; reason?: string }>; configured: boolean }> {
  const out: Array<{ name: string; ok: boolean; reason?: string }> = []
  // HF: just check token presence + simple GET to model index — don't burn a generation
  const hasHfToken = !!process.env['HF_TOKEN']
  if (hasHfToken) {
    try {
      // Probe via /api/models metadata (lightweight, doesn't burn inference)
      const r = await fetch(`https://huggingface.co/api/models/${HF_MODELS.flux_schnell}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${process.env['HF_TOKEN']}` },
        signal: AbortSignal.timeout(8_000),
      })
      out.push({ name: 'huggingface', ok: r.ok, reason: r.ok ? undefined : `status ${r.status}` })
      await recordHealth(workspaceId, 'huggingface', r.ok)
    } catch (e) { out.push({ name: 'huggingface', ok: false, reason: (e as Error).message }) }
  } else {
    out.push({ name: 'huggingface', ok: false, reason: 'HF_TOKEN not set' })
  }
  // Pollinations: hit the homepage HEAD-like check
  try {
    const r = await fetch('https://image.pollinations.ai/prompt/test?width=64&height=64&nologo=true', { method: 'GET', signal: AbortSignal.timeout(10_000) })
    out.push({ name: 'pollinations', ok: r.ok, reason: r.ok ? undefined : `status ${r.status}` })
  } catch (e) { out.push({ name: 'pollinations', ok: false, reason: (e as Error).message }) }
  const ok = out.some(p => p.ok)
  return { ok, providers: out, configured: hasHfToken }
}
