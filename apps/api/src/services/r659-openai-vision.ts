/**
 * R659 — OpenAI vision via gpt-4o.
 *
 * Parity with the R643 vision.ocr / vision.describe (which currently route
 * to Tesseract + Anthropic). With OPENAI_API_KEY present we get a single
 * provider call that handles both extract-text and describe-scene jobs.
 *
 * Accepts: base64 PNG/JPG OR URL OR asset_id (resolves to S3 public URL).
 * Returns: text + tokens + cost. Falls back to error when no key.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

export interface VisionInput {
  prompt?:  string
  imageUrl?: string
  imageB64?: string
  assetId?:  string
  mode?:     'describe' | 'ocr' | 'extract_data'
  model?:    string
}

export interface VisionResult {
  ok:        boolean
  text?:     string
  data?:     unknown
  model:     string
  tokens:    number
  costUsd:   number
  latencyMs: number
  error?:    string
}

const PROMPTS = {
  describe:     'Describe this image in detail: objects, scene, colors, mood, notable elements.',
  ocr:          'Extract every word of text visible in this image. Preserve line breaks and reading order. Output only the text, no commentary.',
  extract_data: 'Extract any structured data visible (numbers, tables, charts, labels). Output as JSON.',
}

async function resolveAssetUrl(workspaceId: string, assetId: string): Promise<string | null> {
  try {
    const rows = await db.execute(sql`
      SELECT public_url FROM assets WHERE id = ${assetId} AND workspace_id = ${workspaceId} LIMIT 1
    `)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    return r?.['public_url'] ? String(r['public_url']) : null
  } catch { return null }
}

export async function describeImage(workspaceId: string, input: VisionInput): Promise<VisionResult> {
  const t0 = Date.now()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) {
    return { ok: false, error: 'OPENAI_API_KEY not set', model: 'gpt-4o', tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
  }
  const model = input.model ?? 'gpt-4o'
  const mode = input.mode ?? 'describe'

  // Resolve image source to a data URL or external URL
  let imageRef: { type: 'image_url'; image_url: { url: string } } | null = null
  if (input.imageB64) {
    imageRef = { type: 'image_url', image_url: { url: `data:image/png;base64,${input.imageB64}` } }
  } else if (input.imageUrl) {
    imageRef = { type: 'image_url', image_url: { url: input.imageUrl } }
  } else if (input.assetId) {
    const url = await resolveAssetUrl(workspaceId, input.assetId)
    if (!url) return { ok: false, error: `asset ${input.assetId} not found`, model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
    imageRef = { type: 'image_url', image_url: { url } }
  }
  if (!imageRef) {
    return { ok: false, error: 'one of imageUrl, imageB64, assetId required', model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
  }

  const promptText = input.prompt ?? PROMPTS[mode]
  const body: Record<string, unknown> = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        imageRef,
      ],
    }],
    max_tokens: 2048,
  }

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return { ok: false, error: `openai ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`,
        model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
    }
    const j = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?:   { prompt_tokens?: number; completion_tokens?: number }
    }
    const text = j.choices?.[0]?.message?.content ?? ''
    const inp = (j.usage?.prompt_tokens ?? 0), out = (j.usage?.completion_tokens ?? 0)
    // gpt-4o pricing: $2.50 in / $10.00 out per 1M
    const costUsd = (inp / 1_000_000) * 2.5 + (out / 1_000_000) * 10
    const result: VisionResult = {
      ok: true, text, model,
      tokens: inp + out, costUsd: Number(costUsd.toFixed(6)),
      latencyMs: Date.now() - t0,
    }
    if (mode === 'extract_data') {
      try { result.data = JSON.parse(text) } catch { /* leave as text */ }
    }
    return result
  } catch (e) {
    return { ok: false, error: (e as Error).message, model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
  }
}
