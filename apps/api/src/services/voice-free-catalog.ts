/**
 * voice-free-catalog.ts — R146.110 — every free TTS voice we can reach.
 *
 * Honest scope: "all free voices on the internet" is the operator's brief.
 * In practice that means a curated catalog of public-good / no-key-needed
 * TTS endpoints, plus the operator's browser system voices (Web Speech API,
 * synthesized client-side, free forever). We DO NOT proxy paid voices
 * (ElevenLabs, PlayHT, OpenAI tts-1) — those already live in
 * voiceover-service.ts and are gated by keys.
 *
 * Sources cataloged here:
 *
 *   1. Pollinations.ai TTS — 11 voices (OpenAI gpt-4o-audio quality), public
 *      GET endpoint, no key, no signup. https://text.pollinations.ai
 *   2. StreamElements / Amazon Polly — 50+ voices across many languages,
 *      public free endpoint used by Twitch streamers.
 *      https://api.streamelements.com/kappa/v2/speech
 *   3. Hugging Face Inference (Bark / SpeechT5 / MMS-TTS / VITS / Coqui) —
 *      requires HF_API_TOKEN (free), exposes preset voices per model.
 *   4. Browser Web Speech API — `speechSynthesis.getVoices()`. Catalog lists
 *      this as a SOURCE; actual voice enumeration happens client-side.
 *
 * Each voice is normalized to a `FreeVoice` shape with a stable id, language,
 * gender hint, sample-rate hint, source URL template, and a tiny `preview`
 * sample line. The UI calls `/api/v1/free-voice/preview/:id` to get an
 * audio stream of the voice saying the sample.
 */

export type VoiceSource = 'pollinations' | 'streamelements' | 'huggingface' | 'browser'

export interface FreeVoice {
  id:            string        // stable: e.g. "pollinations:alloy"
  source:        VoiceSource
  voiceId:       string        // provider-side id passed to the API
  displayName:   string        // for the UI tile
  language:      string        // BCP-47 hint, "en-US", "ja-JP", etc.
  gender:        'male' | 'female' | 'neutral' | 'unknown'
  style?:        string        // "narrator", "warm", "energetic", etc.
  sampleRate?:   number        // best-effort hint
  needsKey?:     boolean       // true → HF_API_TOKEN required
  modelPath?:    string        // huggingface model id when source=huggingface
  notes?:        string
}

const PREVIEW_LINE = 'Hi — I\'m Novan. This is what I sound like when I read your work back to you.'
export function previewLine(): string { return PREVIEW_LINE }

// ─── 1. Pollinations.ai (11 voices, no key) ─────────────────────────────

const POLLINATIONS_VOICES: Array<{ id: string; gender: FreeVoice['gender']; style: string }> = [
  { id: 'alloy',   gender: 'neutral', style: 'balanced narrator' },
  { id: 'ash',     gender: 'male',    style: 'soft, measured' },
  { id: 'ballad',  gender: 'female',  style: 'expressive, lyric' },
  { id: 'coral',   gender: 'female',  style: 'bright, warm' },
  { id: 'echo',    gender: 'male',    style: 'deep, resonant' },
  { id: 'fable',   gender: 'neutral', style: 'storytime' },
  { id: 'nova',    gender: 'female',  style: 'energetic' },
  { id: 'onyx',    gender: 'male',    style: 'authoritative' },
  { id: 'sage',    gender: 'neutral', style: 'calm, thoughtful' },
  { id: 'shimmer', gender: 'female',  style: 'crystal-clear' },
  { id: 'verse',   gender: 'neutral', style: 'musical, poetic' },
]

// ─── 2. StreamElements / Amazon Polly (large multi-language set) ────────
// These are the voice names Polly exposes through StreamElements' public
// proxy. Free, no key, used widely by Twitch chatbots. Not exhaustive — we
// pick the ones with the broadest language/gender coverage.

