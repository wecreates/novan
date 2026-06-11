/**
 * R631 — Long-form transcribe (A3) + NotebookLM-style podcast (A4).
 *
 *   voice.transcribe_long  — accept a long audio buffer/URL; chunk into
 *                            ~10min slices (server-side guess based on bytes),
 *                            ASR each, stitch, optionally summarize/chapter.
 *   podcast.generate       — combine R621 RAG hits or arbitrary source text
 *                            into a 2-host conversational script, then run
 *                            sentence-by-sentence TTS with alternating voices.
 *                            Returns concatenated mp3 (best-effort; mp3 frame
 *                            concat works in most players without re-mux).
 */
import { Buffer } from 'node:buffer'
import type { ChatMsg } from './chat-providers.js'

// ─── A3 long-form transcription ─────────────────────────────────────────────

export interface LongTranscribeInput {
  audioBase64?: string
  audioUrl?:    string
  filename?:    string
  lang?:        string
  chapter?:     boolean    // summarize + propose chapter timestamps
  summarize?:   boolean
}

export interface LongTranscribeResult {
  text:        string
  chunks:      Array<{ index: number; text: string; ok: boolean; error?: string }>
  durationMs:  number
  summary?:    string
  chapters?:   Array<{ title: string; approxStartSec: number }>
}

async function resolveAudio(input: LongTranscribeInput): Promise<{ ok: true; buf: Buffer; mime: string } | { ok: false; error: string }> {
  if (input.audioBase64) return { ok: true, buf: Buffer.from(input.audioBase64, 'base64'), mime: 'audio/webm' }
  if (input.audioUrl) {
    try {
      const r = await fetch(input.audioUrl, { signal: AbortSignal.timeout(60_000) })
      if (!r.ok) return { ok: false, error: `fetch ${r.status}` }
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 200) return { ok: false, error: 'empty' }
      return { ok: true, buf, mime: r.headers.get('content-type') ?? 'audio/mpeg' }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }
  return { ok: false, error: 'audioBase64 or audioUrl required' }
}

// Simple byte-based chunking. ~10MB ≈ 8-10min for 128kbps mp3.
// We send each chunk to omniAsr (which falls back to OpenAI Whisper via R610).
const CHUNK_BYTES = 8 * 1024 * 1024

export async function transcribeLong(workspaceId: string, input: LongTranscribeInput): Promise<LongTranscribeResult> {
  const t0 = Date.now()
  const src = await resolveAudio(input)
  if (!src.ok) throw new Error(src.error)

  const chunks: LongTranscribeResult['chunks'] = []
  const slices: Buffer[] = []
  for (let i = 0; i < src.buf.length; i += CHUNK_BYTES) slices.push(src.buf.subarray(i, Math.min(i + CHUNK_BYTES, src.buf.length)))
  if (slices.length === 0) slices.push(src.buf)

  const { omniAsr } = await import('./r599-omnivoice-provider.js')
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i]
    if (!slice) continue
    try {
      const asrInput: Parameters<typeof omniAsr>[0] = { audio: slice, filename: input.filename ?? `chunk-${i}.bin` }
      if (input.lang) asrInput.language = input.lang
      const r = await omniAsr(asrInput, workspaceId)
      chunks.push({ index: i, text: (r.text ?? '').trim(), ok: true })
    } catch (e) {
      chunks.push({ index: i, text: '', ok: false, error: (e as Error).message })
    }
  }

  const fullText = chunks.map(c => c.text).filter(Boolean).join('\n\n').trim()
  const result: LongTranscribeResult = { text: fullText, chunks, durationMs: Date.now() - t0 }

  // Optional summary + chapters
  if ((input.summarize || input.chapter) && fullText.length > 200) {
    const { streamChat } = await import('./chat-providers.js')
    const msgs: ChatMsg[] = [
      { role: 'system', content: 'You summarize transcripts. Output JSON: { "summary": string (≤5 sentences), "chapters": [{"title": string, "approxStartSec": number}] }. approxStartSec is your best guess from the transcript flow (start at 0). If chapters not requested, return empty array.' },
      { role: 'user', content: `${input.chapter ? 'Propose 4-8 chapter titles + approximate start seconds.' : 'Skip chapters (return empty array).'}\n\nTranscript:\n${fullText.slice(0, 30000)}` },
    ]
    let raw = ''
    const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
    let next: IteratorResult<{ delta: string; done: boolean }, { tokens: number; costUsd: number; provider: string; model: string }>
    while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as { summary?: string; chapters?: Array<{ title: string; approxStartSec: number }> }
        if (parsed.summary)  result.summary  = parsed.summary
        if (parsed.chapters) result.chapters = parsed.chapters
      } catch { /* parse failed */ }
    }
  }
  return result
}

