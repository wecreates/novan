/**
 * speech-providers.ts — provider-agnostic registry.
 *
 * Defines the static catalogue of supported speech providers and exposes
 * a workspace-scoped enable / disable / configure API. We NEVER store raw
 * API keys here — only a `keyRef` pointing into the existing vault. The
 * router consumes this registry; no provider is hardcoded as the default.
 *
 * Providers cover three kinds:
 *   - realtime_s2s : full duplex speech ↔ speech (OpenAI Realtime, Gemini Live)
 *   - stt          : speech → text (Deepgram, AssemblyAI, Azure)
 *   - tts          : text → speech (ElevenLabs, Cartesia, PlayHT, Azure)
 *   - custom       : private hosted endpoint (operator-supplied)
 *
 * The `fallback` mode in the router pipes STT → Brain → TTS, so STT/TTS
 * providers remain useful even when no realtime S2S provider is reachable.
 */
import { db } from '../db/client.js'
import { speechProviderConfigs } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type SpeechProviderKind = 'realtime_s2s' | 'stt' | 'tts' | 'custom'

export interface SpeechProviderDefinition {
  id: string
  displayName: string
  vendor: string
  kind: SpeechProviderKind
  /** Approximate cost per minute of audio (USD). */
  costPerMinUsd: number
  /** Typical observed first-audio latency (ms). */
  typicalLatencyMs: number
  supportsStreaming: boolean
  supportsInterruption: boolean
  /** ISO-639 / BCP-47 locales known to work. Empty = unknown. */
  locales: string[]
  /** Default voice id where applicable. */
  defaultVoice?: string
  /** Documentation pointer (operator-visible). */
  docsUrl?: string
}

/**
 * Catalogue. Costs/latency are starting heuristics; the router updates
 * `health_score` and `last_latency_ms` from live measurements per workspace.
 */
export const PROVIDER_CATALOGUE: SpeechProviderDefinition[] = [
  { id: 'openai_realtime',  displayName: 'OpenAI Realtime',    vendor: 'openai',     kind: 'realtime_s2s', costPerMinUsd: 0.30, typicalLatencyMs: 450,  supportsStreaming: true,  supportsInterruption: true,  locales: ['en-US','en-GB','es-ES','fr-FR','de-DE','ja-JP'], defaultVoice: 'alloy',     docsUrl: 'https://platform.openai.com/docs/guides/realtime' },
  { id: 'gemini_live',      displayName: 'Gemini Live',         vendor: 'google',     kind: 'realtime_s2s', costPerMinUsd: 0.25, typicalLatencyMs: 500,  supportsStreaming: true,  supportsInterruption: true,  locales: ['en-US','en-GB','es-ES','hi-IN','ja-JP'],          defaultVoice: 'Aoede',     docsUrl: 'https://ai.google.dev/gemini-api/docs/live' },
  { id: 'azure_speech',     displayName: 'Azure Speech',        vendor: 'microsoft',  kind: 'tts',          costPerMinUsd: 0.16, typicalLatencyMs: 800,  supportsStreaming: true,  supportsInterruption: false, locales: ['en-US','en-GB','es-ES','fr-FR','de-DE','ja-JP','zh-CN'], defaultVoice: 'en-US-JennyNeural', docsUrl: 'https://learn.microsoft.com/azure/ai-services/speech-service/' },
  { id: 'elevenlabs',       displayName: 'ElevenLabs',          vendor: 'elevenlabs', kind: 'tts',          costPerMinUsd: 0.30, typicalLatencyMs: 600,  supportsStreaming: true,  supportsInterruption: false, locales: ['en-US','en-GB','es-ES','fr-FR','de-DE'],         defaultVoice: 'Rachel',    docsUrl: 'https://elevenlabs.io/docs' },
  { id: 'cartesia_tts',     displayName: 'Cartesia',            vendor: 'cartesia',   kind: 'tts',          costPerMinUsd: 0.18, typicalLatencyMs: 350,  supportsStreaming: true,  supportsInterruption: false, locales: ['en-US'],                                          defaultVoice: 'sonic-en', docsUrl: 'https://docs.cartesia.ai' },
  { id: 'playht',           displayName: 'PlayHT',              vendor: 'playht',     kind: 'tts',          costPerMinUsd: 0.20, typicalLatencyMs: 700,  supportsStreaming: true,  supportsInterruption: false, locales: ['en-US','en-GB','es-ES'],                          docsUrl: 'https://docs.play.ht' },
  { id: 'deepgram_stt',     displayName: 'Deepgram',            vendor: 'deepgram',   kind: 'stt',          costPerMinUsd: 0.04, typicalLatencyMs: 250,  supportsStreaming: true,  supportsInterruption: false, locales: ['en-US','en-GB','es-ES'],                          docsUrl: 'https://developers.deepgram.com' },
  { id: 'assemblyai_stt',   displayName: 'AssemblyAI',          vendor: 'assemblyai', kind: 'stt',          costPerMinUsd: 0.07, typicalLatencyMs: 400,  supportsStreaming: true,  supportsInterruption: false, locales: ['en-US','en-GB'],                                   docsUrl: 'https://www.assemblyai.com/docs' },
  { id: 'custom',           displayName: 'Custom endpoint',     vendor: 'self',       kind: 'custom',       costPerMinUsd: 0.00, typicalLatencyMs: 0,    supportsStreaming: true,  supportsInterruption: false, locales: [] },
]

