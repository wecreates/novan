/**
 * R175 — Crystal-clear image generation.
 *
 * Frontier provider waterfall (best-quality first):
 *   1. flux_pro_ultra (Black Forest Labs)  — 8MP native, photographic depth
 *   2. mj_v7         (Midjourney via piapi) — best artistic/cinematic
 *   3. recraft_v3    (Recraft.ai)          — typography + brand assets
 *   4. imagen_4      (Google)              — photorealism + faces
 *   5. ideogram_v3   (Ideogram)            — text accuracy
 *
 * Upscaler waterfall:
 *   1. magnific  — creative high-detail upscale
 *   2. clarity   — best-quality realism
 *   3. topaz     — Gigapixel-style sharp
 *   4. upscayl   — open-source ESRGAN
 *
 * Vault keys (any/all):
 *   bfl_api_key, piapi_key, recraft_api_key, google_genai_key,
 *   ideogram_api_key, magnific_api_key, clarity_api_key,
 *   topaz_api_key, replicate_api_key
 */
import { db } from '../db/client.js'
import { imageProJob, imageUpscaleJob, secretsVault } from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

async function vaultKey(workspaceId: string, name: string, reason: string): Promise<string | null> {
  const [row] = await db.select({ id: secretsVault.id }).from(secretsVault)
    .where(and(eq(secretsVault.workspaceId, workspaceId), eq(secretsVault.name, name))).limit(1)
  if (!row) return null
  try {
    const { revealSecret } = await import('./secrets-vault.js')
    return await revealSecret(row.id, 'system:r175-image-pro', reason)
  } catch { return null }
}

// ─── Aspect → dims ──────────────────────────────────────────────────

function dimsForAspect(aspect: string, megapixels: number): { w: number; h: number } {
  const ratios: Record<string, [number, number]> = {
    '1:1':  [1, 1],
    '16:9': [16, 9],
    '9:16': [9, 16],
    '4:5':  [4, 5],
    '5:4':  [5, 4],
    '3:2':  [3, 2],
    '2:3':  [2, 3],
    '21:9': [21, 9],
  }
  const [rw, rh] = ratios[aspect] ?? [1, 1]
  const total = megapixels * 1_000_000
  const s = Math.sqrt(total / (rw * rh))
  const w = Math.round(rw * s / 8) * 8                // multiple of 8 for SD-derived models
  const h = Math.round(rh * s / 8) * 8
  return { w, h }
}

// ─── Generators ──────────────────────────────────────────────────────

export interface GenInput {
  prompt:         string
  negativePrompt?: string
  aspect?:        '1:1' | '16:9' | '9:16' | '4:5' | '5:4' | '3:2' | '2:3' | '21:9'
  megapixels?:    number     // 1, 2, 4, 8
  seed?:          number
  referenceUrls?: string[]
  provider?:      string
  businessId?:    string
}

const PROVIDERS: Array<{ id: string; secret: string; quality: number; mpMax: number }> = [
  { id: 'flux_pro_ultra', secret: 'bfl_api_key',       quality: 95, mpMax: 8 },
  { id: 'mj_v7',          secret: 'piapi_key',         quality: 92, mpMax: 4 },
  { id: 'recraft_v3',     secret: 'recraft_api_key',   quality: 90, mpMax: 4 },
  { id: 'imagen_4',       secret: 'google_genai_key',  quality: 90, mpMax: 2 },
  { id: 'ideogram_v3',    secret: 'ideogram_api_key',  quality: 88, mpMax: 2 },
]