// ─── A4 NotebookLM-style podcast ─────────────────────────────────────────────

export interface PodcastInput {
  source:       string                       // any source text (RAG output, article, transcript)
  topic?:       string
  targetMin?:   number                       // target duration in minutes (default 5)
  voices?:      { hostA: string; hostB: string }   // R599/R610 voice ids
  language?:    string
}

export interface PodcastResult {
  script:       Array<{ speaker: 'A' | 'B'; text: string }>
  audioBase64?: string         // concatenated mp3
  bytes?:       number
  durationMs:   number
  tokens:       number
  costUsd:      number
}

const DEFAULT_VOICES = { hostA: 'nova', hostB: 'onyx' }   // R610 OpenAI voices

export async function generatePodcast(workspaceId: string, input: PodcastInput): Promise<PodcastResult> {
  const t0 = Date.now()
  if (!input.source?.trim()) throw new Error('source required')
  const targetMin = Math.max(2, Math.min(20, input.targetMin ?? 5))
  // Rough rule: 150 wpm × targetMin = target words. ~75 lines of dialogue avg.
  const targetLines = Math.round(targetMin * 12)

  const { streamChat } = await import('./chat-providers.js')
  const msgs: ChatMsg[] = [
    { role: 'system', content: `You write 2-host podcast scripts. Output JSON: { "script": [{"speaker": "A"|"B", "text": "..."}] }. Host A = curious learner, Host B = expert. Natural back-and-forth with questions, examples, and disagreement. Stay grounded in the source. ~${targetLines} lines total. No stage directions, no "[laughs]", no host names — just speaker tag + spoken text.` },
    { role: 'user', content: `${input.topic ? `Topic: ${input.topic}\n\n` : ''}Source material:\n${input.source.slice(0, 20000)}` },
  ]
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
  final = next.value

  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('LLM did not return JSON script')
  let parsed: { script?: Array<{ speaker?: string; text?: string }> }
  try { parsed = JSON.parse(m[0]) } catch { throw new Error('script JSON parse failed') }
  const script: PodcastResult['script'] = []
  for (const line of parsed.script ?? []) {
    const sp = line.speaker === 'B' ? 'B' as const : 'A' as const
    const t = (line.text ?? '').trim()
    if (t) script.push({ speaker: sp, text: t })
  }
  if (script.length < 4) throw new Error('script too short')

  // TTS each line; concatenate mp3 frames (lossy but plays in all major players).
  const voices = input.voices ?? DEFAULT_VOICES
  const { omniTts } = await import('./r599-omnivoice-provider.js')
  const audioChunks: Buffer[] = []
  for (const line of script) {
    try {
      const ttsInput: Parameters<typeof omniTts>[0] = {
        text:   line.text,
        voice:  line.speaker === 'A' ? voices.hostA : voices.hostB,
        format: 'mp3',
      }
      if (input.language) ttsInput.language = input.language
      const r = await omniTts(ttsInput, workspaceId)
      const ar = r as unknown as { audioBase64?: string; audio_base64?: string }
      const b64 = ar.audioBase64 ?? ar.audio_base64
      if (b64) audioChunks.push(Buffer.from(b64, 'base64'))
    } catch { /* skip line on TTS failure */ }
  }

  const result: PodcastResult = {
    script,
    durationMs: Date.now() - t0,
    tokens:     final.tokens,
    costUsd:    final.costUsd,
  }
  if (audioChunks.length > 0) {
    const concat = Buffer.concat(audioChunks)
    result.audioBase64 = concat.toString('base64')
    result.bytes = concat.length
  }
  return result
}