export function getProviderDefinition(id: string): SpeechProviderDefinition | null {
  return PROVIDER_CATALOGUE.find(p => p.id === id) ?? null
}

export interface ConfigureProviderInput {
  workspaceId: string
  providerId: string                  // must exist in catalogue OR equal 'custom'
  displayName?: string
  endpoint?: string                   // required for kind === 'custom'
  keyRef?: string                     // vault reference, NEVER raw key
  enabled?: boolean
  priority?: number
  preferredVoice?: string
  preferredLocale?: string
  maxCostPerMinUsd?: number
  maxLatencyMs?: number
}

/**
 * Upsert a workspace-scoped provider configuration. Raw API keys must
 * never reach this function — operators register them in the vault and
 * pass the vault `keyRef` only. The handler logs an error and refuses if
 * a raw-looking secret is passed in keyRef.
 */
export async function configureSpeechProvider(input: ConfigureProviderInput): Promise<{ id: string }> {
  const def = getProviderDefinition(input.providerId)
  if (!def) throw new Error(`unknown provider: ${input.providerId}`)
  if (def.kind === 'custom' && !input.endpoint) throw new Error('custom provider requires endpoint')
  if (input.keyRef && /^(sk-|key-|Bearer )/i.test(input.keyRef)) {
    throw new Error('keyRef must be a vault reference, not a raw API key')
  }
  const now = Date.now()
  const existing = await db.select().from(speechProviderConfigs)
    .where(and(eq(speechProviderConfigs.workspaceId, input.workspaceId), eq(speechProviderConfigs.providerId, input.providerId)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[speech-providers]', e.message); return null })

  if (existing) {
    await db.update(speechProviderConfigs).set({
      displayName:      input.displayName ?? existing.displayName,
      endpoint:         input.endpoint ?? existing.endpoint,
      keyRef:           input.keyRef ?? existing.keyRef,
      enabled:          input.enabled ?? existing.enabled,
      priority:         input.priority ?? existing.priority,
      preferredVoice:   input.preferredVoice ?? existing.preferredVoice,
      preferredLocale:  input.preferredLocale ?? existing.preferredLocale,
      maxCostPerMinUsd: input.maxCostPerMinUsd ?? existing.maxCostPerMinUsd,
      maxLatencyMs:     input.maxLatencyMs ?? existing.maxLatencyMs,
      updatedAt:        now,
    }).where(eq(speechProviderConfigs.id, existing.id))
    return { id: existing.id }
  }

  const id = uuidv7()
  await db.insert(speechProviderConfigs).values({
    id,
    workspaceId:         input.workspaceId,
    providerId:          input.providerId,
    displayName:         input.displayName ?? def.displayName,
    kind:                def.kind,
    endpoint:            input.endpoint ?? null,
    keyRef:              input.keyRef ?? null,
    enabled:             input.enabled ?? true,
    priority:            input.priority ?? 100,
    preferredVoice:      input.preferredVoice ?? def.defaultVoice ?? null,
    preferredLocale:     input.preferredLocale ?? 'en-US',
    maxCostPerMinUsd:    input.maxCostPerMinUsd ?? 0.5,
    maxLatencyMs:        input.maxLatencyMs ?? 1500,
    supportsStreaming:   def.supportsStreaming,
    supportsInterruption: def.supportsInterruption,
    healthScore:         1.0,
    createdAt:           now,
    updatedAt:           now,
  })
  return { id }
}

export interface ProviderRow {
  id: string
  providerId: string
  displayName: string
  kind: SpeechProviderKind
  enabled: boolean
  priority: number
  preferredVoice: string | null
  preferredLocale: string
  maxCostPerMinUsd: number
  maxLatencyMs: number
  supportsStreaming: boolean
  supportsInterruption: boolean
  healthScore: number
  lastLatencyMs: number | null
  lastError: string | null
  lastHealthAt: number | null
  hasKey: boolean
  /** Vault secret id — never the raw key. Server-only; hasKey is the boolean for clients. */
  keyRef: string | null
  /** Operator-supplied endpoint URL (custom kind, Deepgram project URL, …). */
  endpoint: string | null
  catalogue: SpeechProviderDefinition | null
}

export async function listProviders(workspaceId: string): Promise<ProviderRow[]> {
  const rows = await db.select().from(speechProviderConfigs)
    .where(eq(speechProviderConfigs.workspaceId, workspaceId))
    .catch(() => [])
  return rows.map(r => ({
    id: r.id,
    providerId: r.providerId,
    displayName: r.displayName,
    kind: r.kind as SpeechProviderKind,
    enabled: r.enabled,
    priority: r.priority,
    preferredVoice: r.preferredVoice,
    preferredLocale: r.preferredLocale,
    maxCostPerMinUsd: r.maxCostPerMinUsd,
    maxLatencyMs: r.maxLatencyMs,
    supportsStreaming: r.supportsStreaming,
    supportsInterruption: r.supportsInterruption,
    healthScore: r.healthScore,
    lastLatencyMs: r.lastLatencyMs,
    lastError: r.lastError,
    lastHealthAt: r.lastHealthAt,
    hasKey: !!r.keyRef,
    keyRef: r.keyRef,
    endpoint: r.endpoint,
    catalogue: getProviderDefinition(r.providerId),
  }))
}

export async function setProviderEnabled(workspaceId: string, providerId: string, enabled: boolean): Promise<void> {
  await db.update(speechProviderConfigs)
    .set({ enabled, updatedAt: Date.now() })
    .where(and(eq(speechProviderConfigs.workspaceId, workspaceId), eq(speechProviderConfigs.providerId, providerId)))
    .catch((e: Error) => { console.error('[speech-providers]', e.message); return null })
}

export async function recordProviderHealth(workspaceId: string, providerId: string, ok: boolean, latencyMs: number, err?: string): Promise<void> {
  // Exponential moving average for healthScore (alpha = 0.3)
  const existing = await db.select().from(speechProviderConfigs)
    .where(and(eq(speechProviderConfigs.workspaceId, workspaceId), eq(speechProviderConfigs.providerId, providerId)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[speech-providers]', e.message); return null })
  if (!existing) return
  const alpha = 0.3
  const score = alpha * (ok ? 1 : 0) + (1 - alpha) * existing.healthScore
  await db.update(speechProviderConfigs).set({
    healthScore: Number(score.toFixed(3)),
    lastLatencyMs: latencyMs,
    lastError: ok ? null : (err ?? 'unknown'),
    lastHealthAt: Date.now(),
    updatedAt: Date.now(),
  }).where(eq(speechProviderConfigs.id, existing.id)).catch((e: Error) => { console.error('[speech-providers]', e.message); return null })
}
