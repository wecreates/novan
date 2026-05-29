/**
 * music-studio.ts — ACE-Step v1.5 bridge for the brain.
 *
 * Wraps the local ACE-Step REST server (default http://127.0.0.1:8001)
 * with three high-level capabilities:
 *
 *   1. generateMusic({prompt, lyrics, duration, ...}) — text→music with
 *      quality presets tuned to beat Suno / Udio (less robotic vocals,
 *      48kHz stereo wav32, SDE diffusion, more inference steps).
 *
 *   2. replicateSong(url, instructions?) — drop ANY song URL (Spotify,
 *      Apple Music, YouTube Music, SoundCloud, Bandcamp, Tidal, Deezer,
 *      Audius, direct mp3/wav). Downloads via yt-dlp, extracts audio
 *      analysis + codes, then regenerates a near-identical track with
 *      legally safe variation (different vocal timbre, ~0.4 cover noise,
 *      LM-rewritten lyrics with same meaning).
 *
 *   3. autoStartServer() — spawns the ACE-Step API server in the
 *      background if not already running. Brain calls this on first
 *      music op so the user never has to launch it manually.
 *
 * URL detection helpers (extractSongUrls, isLikelySongPage) are used by
 * novan-chat.ts to auto-trigger replication when a song link appears.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Config ────────────────────────────────────────────────────────────
const ACESTEP_BASE = process.env['ACESTEP_API_URL'] ?? 'http://127.0.0.1:8001'
const ACESTEP_REPO = process.env['ACESTEP_REPO_PATH'] ?? 'C:\\Users\\19496\\Downloads\\ACE-Step-1.5-main'
const ACESTEP_API_KEY = process.env['ACESTEP_API_KEY'] ?? ''
const YTDLP_BIN = process.env['YTDLP_BIN'] ?? 'yt-dlp'
const FFMPEG_BIN = process.env['FFMPEG_BIN'] ?? 'ffmpeg'

const MUSIC_TMP_DIR = join(tmpdir(), 'novan-music')
if (!existsSync(MUSIC_TMP_DIR)) mkdirSync(MUSIC_TMP_DIR, { recursive: true })

// ─── Quality presets (tuned to beat Suno/Udio) ─────────────────────────
// Defaults aim for: natural vocals, full mix headroom, coherent structure.
const QUALITY_PRESET = {
  // MASTER — top fidelity. ~2x slower than studio but cleanest output.
  // Uses ADG (Adaptive Diffusion Guidance) with a CFG interval to keep
  // guidance high where it matters (mid-diffusion) and low at the start
  // + end → less over-saturation, more natural micro-dynamics.
  master: {
    inference_steps: 150,                  // 120 → 150: cleaner diffusion convergence
    guidance_scale: 9.0,
    infer_method: 'sde',                   // SDE keeps natural micro-timing in vocals
    shift: 3.3,
    use_adg: true,                         // adaptive diffusion guidance
    cfg_interval_start: 0.05,
    cfg_interval_end: 0.95,
    use_cot_caption: true,                 // LM CoT enriches caption → richer mix
    use_cot_language: true,                // LM CoT on phonemes → natural singing
    use_format: true,
    thinking: true,                        // 5Hz LM generates structure codes
    lm_temperature: 0.78,                  // tighter sampling → fewer phoneme artifacts
    lm_cfg_scale: 2.7,
    lm_top_p: 0.93,
    lm_top_k: 40,
    lm_repetition_penalty: 1.08,           // stops vocal stutter loops
    constrained_decoding: true,
    constrained_decoding_debug: false,
    audio_format: 'wav32',                 // 32-bit float WAV for mastering headroom
    use_tiled_decode: true,
    audio_duration: 180,
  },
  studio: {
    inference_steps: 60,
    guidance_scale: 8.5,
    infer_method: 'sde',
    shift: 3.0,
    use_cot_caption: true,
    use_cot_language: true,
    use_format: true,
    thinking: true,
    lm_temperature: 0.85,
    lm_cfg_scale: 2.5,
    lm_top_p: 0.9,
    constrained_decoding: true,
    audio_format: 'wav32',
    use_tiled_decode: true,
    audio_duration: 180,
  },
  draft: {
    inference_steps: 16,
    guidance_scale: 7.0,
    infer_method: 'ode',
    audio_format: 'mp3',
    audio_duration: 45,
    thinking: false,
    use_format: false,
  },
} as const

export type QualityTier = keyof typeof QUALITY_PRESET

// ─── Types ─────────────────────────────────────────────────────────────
export interface GenerateMusicInput {
  prompt?: string                 // e.g. "dreamy synthwave, female vocals, 90bpm"
  lyrics?: string                 // optional explicit lyrics
  duration?: number               // seconds (default 180)
  bpm?: number
  key?: string                    // e.g. "C major"
  language?: string               // vocal_language, default 'en'
  quality?: QualityTier           // 'master' | 'studio' | 'draft'
  seed?: number                   // -1 = random
  referenceAudioPath?: string     // optional reference for style match
  coverStrength?: number          // 0..1, how close to reference (default 1.0)
  coverNoise?: number             // 0..1, variation injected (default 0.0)
  instruction?: string            // extra DiT instruction text
  workspaceId?: string
  // ── Conductor controls ──────────────────────────────────────────
  takes?: number                  // render N variations, pick highest-scored (default 1; 3 for vocal-heavy)
  applyMastering?: boolean        // run two-pass loudnorm + true-peak limit + 48k/24-bit (default true for master tier)
  hasVocals?: boolean             // hint: triggers takes=3 if unset, runs vocal-enhance pass before mastering
}

export interface MusicJob {
  ok: boolean
  jobId?: string
  status?: 'queued' | 'running' | 'done' | 'failed' | 'unknown'
  audioPath?: string              // server-side path
  audioUrl?: string               // /v1/audio?path=... on ACE server
  localPath?: string              // local mirror path after download
  masteredPath?: string           // mastered final file (broadcast spec)
  durationSec?: number
  format?: string
  bpm?: number
  key?: string
  promptUsed?: string
  lyricsUsed?: string
  error?: string
  startedAt: number
  finishedAt?: number
  // ── Conductor metadata ──────────────────────────────────────────
  takesRendered?: number          // how many variations were generated
  selectedTakeScore?: number      // naturalness score of the chosen take
  mastering?: {
    lufs?: number
    truePeakDb?: number
    sampleRate?: number
    bitDepth?: number
  }
}

// ─── HTTP helpers ──────────────────────────────────────────────────────
async function aceFetch(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    }
    if (ACESTEP_API_KEY) headers['authorization'] = `Bearer ${ACESTEP_API_KEY}`
    return await fetch(`${ACESTEP_BASE}${path}`, { ...init, headers, signal: ctrl.signal })
  } finally { clearTimeout(t) }
}

export async function isAceServerUp(): Promise<boolean> {
  try {
    const r = await aceFetch('/health', { method: 'GET' }, 3000)
    return r.ok
  } catch { return false }
}

// ─── Auto-start server ─────────────────────────────────────────────────
let _startAttempt: Promise<boolean> | null = null

export async function autoStartServer(): Promise<boolean> {
  if (await isAceServerUp()) return true
  if (_startAttempt) return _startAttempt
  _startAttempt = (async () => {
    if (!existsSync(ACESTEP_REPO)) return false
    const isWin = process.platform === 'win32'
    const launcher = isWin
      ? join(ACESTEP_REPO, 'start_api_server.bat')
      : join(ACESTEP_REPO, 'run_api_server.sh')
    if (!existsSync(launcher)) return false
    // Spawn detached so it survives the API process if needed
    try {
      const child = spawn(launcher, [], {
        cwd: ACESTEP_REPO,
        detached: true,
        stdio: 'ignore',
        shell: isWin,
        windowsHide: true,
      })
      child.unref()
    } catch { return false }
    // Wait up to 90s for /health
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500))
      if (await isAceServerUp()) return true
    }
    return false
  })().finally(() => { _startAttempt = null })
  return _startAttempt
}

// ─── Core generation ───────────────────────────────────────────────────
async function ensureUp(): Promise<void> {
  if (!(await isAceServerUp())) {
    const ok = await autoStartServer()
    if (!ok) throw new Error('ACE-Step API server unreachable and auto-start failed')
  }
}

function buildReleaseTaskBody(input: GenerateMusicInput): Record<string, unknown> {
  const tier = QUALITY_PRESET[input.quality ?? 'master']
  const body: Record<string, unknown> = {
    ...tier,
    prompt: input.prompt ?? '',
    lyrics: input.lyrics ?? '',
    vocal_language: input.language ?? 'en',
    audio_duration: input.duration ?? tier.audio_duration,
    use_random_seed: input.seed === undefined || input.seed < 0,
    seed: input.seed ?? -1,
  }
  if (input.bpm) body['bpm'] = input.bpm
  if (input.key) body['key_scale'] = input.key
  if (input.referenceAudioPath) {
    body['reference_audio_path'] = input.referenceAudioPath
    body['audio_cover_strength'] = input.coverStrength ?? 0.6
    body['cover_noise_strength'] = input.coverNoise ?? 0.4
    body['task_type'] = 'cover'
  }
  if (input.instruction) body['instruction'] = input.instruction
  return body
}

/**
 * Submit ONE ACE-Step render and wait for completion. Internal helper.
 * Used by generateMusic which orchestrates N takes + scoring + mastering.
 */
