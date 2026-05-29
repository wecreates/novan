/**
 * voiceover-service.ts — text-to-speech for video narration.
 *
 * Provider chain (in order of vocal naturalness):
 *   1. ElevenLabs  (ELEVENLABS_API_KEY)   — gold standard, most natural
 *   2. OpenAI TTS  (OPENAI_API_KEY)       — strong fallback, fast
 *   3. PlayHT      (PLAYHT_API_KEY+USER)  — third option
 *
 * Outputs a WAV file. Used by the editor agent to generate per-beat
 * narration, then ducked under music via the master chain.
 */

import { writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const VO_DIR = join(tmpdir(), 'novan-voiceover')
if (!existsSync(VO_DIR)) mkdirSync(VO_DIR, { recursive: true })

export interface TtsInput {
  text:    string
  outPath?: string
  voice?:  string                 // provider-specific voice id; default per provider
  style?:  'neutral' | 'narrator' | 'energetic' | 'calm' | 'authoritative'
  speed?:  number                 // 0.5–2.0; default 1.0
  workspaceId?: string
}

export interface TtsResult {
  ok:        boolean
  path?:     string
  provider?: string
  voice?:    string
  durationSec?: number
  error?:    string
}

// ─── ElevenLabs ────────────────────────────────────────────────────────
async function ttsElevenLabs(input: TtsInput): Promise<TtsResult> {
  const key = process.env['ELEVENLABS_API_KEY']
  if (!key) return { ok: false, error: 'no ELEVENLABS_API_KEY' }
  // Voice IDs: Rachel (narrator), Adam (deep authoritative), Bella (energetic).
  // Operator can override via input.voice (Elevenlabs voice_id).
  const voice = input.voice ?? process.env['ELEVENLABS_VOICE_ID'] ?? '21m00Tcm4TlvDq8ikWAM' // Rachel
  const styleMap = { neutral: 0.0, narrator: 0.15, energetic: 0.45, calm: 0.1, authoritative: 0.25 }
  const stability = input.style === 'energetic' ? 0.4 : input.style === 'calm' ? 0.75 : 0.55
  const startMs = Date.now()
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: input.text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability,
          similarity_boost: 0.78,
          style: styleMap[input.style ?? 'neutral'],
          use_speaker_boost: true,
        },
      }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!r.ok) return { ok: false, error: `elevenlabs ${r.status}` }
    const buf = Buffer.from(await r.arrayBuffer())
    const dest = input.outPath ?? join(VO_DIR, `vo-el-${Date.now().toString(36)}.mp3`)
    await writeFile(dest, buf)
    // Cost tracking — ElevenLabs charges $0.30/1k chars on the paid plan
    try {
      const { recordAiUsage } = await import('./ai-cost-tracker.js')
      recordAiUsage({
        workspaceId: input.workspaceId ?? 'default',
        provider: 'elevenlabs', model: 'eleven_turbo_v2_5',
        promptTokens: input.text.length, outputTokens: 0,
        costUsd: (input.text.length / 1000) * 0.30,
        latencyMs: Date.now() - startMs,
        taskType: 'tts',
      })
    } catch { /* */ }
    return { ok: true, path: dest, provider: 'elevenlabs', voice }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

