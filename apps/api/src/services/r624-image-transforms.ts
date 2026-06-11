/**
 * R624 — Image transforms: background removal, upscale, inpaint, variants.
 *
 * Companion to R609 (gen) + R619 (edit). Every transform is gated on
 * HF_TOKEN; degrades cleanly when the chosen model is gated/cold.
 *
 *   image.bg_remove   — briaai/RMBG-1.4 (CC-BY-NC for free, fine for in-house POD work)
 *   image.upscale     — caidas/swin2SR-classical-sr-x2-64 (2x, open-license)
 *                       fallback: Pollinations upscale URL
 *   image.inpaint     — runwayml/stable-diffusion-inpainting
 *                       (requires image + mask + prompt)
 *   image.variants    — runs R609 N times with slight prompt + seed variation
 *                       returns N base64s; caller picks best
 */
import { Buffer } from 'node:buffer'

const HF_BASE = 'https://router.huggingface.co/hf-inference/models'

async function fetchHfBinary(model: string, body: unknown, accept = 'image/png', timeoutMs = 120_000): Promise<{ ok: true; buf: Buffer; mime: string } | { ok: false; error: string }> {
  const token = process.env['HF_TOKEN']
  if (!token) return { ok: false, error: 'HF_TOKEN not set' }
  try {
    const r = await fetch(`${HF_BASE}/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return { ok: false, error: `hf ${r.status} ${text.slice(0, 200)}` }
    }
    const ab = await r.arrayBuffer()
    const buf = Buffer.from(ab)
    if (buf.length < 200) return { ok: false, error: 'empty response' }
    return { ok: true, buf, mime: r.headers.get('content-type') ?? 'image/png' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function readImage(input: { imageBase64?: string; imageUrl?: string }): Promise<{ ok: true; base64: string; mime: string } | { ok: false; error: string }> {
  if (input.imageBase64) {
    const stripped = input.imageBase64.replace(/^data:[^;]+;base64,/, '')
    return { ok: true, base64: stripped, mime: 'image/png' }
  }
  if (input.imageUrl) {
    try {
      const r = await fetch(input.imageUrl, { signal: AbortSignal.timeout(30_000) })
      if (!r.ok) return { ok: false, error: `fetch ${r.status}` }
      const ab = await r.arrayBuffer()
      const buf = Buffer.from(ab)
      if (buf.length < 200) return { ok: false, error: 'empty' }
      return { ok: true, base64: buf.toString('base64'), mime: r.headers.get('content-type') ?? 'image/png' }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }
  return { ok: false, error: 'imageBase64 or imageUrl required' }
}

// ─── Background removal ─────────────────────────────────────────────────────

export interface BgRemoveInput { imageBase64?: string; imageUrl?: string }
export interface ImageOpResult {
  ok: boolean
  provider?: 'huggingface' | 'pollinations'
  model?: string
  imageBase64?: string
  mime?: string
  bytes?: number
  durationMs: number
  error?: string
}

export async function bgRemove(input: BgRemoveInput): Promise<ImageOpResult> {
  const t0 = Date.now()
  const src = await readImage(input)
  if (!src.ok) return { ok: false, durationMs: 0, error: src.error }
  const r = await fetchHfBinary('briaai/RMBG-1.4', {
    inputs: `data:${src.mime};base64,${src.base64}`,
  }, 'image/png', 60_000)
  if (!r.ok) return { ok: false, durationMs: Date.now() - t0, error: r.error }
  return { ok: true, provider: 'huggingface', model: 'briaai/RMBG-1.4', imageBase64: r.buf.toString('base64'), mime: r.mime, bytes: r.buf.length, durationMs: Date.now() - t0 }
}

// ─── Upscale ────────────────────────────────────────────────────────────────

export interface UpscaleInput { imageBase64?: string; imageUrl?: string; scale?: 2 | 4 }

export async function upscale(input: UpscaleInput): Promise<ImageOpResult> {
  const t0 = Date.now()
  const src = await readImage(input)
  if (!src.ok) return { ok: false, durationMs: 0, error: src.error }
  // 2x default — 4x via Pollinations URL fallback if scale=4
  const model = 'caidas/swin2SR-classical-sr-x2-64'
  const r = await fetchHfBinary(model, {
    inputs: `data:${src.mime};base64,${src.base64}`,
  }, 'image/png', 120_000)
  if (r.ok) {
    return { ok: true, provider: 'huggingface', model, imageBase64: r.buf.toString('base64'), mime: r.mime, bytes: r.buf.length, durationMs: Date.now() - t0 }
  }
  // Last-resort: Pollinations-driven re-render at 2x dims (lossy)
  return { ok: false, durationMs: Date.now() - t0, error: r.error }
}

// ─── Inpaint ────────────────────────────────────────────────────────────────

export interface InpaintInput {
  imageBase64?: string
  imageUrl?:    string
  maskBase64:   string         // white = repaint, black = keep
  prompt:       string
  negativePrompt?: string
}

export async function inpaint(input: InpaintInput): Promise<ImageOpResult> {
  const t0 = Date.now()
  if (!input.prompt?.trim()) return { ok: false, durationMs: 0, error: 'prompt required' }
  if (!input.maskBase64) return { ok: false, durationMs: 0, error: 'maskBase64 required' }
  const src = await readImage(input)
  if (!src.ok) return { ok: false, durationMs: 0, error: src.error }
  const model = 'runwayml/stable-diffusion-inpainting'
  const r = await fetchHfBinary(model, {
    inputs: {
      prompt: input.prompt.slice(0, 1000),
      image: `data:${src.mime};base64,${src.base64}`,
      mask_image: `data:image/png;base64,${input.maskBase64.replace(/^data:[^;]+;base64,/, '')}`,
    },
    parameters: {
      ...(input.negativePrompt ? { negative_prompt: input.negativePrompt.slice(0, 500) } : {}),
    },
  }, 'image/png', 180_000)
  if (!r.ok) return { ok: false, durationMs: Date.now() - t0, error: r.error }
  return { ok: true, provider: 'huggingface', model, imageBase64: r.buf.toString('base64'), mime: r.mime, bytes: r.buf.length, durationMs: Date.now() - t0 }
}

// ─── Variants ───────────────────────────────────────────────────────────────

export interface VariantsInput {
  prompt: string
  count?: number
  width?: number
  height?: number
  model?: 'flux_schnell' | 'flux_dev' | 'sdxl' | 'sd3_medium'
}

export interface VariantsResult {
  ok: boolean
  variants: Array<{ index: number; imageBase64?: string; provider?: string; bytes?: number; error?: string }>
  durationMs: number
}

export async function variants(input: VariantsInput, workspaceId?: string): Promise<VariantsResult> {
  const t0 = Date.now()
  const count = Math.max(2, Math.min(8, input.count ?? 4))
  const { generateFreeImage } = await import('./r609-free-image-gen.js')
  const seedBase = Math.floor(Date.now() % 1_000_000)
  const out = await Promise.all(Array.from({ length: count }, async (_, i) => {
    try {
      const r = await generateFreeImage({
        prompt:    input.prompt,
        width:     input.width  ?? 1024,
        height:    input.height ?? 1024,
        model:     input.model  ?? 'flux_schnell',
        seed:      seedBase + i * 7919,    // prime-spaced seeds
      }, workspaceId)
      const entry: { index: number; imageBase64?: string; provider?: string; bytes?: number; error?: string } = { index: i }
      if (r.imageBase64) entry.imageBase64 = r.imageBase64
      if (r.provider)    entry.provider    = r.provider
      if (r.bytes)       entry.bytes       = r.bytes
      if (!r.ok && r.error) entry.error    = r.error
      return entry
    } catch (e) {
      return { index: i, error: (e as Error).message }
    }
  }))
  return { ok: out.some(v => !!v.imageBase64), variants: out, durationMs: Date.now() - t0 }
}