const STREAMELEMENTS_VOICES: Array<{ id: string; lang: string; gender: FreeVoice['gender']; style: string }> = [
  // English
  { id: 'Brian',     lang: 'en-GB', gender: 'male',   style: 'British narrator' },
  { id: 'Amy',       lang: 'en-GB', gender: 'female', style: 'British' },
  { id: 'Emma',      lang: 'en-GB', gender: 'female', style: 'British, friendly' },
  { id: 'Joanna',    lang: 'en-US', gender: 'female', style: 'US, clear' },
  { id: 'Joey',      lang: 'en-US', gender: 'male',   style: 'US, casual' },
  { id: 'Justin',    lang: 'en-US', gender: 'male',   style: 'US, youthful' },
  { id: 'Kendra',    lang: 'en-US', gender: 'female', style: 'US, smooth' },
  { id: 'Kimberly',  lang: 'en-US', gender: 'female', style: 'US, professional' },
  { id: 'Matthew',   lang: 'en-US', gender: 'male',   style: 'US, news anchor' },
  { id: 'Salli',     lang: 'en-US', gender: 'female', style: 'US, bright' },
  { id: 'Ivy',       lang: 'en-US', gender: 'female', style: 'US, child voice' },
  { id: 'Nicole',    lang: 'en-AU', gender: 'female', style: 'Australian' },
  { id: 'Russell',   lang: 'en-AU', gender: 'male',   style: 'Australian' },
  { id: 'Geraint',   lang: 'en-GB-WLS', gender: 'male', style: 'Welsh' },
  { id: 'Raveena',   lang: 'en-IN', gender: 'female', style: 'Indian English' },
  { id: 'Aditi',     lang: 'en-IN', gender: 'female', style: 'Indian English' },
  // Spanish
  { id: 'Conchita',  lang: 'es-ES', gender: 'female', style: 'Castilian' },
  { id: 'Enrique',   lang: 'es-ES', gender: 'male',   style: 'Castilian' },
  { id: 'Lucia',     lang: 'es-ES', gender: 'female', style: 'Castilian' },
  { id: 'Miguel',    lang: 'es-US', gender: 'male',   style: 'US Spanish' },
  { id: 'Penelope',  lang: 'es-US', gender: 'female', style: 'US Spanish' },
  { id: 'Mia',       lang: 'es-MX', gender: 'female', style: 'Mexican Spanish' },
  // French
  { id: 'Celine',    lang: 'fr-FR', gender: 'female', style: 'Parisian' },
  { id: 'Lea',       lang: 'fr-FR', gender: 'female', style: 'Parisian' },
  { id: 'Mathieu',   lang: 'fr-FR', gender: 'male',   style: 'Parisian' },
  { id: 'Chantal',   lang: 'fr-CA', gender: 'female', style: 'Québécois' },
  // German
  { id: 'Hans',      lang: 'de-DE', gender: 'male',   style: 'German' },
  { id: 'Marlene',   lang: 'de-DE', gender: 'female', style: 'German' },
  { id: 'Vicki',     lang: 'de-DE', gender: 'female', style: 'German' },
  // Italian
  { id: 'Carla',     lang: 'it-IT', gender: 'female', style: 'Italian' },
  { id: 'Giorgio',   lang: 'it-IT', gender: 'male',   style: 'Italian' },
  { id: 'Bianca',    lang: 'it-IT', gender: 'female', style: 'Italian' },
  // Portuguese
  { id: 'Ines',      lang: 'pt-PT', gender: 'female', style: 'European Portuguese' },
  { id: 'Cristiano', lang: 'pt-PT', gender: 'male',   style: 'European Portuguese' },
  { id: 'Camila',    lang: 'pt-BR', gender: 'female', style: 'Brazilian' },
  { id: 'Vitoria',   lang: 'pt-BR', gender: 'female', style: 'Brazilian' },
  { id: 'Ricardo',   lang: 'pt-BR', gender: 'male',   style: 'Brazilian' },
  // Dutch
  { id: 'Lotte',     lang: 'nl-NL', gender: 'female', style: 'Dutch' },
  { id: 'Ruben',     lang: 'nl-NL', gender: 'male',   style: 'Dutch' },
  // Nordic
  { id: 'Astrid',    lang: 'sv-SE', gender: 'female', style: 'Swedish' },
  { id: 'Liv',       lang: 'no-NO', gender: 'female', style: 'Norwegian' },
  { id: 'Naja',      lang: 'da-DK', gender: 'female', style: 'Danish' },
  { id: 'Mads',      lang: 'da-DK', gender: 'male',   style: 'Danish' },
  // Slavic
  { id: 'Jacek',     lang: 'pl-PL', gender: 'male',   style: 'Polish' },
  { id: 'Maja',      lang: 'pl-PL', gender: 'female', style: 'Polish' },
  { id: 'Tatyana',   lang: 'ru-RU', gender: 'female', style: 'Russian' },
  { id: 'Maxim',     lang: 'ru-RU', gender: 'male',   style: 'Russian' },
  // Asian
  { id: 'Mizuki',    lang: 'ja-JP', gender: 'female', style: 'Japanese' },
  { id: 'Takumi',    lang: 'ja-JP', gender: 'male',   style: 'Japanese' },
  { id: 'Seoyeon',   lang: 'ko-KR', gender: 'female', style: 'Korean' },
  { id: 'Zhiyu',     lang: 'cmn-CN', gender: 'female', style: 'Mandarin Chinese' },
  // Middle East
  { id: 'Zeina',     lang: 'arb',    gender: 'female', style: 'Arabic' },
  // Turkish
  { id: 'Filiz',     lang: 'tr-TR', gender: 'female', style: 'Turkish' },
  // Welsh / others
  { id: 'Gwyneth',   lang: 'cy-GB', gender: 'female', style: 'Welsh' },
]

