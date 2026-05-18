/**
 * identity-core.ts — Unified identity, tone, and communication standards.
 *
 * Identity is enforced via:
 *   1. Trait registry (calm, elite, tactical, etc.) with per-workspace overrides
 *   2. Communication auditor: scans agent output for hype, fake-certainty,
 *      missing uncertainty handling, fact/estimate confusion
 *   3. Standardized output templates for incident/brief/research/risk/rec
 *
 * The auditor is pure — no I/O. Persisting an audit is a separate function.
 */
import { db } from '../db/client.js'
import { identityProfile, communicationAudit } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Core trait registry ────────────────────────────────────────────────

export const CORE_TRAITS = {
  calm:                 0.95,
  elite:                0.90,
  tactical:             0.90,
  trustworthy:          0.95,
  operationally_focused: 0.90,
  strategic:            0.85,
  concise:              0.90,
  non_chaotic:          0.95,
  non_hype:             0.95,
  confidence_aware:     0.95,
} as const

export type TraitKey = keyof typeof CORE_TRAITS

// ─── Pure auditor ───────────────────────────────────────────────────────

export type OutputType = 'incident' | 'brief' | 'research' | 'patch' | 'risk' | 'rec' | 'social' | 'support'

export interface AuditResult {
  hypeScore:           number    // 0..1, higher = more hype
  uncertaintyHandling: 'explicit' | 'implicit' | 'missing'
  factEstimateOk:      boolean
  violations:          Array<{ kind: string; detail: string }>
  passed:              boolean
}

// Hype/exaggeration patterns — flag for hype score
const HYPE_PATTERNS: Array<{ pattern: RegExp; weight: number; reason: string }> = [
  { pattern: /\b(absolutely|definitely|guarantee[ds]?|guaranteed|100%\s+(sure|certain))\b/i, weight: 0.20, reason: 'fake certainty' },
  { pattern: /\b(amazing|incredible|game[-\s]?chang(er|ing)|revolutionary|disrupt(ive|ing)?|unprecedented)\b/i, weight: 0.15, reason: 'hype adjective' },
  { pattern: /\b(skyrocket|explosive\s+growth|10x|100x|moonshot)\b/i, weight: 0.20, reason: 'growth hype' },
  { pattern: /\b(insane(ly)?|crazy\s+(good|impressive)|mind[-\s]?blowing|wild)\b/i, weight: 0.15, reason: 'casual hyperbole' },
  { pattern: /[!]{2,}/, weight: 0.10, reason: 'multiple exclamations' },
  { pattern: /\b(literally|honestly|to\s+be\s+honest|tbh)\b/i, weight: 0.05, reason: 'fluff filler' },
  { pattern: /\bjust\s+(launch|ship|deploy|go\s+live)\b/i, weight: 0.10, reason: 'reckless urgency' },
]

// Uncertainty markers — having at least one in a forecast/prediction is good
const UNCERTAINTY_MARKERS = /\b(likely|probably|may|might|could|estimate(d)?|forecast|projection|approximately|approx|~|conf(idence)?\s*[0-9.]+|±|\+\/-|\bif\s+)\b/i

// Fact-vs-estimate language — predictions must be marked as such
const PREDICTION_TRIGGERS = /\b(will|going\s+to|expect|forecast|predict|by\s+(next|end\s+of)|q[1-4]|next\s+(week|month|quarter|year))\b/i
const FACT_MARKER         = /\b(observed|measured|recorded|verified|confirmed|fact[:|\s])\b/i
const ESTIMATE_MARKER     = /\b(estimate|estimated|estimating|projection|projected|forecast|forecasted)\b/i

export function audit(text: string, outputType: OutputType): AuditResult {
  const violations: Array<{ kind: string; detail: string }> = []
  let hypeScore = 0

  for (const { pattern, weight, reason } of HYPE_PATTERNS) {
    if (pattern.test(text)) {
      hypeScore += weight
      violations.push({ kind: 'hype', detail: reason })
    }
  }
  hypeScore = Math.min(1, Number(hypeScore.toFixed(3)))

  // Uncertainty handling check
  const isPredictionContext = outputType === 'research' || outputType === 'risk' || outputType === 'rec' || PREDICTION_TRIGGERS.test(text)
  const hasUncertainty = UNCERTAINTY_MARKERS.test(text)
  let uncertaintyHandling: 'explicit' | 'implicit' | 'missing' = 'implicit'
  if (isPredictionContext) {
    uncertaintyHandling = hasUncertainty ? 'explicit' : 'missing'
    if (uncertaintyHandling === 'missing') {
      violations.push({ kind: 'uncertainty_missing', detail: 'prediction context without uncertainty marker' })
    }
  }

  // Fact-vs-estimate separation check
  // If text uses prediction triggers WITHOUT estimate marker AND without uncertainty → fail
  let factEstimateOk = true
  if (PREDICTION_TRIGGERS.test(text) && !ESTIMATE_MARKER.test(text) && !UNCERTAINTY_MARKERS.test(text) && !FACT_MARKER.test(text)) {
    factEstimateOk = false
    violations.push({ kind: 'fact_estimate_blur', detail: 'prediction language not marked as estimate/forecast' })
  }

  // Hard caps: hype score >0.5 = fail; uncertainty missing = fail
  const passed = hypeScore <= 0.4 && uncertaintyHandling !== 'missing' && factEstimateOk

  return { hypeScore, uncertaintyHandling, factEstimateOk, violations, passed }
}