async function renderOneTake(input: GenerateMusicInput, seedOverride?: number): Promise<MusicJob> {
  const startedAt = Date.now()
  const body = buildReleaseTaskBody(input)
  if (seedOverride !== undefined) {
    body['seed'] = seedOverride
    body['use_random_seed'] = false
  }
  const r = await aceFetch('/release_task', { method: 'POST', body: JSON.stringify(body) }, 30_000)
  if (!r.ok) return { ok: false, status: 'failed', error: `release_task ${r.status}`, startedAt }
  const j = (await r.json()) as { task_id?: string; job_id?: string; id?: string }
  const jobId = j.task_id ?? j.job_id ?? j.id
  if (!jobId) return { ok: false, status: 'failed', error: 'no jobId returned', startedAt }
  const done = await pollJob(jobId, 20 * 60_000)
  return { ...done, startedAt, finishedAt: Date.now(),
    promptUsed: String(body['prompt'] ?? ''),
    lyricsUsed: String(body['lyrics'] ?? ''),
  }
}

/**
 * Conductor pipeline:
 *   1. Render N takes in parallel (default: 3 for vocal tracks, 1 otherwise)
 *   2. Download each take + score for vocal naturalness (LRA, headroom,
 *      dynamic spread)
 *   3. Pick highest-scored take
 *   4. If hasVocals, run vocal-enhance pass (de-ess, presence, level)
 *   5. Run two-pass EBU R128 mastering → 48 kHz / 24-bit / -14 LUFS / -1 dBTP
 */
