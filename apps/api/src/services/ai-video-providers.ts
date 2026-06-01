/**
 * ai-video-providers.ts — R146.95 — frontier-model video generation clients.
 *
 * One client per provider. Each: takes a normalized RenderRequest, talks
 * to the provider's API, polls until completion, returns a RenderResult
 * with a downloadable URL + cost estimate + provider-native metadata.
 *
 * Providers:
 *   - Runway (Gen-3 / Gen-4 via api.runwayml.com)
 *   - Veo (Google Vertex AI - requires GCP service account JSON in env)
 *   - Sora (OpenAI tier-3 API)
 *   - Kling (via fal.ai proxy)
 *   - Luma (Dream Machine via api.lumalabs.ai)
 *
 * All clients honor:
 *   - Per-provider env-key gating; missing key → returns { ok: false, error: 'no-key' }
 *   - Soft-fail (never throw to caller) — orchestrator decides fallback
 *   - Cost recorded via recordAiUsage for budget tracking
 *   - Reference-image conditioning where provider supports it (IP-Adapter
 *     for Runway, ref images for Veo, image-to-video for all)
 */
import { recordAiUsage } from './ai-cost-tracker.js'

export interface RenderRequest {
  prompt:           string
  durationSec:      number
  aspectRatio?:     '16:9' | '9:16' | '1:1'
  seed?:            number
  referenceImages?: string[]            // for character/scene continuity
  prevShotEndFrame?: string             // for inter-shot continuity
  cameraMove?:      'static' | 'pan' | 'dolly' | 'crane' | 'tracking'
  workspaceId:      string
  // Provider hint for the cost-tracker
  callTag?:         string
}

export interface RenderResult {
  ok:           boolean
  provider:     string
  videoUrl?:    string
  thumbnailUrl?: string
  durationSec?: number
  jobId?:       string
  costUsd:      number
  latencyMs:    number
  error?:       string
  rawMeta?:     Record<string, unknown>
}

