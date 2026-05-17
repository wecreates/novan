/**
 * agent-coordinator.ts — Deduplication + signal/noise control.
 *
 * Two responsibilities:
 *   1. claimTask(key)   — only one agent works on a (workspace, agentType, taskSignature)
 *                         tuple at a time. Returns false if another claim is active.
 *   2. shouldEmit(key)  — collapse repetitive events: same (workspace, eventType, payloadSig)
 *                         emitted within DEDUP_WINDOW_MS is suppressed.
 *
 * Pure in-memory. Conservative TTLs so claims auto-release after crashes.
 */

const CLAIM_TTL_MS  = 5 * 60_000     // 5 min — agent task ownership
const DEDUP_WINDOW_MS = 60_000        // 1 min — event collapse window
const PRIORITY_LOG_LIMIT = 200        // last-N priority decisions kept in memory

const CLAIMS = new Map<string, number>()   // key → expiresAt
const RECENT_EVENTS = new Map<string, number>()  // key → lastEmittedAt

export function claimTask(workspaceId: string, agentType: string, taskSignature: string): boolean {
  const key = `${workspaceId}|${agentType}|${taskSignature}`
  const now = Date.now()
  const existing = CLAIMS.get(key)
  if (existing && existing > now) return false
  CLAIMS.set(key, now + CLAIM_TTL_MS)
  return true
}

export function releaseTask(workspaceId: string, agentType: string, taskSignature: string): void {
  CLAIMS.delete(`${workspaceId}|${agentType}|${taskSignature}`)
}

/** Returns true if the event SHOULD be emitted; false if it's a duplicate within window. */
export function shouldEmit(workspaceId: string, eventType: string, payloadSig: string): boolean {
  const key = `${workspaceId}|${eventType}|${payloadSig}`
  const now = Date.now()
  const last = RECENT_EVENTS.get(key)
  if (last && now - last < DEDUP_WINDOW_MS) return false
  RECENT_EVENTS.set(key, now)
  // Light GC every ~1000 entries
  if (RECENT_EVENTS.size > 1000) {
    for (const [k, t] of RECENT_EVENTS) {
      if (now - t > DEDUP_WINDOW_MS * 2) RECENT_EVENTS.delete(k)
    }
  }
  return true
}

// ─── Prioritization helper ───────────────────────────────────────────────────

export interface PriorityInput {
  productionImpact:  number  // 0..1
  reliabilityImpact: number  // 0..1
  securityImpact:    number  // 0..1
  costImpact:        number  // 0..1 (higher = more costly to NOT fix)
  confidence:        number  // 0..1
}

export interface PriorityDecision {
  score:        number              // 0..1
  bucket:       'P0' | 'P1' | 'P2' | 'P3'
  autoApplyOk:  boolean             // confidence high + impact bounded
  warnings:     string[]
  reasons:      string[]
}

const PRIORITY_LOG: Array<{ ts: number; key: string; decision: PriorityDecision }> = []

export function prioritize(key: string, input: PriorityInput): PriorityDecision {
  // Weighted impact score
  const impact =
      input.productionImpact  * 0.30
    + input.reliabilityImpact * 0.25
    + input.securityImpact    * 0.30
    + input.costImpact        * 0.15
  const score = impact * input.confidence
  const bucket: PriorityDecision['bucket'] =
      score >= 0.65 ? 'P0'
    : score >= 0.40 ? 'P1'
    : score >= 0.20 ? 'P2'
    :                 'P3'

  const warnings: string[] = []
  if (input.confidence < 0.5) warnings.push('low_confidence: require approval')
  if (input.securityImpact >= 0.8 && input.confidence < 0.8) warnings.push('high security impact + uncertain — escalate')
  if (input.productionImpact >= 0.8 && bucket !== 'P0') warnings.push('high production impact but bucketed below P0 — review weights')

  // Auto-apply only when confidence >= 0.8 AND security risk bounded
  const autoApplyOk = input.confidence >= 0.8 && input.securityImpact <= 0.5 && bucket !== 'P3'

  const reasons = [
    `impact=${impact.toFixed(2)}`,
    `confidence=${input.confidence.toFixed(2)}`,
    `score=${score.toFixed(2)}`,
    `bucket=${bucket}`,
  ]

  const decision: PriorityDecision = { score, bucket, autoApplyOk, warnings, reasons }
  PRIORITY_LOG.push({ ts: Date.now(), key, decision })
  if (PRIORITY_LOG.length > PRIORITY_LOG_LIMIT) PRIORITY_LOG.shift()
  return decision
}

export function recentPriorityDecisions(limit = 50) {
  return PRIORITY_LOG.slice(-limit).reverse()
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

export function coordinatorSnapshot() {
  const now = Date.now()
  const activeClaims: Array<{ key: string; expiresInMs: number }> = []
  for (const [k, exp] of CLAIMS) {
    if (exp > now) activeClaims.push({ key: k, expiresInMs: exp - now })
  }
  return {
    activeClaims:  activeClaims.length,
    recentEvents:  RECENT_EVENTS.size,
    priorityLog:   PRIORITY_LOG.length,
    claimTtlMs:    CLAIM_TTL_MS,
    dedupWindowMs: DEDUP_WINDOW_MS,
  }
}