export async function proGenerate(workspaceId: string, input: GenInput): Promise<{ id: string; status: string; provider?: string; outputUrl?: string; error?: string }> {
  if (!input.prompt || input.prompt.length < 4) throw new Error('prompt required')
  const aspect = input.aspect ?? '1:1'
  const mp = Math.max(1, Math.min(input.megapixels ?? 4, 8))
  const { w, h } = dimsForAspect(aspect, mp)

  // Provider preference: caller pin > waterfall (highest quality first that has key).
  const order = input.provider
    ? PROVIDERS.filter(p => p.id === input.provider)
    : PROVIDERS.filter(p => mp <= p.mpMax).sort((a, b) => b.quality - a.quality)

  const id = uuidv7()
  await db.insert(imageProJob).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    prompt: input.prompt.slice(0, 4000),
    ...(input.negativePrompt ? { negativePrompt: input.negativePrompt.slice(0, 1000) } : {}),
    provider: order[0]?.id ?? 'unknown',
    aspect, megapixels: mp,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    referenceUrls: input.referenceUrls ?? [],
    params: { width: w, height: h },
    status: 'running',
    createdAt: Date.now(),
  })

  const t0 = Date.now()
  let lastError = 'no provider configured'
  for (const p of order) {
    const key = await vaultKey(workspaceId, p.secret, `generate image via ${p.id}`)
    if (!key) continue
    try {
      const out = await callProvider(p.id, key, input, w, h)
      if (out?.url) {
        await db.update(imageProJob).set({
          provider: p.id,
          outputUrl: out.url,
          width: out.width ?? w,
          height: out.height ?? h,
          costUsd: out.cost ?? 0.05,
          latencyMs: Date.now() - t0,
          status: 'done',
          endedAt: Date.now(),
        }).where(eq(imageProJob.id, id))
        return { id, status: 'done', provider: p.id, outputUrl: out.url }
      }
      lastError = `${p.id}: empty response`
    } catch (e) {
      lastError = `${p.id}: ${(e as Error).message.slice(0, 200)}`
      continue
    }
  }
  await db.update(imageProJob).set({ status: 'failed', error: lastError, endedAt: Date.now() }).where(eq(imageProJob.id, id))
  return { id, status: 'failed', error: lastError }
}

async function callProvider(id: string, key: string, input: GenInput, width: number, height: number): Promise<{ url: string; width?: number; height?: number; cost?: number } | null> {
  if (id === 'flux_pro_ultra') {
    // Black Forest Labs FLUX.1.1 [pro] ultra.
    const sub = await fetch('https://api.bfl.ml/v1/flux-pro-1.1-ultra', {
      method: 'POST',
      headers: { 'x-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: input.prompt,
        aspect_ratio: input.aspect ?? '1:1',
        raw: false,
        output_format: 'png',
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
      }),
    })
    const submission = (await sub.json().catch(() => ({}))) as { id?: string; polling_url?: string }
    if (!submission.id) return null
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const poll = await fetch(submission.polling_url ?? `https://api.bfl.ml/v1/get_result?id=${submission.id}`, {
        headers: { 'x-key': key },
      })
      const pd = (await poll.json().catch(() => ({}))) as { status?: string; result?: { sample?: string } }
      if (pd.status === 'Ready' && pd.result?.sample) return { url: pd.result.sample, width, height, cost: 0.06 }
      if (pd.status === 'Failed' || pd.status === 'Error') return null
    }
    return null
  }
  if (id === 'mj_v7') {
    // piapi Midjourney v7 proxy.
    const sub = await fetch('https://api.piapi.ai/api/v1/task', {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'midjourney',
        task_type: 'imagine',
        input: { prompt: `${input.prompt} --v 7 --ar ${input.aspect ?? '1:1'}`, aspect_ratio: input.aspect ?? '1:1' },
      }),
    })
    const submission = (await sub.json().catch(() => ({}))) as { data?: { task_id?: string } }
    const taskId = submission.data?.task_id
    if (!taskId) return null
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 4000))
      const poll = await fetch(`https://api.piapi.ai/api/v1/task/${encodeURIComponent(taskId)}`, { headers: { 'x-api-key': key } })
      const pd = (await poll.json().catch(() => ({}))) as { data?: { status?: string; output?: { image_url?: string } } }
      if (pd.data?.status === 'completed' && pd.data.output?.image_url) return { url: pd.data.output.image_url, width, height, cost: 0.08 }
      if (pd.data?.status === 'failed') return null
    }
    return null
  }
  if (id === 'recraft_v3') {
    const res = await fetch('https://external.api.recraft.ai/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: input.prompt, model: 'recraftv3', size: `${width}x${height}`, style: 'realistic_image' }),
    })
    const data = (await res.json().catch(() => ({}))) as { data?: Array<{ url?: string }> }
    const url = data.data?.[0]?.url
    return url ? { url, width, height, cost: 0.04 } : null
  }
  if (id === 'imagen_4') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instances: [{ prompt: input.prompt }], parameters: { sampleCount: 1, aspectRatio: input.aspect ?? '1:1' } }),
    })
    const data = (await res.json().catch(() => ({}))) as { predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }> }
    const enc = data.predictions?.[0]?.bytesBase64Encoded
    if (!enc) return null
    const path = `/tmp/img-${uuidv7()}.png`
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, Buffer.from(enc, 'base64'))
    return { url: `file://${path}`, width, height, cost: 0.04 }
  }
  if (id === 'ideogram_v3') {
    const res = await fetch('https://api.ideogram.ai/v1/ideogram-v3/generate', {
      method: 'POST',
      headers: { 'Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: input.prompt, aspect_ratio: input.aspect ?? '1:1', rendering_speed: 'QUALITY' }),
    })
    const data = (await res.json().catch(() => ({}))) as { data?: Array<{ url?: string }> }
    const url = data.data?.[0]?.url
    return url ? { url, width, height, cost: 0.05 } : null
  }
  return null
}

