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

export type ImageProvider = 'openai' | 'stability' | 'replicate' | 'fal'

export interface GenerateInput {
  workspaceId:    string
  prompt:         string
  negativePrompt?: string
  provider:       ImageProvider
  model?:         string
  stylePreset?:   string
  aspectRatio?:   string         // '1:1' | '16:9' | '9:16' | '4:3' | '3:4'
  width?:         number
  height?:        number
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
    default:          return 0.050
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
    .limit(1).then(r => r[0]).catch(() => null)
  return !!row?.enabled
}

// ─── Provider drivers ─────────────────────────────────────────────────────────

async function genOpenAI(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = process.env['OPENAI_API_KEY']
  if (!key) throw new Error('OPENAI_API_KEY not configured')
  const size = `${input.width ?? 1024}x${input.height ?? 1024}`
  const res = await fetch('https://api.openai.com/v1/images/generations', {
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
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
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

  const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
    method:  'POST',
    headers: { 'authorization': `Bearer ${key}`, 'accept': 'application/json' },
    body:    form,
    signal:  AbortSignal.timeout(120_000),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(`Stability ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
  const b64 = body['image'] as string | undefined
  if (!b64) throw new Error('Stability returned no image')
  return { imageUrl: `data:image/png;base64,${b64}`, raw: { finishReason: body['finish_reason'] } }
}

async function genReplicate(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = process.env['REPLICATE_API_TOKEN']
  if (!key) throw new Error('REPLICATE_API_TOKEN not configured')
  const model = input.model ?? 'black-forest-labs/flux-schnell'
  // Use the synchronous predictions endpoint with `Prefer: wait`
  const res = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method:  'POST',
    headers: {
      'authorization': `Bearer ${key}`,
      'content-type':  'application/json',
      'prefer':        'wait',
    },
    body: JSON.stringify({
      input: {
        prompt:        input.prompt,
        aspect_ratio:  input.aspectRatio ?? '1:1',
        output_format: 'png',
      },
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(`Replicate ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
  const output = body['output']
  const url = Array.isArray(output) ? output[0] : (typeof output === 'string' ? output : null)
  if (!url) throw new Error('Replicate returned no image URL')
  return { imageUrl: String(url), raw: body }
}

async function genFal(input: GenerateInput): Promise<{ imageUrl: string; raw: unknown }> {
  const key = process.env['FAL_KEY']
  if (!key) throw new Error('FAL_KEY not configured')
  const model = input.model ?? 'fal-ai/flux/schnell'
  const res = await fetch(`https://fal.run/${model}`, {
    method:  'POST',
    headers: { 'authorization': `Key ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt:       input.prompt,
      image_size:   input.aspectRatio === '16:9' ? 'landscape_16_9' :
                    input.aspectRatio === '9:16' ? 'portrait_16_9'  : 'square_hd',
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const body = await res.json().catch(() => ({})) as Record<string, unknown>
  if (!res.ok) throw new Error(`fal ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
  const images = body['images'] as Array<{ url?: string }> | undefined
  const url = images?.[0]?.url
  if (!url) throw new Error('fal returned no image URL')
  return { imageUrl: url, raw: body }
}

const DRIVERS: Record<ImageProvider, (i: GenerateInput) => Promise<{ imageUrl: string; raw: unknown }>> = {
  openai: genOpenAI, stability: genStability, replicate: genReplicate, fal: genFal,
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'image-generator', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

export async function generateImage(input: GenerateInput): Promise<GenerateResult> {
  const id = uuidv7()
  const now = Date.now()
  const redactedPrompt = redactSecrets(input.prompt).redacted

  // Insert pending row up-front so user has visibility
  await db.insert(imageGenerations).values({
    id, workspaceId: input.workspaceId,
    prompt:          redactedPrompt,
    negativePrompt:  input.negativePrompt ?? null,
    provider:        input.provider,
    model:           input.model        ?? null,
    stylePreset:     input.stylePreset  ?? null,
    aspectRatio:     input.aspectRatio  ?? null,
    width:           input.width        ?? null,
    height:          input.height       ?? null,
    costEstimateUsd: estimateCostUsd(input.provider, input),
    status:          'pending',
    createdBy:       input.createdBy    ?? null,
    createdAt:       now,
  }).catch(() => null)

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
  try {
    const out = await DRIVERS[input.provider]({ ...input, prompt: redactedPrompt })
    const completedAt = Date.now()
    await db.update(imageGenerations).set({
      status:           'succeeded',
      imageUrl:         out.imageUrl,
      actualCostUsd:    estimate,
      providerResponse: out.raw as Record<string, unknown>,
      completedAt,
    }).where(eq(imageGenerations.id, id))
    await emit(input.workspaceId, 'image.generation_completed', { id, provider: input.provider, costUsd: estimate })
    return { id, status: 'succeeded', imageUrl: out.imageUrl, costEstimateUsd: estimate, actualCostUsd: estimate, provider: input.provider }
  } catch (e) {
    const msg = (e as Error).message
    await db.update(imageGenerations).set({
      status: 'failed', errorMessage: msg, completedAt: Date.now(),
    }).where(eq(imageGenerations.id, id))
    await emit(input.workspaceId, 'image.generation_failed', { id, provider: input.provider, error: msg })
    return { id, status: 'failed', costEstimateUsd: estimate, errorMessage: msg, provider: input.provider }
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
export function listAvailableProviders(): ImageProvider[] {
  const out: ImageProvider[] = []
  if (process.env['OPENAI_API_KEY'])      out.push('openai')
  if (process.env['STABILITY_API_KEY'])   out.push('stability')
  if (process.env['REPLICATE_API_TOKEN']) out.push('replicate')
  if (process.env['FAL_KEY'])             out.push('fal')
  return out
}
