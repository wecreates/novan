/**
 * meta-learning.ts — 24/7 calibration: learn how well each reasoning
 * source's confidences match reality, surface tuning recommendations.
 *
 * Honest scope:
 *   - Reads outcome-linked chains, computes calibration gap per source.
 *   - Records a meta-chain with the gap + suggested adjustment.
 *   - DOES NOT auto-mutate global confidences (too risky for a single
 *     loop). Surfaces the suggestion for operator + future scoring.
 *
 * Rules:
 *   - need ≥10 decided outcomes per source to compute calibration
 *   - everything tagged factType: 'fact' (counts) + 'estimate'
 *     (suggested adjustment)
 */
import { db } from '../db/client.js'
import { reasoningChains } from '../db/schema.js'
import { and, eq, gte, sql } from 'drizzle-orm'
import { record as recordChain } from './reasoning-chains.js'

export interface SourceCalibration {
  source: string
  total: number
  matched: number
  unmatched: number
  matchRate: number              // 0..1
  avgConfidenceMatched: number   // 0..1
  avgConfidenceUnmatched: number
  calibrationGap: number         // avgConfMatched - matchRate (positive = overconfident on wins)
  suggestion: 'lower_confidence' | 'raise_confidence' | 'in_band'
  suggestedDelta: number         // signed adjustment in 0..1 space
  factType: 'estimate'
}

export async function calibratePerSource(workspaceId: string, windowDays = 30): Promise<SourceCalibration[]> {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const rows = await db.select({
    source: reasoningChains.source,
    matched: reasoningChains.outcomeMatched,
    confidence: reasoningChains.confidence,
  }).from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.outcomeKnown, true),
      gte(reasoningChains.createdAt, since),
    )).catch(() => [])

  // Group by source
  const groups = new Map<string, { matched: number[]; unmatched: number[] }>()
  for (const r of rows) {
    const g = groups.get(r.source) ?? { matched: [], unmatched: [] }
    const c = typeof r.confidence === 'number' ? r.confidence : 0.5
    if (r.matched === true)  g.matched.push(c)
    if (r.matched === false) g.unmatched.push(c)
    groups.set(r.source, g)
  }

  const out: SourceCalibration[] = []
  for (const [source, g] of groups) {
    const total = g.matched.length + g.unmatched.length
    if (total < 10) continue   // insufficient sample
    const matchRate = g.matched.length / total
    const avgConfMatched   = g.matched.length   > 0 ? g.matched.reduce((s, v) => s + v, 0) / g.matched.length   : 0
    const avgConfUnmatched = g.unmatched.length > 0 ? g.unmatched.reduce((s, v) => s + v, 0) / g.unmatched.length : 0
    // Calibration gap: how off is the average confidence vs the actual matchRate
    const overallAvgConf = ((avgConfMatched * g.matched.length) + (avgConfUnmatched * g.unmatched.length)) / total
    const gap = Number((overallAvgConf - matchRate).toFixed(3))
    // Suggested adjustment: move confidences by -gap (bounded ±0.15 per cycle)
    const suggestedDelta = Math.max(-0.15, Math.min(0.15, -gap))
    const suggestion: SourceCalibration['suggestion'] =
      Math.abs(gap) < 0.10 ? 'in_band' : gap > 0 ? 'lower_confidence' : 'raise_confidence'
    out.push({
      source, total,
      matched:   g.matched.length,
      unmatched: g.unmatched.length,
      matchRate:               Number(matchRate.toFixed(3)),
      avgConfidenceMatched:    Number(avgConfMatched.toFixed(3)),
      avgConfidenceUnmatched:  Number(avgConfUnmatched.toFixed(3)),
      calibrationGap:          gap,
      suggestion,
      suggestedDelta:          Number(suggestedDelta.toFixed(3)),
      factType: 'estimate',
    })
  }
  return out.sort((a, b) => Math.abs(b.calibrationGap) - Math.abs(a.calibrationGap))
}

/**
 * Surface calibration findings as meta-chains so operator + drift detector
 * can audit. Returns how many chains were written.
 */
export async function recordCalibrationFindings(workspaceId: string): Promise<{ recorded: number; calibrations: SourceCalibration[] }> {
  const cals = await calibratePerSource(workspaceId)
  let recorded = 0
  for (const c of cals) {
    if (c.suggestion === 'in_band') continue   // no-op
    await recordChain({
      workspaceId,
      kind: 'decision',
      subjectId: `meta-learning:${c.source}`,
      decision: `Calibration: ${c.source} is ${c.suggestion === 'lower_confidence' ? 'OVERCONFIDENT' : 'UNDERCONFIDENT'} (gap=${c.calibrationGap}, n=${c.total}). Suggested confidence delta ${c.suggestedDelta}.`,
      evidence: [
        { type: 'calibration', id: c.source, extract: `matchRate=${c.matchRate}, avgConf=${c.avgConfidenceMatched + c.avgConfidenceUnmatched}/2` },
      ],
      tradeoffs: [
        { name: 'safety',  value: 'no auto-mutation', rationale: 'operator review before global confidence shift' },
      ],
      confidence: c.total >= 30 ? 0.75 : 0.55,
      source: 'meta-learning',
    }).then(() => recorded++).catch(() => null)
  }
  return { recorded, calibrations: cals }
}