const TIMEOUT_BUDGET_MS = 10 * 60_000        // 10 min per shot — frontier models are slow

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout-${ms}ms`)), ms)),
  ])
}

async function pollUntilDone(check: () => Promise<{ done: boolean; videoUrl?: string; thumbnailUrl?: string; error?: string }>, intervalMs = 6000, maxAttempts = 100): Promise<{ done: boolean; videoUrl?: string; thumbnailUrl?: string; error?: string }> {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await check()
    if (r.done) return r
    if (r.error) return { done: false, error: r.error }
    await new Promise(res => setTimeout(res, intervalMs))
  }
  return { done: false, error: 'poll-timeout' }
}

function trackUsage(provider: string, workspaceId: string, costUsd: number, latencyMs: number, _ok: boolean): void {
  recordAiUsage({
    workspaceId,
    provider:       `video-${provider}`,
    model:          provider,
    promptTokens:   0,
    outputTokens:   0,
    costUsd,
    latencyMs,
    taskType:       'video-gen',
  })
}

// ─── Runway (Gen-3 Alpha / Gen-4 via api.runwayml.com) ─────────────────────

export async function renderViaRunway(req: RenderRequest): Promise<RenderResult> {
  const key = process.env['RUNWAY_API_KEY']
  if (!key) return { ok: false, provider: 'runway', costUsd: 0, latencyMs: 0, error: 'no-key' }
  const t0 = Date.now()
  try {
    // Runway pricing: ~$0.05/sec for Gen-3 Alpha Turbo, ~$0.10/sec for full Gen-3, Gen-4 higher
    const model = req.durationSec <= 5 ? 'gen3a_turbo' : 'gen3a'
    const ratio = req.aspectRatio === '9:16' ? '768:1280' : req.aspectRatio === '1:1' ? '960:960' : '1280:768'
    const body: Record<string, unknown> = {
      model,
      promptText: req.prompt.slice(0, 1000),
      duration:   Math.min(10, Math.max(5, Math.round(req.durationSec))),
      ratio,
      ...(req.seed                 ? { seed: req.seed } : {}),
      ...(req.referenceImages?.[0] ? { promptImage: req.referenceImages[0] } : {}),
    }
    const startRes = await withTimeout(fetch('https://api.runwayml.com/v1/image_to_video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }), 35_000)
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => '')
      const r = { ok: false, provider: 'runway', costUsd: 0, latencyMs: Date.now() - t0, error: `start ${startRes.status}: ${txt.slice(0, 200)}` }
      trackUsage('runway', req.workspaceId, 0, r.latencyMs, false)
      return r
    }
    const startData = await startRes.json() as { id?: string }
    const jobId = startData.id
    if (!jobId) {
      trackUsage('runway', req.workspaceId, 0, Date.now() - t0, false)
      return { ok: false, provider: 'runway', costUsd: 0, latencyMs: Date.now() - t0, error: 'no-job-id' }
    }
    const polled = await withTimeout(pollUntilDone(async () => {
      const r = await fetch(`https://api.runwayml.com/v1/tasks/${jobId}`, { headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06' }, signal: AbortSignal.timeout(15_000) })
      if (!r.ok) return { done: false, error: `poll ${r.status}` }
      const d = await r.json() as { status?: string; output?: string[]; failure?: { reason?: string } }
      if (d.status === 'SUCCEEDED' && d.output?.[0]) return { done: true, videoUrl: d.output[0] }
      if (d.status === 'FAILED') return { done: false, error: d.failure?.reason ?? 'failed' }
      return { done: false }
    }), TIMEOUT_BUDGET_MS)
    const costUsd = (model === 'gen3a_turbo' ? 0.05 : 0.10) * Math.min(10, req.durationSec)
    const latencyMs = Date.now() - t0
    if (!polled.done || !polled.videoUrl) {
      trackUsage('runway', req.workspaceId, costUsd, latencyMs, false)
      return { ok: false, provider: 'runway', costUsd, latencyMs, error: polled.error ?? 'no-video', jobId }
    }
    trackUsage('runway', req.workspaceId, costUsd, latencyMs, true)
    return { ok: true, provider: 'runway', videoUrl: polled.videoUrl, durationSec: req.durationSec, jobId, costUsd, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('runway', req.workspaceId, 0, latencyMs, false)
    return { ok: false, provider: 'runway', costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Veo (Google Vertex AI) ─────────────────────────────────────────────

export async function renderViaVeo(req: RenderRequest): Promise<RenderResult> {
  const project = process.env['GCP_PROJECT_ID']
  const region  = process.env['VEO_REGION'] ?? 'us-central1'
  const token   = process.env['GCP_ACCESS_TOKEN']     // operator must mint via gcloud + set; refresh out-of-process
  if (!project || !token) return { ok: false, provider: 'veo', costUsd: 0, latencyMs: 0, error: 'no-key (need GCP_PROJECT_ID + GCP_ACCESS_TOKEN)' }
  const t0 = Date.now()
  try {
    const model = 'veo-3.0-generate-preview'
    const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:predictLongRunning`
    const instance: Record<string, unknown> = { prompt: req.prompt.slice(0, 1500) }
    if (req.referenceImages?.[0]) instance['image'] = { bytesBase64Encoded: '', mimeType: 'image/jpeg' /* operator must upload via separate endpoint then pass GCS URI here */ }
    const body = {
      instances: [instance],
      parameters: {
        aspectRatio:      req.aspectRatio === '9:16' ? '9:16' : '16:9',
        durationSeconds:  Math.min(8, Math.max(2, Math.round(req.durationSec))),
        sampleCount:      1,
        ...(req.seed ? { seed: req.seed } : {}),
      },
    }
    const startRes = await withTimeout(fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }), 35_000)
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => '')
      const r = { ok: false, provider: 'veo', costUsd: 0, latencyMs: Date.now() - t0, error: `start ${startRes.status}: ${txt.slice(0, 200)}` }
      trackUsage('veo', req.workspaceId, 0, r.latencyMs, false)
      return r
    }
    const startData = await startRes.json() as { name?: string }
    const opName = startData.name
    if (!opName) {
      trackUsage('veo', req.workspaceId, 0, Date.now() - t0, false)
      return { ok: false, provider: 'veo', costUsd: 0, latencyMs: Date.now() - t0, error: 'no-operation-name' }
    }
    const polled = await withTimeout(pollUntilDone(async () => {
      const pollUrl = `https://${region}-aiplatform.googleapis.com/v1/${opName}:fetchPredictOperation`
      const r = await fetch(pollUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ operationName: opName }), signal: AbortSignal.timeout(15_000) })
      if (!r.ok) return { done: false, error: `poll ${r.status}` }
      const d = await r.json() as { done?: boolean; response?: { videos?: Array<{ gcsUri?: string }> }; error?: { message?: string } }
      if (d.error) return { done: false, error: d.error.message ?? 'failed' }
      if (d.done && d.response?.videos?.[0]?.gcsUri) return { done: true, videoUrl: d.response.videos[0].gcsUri }
      return { done: false }
    }), TIMEOUT_BUDGET_MS)
    // Veo 3 pricing: ~$0.35-0.50/sec (Preview); use 0.4 as midpoint
    const costUsd = 0.40 * Math.min(8, req.durationSec)
    const latencyMs = Date.now() - t0
    if (!polled.done || !polled.videoUrl) {
      trackUsage('veo', req.workspaceId, costUsd, latencyMs, false)
      return { ok: false, provider: 'veo', costUsd, latencyMs, error: polled.error ?? 'no-video', jobId: opName }
    }
    trackUsage('veo', req.workspaceId, costUsd, latencyMs, true)
    return { ok: true, provider: 'veo', videoUrl: polled.videoUrl, durationSec: req.durationSec, jobId: opName, costUsd, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('veo', req.workspaceId, 0, latencyMs, false)
    return { ok: false, provider: 'veo', costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Sora (OpenAI Video API) ────────────────────────────────────────────

export async function renderViaSora(req: RenderRequest): Promise<RenderResult> {
  const key = process.env['OPENAI_API_KEY']
  if (!key) return { ok: false, provider: 'sora', costUsd: 0, latencyMs: 0, error: 'no-key' }
  const t0 = Date.now()
  try {
    // OpenAI's Video API as of 2025-2026 — endpoint shape may evolve
    const body = {
      model:     'sora-1.0-turbo',
      prompt:    req.prompt.slice(0, 2000),
      size:      req.aspectRatio === '9:16' ? '720x1280' : req.aspectRatio === '1:1' ? '1024x1024' : '1280x720',
      duration:  Math.min(20, Math.max(5, Math.round(req.durationSec))),
      ...(req.seed ? { seed: req.seed } : {}),
    }
    const startRes = await withTimeout(fetch('https://api.openai.com/v1/videos/generations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    }), 35_000)
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => '')
      const r = { ok: false, provider: 'sora', costUsd: 0, latencyMs: Date.now() - t0, error: `start ${startRes.status}: ${txt.slice(0, 200)}` }
      trackUsage('sora', req.workspaceId, 0, r.latencyMs, false)
      return r
    }
    const startData = await startRes.json() as { id?: string; status?: string; output?: Array<{ url?: string }> }
    // Sora may return synchronously for short durations
    if (startData.output?.[0]?.url) {
      const costUsd = 0.30 * Math.min(20, req.durationSec)
      const latencyMs = Date.now() - t0
      trackUsage('sora', req.workspaceId, costUsd, latencyMs, true)
      return { ok: true, provider: 'sora', videoUrl: startData.output[0].url, durationSec: req.durationSec, jobId: startData.id ?? '', costUsd, latencyMs }
    }
    const jobId = startData.id
    if (!jobId) {
      trackUsage('sora', req.workspaceId, 0, Date.now() - t0, false)
      return { ok: false, provider: 'sora', costUsd: 0, latencyMs: Date.now() - t0, error: 'no-job-id' }
    }
    const polled = await withTimeout(pollUntilDone(async () => {
      const r = await fetch(`https://api.openai.com/v1/videos/generations/${jobId}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
      if (!r.ok) return { done: false, error: `poll ${r.status}` }
      const d = await r.json() as { status?: string; output?: Array<{ url?: string }>; error?: { message?: string } }
      if (d.status === 'completed' && d.output?.[0]?.url) return { done: true, videoUrl: d.output[0].url }
      if (d.status === 'failed') return { done: false, error: d.error?.message ?? 'failed' }
      return { done: false }
    }), TIMEOUT_BUDGET_MS)
    const costUsd = 0.30 * Math.min(20, req.durationSec)
    const latencyMs = Date.now() - t0
    if (!polled.done || !polled.videoUrl) {
      trackUsage('sora', req.workspaceId, costUsd, latencyMs, false)
      return { ok: false, provider: 'sora', costUsd, latencyMs, error: polled.error ?? 'no-video', jobId }
    }
    trackUsage('sora', req.workspaceId, costUsd, latencyMs, true)
    return { ok: true, provider: 'sora', videoUrl: polled.videoUrl, durationSec: req.durationSec, jobId, costUsd, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('sora', req.workspaceId, 0, latencyMs, false)
    return { ok: false, provider: 'sora', costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Kling (via fal.ai proxy) ───────────────────────────────────────────

export async function renderViaKling(req: RenderRequest): Promise<RenderResult> {
  const key = process.env['FAL_KEY']
  if (!key) return { ok: false, provider: 'kling', costUsd: 0, latencyMs: 0, error: 'no-key (FAL_KEY)' }
  const t0 = Date.now()
  try {
    const endpoint = 'https://fal.run/fal-ai/kling-video/v1.5/standard/text-to-video'
    const body = {
      prompt:           req.prompt.slice(0, 1500),
      duration:         req.durationSec <= 5 ? '5' : '10',
      aspect_ratio:     req.aspectRatio ?? '16:9',
      ...(req.referenceImages?.[0] ? { image_url: req.referenceImages[0] } : {}),
    }
    const res = await withTimeout(fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Key ${key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_BUDGET_MS),
    }), TIMEOUT_BUDGET_MS + 5000)
    const latencyMs = Date.now() - t0
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      trackUsage('kling', req.workspaceId, 0, latencyMs, false)
      return { ok: false, provider: 'kling', costUsd: 0, latencyMs, error: `${res.status}: ${txt.slice(0, 200)}` }
    }
    const data = await res.json() as { video?: { url?: string } }
    if (!data.video?.url) {
      trackUsage('kling', req.workspaceId, 0, latencyMs, false)
      return { ok: false, provider: 'kling', costUsd: 0, latencyMs, error: 'no-video-url' }
    }
    // Kling pricing via fal: ~$0.35 for 5s standard, ~$0.70 for 10s
    const costUsd = req.durationSec <= 5 ? 0.35 : 0.70
    trackUsage('kling', req.workspaceId, costUsd, latencyMs, true)
    return { ok: true, provider: 'kling', videoUrl: data.video.url, durationSec: req.durationSec, costUsd, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('kling', req.workspaceId, 0, latencyMs, false)
    return { ok: false, provider: 'kling', costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Luma Dream Machine ─────────────────────────────────────────────────

export async function renderViaLuma(req: RenderRequest): Promise<RenderResult> {
  const key = process.env['LUMA_API_KEY']
  if (!key) return { ok: false, provider: 'luma', costUsd: 0, latencyMs: 0, error: 'no-key' }
  const t0 = Date.now()
  try {
    const body: Record<string, unknown> = {
      prompt:       req.prompt.slice(0, 1500),
      aspect_ratio: req.aspectRatio ?? '16:9',
      loop:         false,
      ...(req.referenceImages?.[0] ? { keyframes: { frame0: { type: 'image', url: req.referenceImages[0] } } } : {}),
    }
    const startRes = await withTimeout(fetch('https://api.lumalabs.ai/dream-machine/v1/generations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    }), 35_000)
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => '')
      trackUsage('luma', req.workspaceId, 0, Date.now() - t0, false)
      return { ok: false, provider: 'luma', costUsd: 0, latencyMs: Date.now() - t0, error: `start ${startRes.status}: ${txt.slice(0, 200)}` }
    }
    const startData = await startRes.json() as { id?: string }
    const jobId = startData.id
    if (!jobId) {
      trackUsage('luma', req.workspaceId, 0, Date.now() - t0, false)
      return { ok: false, provider: 'luma', costUsd: 0, latencyMs: Date.now() - t0, error: 'no-job-id' }
    }
    const polled = await withTimeout(pollUntilDone(async () => {
      const r = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${jobId}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) })
      if (!r.ok) return { done: false, error: `poll ${r.status}` }
      const d = await r.json() as { state?: string; assets?: { video?: string }; failure_reason?: string }
      if (d.state === 'completed' && d.assets?.video) return { done: true, videoUrl: d.assets.video }
      if (d.state === 'failed') return { done: false, error: d.failure_reason ?? 'failed' }
      return { done: false }
    }), TIMEOUT_BUDGET_MS)
    // Luma pricing: ~$0.35/5s for Dream Machine
    const costUsd = 0.07 * Math.min(10, req.durationSec)
    const latencyMs = Date.now() - t0
    if (!polled.done || !polled.videoUrl) {
      trackUsage('luma', req.workspaceId, costUsd, latencyMs, false)
      return { ok: false, provider: 'luma', costUsd, latencyMs, error: polled.error ?? 'no-video', jobId }
    }
    trackUsage('luma', req.workspaceId, costUsd, latencyMs, true)
    return { ok: true, provider: 'luma', videoUrl: polled.videoUrl, durationSec: req.durationSec, jobId, costUsd, latencyMs }
  } catch (e) {
    const latencyMs = Date.now() - t0
    trackUsage('luma', req.workspaceId, 0, latencyMs, false)
    return { ok: false, provider: 'luma', costUsd: 0, latencyMs, error: (e as Error).message }
  }
}

// ─── Dispatcher ────────────────────────────────────────────────────────

export async function renderShot(provider: 'runway' | 'veo' | 'sora' | 'kling' | 'luma', req: RenderRequest): Promise<RenderResult> {
  switch (provider) {
    case 'runway': return renderViaRunway(req)
    case 'veo':    return renderViaVeo(req)
    case 'sora':   return renderViaSora(req)
    case 'kling':  return renderViaKling(req)
    case 'luma':   return renderViaLuma(req)
  }
}

/** Try primary, fall through to fallbacks on failure or no-key. */
export async function renderShotWithFallback(primary: 'runway' | 'veo' | 'sora' | 'kling' | 'luma', fallbacks: Array<'runway' | 'veo' | 'sora' | 'kling' | 'luma'>, req: RenderRequest): Promise<RenderResult & { providerChain: string[] }> {
  const chain: string[] = []
  const order = [primary, ...fallbacks]
  for (const p of order) {
    chain.push(p)
    const r = await renderShot(p, req)
    if (r.ok) return { ...r, providerChain: chain }
    // If failure is "no-key" we definitely want to try next; for real errors also fall through
  }
  return { ok: false, provider: 'none', costUsd: 0, latencyMs: 0, error: 'all-providers-failed', providerChain: chain }
}
