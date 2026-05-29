/**
 * ai-broll-generator.ts — generate synthetic b-roll via Runway / Luma /
 * Replicate-SVD / Veo when the asset scraper can't find the right shot.
 *
 * Provider chain:
 *   1. Runway Gen-3 Turbo  (RUNWAY_API_KEY)
 *   2. Luma Dream Machine  (LUMA_API_KEY)
 *   3. Replicate SVD       (REPLICATE_API_TOKEN, model stable-video-diffusion)
 *   4. Google Veo          (VEO_API_KEY) — Vertex AI, requires GCP setup
 *
 * All async — generation takes 30s–3min per clip. Polls until completion.
 */

import { writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BROLL_DIR = join(tmpdir(), 'novan-ai-broll')
if (!existsSync(BROLL_DIR)) mkdirSync(BROLL_DIR, { recursive: true })

export interface BrollPrompt {
  prompt:       string
  durationSec?: number          // 4-10
  aspectRatio?: '16:9' | '9:16' | '1:1'
  seedImageUrl?: string         // optional reference
}

export interface BrollResult {
  ok:        boolean
  path?:     string
  provider?: string
  durationSec?: number
  error?:    string
}

async function downloadTo(url: string, ext = 'mp4'): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(180_000) })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const dest = join(BROLL_DIR, `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`)
    await writeFile(dest, buf)
    return dest
  } catch { return null }
}

async function tryRunway(p: BrollPrompt): Promise<BrollResult> {
  const key = process.env['RUNWAY_API_KEY']
  if (!key) return { ok: false, error: 'no RUNWAY_API_KEY' }
  // Use production endpoint by default; operator can override to dev
  // via RUNWAY_API_BASE (e.g. https://api.dev.runwayml.com).
  // Previously hardcoded api.dev.runwayml.com — dev endpoint in prod code.
  const apiBase = process.env['RUNWAY_API_BASE'] ?? 'https://api.runwayml.com'
  try {
    const init = await fetch(`${apiBase}/v1/image_to_video`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gen3a_turbo',
        promptText: p.prompt,
        duration: Math.min(10, p.durationSec ?? 5),
        ratio: p.aspectRatio === '9:16' ? '768:1280' : p.aspectRatio === '1:1' ? '960:960' : '1280:768',
        ...(p.seedImageUrl ? { promptImage: p.seedImageUrl } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!init.ok) return { ok: false, error: `runway init ${init.status}` }
    const j = await init.json() as { id?: string }
    if (!j.id) return { ok: false, error: 'no task id' }
    // Poll
    const deadline = Date.now() + 5 * 60_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 4000))
      const s = await fetch(`${apiBase}/v1/tasks/${j.id}`, {
        headers: { Authorization: `Bearer ${key}`, 'X-Runway-Version': '2024-11-06' },
      })
      if (!s.ok) continue
      const sj = await s.json() as { status?: string; output?: string[] }
      if (sj.status === 'SUCCEEDED' && sj.output?.[0]) {
        const path = await downloadTo(sj.output[0])
        if (path) { const out: BrollResult = { ok: true, provider: 'runway', path }; if (p.durationSec) out.durationSec = p.durationSec; return out }
      }
      if (sj.status === 'FAILED') return { ok: false, error: 'runway failed' }
    }
    return { ok: false, error: 'runway timeout' }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

async function tryLuma(p: BrollPrompt): Promise<BrollResult> {
  const key = process.env['LUMA_API_KEY']
  if (!key) return { ok: false, error: 'no LUMA_API_KEY' }
  try {
    const init = await fetch('https://api.lumalabs.ai/dream-machine/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: p.prompt,
        aspect_ratio: p.aspectRatio ?? '16:9',
        loop: false,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!init.ok) return { ok: false, error: `luma init ${init.status}` }
    const j = await init.json() as { id?: string }
    if (!j.id) return { ok: false, error: 'no luma id' }
    const deadline = Date.now() + 6 * 60_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000))
      const s = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${j.id}`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (!s.ok) continue
      const sj = await s.json() as { state?: string; assets?: { video?: string } }
      if (sj.state === 'completed' && sj.assets?.video) {
        const path = await downloadTo(sj.assets.video)
        if (path) { const out: BrollResult = { ok: true, provider: 'luma', path }; if (p.durationSec) out.durationSec = p.durationSec; return out }
      }
      if (sj.state === 'failed') return { ok: false, error: 'luma failed' }
    }
    return { ok: false, error: 'luma timeout' }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

async function tryReplicateSVD(p: BrollPrompt): Promise<BrollResult> {
  const key = process.env['REPLICATE_API_TOKEN']
  if (!key) return { ok: false, error: 'no REPLICATE_API_TOKEN' }
  try {
    const init = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'content-type': 'application/json', Prefer: 'wait=60' },
      body: JSON.stringify({
        version: '3f0457e4619daac51203dedb472816fd4af51f3149fa7a9e0b5ffcf1b8172438',
        input: { prompt: p.prompt, video_length: p.durationSec === 8 ? '25_frames_with_svd_xt' : '14_frames_with_svd', sizing_strategy: 'maintain_aspect_ratio' },
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!init.ok) return { ok: false, error: `replicate ${init.status}` }
    const j = await init.json() as { id?: string; output?: string | string[]; status?: string }
    let url: string | undefined
    if (j.output) url = Array.isArray(j.output) ? j.output[0] : j.output
    if (!url && j.id) {
      const deadline = Date.now() + 5 * 60_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 4000))
        const s = await fetch(`https://api.replicate.com/v1/predictions/${j.id}`, { headers: { Authorization: `Token ${key}` } })
        if (!s.ok) continue
        const sj = await s.json() as { status?: string; output?: string | string[] }
        if (sj.status === 'succeeded' && sj.output) { url = Array.isArray(sj.output) ? sj.output[0] : sj.output; break }
        if (sj.status === 'failed') return { ok: false, error: 'replicate failed' }
      }
    }
    if (!url) return { ok: false, error: 'no replicate output' }
    const path = await downloadTo(url)
    if (!path) return { ok: false, error: 'replicate download failed' }
    const out: BrollResult = { ok: true, provider: 'replicate-svd', path }
    if (p.durationSec) out.durationSec = p.durationSec
    return out
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function generateBroll(p: BrollPrompt): Promise<BrollResult> {
  for (const fn of [tryRunway, tryLuma, tryReplicateSVD]) {
    const r = await fn(p)
    if (r.ok) return r
  }
  return { ok: false, error: 'all AI b-roll providers failed or unconfigured' }
}

export async function generateBatch(prompts: BrollPrompt[]): Promise<BrollResult[]> {
  return Promise.all(prompts.map(generateBroll))
}
