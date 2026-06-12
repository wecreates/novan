/**
 * R654 — OpenAI gpt-image-1 prompt-to-image.
 *
 * Higher-quality direct image gen with the same OPENAI_API_KEY we already use
 * for chat/tools/schema. Persists the image as an asset via R616 so it lands
 * in the workspace's S3 bucket + gets auto-KG-linked (R646b wiring).
 *
 * Falls back gracefully when OPENAI_API_KEY is missing — caller already has
 * R609 (image.free.generate, FLUX-schnell/Pollinations) for the no-key path.
 */
import crypto from 'crypto'

export interface OpenAIImageInput {
  prompt:    string
  size?:     '1024x1024' | '1024x1536' | '1536x1024' | '1792x1024' | '1024x1792' | 'auto'
  quality?:  'low' | 'medium' | 'high' | 'auto'
  n?:        number
  background?: 'transparent' | 'opaque' | 'auto'
}

export interface OpenAIImageResult {
  ok:        boolean
  assetIds?: string[]
  urls?:     string[]
  bytes?:    number
  model:     string
  costUsd:   number
  latencyMs: number
  error?:    string
}

const COST_PER_IMAGE: Record<string, number> = {
  // gpt-image-1 pricing rough estimate (2026-Q2): $0.04 medium 1024², $0.17 high 1024²
  'low':    0.011,
  'medium': 0.042,
  'high':   0.167,
  'auto':   0.042,
}

export async function generateOpenAIImage(workspaceId: string, input: OpenAIImageInput): Promise<OpenAIImageResult> {
  const t0 = Date.now()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) {
    return { ok: false, error: 'OPENAI_API_KEY not set', model: 'gpt-image-1', costUsd: 0, latencyMs: Date.now() - t0 }
  }
  const size = input.size ?? '1024x1024'
  const quality = input.quality ?? 'medium'
  const n = Math.max(1, Math.min(4, input.n ?? 1))

  const body: Record<string, unknown> = {
    model: 'gpt-image-1',
    prompt: input.prompt,
    size,
    quality,
    n,
    output_format: 'png',
  }
  if (input.background) body['background'] = input.background

  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return {
        ok: false,
        error: `openai ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`,
        model: 'gpt-image-1', costUsd: 0, latencyMs: Date.now() - t0,
      }
    }
    const j = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> }
    const imgs = j.data ?? []
    if (imgs.length === 0) {
      return { ok: false, error: 'no images returned', model: 'gpt-image-1', costUsd: 0, latencyMs: Date.now() - t0 }
    }

    // Persist each image via R616
    const { persistAsset } = await import('./r616-asset-persistence.js')
    const assetIds: string[] = []
    const urls: string[] = []
    let totalBytes = 0
    for (const img of imgs) {
      let buf: Buffer | null = null
      if (img.b64_json) buf = Buffer.from(img.b64_json, 'base64')
      else if (img.url) {
        try {
          const ir = await fetch(img.url)
          if (ir.ok) buf = Buffer.from(await ir.arrayBuffer())
        } catch { /* skip */ }
      }
      if (!buf) continue
      totalBytes += buf.length
      try {
        const a = await persistAsset({
          workspaceId,
          kind: 'image',
          mime: 'image/png',
          bytes: buf,
          prompt: input.prompt,
          metadata: { provider: 'openai', model: 'gpt-image-1', size, quality },
        } as Parameters<typeof persistAsset>[0])
        if (a?.id) assetIds.push(a.id)
        if (a?.publicUrl) urls.push(a.publicUrl)
      } catch { /* persistence failure tolerated */ }
    }

    const costUsd = (COST_PER_IMAGE[quality] ?? 0.042) * n
    const result: OpenAIImageResult = {
      ok: true,
      assetIds, urls, bytes: totalBytes,
      model: 'gpt-image-1',
      costUsd: Number(costUsd.toFixed(4)),
      latencyMs: Date.now() - t0,
    }
    return result
  } catch (e) {
    return { ok: false, error: (e as Error).message, model: 'gpt-image-1', costUsd: 0, latencyMs: Date.now() - t0 }
  }
}

// Helper for callers wanting a stable id without DB roundtrip
export function _imgRequestId(): string { return `img_${crypto.randomBytes(6).toString('hex')}` }

