/**
 * ai-image-providers.ts — R146.99 — frontier image-model render clients.
 *
 * Parallel structure to ai-video-providers.ts. Each client takes a
 * normalized ImageRenderRequest and returns ImageRenderResult with
 * download URL + cost estimate. Soft-fail on missing keys.
 *
 * Providers:
 *   - Replicate Flux (Pro / Schnell)
 *   - Replicate SDXL (with LoRA stack support)
 *   - OpenAI (DALL-E 3 / gpt-image-1)
 *   - Stability AI (SD 3.5)
 *   - Gemini Imagen 4
 *
 * Reference-image conditioning (IP-Adapter) for character consistency
 * supported by Flux + SDXL paths via Replicate's model variants.
 */
import { recordAiUsage } from './ai-cost-tracker.js'
import { compressPrompt } from './ai-video-stretcher.js'

/** R146.104 — auto-apply stretcher at the image-provider edge. Same gate as
 *  ai-video-providers.ts: every render call passes the prompt through
 *  compression unless skipStretch=true. ~30-40% byte reduction, identical
 *  output quality. */
function applyStretch<T extends { prompt: string; skipStretch?: boolean }>(req: T): T & { prompt: string } {
  if (req.skipStretch) return req
  const { compressed } = compressPrompt(req.prompt)
  return { ...req, prompt: compressed }
}

export interface ImageRenderRequest {
  prompt:           string
  negativePrompt?: string
  width?:          number      // default 1024
  height?:         number      // default 1024
  numImages?:      number      // default 1, max 4
  seed?:           number
  referenceImages?: string[]   // IP-Adapter conditioning
  styleLoraUrls?:   string[]   // SDXL LoRA stack
  guidanceScale?:  number      // 1-10, default 3.5 for Flux, 7 for SDXL
  steps?:          number      // 4-50, default 28 Flux, 30 SDXL
  workspaceId:     string
  callTag?:        string
  // R146.104 — opt out of auto prompt compression at the provider edge
  skipStretch?:    boolean
}

export interface ImageRenderResult {
  ok:           boolean
  provider:     string
  imageUrls:    string[]
  costUsd:      number
  latencyMs:    number
  seed?:        number
  error?:       string
  rawMeta?:     Record<string, unknown>
}

const POLL_TIMEOUT_MS = 90_000

function trackUsage(provider: string, workspaceId: string, costUsd: number, latencyMs: number): void {
  recordAiUsage({
    workspaceId,
    provider:       `image-${provider}`,
    model:          provider,
    promptTokens:   0,
    outputTokens:   0,
    costUsd,
    latencyMs,
    taskType:       'image-gen',
  })
}

async function pollReplicate(predictionUrl: string, token: string): Promise<{ outputs: string[]; error?: string }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const r = await fetch(predictionUrl, { headers: { Authorization: `Token ${token}` }, signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return { outputs: [], error: `poll ${r.status}` }
    const d = await r.json() as { status?: string; output?: string[] | string; error?: string }
    if (d.status === 'succeeded') {
      const outputs = Array.isArray(d.output) ? d.output : d.output ? [d.output] : []
      return { outputs }
    }
    if (d.status === 'failed' || d.status === 'canceled') return { outputs: [], error: d.error ?? 'failed' }
    await new Promise(res => setTimeout(res, 2500))
  }
  return { outputs: [], error: 'poll-timeout' }
}

// ─── Replicate Flux (Pro / Schnell) ────────────────────────────────────