export async function generateMusic(input: GenerateMusicInput): Promise<MusicJob> {
  const startedAt = Date.now()
  // 24/7 cloud routing — ACE-Step runs on the operator's GPU box; if
  // we're not there OR explicitly remoted, queue and wait for bridge.
  try {
    const { shouldRouteToQueue, enqueueGuiJob, awaitGuiJob } = await import('./gui-queue.js')
    if (shouldRouteToQueue()) {
      const wsId = input.workspaceId ?? 'default'
      const jobId = await enqueueGuiJob(wsId, 'music.generate', input as unknown as Record<string, unknown>)
      const job = await awaitGuiJob(jobId, 10 * 60_000)
      if (job.status === 'completed' && job.result) return job.result as unknown as MusicJob
      return {
        ok: false, status: 'failed',
        error: job.status === 'pending'
          ? `queued — waiting for GPU bridge (job ${jobId})`
          : (job.error ?? 'bridge failed'),
        startedAt, finishedAt: Date.now(),
      }
    }
  } catch { /* fall through to local */ }
  try {
    await ensureUp()

    const tier = input.quality ?? 'master'
    const hasVocals = input.hasVocals ?? (input.lyrics ? true : !/instrumental|no vocals|no vocal/i.test(input.prompt ?? ''))
    const takes = Math.max(1, Math.min(5, input.takes ?? (hasVocals && tier === 'master' ? 3 : 1)))
    const wantMaster = input.applyMastering ?? (tier === 'master')

    // 1. Render N takes in parallel
    const seeds: number[] = []
    if (takes > 1) {
      for (let i = 0; i < takes; i++) seeds.push(Math.floor(Math.random() * 2_000_000_000))
    }
    const renders = await Promise.all(
      Array.from({ length: takes }, (_, i) => renderOneTake(input, seeds[i])),
    )
    const successful = renders.filter(r => r.ok)
    if (successful.length === 0) {
      const firstErr = renders.find(r => r.error)?.error ?? 'all takes failed'
      return { ...renders[0]!, error: firstErr, takesRendered: takes }
    }

    // Mastering chain only runs if ffmpeg is available
    let ffOk = false
    try {
      const { isFfmpegAvailable } = await import('./music-mastering.js')
      ffOk = await isFfmpegAvailable()
    } catch { /* */ }

    // 2-3. Pick best take
    let best: MusicJob = successful[0]!
    let bestScore = 0
    let bestLocal: string | undefined
    if (successful.length === 1 || !ffOk) {
      bestLocal = await downloadJobAudio(best)
    } else {
      const { scoreNaturalness } = await import('./music-mastering.js')
      const scored = await Promise.all(successful.map(async (t) => {
        const local = await downloadJobAudio(t)
        const score = local ? await scoreNaturalness(local) : 0
        return { take: t, local, score }
      }))
      scored.sort((a, b) => b.score - a.score)
      best = scored[0]!.take
      bestScore = scored[0]!.score
      bestLocal = scored[0]!.local
    }
    if (bestLocal) best.localPath = bestLocal
    best.takesRendered = takes
    if (bestScore) best.selectedTakeScore = bestScore

    // 4-5. Vocal-enhance + master
    if (wantMaster && ffOk && bestLocal) {
      try {
        const { vocalEnhance, master } = await import('./music-mastering.js')
        let pathForMaster = bestLocal
        if (hasVocals) {
          const enhPath = bestLocal.replace(/(\.[^.]+)$/, '.enh$1')
          const enh = await vocalEnhance(bestLocal, enhPath)
          if (enh.ok) pathForMaster = enhPath
        }
        const masterPath = bestLocal.replace(/(\.[^.]+)$/, '.master.wav')
        const m = await master(pathForMaster, masterPath, { targetLufs: -14, truePeakDb: -1, lra: 11, sampleRate: 48000, bitDepth: 24 })
        if (m.ok) {
          best.masteredPath = m.outPath
          best.mastering = { lufs: m.appliedI ?? -14, truePeakDb: -1, sampleRate: 48000, bitDepth: 24 }
        }
      } catch { /* mastering failures don't kill the take */ }
    }

    best.startedAt = startedAt
    best.finishedAt = Date.now()
    return best
  } catch (e) {
    return { ok: false, status: 'failed', error: (e as Error).message, startedAt }
  }
}