// ─── 3. Hugging Face (token required, but token is free) ────────────────

const HF_VOICES: Array<{ voiceId: string; modelPath: string; lang: string; gender: FreeVoice['gender']; style: string }> = [
  // Bark — multi-speaker presets; each preset is a distinct voice persona
  { voiceId: 'v2/en_speaker_0', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'male',   style: 'Bark — relaxed' },
  { voiceId: 'v2/en_speaker_1', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'male',   style: 'Bark — deep' },
  { voiceId: 'v2/en_speaker_2', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'female', style: 'Bark — bright' },
  { voiceId: 'v2/en_speaker_3', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'male',   style: 'Bark — neutral' },
  { voiceId: 'v2/en_speaker_4', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'female', style: 'Bark — warm' },
  { voiceId: 'v2/en_speaker_5', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'female', style: 'Bark — soft' },
  { voiceId: 'v2/en_speaker_6', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'male',   style: 'Bark — gravelly' },
  { voiceId: 'v2/en_speaker_7', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'male',   style: 'Bark — youthful' },
  { voiceId: 'v2/en_speaker_8', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'female', style: 'Bark — animated' },
  { voiceId: 'v2/en_speaker_9', modelPath: 'suno/bark-small', lang: 'en-US', gender: 'male',   style: 'Bark — calm' },
  // SpeechT5 — single voice baseline but exposed for fallback
  { voiceId: 'default', modelPath: 'microsoft/speecht5_tts', lang: 'en-US', gender: 'neutral', style: 'SpeechT5 — clean baseline' },
  // MMS-TTS — Meta's Massively Multilingual TTS, one voice per language
  { voiceId: 'eng',     modelPath: 'facebook/mms-tts-eng', lang: 'en',   gender: 'neutral', style: 'MMS English' },
  { voiceId: 'spa',     modelPath: 'facebook/mms-tts-spa', lang: 'es',   gender: 'neutral', style: 'MMS Spanish' },
  { voiceId: 'fra',     modelPath: 'facebook/mms-tts-fra', lang: 'fr',   gender: 'neutral', style: 'MMS French' },
  { voiceId: 'deu',     modelPath: 'facebook/mms-tts-deu', lang: 'de',   gender: 'neutral', style: 'MMS German' },
  { voiceId: 'jpn',     modelPath: 'facebook/mms-tts-jpn', lang: 'ja',   gender: 'neutral', style: 'MMS Japanese' },
  { voiceId: 'kor',     modelPath: 'facebook/mms-tts-kor', lang: 'ko',   gender: 'neutral', style: 'MMS Korean' },
  { voiceId: 'cmn',     modelPath: 'facebook/mms-tts-cmn', lang: 'zh',   gender: 'neutral', style: 'MMS Mandarin' },
  { voiceId: 'hin',     modelPath: 'facebook/mms-tts-hin', lang: 'hi',   gender: 'neutral', style: 'MMS Hindi' },
  { voiceId: 'ara',     modelPath: 'facebook/mms-tts-ara', lang: 'ar',   gender: 'neutral', style: 'MMS Arabic' },
  { voiceId: 'por',     modelPath: 'facebook/mms-tts-por', lang: 'pt',   gender: 'neutral', style: 'MMS Portuguese' },
  { voiceId: 'rus',     modelPath: 'facebook/mms-tts-rus', lang: 'ru',   gender: 'neutral', style: 'MMS Russian' },
  { voiceId: 'tur',     modelPath: 'facebook/mms-tts-tur', lang: 'tr',   gender: 'neutral', style: 'MMS Turkish' },
  { voiceId: 'vie',     modelPath: 'facebook/mms-tts-vie', lang: 'vi',   gender: 'neutral', style: 'MMS Vietnamese' },
  { voiceId: 'tha',     modelPath: 'facebook/mms-tts-tha', lang: 'th',   gender: 'neutral', style: 'MMS Thai' },
  { voiceId: 'ind',     modelPath: 'facebook/mms-tts-ind', lang: 'id',   gender: 'neutral', style: 'MMS Indonesian' },
  // Coqui XTTS-v2 — voice cloning model with built-in speaker presets
  { voiceId: 'Claribel Dervla',    modelPath: 'coqui/XTTS-v2', lang: 'en-US', gender: 'female', style: 'XTTS — narrator' },
  { voiceId: 'Gracie Wise',         modelPath: 'coqui/XTTS-v2', lang: 'en-US', gender: 'female', style: 'XTTS — bright' },
  { voiceId: 'Tammie Ema',          modelPath: 'coqui/XTTS-v2', lang: 'en-US', gender: 'female', style: 'XTTS — measured' },
  { voiceId: 'Damien Black',        modelPath: 'coqui/XTTS-v2', lang: 'en-US', gender: 'male',   style: 'XTTS — deep' },
  { voiceId: 'Viktor Eka',          modelPath: 'coqui/XTTS-v2', lang: 'en-US', gender: 'male',   style: 'XTTS — confident' },
  { voiceId: 'Andrew Chipper',      modelPath: 'coqui/XTTS-v2', lang: 'en-US', gender: 'male',   style: 'XTTS — energetic' },
]

