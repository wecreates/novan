/**
 * speech-router.ts — pick the best speech provider for a workspace and
 * produce a fallback chain. The router is intentionally provider-agnostic:
 *   - input  : enabled provider rows + caller preferences (mode, locale, preset)
 *   - output : { primary, fallbackChain } where chain degrades gracefully
 *
 * Selection score (higher is better):
 *   score = 0.40 * health
 *         + 0.25 * latencyFit       (1.0 if last ≤ target, decays linearly to 0 at 4×)
 *         + 0.15 * costFit          (1.0 if cost ≤ budget, 0 if over)
 *         + 0.10 * featureFit       (streaming + interruption preference)
 *         + 0.10 * priorityBoost    (operator-set priority, normalized)
 *
 * Mode 'realtime' filters to realtime_s2s+custom. Mode 'fallback' assembles
 * an STT + TTS pair (STT → Brain → TTS). Locale filter is soft: providers
 * with empty locales list pass; otherwise must include preferred locale.
 *
 * No provider is hardcoded. If zero candidates remain after filtering, the
 * router returns a structured `{ ok:false, reason }` instead of fabricating
 * a winner — callers must surface this to the user.
 */
import { listProviders, type ProviderRow, type SpeechProviderKind } from './speech-providers.js'

export type VoiceMode = 'realtime' | 'fallback'

export interface RoutingPreferences {
  mode: VoiceMode
  locale?: string                     // default 'en-US'
  preset?: string
  maxLatencyMs?: number               // operator budget
  maxCostPerMinUsd?: number
  requireInterruption?: boolean
  /** Operator-pinned provider — scored last so it wins on ties. */
  preferredProvider?: string
  /** providerId → composite quality (0..1) from feedback rollup. */
  qualityScores?: Record<string, number>
  /** How heavily quality biases routing (0..1). Default 0.15. */
  qualityWeight?: number
}

export interface RoutingDecision {
  ok: boolean
  reason?: string
  mode: VoiceMode
  primary?: string                    // provider_id
  pair?: { stt: string; tts: string } // populated when mode === 'fallback'
  fallbackChain: string[]             // provider_ids tried in order on failure
  scores: Array<{ providerId: string; score: number; reasons: string[] }>
}

function scoreProvider(p: ProviderRow, prefs: RoutingPreferences): { score: number; reasons: string[] } {
  const reasons: string[] = []
  const targetLatency = prefs.maxLatencyMs ?? p.maxLatencyMs
  const budget = prefs.maxCostPerMinUsd ?? p.maxCostPerMinUsd

  // Health (0..1)
  const health = Math.max(0, Math.min(1, p.healthScore))
  reasons.push(`health=${health.toFixed(2)}`)

  // Latency fit: 1.0 at ≤ target, decays linearly to 0 at 4× target
  const observed = p.lastLatencyMs ?? (p.catalogue?.typicalLatencyMs ?? targetLatency)
  let latencyFit: number
  if (observed <= targetLatency) latencyFit = 1
  else if (observed >= targetLatency * 4) latencyFit = 0
  else latencyFit = 1 - (observed - targetLatency) / (targetLatency * 3)
  reasons.push(`latency=${observed}ms→${latencyFit.toFixed(2)}`)

  // Cost fit: 1.0 within budget, 0 if catalogue cost exceeds budget
  const cost = p.catalogue?.costPerMinUsd ?? 0
  const costFit = cost <= budget ? 1 : 0
  reasons.push(`cost=$${cost.toFixed(2)}/min→${costFit}`)

  // Feature fit
  let featureFit = 0.5
  if (p.supportsStreaming) featureFit += 0.3
  if (prefs.requireInterruption) featureFit = p.supportsInterruption ? 1 : 0
  else if (p.supportsInterruption) featureFit += 0.2
  featureFit = Math.min(1, featureFit)
  reasons.push(`features=${featureFit.toFixed(2)}`)

  // Priority boost — operator-controlled, normalize against 1000
  const priorityBoost = Math.max(0, Math.min(1, p.priority / 1000))
  reasons.push(`priority=${p.priority}→${priorityBoost.toFixed(2)}`)

  // Quality boost from operator-rated feedback (composite 0..1)
  const qualityWeight = Math.max(0, Math.min(1, prefs.qualityWeight ?? 0.15))
  const qualityScore  = Math.max(0, Math.min(1, prefs.qualityScores?.[p.providerId] ?? 0))
  reasons.push(`quality=${qualityScore.toFixed(2)}×${qualityWeight.toFixed(2)}`)

  // Preferred-provider bump (small, deterministic tiebreaker)
  const preferredBump = prefs.preferredProvider === p.providerId ? 0.05 : 0
  if (preferredBump) reasons.push(`preferred=+${preferredBump.toFixed(2)}`)

  // Re-normalize the original 5 weights to (1 - qualityWeight) so the
  // sum stays bounded at ~1.0 + preferredBump.
  const base = 1 - qualityWeight
  const score = base * (0.40 * health + 0.25 * latencyFit + 0.15 * costFit + 0.10 * featureFit + 0.10 * priorityBoost)
              + qualityWeight * qualityScore
              + preferredBump

  return { score: Number(score.toFixed(4)), reasons }
}

function localeOk(p: ProviderRow, locale: string): boolean {
  const list = p.catalogue?.locales ?? []
  if (list.length === 0) return true               // unknown coverage → allow
  return list.includes(locale) || list.some(l => l.split('-')[0] === locale.split('-')[0])
}

