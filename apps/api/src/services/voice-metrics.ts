/**
 * voice-metrics.ts — rollups for the war-room voice intelligence view +
 * inputs to provider routing.
 *
 * Pure aggregator + a DB-backed convenience wrapper. The provider
 * routing layer already consumes `providerQualityRollup` from
 * voice-context-store; this module focuses on operator-facing metrics:
 *   - intent confidence distribution
 *   - correction rate
 *   - interruption rate (barge_in + stop / pause / never_mind)
 *   - approval rate (confirm-verdict plans that the operator approved)
 *   - blocked-action rate
 *   - per-provider latency observations
 */
import { db } from '../db/client.js'
import { voiceEvents } from '../db/schema.js'
import { and, eq, gte } from 'drizzle-orm'

export interface VoiceMetrics {
  windowMs:           number
  totalTurns:         number
  avgConfidence:      number | null
  lowConfidenceRate:  number     // confidence < 0.55 share
  correctionRate:     number     // corrections / total
  interruptionRate:   number     // (barge_in + stop + never_mind) / total
  approvalRate:       number     // confirms / (confirms + cancellations)
  blockedActionRate:  number     // blocks / total
  perProviderLatency: Array<{ provider: string; samples: number; p50: number; p95: number }>
  topIntents:         Array<{ intent: string; count: number }>
}

interface EventLike {
  kind: string; provider: string | null; latencyMs: number | null
  meta: { intent?: string; confidence?: number; verdict?: string; conversationMeta?: string } | null
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
  return sorted[idx]!
}

/** Pure aggregator — used in tests. */
export function aggregateMetrics(rows: ReadonlyArray<EventLike>, windowMs: number): VoiceMetrics {
  let totalTurns = 0
  let confSum = 0, confN = 0, lowConf = 0
  let corrections = 0, interruptions = 0, confirms = 0, cancellations = 0, blocked = 0
  const latencyByProvider = new Map<string, number[]>()
  const intentCounts = new Map<string, number>()

  for (const r of rows) {
    const meta = r.meta ?? {}
    const isTurn = r.kind === 'command' || r.kind === 'confirm' || r.kind === 'clarify' || r.kind === 'block'
    if (isTurn) totalTurns++
    if (typeof meta.confidence === 'number') {
      confSum += meta.confidence; confN++
      if (meta.confidence < 0.55) lowConf++
    }
    if (meta.intent) intentCounts.set(meta.intent, (intentCounts.get(meta.intent) ?? 0) + 1)
    if (meta.conversationMeta === 'correction') corrections++
    if (meta.conversationMeta === 'never_mind' || meta.conversationMeta === 'stop' || r.kind === 'barge_in') interruptions++
    if (meta.verdict === 'reject' || r.kind === 'block') blocked++
    if (r.kind === 'confirm') confirms++
    if (meta.conversationMeta === 'never_mind') cancellations++
    if (r.provider && typeof r.latencyMs === 'number') {
      const arr = latencyByProvider.get(r.provider) ?? []
      arr.push(r.latencyMs)
      latencyByProvider.set(r.provider, arr)
    }
  }

  const perProviderLatency = [...latencyByProvider.entries()].map(([provider, lat]) => {
    const sorted = [...lat].sort((a, b) => a - b)
    return { provider, samples: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) }
  }).sort((a, b) => b.samples - a.samples)

  const safeDiv = (a: number, b: number) => b === 0 ? 0 : Number((a / b).toFixed(3))

  return {
    windowMs,
    totalTurns,
    avgConfidence:     confN === 0 ? null : Number((confSum / confN).toFixed(3)),
    lowConfidenceRate: safeDiv(lowConf, confN || totalTurns),
    correctionRate:    safeDiv(corrections, totalTurns),
    interruptionRate:  safeDiv(interruptions, totalTurns),
    approvalRate:      safeDiv(confirms, confirms + cancellations),
    blockedActionRate: safeDiv(blocked, totalTurns),
    perProviderLatency,
    topIntents: [...intentCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                  .map(([intent, count]) => ({ intent, count })),
  }
}

export async function rollupVoiceMetrics(workspaceId: string, opts: { windowMs?: number } = {}): Promise<VoiceMetrics> {
  const windowMs = opts.windowMs ?? 7 * 86_400_000
  const since = Date.now() - windowMs
  const rows = await db.select({
    kind: voiceEvents.kind, provider: voiceEvents.provider,
    latencyMs: voiceEvents.latencyMs, meta: voiceEvents.meta,
  }).from(voiceEvents)
    .where(and(eq(voiceEvents.workspaceId, workspaceId), gte(voiceEvents.createdAt, since)))
    .limit(20_000).catch(() => [])
  return aggregateMetrics(rows as EventLike[], windowMs)
}