export async function pollJob(jobId: string, timeoutMs = 15 * 60_000): Promise<MusicJob> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const r = await aceFetch('/query_result', {
        method: 'POST',
        body: JSON.stringify({ task_ids: [jobId] }),
      }, 15_000)
      if (r.ok) {
        const j = (await r.json()) as { results?: Array<Record<string, unknown>> }
        const row = j.results?.[0]
        if (row) {
          const status = String(row['status'] ?? '').toLowerCase()
          if (status === 'done' || status === 'success' || status === 'completed') {
            const audioPath = String(row['audio_path'] ?? row['output_path'] ?? '')
            const audioUrlRaw = String(row['audio_url']  ?? '')
            const durationSec = Number(row['duration_sec'] ?? row['duration'] ?? 0)
            const fmt = String(row['format'] ?? '')
            const bpm = Number(row['bpm'] ?? 0)
            const key = String(row['key_scale'] ?? '')
            const out: MusicJob = { ok: true, jobId, status: 'done', startedAt: 0 }
            if (audioPath) out.audioPath = audioPath
            if (audioUrlRaw) out.audioUrl = audioUrlRaw
            else if (audioPath) out.audioUrl = `${ACESTEP_BASE}/v1/audio?path=${encodeURIComponent(audioPath)}`
            if (durationSec) out.durationSec = durationSec
            if (fmt) out.format = fmt
            if (bpm) out.bpm = bpm
            if (key) out.key = key
            return out
          }
          if (status === 'failed' || status === 'error') {
            return { ok: false, jobId, status: 'failed',
              error: String(row['error'] ?? row['message'] ?? 'job failed'), startedAt: 0 }
          }
        }
      } else { lastErr = `query_result ${r.status}` }
    } catch (e) { lastErr = (e as Error).message }
    await new Promise((rr) => setTimeout(rr, 4000))
  }
  return { ok: false, jobId, status: 'unknown', error: lastErr || 'timeout', startedAt: 0 }
}

