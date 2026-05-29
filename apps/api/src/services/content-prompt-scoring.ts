/**
 * content-prompt-scoring.ts — Close the prompt-evolution feedback loop.
 *
 * When a video / Short / listing gets a performance signal, the prompts
 * used to create it (script, thumbnail, title, hook) get a 0..1 outcome
 * score. That score feeds `prompt-evolution.recordOutcome`, which feeds
 * `usePrompt`'s mean-score ranking, which decides which prompt version
 * the brain pulls on its next call.
 *
 * Without this wire, prompt-evolution is a registry with no real signal —
 * it would only learn from explicit operator approvals (slow + sparse).
 * With this wire, every published piece of content automatically grades
 * the prompts that made it.
 *
 * Two key design choices:
 *
 *   1. **Relative scoring, not absolute.** A YouTube video with 5,000
 *      views might be a hit on a brand-new channel and a flop on a
 *      mature one. We score against the per-platform per-business
 *      median (or the operator's own baseline) so the signal is
 *      meaningful at any scale.
 *
 *   2. **Per-slot signal mapping.** Different prompts have different
 *      success signals — a thumbnail prompt is graded on CTR, a script
 *      prompt on AVD, a title prompt on impressions-to-clicks, an etsy
 *      listing description on conversion. The mapping lives here so
 *      callers don't have to think about it.
 *
 * Honest scope: the score is a smoothed signal, not a verdict. A prompt
 * version needs ≥ 20 outcomes before its mean-score is statistically
 * meaningful. The Wilson-lower-bound pick in `prompt-evolution.usePrompt`
 * handles that.
 */
import { recordOutcome } from './prompt-evolution.js'

export interface ContentOutcome {
  workspaceId:  string
  /** The prompt ids that were used to create this piece of content. */
  promptIds:    { script?: string; thumbnail?: string; title?: string; hook?: string; description?: string; tags?: string }
  platform:     'youtube' | 'tiktok' | 'instagram' | 'etsy' | 'pinterest' | 'newsletter' | 'other'
  /** Raw performance signals — pass whatever the platform gives. */
  signals: {
    views?:                number
    impressions?:          number
    ctr?:                  number      // 0..1
    avg_view_duration_sec?: number     // for video
    durationSec?:          number      // total content duration
    likes?:                number
    saves?:                number
    shares?:               number
    sends?:                number      // IG DMs
    comments?:             number
    follow_conversion?:    number      // follows attributable to this content
    sales?:                number      // POD
    conversion_rate?:      number      // 0..1, POD listing conv
  }
  /** Optional baseline for relative scoring. Operator's own median CTR
   *  on this channel, average AVD%, etc. When provided the score is
   *  relative; when absent we use platform-typical baselines. */
  baseline?: {
    ctr?:                  number
    avg_view_duration_sec?: number
    conversion_rate?:      number
  }
}

const PLATFORM_BASELINE = {
  youtube: { ctr: 0.04, avg_view_duration_pct: 0.40 },
  tiktok:  { watch_through_pct: 0.50 },
  instagram: { send_rate: 0.005 },
  etsy:    { conversion_rate: 0.025 },
  pinterest:{ save_rate: 0.005 },
  newsletter: { open_rate: 0.30 },
  other:   {},
} as const

/** Convert a raw signal to a 0..1 score, with `target` being the
 *  benchmark "good" value above which the score climbs toward 1. */
function logisticScore(value: number, target: number, k = 4): number {
  if (target <= 0) return 0.5
  const x = value / target          // 1.0 means at-target
  // Smooth s-curve through (0,0), (1,0.5), (∞,1).
  const z = (x - 1) * k
  return 1 / (1 + Math.exp(-z))
}

/** Compute the 0..1 score for each prompt slot involved in this piece
 *  of content. Returns the mapping {slot: score} so the caller can also
 *  log it. */
export function scoreFromSignals(outcome: ContentOutcome): { thumbnail?: number; script?: number; title?: number; hook?: number; description?: number; tags?: number } {
  const out: { thumbnail?: number; script?: number; title?: number; hook?: number; description?: number; tags?: number } = {}
  const sig = outcome.signals
  const base = outcome.baseline ?? {}

  // Thumbnail prompt → CTR signal (impressions → clicks)
  if (sig.ctr !== undefined && sig.ctr > 0) {
    const target = base.ctr ?? PLATFORM_BASELINE.youtube.ctr
    out.thumbnail = logisticScore(sig.ctr, target)
    // Title prompt also rides CTR (the title is half the click decision).
    out.title     = logisticScore(sig.ctr, target * 0.95)
  }

  // Script / hook prompt → AVD (video) or watch-through (Shorts/TikTok)
  if (sig.avg_view_duration_sec !== undefined && sig.durationSec !== undefined && sig.durationSec > 0) {
    const avdPct = sig.avg_view_duration_sec / sig.durationSec
    const target = (outcome.platform === 'youtube' ? PLATFORM_BASELINE.youtube.avg_view_duration_pct : PLATFORM_BASELINE.tiktok.watch_through_pct)
    const targetVal = base.avg_view_duration_sec
      ? (base.avg_view_duration_sec / sig.durationSec)
      : target
    out.script = logisticScore(avdPct, targetVal)
    // The hook is the first 8 seconds — by the time the viewer gets
    // past 30s the hook is no longer the binding constraint, so we use
    // a stricter target.
    out.hook   = logisticScore(avdPct, targetVal * 1.2)
  }

  // Etsy / POD: description + tags ride conversion_rate
  if (sig.conversion_rate !== undefined && sig.conversion_rate > 0) {
    const target = base.conversion_rate ?? PLATFORM_BASELINE.etsy.conversion_rate
    out.description = logisticScore(sig.conversion_rate, target)
    out.tags        = logisticScore(sig.conversion_rate, target * 0.9)
  }

  return out
}

/**
 * Apply the scores to the prompt-evolution registry.
 *
 * Best-effort: a failure to score one slot does not stop the others.
 * Returns the score map that was applied so the caller can also log it
 * for audit purposes.
 */
export async function applyOutcome(outcome: ContentOutcome): Promise<{ thumbnail?: number; script?: number; title?: number; hook?: number; description?: number; tags?: number }> {
  const scores = scoreFromSignals(outcome)
  const writes: Array<Promise<void>> = []
  if (outcome.promptIds.thumbnail && scores.thumbnail !== undefined)
    writes.push(recordOutcome(outcome.promptIds.thumbnail, scores.thumbnail).catch(() => undefined))
  if (outcome.promptIds.script    && scores.script    !== undefined)
    writes.push(recordOutcome(outcome.promptIds.script,    scores.script).catch(() => undefined))
  if (outcome.promptIds.title     && scores.title     !== undefined)
    writes.push(recordOutcome(outcome.promptIds.title,     scores.title).catch(() => undefined))
  if (outcome.promptIds.hook      && scores.hook      !== undefined)
    writes.push(recordOutcome(outcome.promptIds.hook,      scores.hook).catch(() => undefined))
  if (outcome.promptIds.description && scores.description !== undefined)
    writes.push(recordOutcome(outcome.promptIds.description, scores.description).catch(() => undefined))
  if (outcome.promptIds.tags      && scores.tags      !== undefined)
    writes.push(recordOutcome(outcome.promptIds.tags,      scores.tags).catch(() => undefined))
  await Promise.all(writes)
  return scores
}