// ─── Upscaler ────────────────────────────────────────────────────────

export interface UpscaleInput {
  imageUrl:     string
  factor?:      2 | 4 | 8
  detail?:      number       // 0..1
  provider?:    string
}

const UPSCALERS: Array<{ id: string; secret: string; quality: number }> = [
  { id: 'magnific', secret: 'magnific_api_key', quality: 95 },
  { id: 'clarity',  secret: 'clarity_api_key',  quality: 92 },
  { id: 'topaz',    secret: 'topaz_api_key',    quality: 90 },
  { id: 'upscayl',  secret: 'replicate_api_key', quality: 80 },
]

export async function upscale(workspaceId: string, input: UpscaleInput): Promise<{ id: string; status: string; provider?: string; outputUrl?: string; error?: string }> {
  if (!input.imageUrl) throw new Error('imageUrl required')
  const factor = input.factor ?? 4
  const detail = Math.max(0, Math.min(input.detail ?? 0.5, 1))
  const order = input.provider
    ? UPSCALERS.filter(u => u.id === input.provider)
    : [...UPSCALERS].sort((a, b) => b.quality - a.quality)

  const id = uuidv7()
  await db.insert(imageUpscaleJob).values({
    id, workspaceId,
    inputUrl: input.imageUrl,
    scaleFactor: factor,
    provider: order[0]?.id ?? 'unknown',
    detail,
    status: 'running',
    createdAt: Date.now(),
  })

  let lastError = 'no upscaler configured'
  for (const u of order) {
    const key = await vaultKey(workspaceId, u.secret, `upscale image via ${u.id}`)
    if (!key) continue
    try {
      const out = await callUpscaler(u.id, key, input.imageUrl, factor, detail)
      if (out?.url) {
        await db.update(imageUpscaleJob).set({
          provider: u.id, outputUrl: out.url,
          ...(out.widthOut ? { widthOut: out.widthOut } : {}),
          ...(out.heightOut ? { heightOut: out.heightOut } : {}),
          costUsd: out.cost ?? 0.10,
          status: 'done',
          endedAt: Date.now(),
        }).where(eq(imageUpscaleJob.id, id))
        return { id, status: 'done', provider: u.id, outputUrl: out.url }
      }
      lastError = `${u.id}: empty response`
    } catch (e) {
      lastError = `${u.id}: ${(e as Error).message.slice(0, 200)}`
      continue
    }
  }
  await db.update(imageUpscaleJob).set({ status: 'failed', error: lastError, endedAt: Date.now() }).where(eq(imageUpscaleJob.id, id))
  return { id, status: 'failed', error: lastError }
}