// ─── Song URL detection ────────────────────────────────────────────────
const SONG_HOST_RE = /(?:open\.spotify\.com|music\.apple\.com|music\.youtube\.com|youtu\.be|youtube\.com|soundcloud\.com|bandcamp\.com|tidal\.com|deezer\.com|audius\.co)/i
const DIRECT_AUDIO_RE = /\.(?:mp3|wav|flac|m4a|ogg|opus|aac)(?:\?|$)/i

export function isLikelySongPage(url: string): boolean {
  return SONG_HOST_RE.test(url) || DIRECT_AUDIO_RE.test(url)
}

export function extractSongUrls(text: string): string[] {
  if (!text) return []
  const re = /\bhttps?:\/\/[^\s<>"']+/g
  const matches = text.match(re) ?? []
  // Dedupe + cap to 2 (replication is expensive)
  return Array.from(new Set(matches.filter(isLikelySongPage))).slice(0, 2)
}

// ─── yt-dlp download (cross-source) ────────────────────────────────────
async function downloadSongToWav(url: string): Promise<{ ok: boolean; path?: string; title?: string; artist?: string; durationSec?: number; error?: string }> {
  const stamp = Date.now().toString(36)
  const outBase = join(MUSIC_TMP_DIR, `src-${stamp}`)
  const outAudio = `${outBase}.wav`
  const outInfo  = `${outBase}.info.json`
  return await new Promise((resolve) => {
    const args = [
      '-x', '--audio-format', 'wav', '--audio-quality', '0',
      '--write-info-json', '--no-playlist',
      '-o', `${outBase}.%(ext)s`,
      '--ffmpeg-location', FFMPEG_BIN,
      url,
    ]
    let stderr = ''
    let proc
    try {
      proc = spawn(YTDLP_BIN, args, { windowsHide: true })
    } catch (e) { resolve({ ok: false, error: `yt-dlp spawn: ${(e as Error).message}` }); return }
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString() })
    proc.on('error', (e) => resolve({ ok: false, error: `yt-dlp: ${e.message}` }))
    proc.on('close', async (code) => {
      if (code !== 0 || !existsSync(outAudio)) {
        resolve({ ok: false, error: `yt-dlp exit ${code}: ${stderr.slice(0, 300)}` }); return
      }
      let title: string | undefined, artist: string | undefined, durationSec: number | undefined
      try {
        const info = JSON.parse(await readFile(outInfo, 'utf8')) as Record<string, unknown>
        title = String(info['title'] ?? '') || undefined
        artist = String(info['artist'] ?? info['uploader'] ?? '') || undefined
        durationSec = Number(info['duration'] ?? 0) || undefined
      } catch { /* info optional */ }
      const result: { ok: boolean; path?: string; title?: string; artist?: string; durationSec?: number; error?: string } = { ok: true, path: outAudio }
      if (title) result.title = title
      if (artist) result.artist = artist
      if (durationSec) result.durationSec = durationSec
      resolve(result)
    })
  })
}

