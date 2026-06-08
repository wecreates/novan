/**
 * image-generator.ts — Multi-provider AI image generation.
 *
 * Providers (real HTTP calls, fail-fast when key absent):
 *   - openai       OPENAI_API_KEY      gpt-image-1 / dall-e-3
 *   - stability    STABILITY_API_KEY   sd3.5
 *   - replicate    REPLICATE_API_TOKEN flux-schnell / sdxl
 *   - fal          FAL_KEY             flux/schnell
 *
 * Safety:
 *   - 'image' kill switch checked first
 *   - Unsafe-prompt blocklist (CSAM, real-person sexual content, weapons-mfg)
 *   - Secret redaction on prompts
 *   - Budget guard: cost estimate computed before call; rejected if over cap
 *   - Persisted to image_generations (status: pending|succeeded|failed|blocked)
 *   - Every call emits 'image.*' events
 */
import { db }                          from '../db/client.js'
import { imageGenerations, events, killSwitches } from '../db/schema.js'
import { and, eq, desc }               from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'
import { redactSecrets }               from './secret-redactor.js'
import { isImageGenerationEnabled, defaultImageProvider } from './provider-validation.js'
import { checkBeforeAction, emitGovernorBlock } from './resource-governor.js'
import { fetchWithRetry }                       from './provider-retry.js'

export type ImageProvider = 'openai' | 'stability' | 'replicate' | 'fal' | 'horde' | 'huggingface' | 'cloudflare'

export interface GenerateInput {
  workspaceId:    string
  prompt:         string
  enhancedPrompt?: string         // optional: from prompt-rewriter
  negativePrompt?: string
  provider:       ImageProvider
  model?:         string
  stylePreset?:   string
  aspectRatio?:   string         // '1:1' | '16:9' | '9:16' | '4:3' | '3:4'
  width?:         number
  height?:        number
  seed?:          number          // reproducibility
  batchId?:       string          // groups multi-image generations
  sourceImageUrl?: string         // image-to-image input (http(s) URL or data:)
  brandCategory?: string          // icon|logo|hero|...
  routerProvenance?: 'auto' | 'user_pinned'
  budgetCapUsd?:  number         // reject if estimate > cap
  createdBy?:     string
}

export interface GenerateResult {
  id:              string
  status:          'succeeded' | 'failed' | 'blocked'
  imageUrl?:       string
  costEstimateUsd: number
  actualCostUsd?:  number
  errorMessage?:   string
  blockedReason?:  string
  provider:        ImageProvider
}

// ─── Cost estimation (rough but real per-provider rates) ──────────────────────

function estimateCostUsd(provider: ImageProvider, opts: { width?: number; height?: number; model?: string }): number {
  const w = opts.width  ?? 1024
  const h = opts.height ?? 1024
  const px = w * h
  switch (provider) {
    case 'openai':    return px >= 1792 * 1024 ? 0.080 : px >= 1024 * 1024 ? 0.040 : 0.020
    case 'stability': return opts.model?.includes('ultra') ? 0.080 : 0.040
    case 'replicate': return opts.model?.includes('flux') ? 0.003 : 0.010
    case 'fal':       return 0.005
    case 'horde':       return 0           // anonymous tier free, paid via volunteer kudos
    case 'huggingface': return 0           // free token, free tier
    case 'cloudflare':  return 0           // 10k neurons/day free
    default:            return 0.050
  }
}

// ─── Unsafe-prompt blocklist ──────────────────────────────────────────────────

const UNSAFE_PROMPT_PATTERNS: RegExp[] = [
  /\bcsam\b|child\s+sex|minor\s+(nude|sex)|underage\s+(nude|sex|porn)/i,
  /\b(make|create|generate)\s+(a\s+)?(bomb|explosive|weapon)/i,
  /\bfacial\s+composite\s+of\s+(real|specific)/i,
  /\b(deepfake|impersonate)\s+(elon|biden|trump|musk|obama|harris)/i, // narrow celebrity-impersonation
]

function classifyPromptSafety(prompt: string): { unsafe: boolean; reason?: string } {
  for (const p of UNSAFE_PROMPT_PATTERNS) {
    if (p.test(prompt)) return { unsafe: true, reason: `prompt matched blocklist: ${p.source}` }
  }
  return { unsafe: false }
}

// ─── Kill switch ──────────────────────────────────────────────────────────────