// ─── Build catalog ───────────────────────────────────────────────────────

let _cache: FreeVoice[] | null = null

export function listFreeVoices(): FreeVoice[] {
  if (_cache) return _cache
  const out: FreeVoice[] = []
  for (const v of POLLINATIONS_VOICES) {
    out.push({
      id: `pollinations:${v.id}`, source: 'pollinations', voiceId: v.id,
      displayName: capitalize(v.id), language: 'en-US', gender: v.gender,
      style: v.style, sampleRate: 24000,
    })
  }
  for (const v of STREAMELEMENTS_VOICES) {
    out.push({
      id: `streamelements:${v.id}`, source: 'streamelements', voiceId: v.id,
      displayName: v.id, language: v.lang, gender: v.gender,
      style: v.style, sampleRate: 22050,
    })
  }
  for (const v of HF_VOICES) {
    out.push({
      id: `huggingface:${v.modelPath}:${v.voiceId}`, source: 'huggingface',
      voiceId: v.voiceId, modelPath: v.modelPath,
      displayName: `${v.modelPath.split('/').pop()} · ${v.voiceId}`,
      language: v.lang, gender: v.gender, style: v.style,
      sampleRate: 24000, needsKey: true,
      notes: 'Free tier — requires HF_API_TOKEN. May cold-load on first call.',
    })
  }
  // Browser source — single catalog entry that signals the client to
  // enumerate window.speechSynthesis.getVoices() in addition to server voices.
  out.push({
    id: 'browser:system', source: 'browser', voiceId: 'system',
    displayName: 'Browser system voices (OS-installed)',
    language: 'multi', gender: 'unknown',
    style: 'Client-side Web Speech API — counts depend on the user\'s OS (often 30–100 voices)',
    notes: 'Enumerated and previewed client-side. No server bandwidth cost. Available even when offline.',
  })
  _cache = out
  return out
}

export function findFreeVoice(id: string): FreeVoice | null {
  return listFreeVoices().find(v => v.id === id) ?? null
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s
}

// ─── Synthesize: returns audio bytes for the given voice + text ─────────

export interface SynthResult {
  ok:          boolean
  bytes?:      Buffer
  contentType?: string
  error?:      string
  latencyMs:   number
}