/**
 * Route a single workspace. Pure function over the provided rows so unit
 * tests can construct deterministic scenarios without touching the DB.
 */
export function decideFromRows(rows: ProviderRow[], prefs: RoutingPreferences): RoutingDecision {
  const locale = prefs.locale ?? 'en-US'
  const enabled = rows.filter(r => r.enabled && localeOk(r, locale))
  const mode = prefs.mode

  if (mode === 'realtime') {
    const realtime = enabled.filter(r => r.kind === 'realtime_s2s' || r.kind === 'custom')
    if (realtime.length === 0) {
      return {
        ok: false,
        reason: 'no realtime providers enabled — switch to fallback mode or enable a realtime provider',
        mode, fallbackChain: [], scores: [],
      }
    }
    const scored = realtime.map(p => ({ providerId: p.providerId, ...scoreProvider(p, prefs) }))
                           .sort((a, b) => b.score - a.score)
    return {
      ok: true, mode,
      primary: scored[0]!.providerId,
      fallbackChain: scored.slice(1).map(s => s.providerId),
      scores: scored,
    }
  }

  // fallback mode: pair STT + TTS
  const stt = enabled.filter(r => r.kind === 'stt')
  const tts = enabled.filter(r => r.kind === 'tts')
  if (stt.length === 0 || tts.length === 0) {
    return {
      ok: false,
      reason: `fallback mode requires STT (${stt.length}) and TTS (${tts.length}) providers`,
      mode, fallbackChain: [], scores: [],
    }
  }
  const scoredStt = stt.map(p => ({ providerId: p.providerId, ...scoreProvider(p, prefs) })).sort((a, b) => b.score - a.score)
  const scoredTts = tts.map(p => ({ providerId: p.providerId, ...scoreProvider(p, prefs) })).sort((a, b) => b.score - a.score)
  const pair = { stt: scoredStt[0]!.providerId, tts: scoredTts[0]!.providerId }
  return {
    ok: true, mode, pair,
    primary: `${pair.stt}+${pair.tts}`,
    fallbackChain: [
      ...scoredStt.slice(1).map(s => `${s.providerId}+${pair.tts}`),
      ...scoredTts.slice(1).map(t => `${pair.stt}+${t.providerId}`),
    ],
    scores: [...scoredStt, ...scoredTts],
  }
}

/** DB-backed convenience wrapper. Loads provider rows, operator prefs,
 *  and quality rollup, then applies the pure decideFromRows() function.
 *  Caller-supplied prefs override workspace defaults. */
export async function decideForWorkspace(workspaceId: string, prefs: RoutingPreferences): Promise<RoutingDecision> {
  const [rows, wsPrefs, rollup] = await Promise.all([
    listProviders(workspaceId),
    import('./voice-preferences.js').then(m => m.getVoicePrefs(workspaceId)).catch((e: Error) => { console.error('[speech-router]', e.message); return null }),
    import('./voice-context-store.js').then(m => m.providerQualityRollup(workspaceId)).catch(() => [] as Array<{ provider: string; composite: number }>),
  ])
  const qualityScores: Record<string, number> = {}
  for (const r of rollup) qualityScores[r.provider] = r.composite
  const merged: RoutingPreferences = {
    ...prefs,
    ...(prefs.preferredProvider === undefined && wsPrefs?.preferredProvider
      ? { preferredProvider: wsPrefs.preferredProvider } : {}),
    ...(prefs.qualityWeight === undefined && wsPrefs
      ? { qualityWeight: wsPrefs.qualityWeight } : {}),
    ...(prefs.locale === undefined && wsPrefs?.preferredLocale
      ? { locale: wsPrefs.preferredLocale } : {}),
    ...(prefs.qualityScores === undefined ? { qualityScores } : {}),
  }
  return decideFromRows(rows, merged)
}

/** Voice personality presets — operator-visible, voice-agnostic. */
export const VOICE_PRESETS = [
  { id: 'calm_operator',     label: 'Calm Operator',      style: 'measured, low-pace, neutral',     temperatureHint: 0.4, recommendedVoices: ['alloy','Rachel','en-US-JennyNeural'] },
  { id: 'executive_briefing', label: 'Executive Briefing', style: 'concise, confident, structured',  temperatureHint: 0.3, recommendedVoices: ['onyx','Adam','en-US-GuyNeural'] },
  { id: 'technical_engineer', label: 'Technical Engineer', style: 'precise, vocabulary-rich, dry',   temperatureHint: 0.4, recommendedVoices: ['echo','Daniel'] },
  { id: 'security_mode',      label: 'Security Mode',      style: 'serious, terse, alert-aware',     temperatureHint: 0.2, recommendedVoices: ['onyx','Antoni'] },
  { id: 'creative_director',  label: 'Creative Director',  style: 'expressive, narrative, warm',     temperatureHint: 0.7, recommendedVoices: ['nova','Bella'] },
  { id: 'fast_minimal',       label: 'Fast Minimal',       style: 'shortest possible, clipped',      temperatureHint: 0.3, recommendedVoices: ['shimmer'] },
] as const
export type VoicePreset = typeof VOICE_PRESETS[number]['id']

export function getPreset(id: string) {
  return VOICE_PRESETS.find(p => p.id === id) ?? VOICE_PRESETS[0]
}