async function callUpscaler(id: string, key: string, imageUrl: string, factor: number, detail: number): Promise<{ url: string; widthOut?: number; heightOut?: number; cost?: number } | null> {
  if (id === 'magnific') {
    const res = await fetch('https://api.magnific.ai/v1/upscale', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, scale_factor: factor, creativity: detail, hdr: 0.5, resemblance: 0.7, fractality: 0.5 }),
    })
    const data = (await res.json().catch(() => ({}))) as { output_url?: string }
    return data.output_url ? { url: data.output_url, cost: 0.40 } : null
  }
  if (id === 'clarity') {
    const res = await fetch('https://api.clarity.ai/v1/upscale', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageUrl, scale: factor, detail }),
    })
    const data = (await res.json().catch(() => ({}))) as { result?: { url?: string } }
    return data.result?.url ? { url: data.result.url, cost: 0.25 } : null
  }
  if (id === 'topaz') {
    const res = await fetch('https://api.topazlabs.com/image/v1/enhance', {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, scale: factor, sharpen: detail }),
    })
    const data = (await res.json().catch(() => ({}))) as { url?: string }
    return data.url ? { url: data.url, cost: 0.20 } : null
  }
  if (id === 'upscayl') {
    // Replicate nightmareai/real-esrgan
    const sub = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { 'Authorization': `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: '42fed1c4974146d4d2414e2be2c5277c7fcf05fcc3a73abf41610695738c1d7b',
        input: { image: imageUrl, scale: factor, face_enhance: false },
      }),
    })
    const submission = (await sub.json().catch(() => ({}))) as { id?: string; urls?: { get?: string } }
    const pollUrl = submission.urls?.get
    if (!pollUrl) return null
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 3000))
      const poll = await fetch(pollUrl, { headers: { 'Authorization': `Token ${key}` } })
      const pd = (await poll.json().catch(() => ({}))) as { status?: string; output?: string | string[] }
      if (pd.status === 'succeeded' && pd.output) {
        const url = Array.isArray(pd.output) ? pd.output[0] : pd.output
        return url ? { url, cost: 0.08 } : null
      }
      if (pd.status === 'failed' || pd.status === 'canceled') return null
    }
    return null
  }
  return null
}

/**
 * Convenience: generate at top quality + auto-upscale for crystal-clear output.
 */
export async function crystalize(workspaceId: string, input: GenInput & { upscaleFactor?: 2 | 4 | 8; upscaleDetail?: number }): Promise<{ ok: boolean; genId?: string; upscaleId?: string; finalUrl?: string; provider?: string; upscaler?: string; error?: string }> {
  const g = await proGenerate(workspaceId, input)
  if (g.status !== 'done' || !g.outputUrl) return { ok: false, ...(g.id ? { genId: g.id } : {}), ...(g.error ? { error: g.error } : { error: 'generation failed' }) }
  const u = await upscale(workspaceId, { imageUrl: g.outputUrl, factor: input.upscaleFactor ?? 4, ...(input.upscaleDetail !== undefined ? { detail: input.upscaleDetail } : {}) })
  if (u.status !== 'done') return { ok: true, genId: g.id, ...(g.provider ? { provider: g.provider } : {}), finalUrl: g.outputUrl, ...(u.error ? { error: u.error } : {}) }
  return { ok: true, genId: g.id, upscaleId: u.id, ...(g.provider ? { provider: g.provider } : {}), ...(u.provider ? { upscaler: u.provider } : {}), finalUrl: u.outputUrl ?? g.outputUrl }
}

// ─── Reads ───────────────────────────────────────────────────────────

export async function proJobsList(workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<typeof imageProJob.$inferSelect>> {
  const filters = [eq(imageProJob.workspaceId, workspaceId)]
  if (opts.status) filters.push(eq(imageProJob.status, opts.status))
  return db.select().from(imageProJob).where(and(...filters)).orderBy(desc(imageProJob.createdAt)).limit(Math.min(opts.limit ?? 30, 200))
}

export async function upscaleJobsList(workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<typeof imageUpscaleJob.$inferSelect>> {
  const filters = [eq(imageUpscaleJob.workspaceId, workspaceId)]
  if (opts.status) filters.push(eq(imageUpscaleJob.status, opts.status))
  return db.select().from(imageUpscaleJob).where(and(...filters)).orderBy(desc(imageUpscaleJob.createdAt)).limit(Math.min(opts.limit ?? 30, 200))
}