// ─── OpenAI TTS ────────────────────────────────────────────────────────
async function ttsOpenAI(input: TtsInput): Promise<TtsResult> {
  const key = process.env['OPENAI_API_KEY']
  if (!key) return { ok: false, error: 'no OPENAI_API_KEY' }
  const voice = input.voice ?? 'onyx'   // alloy | echo | fable | onyx | nova | shimmer
  const startMs = Date.now()
  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env['OPENAI_TTS_MODEL'] ?? 'tts-1-hd',
        voice,
        input: input.text,
        response_format: 'mp3',
        speed: input.speed ?? 1.0,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!r.ok) return { ok: false, error: `openai-tts ${r.status}` }
    const buf = Buffer.from(await r.arrayBuffer())
    const dest = input.outPath ?? join(VO_DIR, `vo-oa-${Date.now().toString(36)}.mp3`)
    await writeFile(dest, buf)
    // Cost — OpenAI tts-1-hd: $0.030/1k chars; tts-1: $0.015/1k chars
    try {
      const { recordAiUsage } = await import('./ai-cost-tracker.js')
      const model = process.env['OPENAI_TTS_MODEL'] ?? 'tts-1-hd'
      const ratePer1k = model.includes('hd') ? 0.030 : 0.015
      recordAiUsage({
        workspaceId: input.workspaceId ?? 'default', provider: 'openai', model,
        promptTokens: input.text.length, outputTokens: 0,
        costUsd: (input.text.length / 1000) * ratePer1k,
        latencyMs: Date.now() - startMs, taskType: 'tts',
      })
    } catch { /* */ }
    return { ok: true, path: dest, provider: 'openai', voice }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

