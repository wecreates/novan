/**
 * tts-bridge.ts — proxy to the Python TTS sidecar.
 *
 * The sidecar (services/tts-sidecar/app.py) runs on its own port and
 * loads Coqui XTTS-v2. This bridge is the only place in the Node API
 * that talks to it. Goals:
 *
 *   1. Treat sidecar absence as best-effort, NEVER throw. The rest of
 *      the platform runs fine without it.
 *   2. Validate reference-audio paths so the operator can't ask the
 *      sidecar to synthesize from a non-existent file (the sidecar
 *      also defends, but failing early is cheaper).
 *   3. Centralize timeout + retry logic so callers stay tiny.
 *
 * Pure helpers are colocated for unit testing. The DB write paths
 * (profile CRUD) live in the route layer.
 */
import path from 'node:path'
import fs   from 'node:fs/promises'

const SIDECAR_BASE = process.env['TTS_SIDECAR_URL'] ?? 'http://127.0.0.1:5005'
const SYNTH_TIMEOUT_MS  = 30_000
const HEALTH_TIMEOUT_MS = 2_000

// Operator-supplied reference audio lives here. Both the Node API and
// the Python sidecar read this same directory.
export const REF_ROOT = path.resolve(
  process.env['TTS_REF_ROOT'] ?? path.join(process.cwd(), '..', '..', 'data', 'voice-refs'),
)

// ─── Pure helpers ─────────────────────────────────────────────────────

/** Allowed reference audio mimes / extensions. */
const ALLOWED_EXTS = new Set(['.wav', '.mp3', '.flac', '.ogg'])

export interface RefPathValidation {
  ok:      boolean
  reason?: string
  abs?:    string
  rel?:    string
}

/**
 * Verify a relative path stays inside REF_ROOT and uses an allowed
 * audio extension. Pure (no fs touch) — fs check happens in the route.
 */
export function validateRefPath(relInput: string, refRoot: string = REF_ROOT): RefPathValidation {
  if (typeof relInput !== 'string' || relInput.length === 0) {
    return { ok: false, reason: 'ref_audio_path required' }
  }
  if (relInput.length > 300) {
    return { ok: false, reason: 'ref_audio_path too long' }
  }
  // Reject obvious traversal + absolute paths
  if (relInput.includes('..')) return { ok: false, reason: 'path traversal not allowed' }
  if (path.isAbsolute(relInput)) return { ok: false, reason: 'must be relative to data/voice-refs/' }

  const abs = path.resolve(refRoot, relInput)
  const root = path.resolve(refRoot)
  // Realpath-style containment check: abs must start with refRoot + separator
  if (!(abs === root || abs.startsWith(root + path.sep))) {
    return { ok: false, reason: 'path escapes voice-refs root' }
  }
  const ext = path.extname(abs).toLowerCase()
  if (!ALLOWED_EXTS.has(ext)) {
    return { ok: false, reason: `unsupported extension: ${ext || '(none)'} — use .wav/.mp3/.flac/.ogg` }
  }
  return { ok: true, abs, rel: relInput }
}

/** ISO language codes XTTS-v2 supports. */
const SUPPORTED_LANGS = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'tr',
  'ru', 'nl', 'cs', 'ar', 'zh-cn', 'hu', 'ko', 'ja', 'hi',
])

export function isSupportedLanguage(code: string): boolean {
  return SUPPORTED_LANGS.has(code.toLowerCase())
}

/** Sanity-check a profile name before persisting. */
export function validateProfileName(name: string): { ok: boolean; reason?: string } {
  if (typeof name !== 'string') return { ok: false, reason: 'name must be a string' }
  const trimmed = name.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'name required' }
  if (trimmed.length > 80) return { ok: false, reason: 'name too long (max 80)' }
  return { ok: true }
}

// ─── Sidecar IO ───────────────────────────────────────────────────────

export interface SidecarHealth {
  reachable:    boolean
  modelLoaded?: boolean
  device?:      string
  error?:       string
}

/** Cheap probe — never throws. */
export async function probeSidecar(): Promise<SidecarHealth> {
  try {
    const r = await fetch(`${SIDECAR_BASE}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (!r.ok) return { reachable: false, error: `HTTP ${r.status}` }
    const j = await r.json() as { ok?: boolean; model_loaded?: boolean; device?: string }
    return {
      reachable: Boolean(j.ok),
      ...(j.model_loaded !== undefined ? { modelLoaded: j.model_loaded } : {}),
      ...(j.device      !== undefined ? { device:      j.device      } : {}),
    }
  } catch (e) {
    return { reachable: false, error: (e as Error).message }
  }
}

export interface SynthesizeInput {
  text:        string
  speakerWav?: string       // relative path under REF_ROOT
  language?:   string
  speed?:      number
}

export interface SynthesizeResult {
  ok:        boolean
  audio?:    ArrayBuffer
  mime?:     string
  error?:    string
  /** When the sidecar can't be reached, callers should fall back to
   *  another TTS provider or skip voice altogether. */
  fallback?: 'sidecar_unreachable' | 'sidecar_error' | 'invalid_input'
}

/** POST /synthesize to the sidecar; returns raw audio bytes on success. */
export async function synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
  if (!input.text || input.text.trim().length === 0) {
    return { ok: false, fallback: 'invalid_input', error: 'text required' }
  }
  if (input.language && !isSupportedLanguage(input.language)) {
    return { ok: false, fallback: 'invalid_input', error: `unsupported language: ${input.language}` }
  }
  if (input.speakerWav) {
    const v = validateRefPath(input.speakerWav)
    if (!v.ok) return { ok: false, fallback: 'invalid_input', error: v.reason ?? 'invalid path' }
    // Existence check — sidecar will 404 anyway but failing fast saves a round trip
    try { await fs.access(v.abs!) }
    catch { return { ok: false, fallback: 'invalid_input', error: `reference audio missing: ${input.speakerWav}` } }
  }

  try {
    const r = await fetch(`${SIDECAR_BASE}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text:        input.text,
        speaker_wav: input.speakerWav ?? null,
        language:    input.language   ?? 'en',
        speed:       input.speed      ?? 1.0,
      }),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      return { ok: false, fallback: 'sidecar_error', error: `sidecar HTTP ${r.status}: ${body.slice(0, 200)}` }
    }
    const audio = await r.arrayBuffer()
    return { ok: true, audio, mime: 'audio/wav' }
  } catch (e) {
    return { ok: false, fallback: 'sidecar_unreachable', error: (e as Error).message }
  }
}

/** Resolve a profile's stored ref path to an absolute path for disk ops. */
export function resolveRefPath(rel: string): string {
  return path.resolve(REF_ROOT, rel)
}
