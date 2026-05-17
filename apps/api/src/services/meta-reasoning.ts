/**
 * meta-reasoning.ts — Score Novan's own predictions against outcomes.
 *
 * Pure analysis over reasoning_chains. No fabrication: only chains with
 * outcomeKnown=true contribute to accuracy metrics.
 */
import { db }                          from '../db/client.js'
import { reasoningChains }             from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'

const DAY = 24 * 60 * 60_000

export interface AccuracyReport {
  workspaceId:        string
  window:             '7d' | '30d' | 'all_time'
  totalChains:        number
  withKnownOutcome:   number
  matched:            number       // prediction confirmed
  unmatched:          number       // prediction wrong
  matchRate:          number | null
  byKind:             Array<{ kind: string; total: number; matched: number; matchRate: number | null }>
  avgConfidenceMatched:   number | null
  avgConfidenceUnmatched: number | null
  calibrationGap:     number | null   // matched - confidence (close to 0 = well-calibrated)
}

function rate(matched: number, total: number): number | null {
  return total > 0 ? Number((matched / total).toFixed(3)) : null
}

export async function accuracyReport(workspaceId: string, windowMs?: number): Promise<AccuracyReport> {
  const since = windowMs ? Date.now() - windowMs : 0
  const conds = [eq(reasoningChains.workspaceId, workspaceId)]
  if (since > 0) conds.push(gte(reasoningChains.createdAt, since))

  const all = await db.select().from(reasoningChains)
    .where(and(...conds))
    .catch(() => [])

  const known = all.filter(c => c.outcomeKnown && c.outcomeMatched !== null)
  const matched = known.filter(c => c.outcomeMatched === true)
  const unmatched = known.filter(c => c.outcomeMatched === false)

  // Per-kind breakdown
  const byKindMap = new Map<string, { total: number; matched: number }>()
  for (const c of known) {
    const k = c.kind
    const cur = byKindMap.get(k) ?? { total: 0, matched: 0 }
    cur.total++
    if (c.outcomeMatched) cur.matched++
    byKindMap.set(k, cur)
  }

  const avgConf = (rows: typeof known): number | null => {
    const vals = rows.map(r => r.confidence).filter((v): v is number => typeof v === 'number')
    return vals.length > 0 ? Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3)) : null
  }

  const matchRate = rate(matched.length, known.length)
  const avgConfMatched = avgConf(matched)
  const avgConfUnmatched = avgConf(unmatched)

  // Calibration: difference between observed match rate and avg confidence.
  // Negative = overconfident; positive = underconfident.
  const allConf = avgConf(known)
  const calibrationGap = matchRate !== null && allConf !== null
    ? Number((matchRate - allConf).toFixed(3))
    : null

  return {
    workspaceId,
    window: windowMs === undefined ? 'all_time' : windowMs <= 7 * DAY ? '7d' : '30d',
    totalChains: all.length,
    withKnownOutcome: known.length,
    matched: matched.length,
    unmatched: unmatched.length,
    matchRate,
    byKind: [...byKindMap.entries()].map(([kind, v]) => ({
      kind, total: v.total, matched: v.matched, matchRate: rate(v.matched, v.total),
    })),
    avgConfidenceMatched: avgConfMatched,
    avgConfidenceUnmatched: avgConfUnmatched,
    calibrationGap,
  }
}

/** Surface chains where we predicted high confidence but were wrong — biggest learning signal. */
export async function highConfidenceMisses(workspaceId: string, limit = 10) {
  return db.select().from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.outcomeMatched, false),
      sql`${reasoningChains.confidence} >= 0.7`,
    ))
    .orderBy(desc(reasoningChains.createdAt))
    .limit(limit)
    .catch(() => [])
}
