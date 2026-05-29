/**
 * voice-wake.ts — wake-phrase detection.
 *
 * Pure functions. The frontend continuous-SR loop calls `detectWake()`
 * on every interim/final transcript when `wake_enabled` is true; the
 * route handler also uses it to strip the wake phrase before passing the
 * remainder to the intent parser, so an utterance like "hey novan, zoom
 * into security" routes the same as "zoom into security" with no wake.
 *
 * Safety:
 *   - Wake detection NEVER opens the mic on its own — it is gated by the
 *     same visible mic-on state as push-to-talk. The hook simply decides
 *     whether to *act* on already-streaming audio.
 *   - Push-to-talk remains the default safest mode; wake_enabled is opt-in
 *     per workspace.
 *   - All wake detections emit a `voice.wake_detected` event so the
 *     operator can audit when Novan started listening for a command.
 */

export interface WakeResult {
  matched:   boolean
  phrase:    string | null      // which configured phrase matched
  remainder: string             // text with the wake phrase stripped
  /** Index in the input where the wake phrase ended (-1 if none). */
  cutAt:     number
}

const DEFAULT_PHRASES = ['hey novan', 'novan']

/**
 * Return a normalized lowercase list of unique non-empty phrases.
 * Phrases are sorted by length descending so the matcher prefers
 * the longest match ("hey novan" beats "novan").
 */
export function normalizePhrases(phrases: ReadonlyArray<string> | null | undefined): string[] {
  const list = (phrases && phrases.length > 0 ? phrases : DEFAULT_PHRASES)
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0)
  return [...new Set(list)].sort((a, b) => b.length - a.length)
}

/**
 * Detect a wake phrase in `transcript` and return the post-wake remainder.
 *
 *   "hey novan, zoom into security"  → matched, remainder="zoom into security"
 *   "ok novan, what's up?"           → matched (novan), remainder="what's up?"
 *   "the runtime looks fine"         → no match
 *
 * Robustness:
 *   - Case-insensitive.
 *   - Leading filler accepted ("ok ", "yo ", "hey, ", commas, dashes).
 *   - Trailing commas / dashes / "please" stripped from the remainder.
 *   - Word-boundary anchored to avoid matching "Novannah" etc.
 */
export function detectWake(transcript: string, phrases: ReadonlyArray<string>): WakeResult {
  const text = (transcript ?? '').trim()
  if (!text) return { matched: false, phrase: null, remainder: '', cutAt: -1 }
  const lower = text.toLowerCase()
  for (const p of normalizePhrases(phrases)) {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Allow a small amount of leading conversational filler before the
    // wake phrase; otherwise the phrase must start with a word boundary.
    const re = new RegExp(`(?:^|\\b)(?:hey,?\\s+|ok,?\\s+|okay,?\\s+|yo,?\\s+)?${esc}\\b[\\s,.\\-:!?]*`, 'i')
    const m = lower.match(re)
    if (m && m.index !== undefined) {
      const cutAt = m.index + m[0].length
      // Preserve original-case remainder; strip trailing politeness fillers.
      const remainder = text.slice(cutAt)
        .replace(/^\s*(?:please|can you|could you)[\s,]*/i, '')
        .trim()
      return { matched: true, phrase: p, remainder, cutAt }
    }
  }
  return { matched: false, phrase: null, remainder: text, cutAt: -1 }
}

/**
 * Convenience: when wake is required but the transcript has none, the
 * frontend should drop it silently. When wake is not required (push-to-
 * talk window already open) or when this call matches, return the text
 * to route through /command.
 *
 *   gateTranscript(text, { wakeRequired: false })            → text
 *   gateTranscript("hey novan, zoom in", { wakeRequired: true, phrases }) → "zoom in"
 *   gateTranscript("zoom in", { wakeRequired: true, phrases })            → null
 */
export function gateTranscript(text: string, opts: { wakeRequired: boolean; phrases?: ReadonlyArray<string> }): { ok: boolean; remainder: string; wake?: WakeResult } {
  if (!opts.wakeRequired) return { ok: true, remainder: text }
  const wake = detectWake(text, opts.phrases ?? DEFAULT_PHRASES)
  if (!wake.matched) return { ok: false, remainder: '', wake }
  // Remainder may be empty ("hey Novan" alone) — caller can still acknowledge.
  return { ok: true, remainder: wake.remainder, wake }
}