// ─── PlayHT ────────────────────────────────────────────────────────────
async function ttsPlayHT(input: TtsInput): Promise<TtsResult> {
  const key = process.env['PLAYHT_API_KEY']
  const user = process.env['PLAYHT_USER_ID']
  if (!key || !user) return { ok: false, error: 'no PLAYHT credentials' }
  const voice = input.voice ?? 's3://voice-cloning-zero-shot/9f1ee23a-9108-4538-90be-8e62b1287c1f/jennifersaad/manifest.json'
  const startMs = Date.now()
  try {
    const r = await fetch('https://api.play.ht/api/v2/tts/stream', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'X-USER-ID': user, accept: 'audio/mpeg', 'content-type': 'application/json' },
      body: JSON.stringify({
        text: input.text, voice, output_format: 'mp3',
        voice_engine: 'PlayHT2.0-turbo', speed: input.speed ?? 1.0,
      }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!r.ok) return { ok: false, error: `playht ${r.status}` }
    const buf = Buffer.from(await r.arrayBuffer())
    const dest = input.outPath ?? join(VO_DIR, `vo-pl-${Date.now().toString(36)}.mp3`)
    await writeFile(dest, buf)
    // PlayHT TTS pricing: ~$0.39/1k chars on the standard tier as of
    // 2026-05. Previously this success path skipped recordAiUsage so
    // PlayHT-driven TTS was invisible to budget-guard while ElevenLabs
    // + OpenAI were tracked — operator's cost report under-counted
    // every time the fallback chain reached PlayHT.
    try {
      const { recordAiUsage } = await import('./ai-cost-tracker.js')
      recordAiUsage({
        workspaceId: input.workspaceId ?? 'default',
        provider: 'playht', model: 'PlayHT2.0-turbo',
        promptTokens: input.text.length, outputTokens: 0,
        costUsd: (input.text.length / 1000) * 0.39,
        latencyMs: Date.now() - startMs,
        taskType: 'tts',
      })
    } catch { /* tolerated */ }
    return { ok: true, path: dest, provider: 'playht', voice }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

// ─── Budget guard ──────────────────────────────────────────────────────
// Cost protection — ElevenLabs charges per character. A runaway mass-
// produce loop can burn $50+ in minutes if not capped. Configurable
// via TTS_MAX_CHARS_PER_DAY env (default 200_000 ≈ ~$11/day at $0.30/1K).
//
// SCHEMA-LESS DB-backed storage: previously tmpdir() JSON file was
// (a) lost on reboot, (b) RMW-race-unsafe under concurrent calls. Now
// uses an atomic UPSERT against a tiny budget table.
// R144 — NaN-safe coercion. Bad env value would silently lift the cap.
const MAX_CHARS_PER_DAY = (() => {
  const raw = process.env['TTS_MAX_CHARS_PER_DAY']
  if (!raw) return 200_000
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 200_000
})()
let _budgetEnsured = false
async function ensureBudgetTable(): Promise<void> {
  if (_budgetEnsured) return
  try {
    const { db } = await import('../db/client.js')
    const { sql: _sql } = await import('drizzle-orm')
    await db.execute(_sql`
      CREATE TABLE IF NOT EXISTS tts_budget (
        scope TEXT NOT NULL DEFAULT 'global' PRIMARY KEY,
        day_start BIGINT NOT NULL,
        chars_used INTEGER NOT NULL DEFAULT 0
      )`)
    _budgetEnsured = true
  } catch { /* DB unavailable — fall through to in-memory */ }
}

let _memBudget: { dayStart: number; charsUsed: number } = { dayStart: Date.now(), charsUsed: 0 }

interface BudgetState { dayStart: number; charsUsed: number }
async function readBudget(): Promise<BudgetState> {
  await ensureBudgetTable()
  try {
    const { db } = await import('../db/client.js')
    const { sql: _sql } = await import('drizzle-orm')
    const rows = await db.execute(_sql`SELECT day_start, chars_used FROM tts_budget WHERE scope = 'global' LIMIT 1`)
    const r = Array.isArray(rows) ? rows[0] : (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
    if (r) {
      const dayStart  = Number((r as Record<string, unknown>)['day_start'])
      const charsUsed = Number((r as Record<string, unknown>)['chars_used'])
      if (Date.now() - dayStart > 24 * 60 * 60_000) return { dayStart: Date.now(), charsUsed: 0 }
      return { dayStart, charsUsed }
    }
  } catch { /* */ }
  // Fallback to in-memory
  if (Date.now() - _memBudget.dayStart > 24 * 60 * 60_000) _memBudget = { dayStart: Date.now(), charsUsed: 0 }
  return _memBudget
}
async function bumpBudget(chars: number): Promise<void> {
  // ATOMIC upsert — increments inside a single SQL statement, so
  // concurrent calls don't race. Previously: readBudget + writeFile
  // was lost-update under concurrency.
  await ensureBudgetTable()
  const now = Date.now()
  try {
    const { db } = await import('../db/client.js')
    const { sql: _sql } = await import('drizzle-orm')
    await db.execute(_sql`
      INSERT INTO tts_budget (scope, day_start, chars_used)
      VALUES ('global', ${now}, ${chars})
      ON CONFLICT (scope) DO UPDATE SET
        chars_used = CASE
          WHEN ${now} - tts_budget.day_start > ${24 * 60 * 60_000} THEN ${chars}
          ELSE tts_budget.chars_used + ${chars}
        END,
        day_start = CASE
          WHEN ${now} - tts_budget.day_start > ${24 * 60 * 60_000} THEN ${now}
          ELSE tts_budget.day_start
        END
    `)
    return
  } catch { /* */ }
  // Fallback to in-memory
  if (now - _memBudget.dayStart > 24 * 60 * 60_000) _memBudget = { dayStart: now, charsUsed: 0 }
  _memBudget.charsUsed += chars
}
async function budgetOk(addChars: number): Promise<{ ok: boolean; remaining: number }> {
  const s = await readBudget()
  const remaining = MAX_CHARS_PER_DAY - s.charsUsed - addChars
  return { ok: remaining >= 0, remaining }
}

// ─── Chunking ──────────────────────────────────────────────────────────
// ElevenLabs caps at 5000 chars/request; OpenAI at 4096. Split on
// sentence boundaries so prosody doesn't crack across cuts.
const SAFE_CHUNK_CHARS = 3500
function chunkText(text: string, maxChars = SAFE_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) return [text]
  // Split on sentence terminator, then greedy-pack into chunks
  const sentences = text.match(/[^.!?]+[.!?]+|\S+$/g) ?? [text]
  const out: string[] = []
  let buf = ''
  for (const s of sentences) {
    if ((buf + s).length > maxChars) {
      if (buf) out.push(buf.trim())
      buf = s
    } else {
      buf += s
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

// ─── Public ────────────────────────────────────────────────────────────
export async function synthesize(input: TtsInput): Promise<TtsResult> {
  if (!input.text || input.text.trim().length === 0) return { ok: false, error: 'empty text' }
  if (input.outPath) try { mkdirSync(dirname(input.outPath), { recursive: true }) } catch { /* */ }
  // Budget check
  const budget = await budgetOk(input.text.length)
  if (!budget.ok) return { ok: false, error: `TTS daily budget exceeded (${MAX_CHARS_PER_DAY} chars). Raise TTS_MAX_CHARS_PER_DAY or wait until midnight.` }

  // Auto-chunk if text exceeds provider limits
  const chunks = chunkText(input.text)
  if (chunks.length > 1) {
    // Chunked path — DO NOT bump budget here. synthesizeBeats calls
    // synthesize per chunk, each of which already bumps for its own text.
    // Previously this AND the inner calls both bumped → double-counting.
    return synthesizeBeats(chunks, {
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.style ? { style: input.style } : {}),
      ...(input.speed ? { speed: input.speed } : {}),
      gapMs: 150,
    })
  }

  const chain = [ttsElevenLabs, ttsOpenAI, ttsPlayHT]
  let lastErr = ''
  for (const fn of chain) {
    const r = await fn(input)
    if (r.ok) { await bumpBudget(input.text.length); return r }
    lastErr = r.error ?? 'unknown'
  }
  return { ok: false, error: `all TTS providers failed: ${lastErr}` }
}

export async function ttsStatus(): Promise<{ charsUsedToday: number; charsRemaining: number; dailyCap: number }> {
  const s = await readBudget()
  return { charsUsedToday: s.charsUsed, charsRemaining: Math.max(0, MAX_CHARS_PER_DAY - s.charsUsed), dailyCap: MAX_CHARS_PER_DAY }
}

/**
 * Multi-beat narration: synthesize per-beat lines + concat into one file
 * with short silences between. Used by the editor agent before CapCut.
 */
export async function synthesizeBeats(lines: string[], opts: Omit<TtsInput, 'text' | 'outPath'> & { gapMs?: number } = {}): Promise<TtsResult & { partPaths?: string[] }> {
  if (lines.length === 0) return { ok: false, error: 'no lines' }
  const parts: string[] = []
  for (const line of lines) {
    if (!line || line.trim().length === 0) continue
    const r = await synthesize({ text: line, ...opts })
    if (!r.ok || !r.path) return { ok: false, error: `beat synth failed: ${r.error ?? 'unknown'}`, partPaths: parts }
    parts.push(r.path)
  }
  if (parts.length === 0) return { ok: false, error: 'no parts synthesized' }
  if (parts.length === 1) return { ok: true, path: parts[0]!, partPaths: parts, provider: 'concat-skipped' }
  // ffmpeg concat
  const { spawn } = await import('node:child_process')
  const ffmpeg = process.env['FFMPEG_BIN'] ?? 'ffmpeg'
  const listPath = join(VO_DIR, `concat-${Date.now().toString(36)}.txt`)
  const gapMs = opts.gapMs ?? 350
  const gapPath = join(VO_DIR, `gap-${gapMs}ms.mp3`)
  if (!existsSync(gapPath)) {
    await new Promise<void>((resolve) => {
      const p = spawn(ffmpeg, ['-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`, '-t', String(gapMs / 1000), '-q:a', '9', '-acodec', 'libmp3lame', gapPath], { windowsHide: true })
      p.on('close', () => resolve())
      p.on('error', () => resolve())
    })
  }
  const lines2: string[] = []
  for (let i = 0; i < parts.length; i++) {
    lines2.push(`file '${parts[i]!.replace(/'/g, "'\\''")}'`)
    if (i < parts.length - 1 && existsSync(gapPath)) lines2.push(`file '${gapPath.replace(/'/g, "'\\''")}'`)
  }
  await writeFile(listPath, lines2.join('\n'))
  const dest = join(VO_DIR, `vo-concat-${Date.now().toString(36)}.mp3`)
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', dest], { windowsHide: true })
    p.on('close', (c) => resolve(c === 0 && existsSync(dest)))
    p.on('error', () => resolve(false))
  })
  if (!ok) return { ok: false, error: 'ffmpeg concat failed', partPaths: parts }
  return { ok: true, path: dest, partPaths: parts, provider: 'concat' }
}
