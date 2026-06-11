/**
 * R619 — Free / open-source image editing.
 *
 * Companion to R609 (text→image). This is edit-existing-image:
 * "make the sky purple", "remove background", "add a hat".
 *
 *   Tier 1 — HuggingFace FLUX.1-Kontext-dev (free, gated SOTA edit model)
 *     Falls back if HF returns 401/403 (gated) or 5xx.
 *
 *   Tier 2 — HuggingFace Qwen-Image-Edit (ungated alt)
 *     Different prompt style ("Change the X to Y") but works without acceptance.
 *
 *   Tier 3 — Pollinations.ai img2img endpoint (free, zero auth)
 *     Lower fidelity but always reachable.
 *
 * Input accepts EITHER imageBase64 OR imageUrl (we'll fetch + base64 it).
 * Output shape matches R609 so callers can swap.
 */
import { Buffer } from 'node:buffer'

const HF_BASE = 'https://router.huggingface.co/hf-inference/models'

const HF_MODELS = {
  flux_kontext: 'black-forest-labs/FLUX.1-Kontext-dev',
  qwen_edit:    'Qwen/Qwen-Image-Edit',
}

export type EditModel = keyof typeof HF_MODELS

export interface ImageEditInput {
  prompt:       string
  imageBase64?: string
  imageUrl?:    string
  model?:       EditModel
  strength?:    number     // 0–1, default 0.85
  width?:       number
  height?:      number
  seed?:        number
}

export interface ImageEditResult {
  ok:          boolean
  provider:    'huggingface' | 'pollinations' | null
  model?:      string
  bytes?:      number
  mime?:       string
  imageBase64?: string
  durationMs:  number
  error?:      string
}

async function recordHealth(workspaceId: string | undefined, connector: string, ok: boolean, err?: string): Promise<void> {
  if (!workspaceId) return
  try {
    const mod = await import('./r581-connector-health.js')
    if (ok) await mod.recordConnectorOk(workspaceId, connector)
    else    await mod.recordConnectorFail(workspaceId, connector, err ?? 'unknown')
  } catch { /* tolerated */ }
}

async function resolveImage(input: ImageEditInput): Promise<{ ok: true; base64: string; mime: string } | { ok: false; error: string }> {
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
      if (buf.length < 200) return { ok: false, error: 'fetched empty' }
      const mime = r.headers.get('content-type') ?? 'image/png'
      return { ok: true, base64: buf.toString('base64'), mime }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }
  return { ok: false, error: 'imageBase64 or imageUrl required' }
}

// ─── Tier 1+2 HuggingFace ────────────────────────────────────────────────────

async function tryHuggingFace(input: ImageEditInput, srcBase64: string, srcMime: string, modelKey: EditModel, workspaceId?: string): Promise<ImageEditResult> {
  const token = process.env['HF_TOKEN']
  const t0 = Date.now()
  if (!token) return { ok: false, provider: null, durationMs: 0, error: 'HF_TOKEN not set' }
  const model = HF_MODELS[modelKey]
  // HF inference for img-edit models accepts inputs={image_base64, prompt}
  // (varies by model card — these two both consume that structure).
  const body: Record<string, unknown> = {
    inputs: {
      image: `data:${srcMime};base64,${srcBase64}`,
      prompt: input.prompt.slice(0, 2000),
    },
    parameters: {
      ...(typeof input.strength === 'number' ? { strength: Math.max(0, Math.min(1, input.strength)) } : { strength: 0.85 }),
      ...(input.width  ? { width:  Math.max(256, Math.min(1536, input.width))  } : {}),
      ...(input.height ? { height: Math.max(256, Math.min(1536, input.height)) } : {}),
      ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
    },
  }
  try {
    const r = await fetch(`${HF_BASE}/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'image/png' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
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

// ─── Tier 3 Pollinations img2img (free, no auth) ────────────────────────────

async function tryPollinations(input: ImageEditInput, srcBase64: string): Promise<ImageEditResult> {
  const t0 = Date.now()
  const w = Math.max(256, Math.min(1536, input.width ?? 1024))
  const h = Math.max(256, Math.min(1536, input.height ?? 1024))
  const seed = typeof input.seed === 'number' ? input.seed : Math.floor(Date.now() % 1_000_000)
  // Pollinations img2img: POST raw image bytes, prompt in path
  try {
    const buf = Buffer.from(srcBase64, 'base64')
    const u = `https://image.pollinations.ai/prompt/${encodeURIComponent(input.prompt.slice(0, 500))}?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux`
    const r = await fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: buf,
      signal: AbortSignal.timeout(180_000),
    })
    if (!r.ok) return { ok: false, provider: 'pollinations', durationMs: Date.now() - t0, error: `pollinations ${r.status}` }
    const ab = await r.arrayBuffer()
    const out = Buffer.from(ab)
    if (out.length < 200) return { ok: false, provider: 'pollinations', durationMs: Date.now() - t0, error: 'pollinations: empty' }
    return { ok: true, provider: 'pollinations', model: 'flux-img2img', bytes: out.length, mime: 'image/png', imageBase64: out.toString('base64'), durationMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, provider: 'pollinations', durationMs: Date.now() - t0, error: (e as Error).message }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function editImage(input: ImageEditInput, workspaceId?: string): Promise<ImageEditResult> {
  if (!input.prompt?.trim()) return { ok: false, provider: null, durationMs: 0, error: 'prompt required' }
  const src = await resolveImage(input)
  if (!src.ok) return { ok: false, provider: null, durationMs: 0, error: src.error }

  const order: EditModel[] = input.model ? [input.model, input.model === 'flux_kontext' ? 'qwen_edit' : 'flux_kontext'] : ['flux_kontext', 'qwen_edit']
  for (const m of order) {
    const r = await tryHuggingFace(input, src.base64, src.mime, m, workspaceId)
    if (r.ok) return r
    // 401/403 on gated model → try next without burning time
    if (!r.error?.includes('401') && !r.error?.includes('403') && !r.error?.includes('429')) {
      // some other error — try next anyway
    }
  }
  return tryPollinations(input, src.base64)
}

export async function editImageHealth(workspaceId?: string): Promise<{ ok: boolean; providers: Array<{ name: string; ok: boolean; reason?: string }>; configured: boolean }> {
  const out: Array<{ name: string; ok: boolean; reason?: string }> = []
  out.push({ name: 'huggingface-flux-kontext', ok: !!process.env['HF_TOKEN'], ...(process.env['HF_TOKEN'] ? {} : { reason: 'HF_TOKEN missing' }) })
  out.push({ name: 'huggingface-qwen-edit',    ok: !!process.env['HF_TOKEN'], ...(process.env['HF_TOKEN'] ? {} : { reason: 'HF_TOKEN missing' }) })
  out.push({ name: 'pollinations-img2img',     ok: true })
  void workspaceId
  return { ok: out.some(p => p.ok), providers: out, configured: !!process.env['HF_TOKEN'] }
}
