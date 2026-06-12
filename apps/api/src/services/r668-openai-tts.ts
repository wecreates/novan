/**
 * R668 — OpenAI text-to-speech.
 *
 * Reuses OPENAI_API_KEY. Persists the result as an audio asset (MP3) via
 * R616 so the URL flows through the same asset infrastructure as images.
 * Voices: alloy, echo, fable, onyx, nova, shimmer, ash, ballad, coral, sage.
 * Models: tts-1 (fast, $15/1M chars) or tts-1-hd (higher quality, $30/1M).
 */

export interface TtsInput {
  text:    string
  voice?:  'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'ash' | 'ballad' | 'coral' | 'sage'
  model?:  'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts'
  format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav'
  speed?:  number  // 0.25 to 4.0
}

export interface TtsResult {
  ok:        boolean
  assetId?:  string
  publicUrl?: string
  bytes?:    number
  durationApproxSec?: number
  model:     string
  voice:     string
  costUsd:   number
  latencyMs: number
  error?:    string
}

const COST_PER_1K_CHARS: Record<string, number> = {
  'tts-1':           0.015,
  'tts-1-hd':        0.030,
  'gpt-4o-mini-tts': 0.012,
}

export async function speak(workspaceId: string, input: TtsInput): Promise<TtsResult> {
  const t0 = Date.now()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set', model: 'tts-1', voice: 'alloy', costUsd: 0, latencyMs: Date.now() - t0 }
  if (!input.text?.trim()) return { ok: false, error: 'text required', model: 'tts-1', voice: 'alloy', costUsd: 0, latencyMs: Date.now() - t0 }
  const text = input.text.slice(0, 4096)  // OpenAI cap
  const model = input.model ?? 'tts-1'
  const voice = input.voice ?? 'alloy'
  const format = input.format ?? 'mp3'

  const body: Record<string, unknown> = { model, input: text, voice, response_format: format }
  if (input.speed) body['speed'] = Math.max(0.25, Math.min(4.0, input.speed))

  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return { ok: false, error: `openai ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`,
        model, voice, costUsd: 0, latencyMs: Date.now() - t0 }
    }
    const buf = Buffer.from(await res.arrayBuffer())

    const { persistAsset } = await import('./r616-asset-persistence.js')
    const mimeMap: Record<string, string> = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav' }
    let assetId: string | undefined
    let publicUrl: string | undefined
    try {
      const a = await persistAsset({
        workspaceId, kind: 'audio', mime: mimeMap[format] ?? 'audio/mpeg', bytes: buf,
        prompt: text.slice(0, 200),
        metadata: { provider: 'openai', model, voice, format },
      } as Parameters<typeof persistAsset>[0])
      if (a?.id) assetId = a.id
      if (a?.publicUrl) publicUrl = a.publicUrl
    } catch { /* tolerated */ }

    const costUsd = (text.length / 1000) * (COST_PER_1K_CHARS[model] ?? 0.015)
    const durationApproxSec = Math.round(text.length / 18)  // ~18 chars/sec average speech
    const result: TtsResult = {
      ok: true, bytes: buf.length, durationApproxSec, model, voice,
      costUsd: Number(costUsd.toFixed(6)),
      latencyMs: Date.now() - t0,
    }
    if (assetId)   result.assetId   = assetId
    if (publicUrl) result.publicUrl = publicUrl
    return result
  } catch (e) {
    return { ok: false, error: (e as Error).message, model, voice, costUsd: 0, latencyMs: Date.now() - t0 }
  }
}