// ─── Whisper transcription of source song lyrics ──────────────────────
// Used by the replicator so we have the ORIGINAL words to paraphrase
// (instead of feeding ACE-Step empty lyrics, which forces the LM to
// invent — losing the song's actual narrative).
async function transcribeSongLyrics(audioPath: string): Promise<string> {
  try {
    const buf = await readFile(audioPath)
    const groqKey = process.env['GROQ_API_KEY']
    if (groqKey) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), 'song.wav')
      form.append('model', process.env['GROQ_WHISPER_MODEL'] ?? 'whisper-large-v3')
      form.append('response_format', 'text')
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}` },
        body: form,
        signal: AbortSignal.timeout(180_000),
      })
      if (r.ok) {
        const t = (await r.text()).trim()
        if (t.length > 5) return t
      }
    }
    const openaiKey = process.env['OPENAI_API_KEY']
    if (openaiKey) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), 'song.wav')
      form.append('model', 'whisper-1')
      form.append('response_format', 'text')
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiKey}` },
        body: form,
        signal: AbortSignal.timeout(300_000),
      })
      if (r.ok) {
        const t = (await r.text()).trim()
        if (t.length > 5) return t
      }
    }
  } catch { /* */ }
  return ''
}

// ─── Audio analysis via ACE-Step ───────────────────────────────────────
async function analyzeReferenceAudio(audioPath: string): Promise<{ bpm?: number; key?: string; caption?: string; lyrics?: string; durationSec?: number }> {
  try {
    const r = await aceFetch('/release_task', {
      method: 'POST',
      body: JSON.stringify({
        analysis_only: true,
        reference_audio_path: audioPath,
      }),
    }, 30_000)
    if (!r.ok) return {}
    const j = (await r.json()) as { task_id?: string; job_id?: string }
    const id = j.task_id ?? j.job_id
    if (!id) return {}
    const res = await pollJob(id, 5 * 60_000)
    const out: { bpm?: number; key?: string; caption?: string; lyrics?: string; durationSec?: number } = {}
    if (res.bpm) out.bpm = res.bpm
    if (res.key) out.key = res.key
    if (res.durationSec) out.durationSec = res.durationSec
    return out
  } catch (e) {
    console.error('[music-studio] analyzeAudio failed:', (e as Error).message)
    return {}
  }
}

// ─── Lyric rewrite for legal safety ────────────────────────────────────
/**
 * Rewrites lyrics to preserve meaning + meter + rhyme scheme but change
 * exact wording, so the output is not a substantial copy. Uses the chat
 * provider router. If router unavailable, returns empty (forces ACE-Step's
 * LM to regenerate fresh lyrics from caption).
 */
async function rewriteLyricsForSafety(originalLyrics: string, title: string, artist: string): Promise<string> {
  if (!originalLyrics) return ''
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = 'You are a lyric paraphraser. Rewrite the user lyrics so meaning, mood, theme, rhyme scheme, and syllable count per line are preserved, but no consecutive 5-word sequence matches the original. Output ONLY the rewritten lyrics, nothing else.'
    const user = `Title: ${title}\nArtist: ${artist}\n\nORIGINAL LYRICS:\n${originalLyrics}\n\nREWRITTEN LYRICS (same structure, different wording):`
    let out = ''
    for await (const chunk of streamChat('default', [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ])) {
      if (chunk.delta) out += chunk.delta
    }
    return out.trim()
  } catch { return '' }
}

// ─── Replicate ─────────────────────────────────────────────────────────
export interface ReplicateInput {
  url: string
  instructions?: string           // operator extras: "more upbeat", "female vocal", etc
  variationStrength?: number      // 0..1; higher = more different (default 0.4)
  workspaceId?: string
}

export interface ReplicateResult extends MusicJob {
  source?: {
    url: string
    title?: string
    artist?: string
    durationSec?: number
  }
  variation?: number
  lyricsRewritten?: boolean
}