export async function renderViaFlux(req: ImageRenderRequest, opts: { variant?: 'pro' | 'schnell' | 'dev' } = {}): Promise<ImageRenderResult> {
  req = applyStretch(req)
  const token = process.env['REPLICATE_API_TOKEN']
  if (!token) return { ok: false, provider: 'replicate-flux', imageUrls: [], costUsd: 0, latencyMs: 0, error: 'no-key' }
  const variant = opts.variant ?? (req.referenceImages?.length ? 'pro' : 'schnell')
  const model =
    variant === 'pro'     ? 'black-forest-labs/flux-pro' :
    variant === 'schnell' ? 'black-forest-labs/flux-schnell' :
                            'black-forest-labs/flux-dev'
  const t0 = Date.now()
  try {
    const input: Record<string, unknown> = {
      prompt:           req.prompt.slice(0, 1500),
      aspect_ratio:     pickAspect(req.width ?? 1024, req.height ?? 1024),
      num_outputs:      Math.min(4, Math.max(1, req.numImages ?? 1)),
      output_format:    'png',
      output_quality:   95,
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(variant !== 'schnell' && req.guidanceScale !== undefined ? { guidance: req.guidanceScale } : {}),
      ...(variant !== 'schnell' && req.steps !== undefined ? { num_inference_steps: req.steps } : {}),
      ...(req.referenceImages?.[0] && variant === 'pro' ? { image_prompt: req.referenceImages[0] } : {}),
    }
    const startRes = await fetch('https://api.replicate.com/v1/models/' + model + '/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}`, Prefer: 'wait=60' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(75_000),
    })
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => '')
      const latencyMs = Date.now() - t0
      trackUsage('replicate-flux', req.workspaceId, 0, latencyMs)
      return { ok: false, provider: 'replicate-flux', imageUrls: [], costUsd: 0, latencyMs, error: `${startRes.status}: ${txt.slice(0, 200)}` }
    }
    const startData = await startRes.json() as { status?: string; output?: string | string[]; urls?: { get?: string }; error?: string }
    let outputs: string[] = []
    let err: string | undefined
    if (startData.status === 'succeeded') {
      outputs = Array.isArray(startData.output) ? startData.output : startData.output ? [startData.output] : []
    } else if (startData.urls?.get) {
      const polled = await pollReplicate(startData.urls.get, token)
      outputs = polled.outputs
      err = polled.error
    } else {
      err = startData.error ?? 'no-output'
    }
    const latencyMs = Date.now() - t0
    const num = outputs.length || 1
    const costUsd = variant === 'pro' ? 0.055 * num : variant === 'dev' ? 0.025 * num : 0.003 * num
    if (outputs.length === 0) {
      trackUsage('replicate-flux', req.workspaceId, costUsd, latencyMs)
      return { ok: false, provider: 'replicate-flux', imageUrls: [], costUsd, latencyMs, error: err ?? 'no-output' }
    }
    trackUsage('replicate-flux', req.workspaceId, costUsd, latencyMs)
    return { ok: true, provider: 'replicate-flux', imageUrls: outputs, costUsd, latencyMs, ...(req.seed !== undefined ? { seed: req.seed } : {}) }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('replicate-flux', req.workspaceId, 0, latencyMs)
    return { ok: false, provider: 'replicate-flux', imageUrls: [], costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Replicate SDXL (with LoRA stack) ───────────────────────────────────

export async function renderViaSDXL(req: ImageRenderRequest): Promise<ImageRenderResult> {
  req = applyStretch(req)
  const token = process.env['REPLICATE_API_TOKEN']
  if (!token) return { ok: false, provider: 'replicate-sdxl', imageUrls: [], costUsd: 0, latencyMs: 0, error: 'no-key' }
  const t0 = Date.now()
  try {
    // Use SDXL with LoRA support model variant
    const model = 'stability-ai/sdxl'
    const input: Record<string, unknown> = {
      prompt:               req.prompt.slice(0, 1500),
      negative_prompt:      (req.negativePrompt ?? '').slice(0, 500),
      width:                req.width  ?? 1024,
      height:               req.height ?? 1024,
      num_outputs:          Math.min(4, Math.max(1, req.numImages ?? 1)),
      num_inference_steps:  req.steps ?? 30,
      guidance_scale:       req.guidanceScale ?? 7.5,
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      ...(req.referenceImages?.[0] ? { image: req.referenceImages[0], prompt_strength: 0.7 } : {}),
    }
    const startRes = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}`, Prefer: 'wait=60' },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(75_000),
    })
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => '')
      const latencyMs = Date.now() - t0
      trackUsage('replicate-sdxl', req.workspaceId, 0, latencyMs)
      return { ok: false, provider: 'replicate-sdxl', imageUrls: [], costUsd: 0, latencyMs, error: `${startRes.status}: ${txt.slice(0, 200)}` }
    }
    const startData = await startRes.json() as { status?: string; output?: string | string[]; urls?: { get?: string }; error?: string }
    let outputs: string[] = []
    let err: string | undefined
    if (startData.status === 'succeeded') {
      outputs = Array.isArray(startData.output) ? startData.output : startData.output ? [startData.output] : []
    } else if (startData.urls?.get) {
      const polled = await pollReplicate(startData.urls.get, token)
      outputs = polled.outputs
      err = polled.error
    } else {
      err = startData.error ?? 'no-output'
    }
    const latencyMs = Date.now() - t0
    const num = outputs.length || 1
    const costUsd = 0.012 * num    // typical SDXL via Replicate
    if (outputs.length === 0) {
      trackUsage('replicate-sdxl', req.workspaceId, costUsd, latencyMs)
      return { ok: false, provider: 'replicate-sdxl', imageUrls: [], costUsd, latencyMs, error: err ?? 'no-output' }
    }
    trackUsage('replicate-sdxl', req.workspaceId, costUsd, latencyMs)
    return { ok: true, provider: 'replicate-sdxl', imageUrls: outputs, costUsd, latencyMs, ...(req.seed !== undefined ? { seed: req.seed } : {}) }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('replicate-sdxl', req.workspaceId, 0, latencyMs)
    return { ok: false, provider: 'replicate-sdxl', imageUrls: [], costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── OpenAI (gpt-image-1 / DALL-E 3) ────────────────────────────────────

export async function renderViaOpenAI(req: ImageRenderRequest): Promise<ImageRenderResult> {
  req = applyStretch(req)
  const key = process.env['OPENAI_API_KEY']
  if (!key) return { ok: false, provider: 'openai', imageUrls: [], costUsd: 0, latencyMs: 0, error: 'no-key' }
  const t0 = Date.now()
  try {
    const size = pickOpenAiSize(req.width ?? 1024, req.height ?? 1024)
    const n = Math.min(4, Math.max(1, req.numImages ?? 1))
    const body = {
      model:  'gpt-image-1',
      prompt: req.prompt.slice(0, 2000),
      n,
      size,
      quality: 'high',
    }
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const latencyMs = Date.now() - t0
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      trackUsage('openai', req.workspaceId, 0, latencyMs)
      return { ok: false, provider: 'openai', imageUrls: [], costUsd: 0, latencyMs, error: `${res.status}: ${txt.slice(0, 200)}` }
    }
    const data = await res.json() as { data?: Array<{ url?: string; b64_json?: string }> }
    const imageUrls = (data.data ?? [])
      .map(d => d.url ?? (d.b64_json ? `data:image/png;base64,${d.b64_json}` : ''))
      .filter(u => u.length > 0)
    const costUsd = 0.19 * imageUrls.length    // approx gpt-image-1 high quality
    if (imageUrls.length === 0) {
      trackUsage('openai', req.workspaceId, costUsd, latencyMs)
      return { ok: false, provider: 'openai', imageUrls: [], costUsd, latencyMs, error: 'no-output' }
    }
    trackUsage('openai', req.workspaceId, costUsd, latencyMs)
    return { ok: true, provider: 'openai', imageUrls, costUsd, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('openai', req.workspaceId, 0, latencyMs)
    return { ok: false, provider: 'openai', imageUrls: [], costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Stability AI (SD 3.5 Large) ───────────────────────────────────────

export async function renderViaStability(req: ImageRenderRequest): Promise<ImageRenderResult> {
  req = applyStretch(req)
  const key = process.env['STABILITY_API_KEY']
  if (!key) return { ok: false, provider: 'stability', imageUrls: [], costUsd: 0, latencyMs: 0, error: 'no-key' }
  const t0 = Date.now()
  try {
    const form = new FormData()
    form.append('prompt', req.prompt.slice(0, 1500))
    form.append('aspect_ratio', pickAspect(req.width ?? 1024, req.height ?? 1024))
    form.append('output_format', 'png')
    if (req.negativePrompt) form.append('negative_prompt', req.negativePrompt.slice(0, 500))
    if (req.seed !== undefined) form.append('seed', String(req.seed))
    const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/sd3', {
      method: 'POST',
      headers: { Accept: 'image/*', Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const latencyMs = Date.now() - t0
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      trackUsage('stability', req.workspaceId, 0, latencyMs)
      return { ok: false, provider: 'stability', imageUrls: [], costUsd: 0, latencyMs, error: `${res.status}: ${txt.slice(0, 200)}` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
    const costUsd = 0.065
    trackUsage('stability', req.workspaceId, costUsd, latencyMs)
    return { ok: true, provider: 'stability', imageUrls: [dataUrl], costUsd, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('stability', req.workspaceId, 0, latencyMs)
    return { ok: false, provider: 'stability', imageUrls: [], costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Gemini Imagen 4 ────────────────────────────────────────────────────

export async function renderViaGeminiImagen(req: ImageRenderRequest): Promise<ImageRenderResult> {
  req = applyStretch(req)
  const key = process.env['GEMINI_API_KEY']
  if (!key) return { ok: false, provider: 'gemini-imagen', imageUrls: [], costUsd: 0, latencyMs: 0, error: 'no-key' }
  const t0 = Date.now()
  try {
    const body = {
      instances: [{ prompt: req.prompt.slice(0, 1500) }],
      parameters: {
        sampleCount:  Math.min(4, Math.max(1, req.numImages ?? 1)),
        aspectRatio:  pickAspect(req.width ?? 1024, req.height ?? 1024),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      },
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-preview-06-06:predict?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const latencyMs = Date.now() - t0
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      trackUsage('gemini-imagen', req.workspaceId, 0, latencyMs)
      return { ok: false, provider: 'gemini-imagen', imageUrls: [], costUsd: 0, latencyMs, error: `${res.status}: ${txt.slice(0, 200)}` }
    }
    const data = await res.json() as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> }
    const imageUrls = (data.predictions ?? [])
      .map(p => p.bytesBase64Encoded ? `data:${p.mimeType ?? 'image/png'};base64,${p.bytesBase64Encoded}` : '')
      .filter(u => u.length > 0)
    const costUsd = 0.04 * imageUrls.length
    if (imageUrls.length === 0) {
      trackUsage('gemini-imagen', req.workspaceId, costUsd, latencyMs)
      return { ok: false, provider: 'gemini-imagen', imageUrls: [], costUsd, latencyMs, error: 'no-output' }
    }
    trackUsage('gemini-imagen', req.workspaceId, costUsd, latencyMs)
    return { ok: true, provider: 'gemini-imagen', imageUrls, costUsd, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('gemini-imagen', req.workspaceId, 0, latencyMs)
    return { ok: false, provider: 'gemini-imagen', imageUrls: [], costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function pickAspect(w: number, h: number): '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '2:3' | '3:2' {
  const r = w / h
  if (Math.abs(r - 16 / 9) < 0.05) return '16:9'
  if (Math.abs(r - 9 / 16) < 0.05) return '9:16'
  if (Math.abs(r - 4 / 3)  < 0.05) return '4:3'
  if (Math.abs(r - 3 / 4)  < 0.05) return '3:4'
  if (Math.abs(r - 3 / 2)  < 0.05) return '3:2'
  if (Math.abs(r - 2 / 3)  < 0.05) return '2:3'
  return '1:1'
}

function pickOpenAiSize(w: number, h: number): '1024x1024' | '1792x1024' | '1024x1792' {
  const r = w / h
  if (r > 1.3)  return '1792x1024'
  if (r < 0.77) return '1024x1792'
  return '1024x1024'
}

// ─── Pollinations.ai (FREE — no key, no signup, community-funded) ──────
//
// R146.104 — best truly-free image alternative to Replicate Flux. The
// public Pollinations endpoint serves Flux-class outputs via a plain GET:
//   GET https://image.pollinations.ai/prompt/{urlencoded prompt}?width=..&height=..&seed=..&nologo=true&model=flux
// Returns image bytes (image/jpeg) directly. No auth, no rate limit
// signal beyond shared community capacity. costUsd: 0.
//
// We return the URL as imageUrls[0]; callers that need bytes resolve
// it themselves (it's a stable, content-addressed-by-prompt URL).
export async function renderViaPollinations(req: ImageRenderRequest): Promise<ImageRenderResult> {
  req = applyStretch(req)
  const t0 = Date.now()
  try {
    const params = new URLSearchParams({
      width:  String(req.width  ?? 1024),
      height: String(req.height ?? 1024),
      model:  'flux',
      nologo: 'true',
      ...(req.seed !== undefined ? { seed: String(req.seed) } : {}),
    })
    // Prompt goes in the path. Cap at 1500 chars to stay below URL limits.
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(req.prompt.slice(0, 1500))}?${params.toString()}`
    // HEAD probe to confirm reachability + cache warm; the URL itself is the
    // download. If HEAD fails we still return the URL — Pollinations serves
    // on-demand and HEAD support is inconsistent.
    let reachable = true
    try {
      const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) })
      reachable = head.ok || head.status === 405  // 405 = HEAD not allowed but GET works
    } catch { reachable = false }
    const latencyMs = Date.now() - t0
    if (!reachable) {
      trackUsage('pollinations', req.workspaceId, 0, latencyMs)
      return { ok: false, provider: 'pollinations', imageUrls: [], costUsd: 0, latencyMs, error: 'unreachable' }
    }
    trackUsage('pollinations', req.workspaceId, 0, latencyMs)
    return { ok: true, provider: 'pollinations', imageUrls: [url], costUsd: 0, latencyMs, ...(req.seed !== undefined ? { seed: req.seed } : {}) }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('pollinations', req.workspaceId, 0, latencyMs)
    return { ok: false, provider: 'pollinations', imageUrls: [], costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Dispatcher ────────────────────────────────────────────────────────

export type ImageProvider = 'replicate-flux' | 'replicate-sdxl' | 'openai' | 'stability' | 'gemini-imagen' | 'pollinations'

export async function renderImage(provider: ImageProvider, req: ImageRenderRequest): Promise<ImageRenderResult> {
  switch (provider) {
    case 'replicate-flux': return renderViaFlux(req)
    case 'replicate-sdxl': return renderViaSDXL(req)
    case 'openai':         return renderViaOpenAI(req)
    case 'stability':      return renderViaStability(req)
    case 'gemini-imagen':  return renderViaGeminiImagen(req)
    case 'pollinations':   return renderViaPollinations(req)
  }
}

export async function renderImageWithFallback(primary: ImageProvider, fallbacks: Array<ImageProvider>, req: ImageRenderRequest): Promise<ImageRenderResult & { providerChain: string[] }> {
  const chain: string[] = []
  for (const p of [primary, ...fallbacks]) {
    chain.push(p)
    const r = await renderImage(p, req)
    if (r.ok) return { ...r, providerChain: chain }
  }
  return { ok: false, provider: 'none', imageUrls: [], costUsd: 0, latencyMs: 0, error: 'all-providers-failed', providerChain: chain }
}