// R666 — image edit (image-to-image)
export interface OpenAIImageEditInput {
  prompt:    string
  /** Source image: one of imageUrl, imageB64, or assetId. */
  imageUrl?: string
  imageB64?: string
  assetId?:  string
  /** Optional mask PNG (transparent where edits should happen) */
  maskB64?:  string
  size?:     '1024x1024' | '1024x1536' | '1536x1024' | 'auto'
  quality?:  'low' | 'medium' | 'high' | 'auto'
  n?:        number
}

async function resolveImageBytes(workspaceId: string, input: OpenAIImageEditInput): Promise<Buffer | null> {
  if (input.imageB64) return Buffer.from(input.imageB64, 'base64')
  if (input.imageUrl) {
    try {
      const r = await fetch(input.imageUrl)
      if (!r.ok) return null
      return Buffer.from(await r.arrayBuffer())
    } catch { return null }
  }
  if (input.assetId) {
    try {
      const { db } = await import('../db/client.js')
      const { sql } = await import('drizzle-orm')
      const rows = await db.execute(sql`SELECT public_url FROM generated_assets WHERE id = ${input.assetId} AND workspace_id = ${workspaceId} LIMIT 1`)
      const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
      const url = r?.['public_url'] ? String(r['public_url']) : null
      if (!url) return null
      const ir = await fetch(url)
      if (!ir.ok) return null
      return Buffer.from(await ir.arrayBuffer())
    } catch { return null }
  }
  return null
}

export async function editOpenAIImage(workspaceId: string, input: OpenAIImageEditInput): Promise<OpenAIImageResult> {
  const t0 = Date.now()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) {
    return { ok: false, error: 'OPENAI_API_KEY not set', model: 'gpt-image-1', costUsd: 0, latencyMs: Date.now() - t0 }
  }
  const bytes = await resolveImageBytes(workspaceId, input)
  if (!bytes) {
    return { ok: false, error: 'failed to resolve source image (imageUrl/imageB64/assetId)', model: 'gpt-image-1', costUsd: 0, latencyMs: Date.now() - t0 }
  }
  const size = input.size ?? '1024x1024'
  const quality = input.quality ?? 'medium'
  const n = Math.max(1, Math.min(4, input.n ?? 1))

  const fd = new FormData()
  fd.append('model', 'gpt-image-1')
  fd.append('prompt', input.prompt)
  fd.append('size', size)
  fd.append('quality', quality)
  fd.append('n', String(n))
  fd.append('image', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'source.png')
  if (input.maskB64) {
    const m = Buffer.from(input.maskB64, 'base64')
    fd.append('mask', new Blob([new Uint8Array(m)], { type: 'image/png' }), 'mask.png')
  }

  try {
    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: fd,
    })
    if (!res.ok) {
      return { ok: false, error: `openai ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`,
        model: 'gpt-image-1', costUsd: 0, latencyMs: Date.now() - t0 }
    }
    const j = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> }
    const imgs = j.data ?? []
    if (imgs.length === 0) {
      return { ok: false, error: 'no images returned', model: 'gpt-image-1', costUsd: 0, latencyMs: Date.now() - t0 }
    }

    const { persistAsset } = await import('./r616-asset-persistence.js')
    const assetIds: string[] = []
    const urls: string[] = []
    let totalBytes = 0
    for (const img of imgs) {
      let buf: Buffer | null = null
      if (img.b64_json) buf = Buffer.from(img.b64_json, 'base64')
      else if (img.url) {
        try { const ir = await fetch(img.url); if (ir.ok) buf = Buffer.from(await ir.arrayBuffer()) } catch { /* skip */ }
      }
      if (!buf) continue
      totalBytes += buf.length
      try {
        const a = await persistAsset({
          workspaceId, kind: 'image', mime: 'image/png', bytes: buf,
          prompt: input.prompt,
          metadata: { provider: 'openai', model: 'gpt-image-1', size, quality, edit: true },
        } as Parameters<typeof persistAsset>[0])
        if (a?.id) assetIds.push(a.id)
        if (a?.publicUrl) urls.push(a.publicUrl)
      } catch { /* tolerated */ }
    }

    const costUsd = (COST_PER_IMAGE[quality] ?? 0.042) * n
    return { ok: true, assetIds, urls, bytes: totalBytes, model: 'gpt-image-1',
      costUsd: Number(costUsd.toFixed(4)), latencyMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: (e as Error).message, model: 'gpt-image-1', costUsd: 0, latencyMs: Date.now() - t0 }
  }
}