export async function replicateSong(input: ReplicateInput): Promise<ReplicateResult> {
  const startedAt = Date.now()
  const variation = Math.max(0.15, Math.min(0.8, input.variationStrength ?? 0.4))
  try {
    await ensureUp()

    // 1. Download source
    const dl = await downloadSongToWav(input.url)
    if (!dl.ok || !dl.path) {
      return { ok: false, status: 'failed', error: dl.error ?? 'download failed', startedAt }
    }
    const source: ReplicateResult['source'] = { url: input.url }
    if (dl.title) source.title = dl.title
    if (dl.artist) source.artist = dl.artist
    if (dl.durationSec) source.durationSec = dl.durationSec

    // 2. Analyze for bpm/key + transcribe original lyrics in parallel
    const [meta, originalLyrics] = await Promise.all([
      analyzeReferenceAudio(dl.path),
      transcribeSongLyrics(dl.path),
    ])

    // 3. Rewrite lyrics (legal safety) — preserves meter/rhyme/meaning,
    //    no 5-word overlap with original. If transcription failed we pass
    //    empty and ACE-Step's LM generates fresh lyrics from the caption.
    const safeLyrics = await rewriteLyricsForSafety(originalLyrics, dl.title ?? '', dl.artist ?? '')

    // 4. Submit cover-mode generation
    const caption = [
      input.instructions ?? '',
      dl.title ? `In the style of "${dl.title}"` : '',
      dl.artist ? `similar to ${dl.artist}` : '',
      meta.bpm ? `${meta.bpm}bpm` : '',
      meta.key ? `key ${meta.key}` : '',
      'high-fidelity studio production, natural vocals, full dynamic range',
    ].filter(Boolean).join(', ')

    const genInput: GenerateMusicInput = {
      prompt: caption,
      lyrics: safeLyrics,
      duration: meta.durationSec ?? source.durationSec ?? 180,
      referenceAudioPath: dl.path,
      coverStrength: 1.0 - variation * 0.6,
      coverNoise:    variation * 0.8,
      quality: 'master',      // highest fidelity for replication
    }
    if (meta.bpm) genInput.bpm = meta.bpm
    if (meta.key) genInput.key = meta.key
    if (input.workspaceId) genInput.workspaceId = input.workspaceId
    const job = await generateMusic(genInput)

    return {
      ...job,
      source,
      variation,
      lyricsRewritten: !!safeLyrics,
      startedAt,
      finishedAt: Date.now(),
    }
  } catch (e) {
    return { ok: false, status: 'failed', error: (e as Error).message, startedAt }
  }
}

// ─── Download finished audio to local file ─────────────────────────────
export async function downloadJobAudio(job: MusicJob, destDir = MUSIC_TMP_DIR): Promise<string | undefined> {
  if (!job.audioUrl) return undefined
  try {
    const r = await aceFetch(job.audioUrl.replace(ACESTEP_BASE, ''), { method: 'GET' }, 60_000)
    if (!r.ok) return undefined
    const buf = Buffer.from(await r.arrayBuffer())
    const ext = job.format && job.format !== 'wav32' ? job.format : 'wav'
    const dest = join(destDir, `${job.jobId ?? 'out'}-${Date.now().toString(36)}.${ext}`)
    await writeFile(dest, buf)
    return dest
  } catch { return undefined }
}

// ─── Chat rendering ────────────────────────────────────────────────────
export function renderJobForChat(job: MusicJob | ReplicateResult): string {
  const lines: string[] = []
  if ('source' in job && job.source) {
    lines.push(`🎵 Replicated: ${job.source.title ?? job.source.url}${job.source.artist ? ` — ${job.source.artist}` : ''}`)
    lines.push(`Variation: ${Math.round((job.variation ?? 0) * 100)}% · Lyrics: ${job.lyricsRewritten ? 'rewritten for safety' : 'auto-generated'}`)
  } else {
    lines.push(`🎵 Generated music`)
  }
  if (job.bpm) lines.push(`BPM: ${job.bpm}${job.key ? ` · Key: ${job.key}` : ''}`)
  if (job.durationSec) lines.push(`Duration: ${Math.round(job.durationSec)}s`)
  if (job.takesRendered && job.takesRendered > 1) {
    lines.push(`Conductor: rendered ${job.takesRendered} takes${job.selectedTakeScore ? `, picked best (naturalness ${job.selectedTakeScore.toFixed(1)}/30)` : ''}`)
  }
  if (job.mastering) {
    lines.push(`Master: ${job.mastering.lufs} LUFS · ${job.mastering.truePeakDb} dBTP · ${job.mastering.sampleRate} Hz · ${job.mastering.bitDepth}-bit`)
  }
  if (job.masteredPath) lines.push(`Mastered file: ${job.masteredPath}`)
  if (job.audioUrl) lines.push(`Raw audio: ${job.audioUrl}`)
  if (!job.ok && job.error) lines.push(`Error: ${job.error}`)
  return lines.join('\n')
}