export async function synthesizeWithFreeVoice(voiceId: string, text: string): Promise<SynthResult> {
  const t0 = Date.now()
  const voice = findFreeVoice(voiceId)
  if (!voice) return { ok: false, error: 'unknown-voice', latencyMs: 0 }
  const sample = text.slice(0, 600) || PREVIEW_LINE
  try {
    if (voice.source === 'pollinations') {
      const url = `https://text.pollinations.ai/${encodeURIComponent(sample)}?model=openai-audio&voice=${encodeURIComponent(voice.voiceId)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) return { ok: false, error: `pollinations ${res.status}`, latencyMs: Date.now() - t0 }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 256) return { ok: false, error: 'tiny-payload', latencyMs: Date.now() - t0 }
      return { ok: true, bytes: buf, contentType: res.headers.get('content-type') ?? 'audio/mpeg', latencyMs: Date.now() - t0 }
    }
    if (voice.source === 'streamelements') {
      const url = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice.voiceId)}&text=${encodeURIComponent(sample)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000), headers: { 'User-Agent': 'Novan/1.0' } })
      if (!res.ok) return { ok: false, error: `streamelements ${res.status}`, latencyMs: Date.now() - t0 }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 256) return { ok: false, error: 'tiny-payload', latencyMs: Date.now() - t0 }
      return { ok: true, bytes: buf, contentType: res.headers.get('content-type') ?? 'audio/mpeg', latencyMs: Date.now() - t0 }
    }
    if (voice.source === 'huggingface') {
      const token = process.env['HF_API_TOKEN']
      if (!token) return { ok: false, error: 'no-hf-token', latencyMs: Date.now() - t0 }
      const body = voice.modelPath?.includes('XTTS') || voice.modelPath?.includes('bark')
        ? JSON.stringify({ inputs: sample, parameters: { speaker_embedding: voice.voiceId, voice_preset: voice.voiceId } })
        : JSON.stringify({ inputs: sample })
      // Try router (preferred) then legacy.
      for (const base of ['https://router.huggingface.co/hf-inference', 'https://api-inference.huggingface.co']) {
        try {
          const res = await fetch(`${base}/models/${voice.modelPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-wait-for-model': 'true' },
            body, signal: AbortSignal.timeout(90_000),
          })
          if (res.status === 503) continue
          if (!res.ok) {
            const txt = await res.text().catch(() => '')
            return { ok: false, error: `huggingface ${res.status}: ${txt.slice(0, 120)}`, latencyMs: Date.now() - t0 }
          }
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length < 256) return { ok: false, error: 'tiny-payload', latencyMs: Date.now() - t0 }
          return { ok: true, bytes: buf, contentType: res.headers.get('content-type') ?? 'audio/flac', latencyMs: Date.now() - t0 }
        } catch { /* try next */ }
      }
      return { ok: false, error: 'all-hf-bases-failed', latencyMs: Date.now() - t0 }
    }
    if (voice.source === 'browser') {
      // Server can't synth — UI uses speechSynthesis directly.
      return { ok: false, error: 'browser-source-client-only', latencyMs: Date.now() - t0 }
    }
    return { ok: false, error: 'unsupported-source', latencyMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 }
  }
}

// ─── Lightweight in-memory preview cache (5 min TTL) ────────────────────
// Avoid re-hitting upstream for the same preview-line + voice combo while a
// user is browsing the UI.

const previewCache = new Map<string, { buf: Buffer; ct: string; until: number }>()
const PREVIEW_TTL_MS = 5 * 60_000

export async function getCachedPreview(voiceId: string): Promise<{ bytes: Buffer; contentType: string } | { error: string }> {
  const key = `${voiceId}|${PREVIEW_LINE}`
  const hit = previewCache.get(key)
  if (hit && hit.until > Date.now()) return { bytes: hit.buf, contentType: hit.ct }
  const r = await synthesizeWithFreeVoice(voiceId, PREVIEW_LINE)
  if (!r.ok || !r.bytes) return { error: r.error ?? 'synth-failed' }
  previewCache.set(key, { buf: r.bytes, ct: r.contentType ?? 'audio/mpeg', until: Date.now() + PREVIEW_TTL_MS })
  // Bound cache to 200 entries
  if (previewCache.size > 200) {
    const oldest = Array.from(previewCache.entries()).sort((a, b) => a[1].until - b[1].until)[0]
    if (oldest) previewCache.delete(oldest[0])
  }
  return { bytes: r.bytes, contentType: r.contentType ?? 'audio/mpeg' }
}