async function imageKillSwitchOn(workspaceId: string): Promise<boolean> {
  const row = await db.select().from(killSwitches)
    .where(and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.switchType, 'image')))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[image-generator]', e.message); return null })
  return !!row?.enabled
}

// ─── Provider drivers ─────────────────────────────────────────────────────────

async function genOpenAI(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = process.env['OPENAI_API_KEY']
  if (!key) throw new Error('OPENAI_API_KEY not configured')
  const size = `${input.width ?? 1024}x${input.height ?? 1024}`
  const out = await fetchWithRetry('image:openai', 'https://api.openai.com/v1/images/generations', {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model:  input.model ?? 'dall-e-3',
      prompt: input.prompt,
      n:      1,
      size,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!out.ok) throw new Error(`OpenAI ${out.status}: ${out.statusText}`)
  const body = await out.response.json().catch(() => ({})) as Record<string, unknown>
  const data = body['data'] as Array<{ url?: string }> | undefined
  const url = data?.[0]?.url
  if (!url) throw new Error('OpenAI returned no image URL')
  return { imageUrl: url, raw: body }
}

async function genStability(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = process.env['STABILITY_API_KEY']
  if (!key) throw new Error('STABILITY_API_KEY not configured')
  const form = new FormData()
  form.append('prompt', input.prompt)
  if (input.negativePrompt) form.append('negative_prompt', input.negativePrompt)
  if (input.aspectRatio)    form.append('aspect_ratio', input.aspectRatio)
  form.append('output_format', 'png')

  const out = await fetchWithRetry('image:stability', 'https://api.stability.ai/v2beta/stable-image/generate/core', {
    method:  'POST',
    headers: { 'authorization': `Bearer ${key}`, 'accept': 'application/json' },
    body:    form,
    signal:  AbortSignal.timeout(120_000),
  })
  if (!out.ok) throw new Error(`Stability ${out.status}: ${out.statusText}`)
  const body = await out.response.json().catch(() => ({})) as Record<string, unknown>
  const b64 = body['image'] as string | undefined
  if (!b64) throw new Error('Stability returned no image')
  return { imageUrl: `data:image/png;base64,${b64}`, raw: { finishReason: body['finish_reason'] } }
}

async function genReplicate(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = process.env['REPLICATE_API_TOKEN']
  if (!key) throw new Error('REPLICATE_API_TOKEN not configured')
  const model = input.model ?? 'black-forest-labs/flux-schnell'
  // Use the synchronous predictions endpoint with `Prefer: wait`
  const out = await fetchWithRetry('image:replicate', `https://api.replicate.com/v1/models/${model}/predictions`, {
    method:  'POST',
    headers: {
      'authorization': `Bearer ${key}`,
      'content-type':  'application/json',
      'prefer':        'wait',
    },
    body: JSON.stringify({
      input: {
        prompt:        input.enhancedPrompt ?? input.prompt,
        aspect_ratio:  input.aspectRatio ?? '1:1',
        output_format: 'png',
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        // Image-to-image: most Replicate models accept `image` as the
        // conditioning input. flux-schnell is text-only, but flux-dev
        // and SDXL variants accept this.
        ...(input.sourceImageUrl ? { image: input.sourceImageUrl } : {}),
      },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!out.ok) throw new Error(`Replicate ${out.status}: ${out.statusText}`)
  const body = await out.response.json().catch(() => ({})) as Record<string, unknown>
  const output = body['output']
  const url = Array.isArray(output) ? output[0] : (typeof output === 'string' ? output : null)
  if (!url) throw new Error('Replicate returned no image URL')
  return { imageUrl: String(url), raw: body }
}

async function genFal(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = process.env['FAL_KEY']
  if (!key) throw new Error('FAL_KEY not configured')
  const model = input.model ?? 'fal-ai/flux/schnell'
  const out = await fetchWithRetry('image:fal', `https://fal.run/${model}`, {
    method:  'POST',
    headers: { 'authorization': `Key ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt:       input.prompt,
      image_size:   input.aspectRatio === '16:9' ? 'landscape_16_9' :
                    input.aspectRatio === '9:16' ? 'portrait_16_9'  : 'square_hd',
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!out.ok) throw new Error(`fal ${out.status}: ${out.statusText}`)
  const body = await out.response.json().catch(() => ({})) as Record<string, unknown>
  const images = body['images'] as Array<{ url?: string }> | undefined
  const url = images?.[0]?.url
  if (!url) throw new Error('fal returned no image URL')
  return { imageUrl: url, raw: body }
}

// ─── R343 — Free / open-source image providers ──────────────────────────────
// Stable Horde: crowd-sourced GPUs, anonymous tier free (apikey "0000000000"),
// supports SDXL, Flux, SD 1.5. Quality is excellent (volunteer workers run
// real GPUs), queue wait varies 30s-5min.

async function genHorde(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = process.env['HORDE_API_KEY'] ?? '0000000000'   // anonymous tier works
  const w = input.width  ?? 1024
  const h = input.height ?? 1024
  // Horde requires width/height as multiples of 64 and <=3072
  const round = (n: number): number => Math.min(3072, Math.max(64, Math.round(n / 64) * 64))
  // R343 — model default tuned for short Horde queue. Flux.1-Schnell had a
  // ~1300s queue in live testing; AlbedoBase XL averages ~10-30s wait.
  // Operator can pin a specific model via input.model.
  const model = input.model ?? 'AlbedoBase XL (SDXL)'

  // Submit
  const submitRes = await fetchWithRetry('image:horde', 'https://stablehorde.net/api/v2/generate/async', {
    method:  'POST',
    headers: { 'apikey': key, 'Content-Type': 'application/json', 'Client-Agent': 'novan/1.0:operator@example.com' },
    body: JSON.stringify({
      prompt: input.prompt + (input.negativePrompt ? ` ### ${input.negativePrompt}` : ''),
      params: {
        sampler_name: 'k_euler',
        width:  round(w),
        height: round(h),
        steps:  4,                        // Flux Schnell is 4-step
        n:      1,
        cfg_scale: 1.0,
        karras: false,
        clip_skip: 1,
      },
      models: [model],
      r2: true,
      nsfw: false,
      shared: true,                       // earn kudos for the operator
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!submitRes.ok) throw new Error(`horde submit ${submitRes.status}: ${submitRes.statusText}`)
  const submitBody = await submitRes.response.json() as { id?: string; message?: string }
  if (!submitBody.id) throw new Error(`horde returned no id: ${submitBody.message ?? 'unknown'}`)
  const id = submitBody.id

  // Poll for completion (up to ~6 min)
  const deadline = Date.now() + 360_000
  let lastCheck: HordeCheck = { done: false, finished: 0, processing: 0, waiting: 1, queue_position: 0, wait_time: 60, restarted: 0, faulted: false }
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4_000))
    const checkRes = await fetch(`https://stablehorde.net/api/v2/generate/check/${id}`, { signal: AbortSignal.timeout(10_000) })
    if (!checkRes.ok) continue
    lastCheck = await checkRes.json() as HordeCheck
    if (lastCheck.faulted) throw new Error('horde job faulted')
    if (lastCheck.done) break
  }
  if (!lastCheck.done) throw new Error(`horde timeout (queue position ${lastCheck.queue_position}, est wait ${lastCheck.wait_time}s)`)

  // Fetch the generated image URL
  const statusRes = await fetch(`https://stablehorde.net/api/v2/generate/status/${id}`, { signal: AbortSignal.timeout(15_000) })
  if (!statusRes.ok) throw new Error(`horde status ${statusRes.status}`)
  const statusBody = await statusRes.json() as { generations?: Array<{ img?: string; seed?: string; model?: string; worker_name?: string }> }
  const url = statusBody.generations?.[0]?.img
  if (!url) throw new Error('horde returned no image url')
  return { imageUrl: url, raw: statusBody }
}

interface HordeCheck {
  done:           boolean
  finished:       number
  processing:     number
  waiting:        number
  queue_position: number
  wait_time:      number
  restarted:      number
  faulted:        boolean
}

// Hugging Face Inference API — uses free token (operator sets HF_TOKEN env).
// Models: black-forest-labs/FLUX.1-schnell (open weights, fast),
//         stabilityai/sdxl-turbo. Returns raw image bytes; we save to disk
//         and return the storage URL.

async function genHuggingFace(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = process.env['HF_TOKEN']
  if (!key) throw new Error('HF_TOKEN not configured (free at huggingface.co/settings/tokens)')
  const model = input.model ?? 'black-forest-labs/FLUX.1-schnell'
  const res = await fetchWithRetry('image:hf', `https://api-inference.huggingface.co/models/${model}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs:     input.prompt,
      parameters: {
        ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
        width:  input.width  ?? 1024,
        height: input.height ?? 1024,
      },
      options: { wait_for_model: true },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    const text = await res.response.text().catch(() => '')
    throw new Error(`hf ${res.status}: ${text.slice(0, 200)}`)
  }
  // HF returns the raw image bytes. Convert to data: URL inline (small enough)
  // and let the storage layer persist via existing path.
  const buf = Buffer.from(await res.response.arrayBuffer())
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
  return { imageUrl: dataUrl, raw: { sizeBytes: buf.length, model } }
}

// Cloudflare Workers AI — generous free tier (10k neurons/day),
// runs Flux.1-Schnell + SDXL. Requires CF_API_TOKEN + CF_ACCOUNT_ID.

async function genCloudflare(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const token   = process.env['CF_API_TOKEN']
  const account = process.env['CF_ACCOUNT_ID']
  if (!token || !account) throw new Error('CF_API_TOKEN + CF_ACCOUNT_ID required (free at dash.cloudflare.com)')
  const model = input.model ?? '@cf/black-forest-labs/flux-1-schnell'
  const res = await fetchWithRetry('image:cf', `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: input.prompt,
      width:  input.width  ?? 1024,
      height: input.height ?? 1024,
      steps:  4,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`cf ${res.status}: ${res.statusText}`)
  const body = await res.response.json() as { result?: { image?: string }; success?: boolean; errors?: unknown[] }
  if (!body.success || !body.result?.image) throw new Error(`cf returned no image: ${JSON.stringify(body.errors ?? body).slice(0, 200)}`)
  // Cloudflare returns base64 PNG
  return { imageUrl: `data:image/png;base64,${body.result.image}`, raw: { model } }
}

const DRIVERS: Record<ImageProvider, (i: GenerateInput) => Promise<{ imageUrl: string; raw: unknown }>> = {
  openai: genOpenAI, stability: genStability, replicate: genReplicate, fal: genFal,
  horde: genHorde, huggingface: genHuggingFace, cloudflare: genCloudflare,
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'image-generator', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[image-generator]', e.message); return null })
}

export async function generateImage(input: GenerateInput): Promise<GenerateResult> {
  const id = uuidv7()
  const now = Date.now()
  // R146.127 — append global quality directive to every image prompt
  const { injectQualityBarIntoImagePrompt } = await import('./ai-quality-directive.js')
  input = { ...input, prompt: injectQualityBarIntoImagePrompt(input.prompt) }
  const redactedPrompt = redactSecrets(input.prompt).redacted

  // Insert pending row up-front so user has visibility
  await db.insert(imageGenerations).values({
    id, workspaceId: input.workspaceId,
    prompt:          redactedPrompt,
    enhancedPrompt:  input.enhancedPrompt ?? null,
    negativePrompt:  input.negativePrompt ?? null,
    provider:        input.provider,
    model:           input.model        ?? null,
    stylePreset:     input.stylePreset  ?? null,
    aspectRatio:     input.aspectRatio  ?? null,
    width:           input.width        ?? null,
    height:          input.height       ?? null,
    seed:            input.seed         ?? null,
    batchId:         input.batchId      ?? null,
    sourceImageRef:  input.sourceImageUrl ?? null,
    brandCategory:   input.brandCategory ?? null,
    routerProvenance: input.routerProvenance ?? null,
    costEstimateUsd: estimateCostUsd(input.provider, input),
    status:          'pending',
    createdBy:       input.createdBy    ?? null,
    createdAt:       now,
  }).catch((e: Error) => { console.error('[image-generator]', e.message); return null })

  // 0. Feature flag
  if (!isImageGenerationEnabled()) {
    await db.update(imageGenerations).set({
      status: 'blocked', blockedReason: 'IMAGE_GENERATION_ENABLED=false', completedAt: Date.now(),
    }).where(eq(imageGenerations.id, id))
    await emit(input.workspaceId, 'image.blocked', { id, reason: 'feature_flag_off' })
    return { id, status: 'blocked', costEstimateUsd: 0, blockedReason: 'image generation disabled by flag', provider: input.provider }
  }

  // 0b. Governor (rate limit + emergency throttle)
  const gov = await checkBeforeAction({ workspaceId: input.workspaceId, kind: 'image' })
  if (!gov.ok) {
    await emitGovernorBlock(input.workspaceId, gov, 'image')
    await db.update(imageGenerations).set({
      status: 'blocked', blockedReason: `governor: ${gov.reason}`, completedAt: Date.now(),
    }).where(eq(imageGenerations.id, id))
    return { id, status: 'blocked', costEstimateUsd: 0, blockedReason: gov.reason ?? 'governor block', provider: input.provider }
  }

  // 0c. Per-provider concurrency cap. If the provider is already
  // saturated, refuse fast so the operator can fall back to a different
  // provider rather than queue up indefinite latency.
  const { tryAcquire, release } = await import('./provider-concurrency.js')
  const slot = tryAcquire(input.provider)
  if (!slot.ok) {
    await db.update(imageGenerations).set({
      status: 'blocked', blockedReason: `concurrency: ${slot.reason}`, completedAt: Date.now(),
    }).where(eq(imageGenerations.id, id))
    await emit(input.workspaceId, 'image.blocked', { id, reason: 'concurrency_cap', provider: input.provider, inflight: slot.inflight, cap: slot.cap })
    return { id, status: 'blocked', costEstimateUsd: 0, blockedReason: slot.reason ?? 'provider saturated', provider: input.provider }
  }
  // Mirror the existing try/finally pattern below: every return path
  // after this point must release the slot. We wrap the rest of the
  // function in a try/finally to guarantee it.
  try {

  // 1. Kill switch
  if (await imageKillSwitchOn(input.workspaceId)) {
    await db.update(imageGenerations).set({
      status: 'blocked', blockedReason: 'kill_switch enabled for image',
      completedAt: Date.now(),
    }).where(eq(imageGenerations.id, id))
    await emit(input.workspaceId, 'image.blocked', { id, reason: 'kill_switch' })
    return { id, status: 'blocked', costEstimateUsd: 0, blockedReason: 'kill_switch', provider: input.provider }
  }

  // 2. Unsafe-prompt blocklist
  const safety = classifyPromptSafety(input.prompt)
  if (safety.unsafe) {
    await db.update(imageGenerations).set({
      status: 'blocked', blockedReason: safety.reason ?? 'unsafe prompt',
      completedAt: Date.now(),
    }).where(eq(imageGenerations.id, id))
    await emit(input.workspaceId, 'image.blocked', { id, reason: 'unsafe_prompt', detail: safety.reason })
    return {
      id, status: 'blocked' as const, costEstimateUsd: 0,
      ...(safety.reason !== undefined ? { blockedReason: safety.reason } : {}),
      provider: input.provider,
    }
  }

  // 3. Budget guard
  const estimate = estimateCostUsd(input.provider, input)
  if (input.budgetCapUsd !== undefined && estimate > input.budgetCapUsd) {
    await db.update(imageGenerations).set({
      status: 'blocked', blockedReason: `cost estimate $${estimate} > cap $${input.budgetCapUsd}`,
      completedAt: Date.now(),
    }).where(eq(imageGenerations.id, id))
    await emit(input.workspaceId, 'image.blocked', { id, reason: 'budget', estimate, cap: input.budgetCapUsd })
    return { id, status: 'blocked' as const, costEstimateUsd: estimate, blockedReason: 'budget cap exceeded', provider: input.provider }
  }

  // 4. Real generation
  await emit(input.workspaceId, 'image.generation_started', { id, provider: input.provider, estimate })
  const startedAt = Date.now()
  try {
    const out = await DRIVERS[input.provider]({ ...input, prompt: redactedPrompt })
    const completedAt = Date.now()
    const latencyMs = completedAt - startedAt
    await db.update(imageGenerations).set({
      status:           'succeeded',
      imageUrl:         out.imageUrl,
      actualCostUsd:    estimate,
      providerResponse: out.raw as Record<string, unknown>,
      latencyMs,
      completedAt,
    }).where(eq(imageGenerations.id, id))
    await emit(input.workspaceId, 'image.generation_completed', { id, provider: input.provider, costUsd: estimate, latencyMs })
    // Roll the cost into ai_usage so the workspace-wide cost dashboard
    // shows image-gen alongside chat / voice / vision spend. Without
    // this row, the operator's budget report shows $0 for image-gen
    // even though image_generations.actualCostUsd was set.
    const { recordAiUsage } = await import('./ai-cost-tracker.js')
    recordAiUsage({
      workspaceId:  input.workspaceId,
      provider:     input.provider,
      model:        input.model ?? 'default',
      promptTokens: 0,
      outputTokens: 0,
      costUsd:      estimate,
      latencyMs,
      taskType:     'image-gen',
    })
    return { id, status: 'succeeded', imageUrl: out.imageUrl, costEstimateUsd: estimate, actualCostUsd: estimate, provider: input.provider }
  } catch (e) {
    const msg = (e as Error).message
    const failedAt = Date.now()
    await db.update(imageGenerations).set({
      status: 'failed', errorMessage: msg,
      // Persist latency on failure too — without it, rate-limit vs auth
      // debugging requires correlating logs to wall-clock manually.
      latencyMs: failedAt - startedAt,
      completedAt: failedAt,
    }).where(eq(imageGenerations.id, id))
    await emit(input.workspaceId, 'image.generation_failed', { id, provider: input.provider, error: msg })
    return { id, status: 'failed', costEstimateUsd: estimate, errorMessage: msg, provider: input.provider }
  }
  } finally {
    release(input.provider)
  }
}

export async function listGenerations(workspaceId: string, limit = 50) {
  return db.select().from(imageGenerations)
    .where(eq(imageGenerations.workspaceId, workspaceId))
    .orderBy(desc(imageGenerations.createdAt))
    .limit(limit)
}

export async function getGeneration(id: string) {
  return db.select().from(imageGenerations).where(eq(imageGenerations.id, id)).limit(1).then(r => r[0] ?? null)
}

/** Quote a cost estimate without generating anything. */
export function quoteCost(provider: ImageProvider, opts: { width?: number; height?: number; model?: string }): number {
  return estimateCostUsd(provider, opts)
}

/** Provider availability — which providers have keys configured. */
// ─── Batch + smart-router public API ─────────────────────────────────────────

export async function generateBatch(
  input: Omit<GenerateInput, 'batchId' | 'seed'> & { count: number; baseSeed?: number },
): Promise<{ batchId: string; results: GenerateResult[] }> {
  const { v7: uuidv7 } = await import('uuid')
  const batchId = uuidv7()
  const count = Math.max(1, Math.min(8, input.count))   // hard cap 8/batch
  const results: GenerateResult[] = []
  for (let i = 0; i < count; i++) {
    const seed = input.baseSeed !== undefined ? input.baseSeed + i : Math.floor(Math.random() * 2147483647)
    const r = await generateImage({ ...input, batchId, seed })
    results.push(r)
    if (r.status === 'failed' || r.status === 'blocked') break  // fail-fast on first error
  }
  return { batchId, results }
}

/**
 * Rate an image (1..5). Updates qualityScore = 0.7*rating + 0.3*priorScore.
 * Operator feedback loop into the router.
 */
export async function rateImage(workspaceId: string, id: string, rating: number): Promise<{ ok: boolean }> {
  const clamped = Math.max(1, Math.min(5, Math.round(rating)))
  const row = await db.select().from(imageGenerations)
    .where(and(eq(imageGenerations.workspaceId, workspaceId), eq(imageGenerations.id, id)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[image-generator]', e.message); return null })
  if (!row) return { ok: false }
  const prior = row.qualityScore ?? 0
  const updated = prior > 0 ? 0.7 * clamped + 0.3 * prior : clamped
  await db.update(imageGenerations).set({
    userRating: clamped, qualityScore: Number(updated.toFixed(2)),
  }).where(eq(imageGenerations.id, id)).catch((e: Error) => { console.error('[image-generator]', e.message); return null })
  return { ok: true }
}

export async function setFavorite(workspaceId: string, id: string, isFavorite: boolean): Promise<{ ok: boolean }> {
  await db.update(imageGenerations).set({ isFavorite })
    .where(and(eq(imageGenerations.workspaceId, workspaceId), eq(imageGenerations.id, id)))
    .catch((e: Error) => { console.error('[image-generator]', e.message); return null })
  return { ok: true }
}

export function listAvailableProviders(): ImageProvider[] {
  const out: ImageProvider[] = []
  if (process.env['OPENAI_API_KEY'])      out.push('openai')
  if (process.env['STABILITY_API_KEY'])   out.push('stability')
  if (process.env['REPLICATE_API_TOKEN']) out.push('replicate')
  if (process.env['FAL_KEY'])             out.push('fal')
  // R343 — open-source / free providers always available
  out.push('horde')                                              // anonymous tier works without key
  if (process.env['HF_TOKEN'])            out.push('huggingface')
  if (process.env['CF_API_TOKEN'] && process.env['CF_ACCOUNT_ID']) out.push('cloudflare')
  return out
}