export async function recordAudit(workspaceId: string, source: string, outputType: OutputType, text: string): Promise<{ id: string; result: AuditResult }> {
  const result = audit(text, outputType)
  const id = uuidv7()
  await db.insert(communicationAudit).values({
    id, workspaceId, source, outputType, text: text.slice(0, 5000),
    hypeScore: result.hypeScore,
    uncertaintyHandling: result.uncertaintyHandling,
    factEstimateOk: result.factEstimateOk,
    violations: result.violations,
    passed: result.passed,
    createdAt: Date.now(),
  }).catch(() => null)
  return { id, result }
}

// ─── Identity profile mgmt ──────────────────────────────────────────────

export async function getProfile(workspaceId: string) {
  const row = await db.select().from(identityProfile)
    .where(eq(identityProfile.workspaceId, workspaceId))
    .limit(1).then(r => r[0]).catch(() => null)
  if (row) return row
  // Ensure default exists
  await db.insert(identityProfile).values({
    workspaceId, traits: CORE_TRAITS as unknown as Record<string, number>,
    toneSettings: {}, version: 1, updatedAt: Date.now(),
  }).onConflictDoNothing().catch(() => null)
  return db.select().from(identityProfile)
    .where(eq(identityProfile.workspaceId, workspaceId))
    .limit(1).then(r => r[0])
}

export async function updateTraits(workspaceId: string, overrides: Partial<Record<TraitKey, number>>): Promise<void> {
  const existing = await getProfile(workspaceId)
  const next: Record<string, number> = { ...(existing?.traits ?? CORE_TRAITS), ...overrides }
  // Clamp
  for (const k of Object.keys(next)) {
    const v = Number(next[k])
    next[k] = Math.max(0, Math.min(1, isFinite(v) ? v : 0.5))
  }
  await db.update(identityProfile).set({
    traits: next, version: (existing?.version ?? 1) + 1, updatedAt: Date.now(),
  }).where(eq(identityProfile.workspaceId, workspaceId)).catch(() => null)
}

// ─── Drift detection ────────────────────────────────────────────────────

export async function identityDriftReport(workspaceId: string, hours = 24): Promise<{
  total: number
  failed: number
  failureRate: number
  avgHypeScore: number
  missingUncertainty: number
  factEstimateBlur: number
  topSources: Array<{ source: string; failed: number; total: number }>
}> {
  const since = Date.now() - hours * 60 * 60_000
  const rows = await db.select().from(communicationAudit)
    .where(eq(communicationAudit.workspaceId, workspaceId))
    .catch(() => [])
  const recent = rows.filter(r => r.createdAt >= since)
  const total = recent.length
  const failed = recent.filter(r => !r.passed).length
  const avgHypeScore = total > 0 ? Number((recent.reduce((s, r) => s + r.hypeScore, 0) / total).toFixed(3)) : 0
  const missingUncertainty = recent.filter(r => r.uncertaintyHandling === 'missing').length
  const factEstimateBlur   = recent.filter(r => !r.factEstimateOk).length

  const bySource = new Map<string, { failed: number; total: number }>()
  for (const r of recent) {
    const s = bySource.get(r.source) ?? { failed: 0, total: 0 }
    s.total++
    if (!r.passed) s.failed++
    bySource.set(r.source, s)
  }
  const topSources = Array.from(bySource.entries())
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.failed - a.failed)
    .slice(0, 8)

  return {
    total, failed,
    failureRate: total > 0 ? Number((failed / total).toFixed(3)) : 0,
    avgHypeScore, missingUncertainty, factEstimateBlur,
    topSources,
  }
}

// ─── Standardized output formatters ─────────────────────────────────────
// Helpers any agent can call to produce identity-consistent text.

export function fmtIncident(opts: { title: string; observedAt: number; severity: string; evidence: string[]; recommendedAction?: string }): string {
  const sev = opts.severity.toUpperCase()
  const evid = opts.evidence.slice(0, 5).map(e => `  - ${e}`).join('\n')
  return [
    `[INCIDENT · ${sev}] ${opts.title}`,
    `Observed: ${new Date(opts.observedAt).toISOString()}`,
    `Evidence:\n${evid}`,
    opts.recommendedAction ? `Recommended: ${opts.recommendedAction}` : '',
  ].filter(Boolean).join('\n')
}

export function fmtRecommendation(opts: { title: string; reason: string; confidence: number; evidence: string[]; tradeoffs?: string[] }): string {
  const evid = opts.evidence.slice(0, 4).map(e => `  · ${e}`).join('\n')
  const tradeoffs = opts.tradeoffs?.slice(0, 3).map(t => `  · ${t}`).join('\n') ?? ''
  return [
    `[RECOMMENDATION · conf ${opts.confidence.toFixed(2)}] ${opts.title}`,
    `Reason: ${opts.reason}`,
    `Evidence:\n${evid}`,
    tradeoffs ? `Tradeoffs:\n${tradeoffs}` : '',
  ].filter(Boolean).join('\n')
}

export function fmtForecast(opts: { kind: string; projection: number | string; horizonDays: number; basis: string; confidence: number }): string {
  return [
    `[FORECAST · ${opts.kind} · estimate]`,
    `Projection: ~${opts.projection} in ${opts.horizonDays}d`,
    `Confidence: ${opts.confidence.toFixed(2)}`,
    `Basis: ${opts.basis}`,
  ].join('\n')
}
