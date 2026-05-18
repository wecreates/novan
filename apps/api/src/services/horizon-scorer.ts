/**
 * horizon-scorer.ts — Tier-2: strategic horizons drive operational priority.
 *
 * Reads active horizons + their objectives, returns a scoring function
 * that the recommendation-engine + autonomous-mind can use to bias
 * picks toward subjects aligned with current goals.
 *
 * Honest: this is keyword-overlap scoring, not deep alignment. Operator
 * writes objectives in natural language; we tokenize them.
 */
import { db } from '../db/client.js'
import { strategicHorizons } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { embed } from './semantic-search.js'

interface ActiveObjective {
  horizonId: string
  horizon:   string
  text:      string
  vector:    number[]
}

let cache: { workspaceId: string; objectives: ActiveObjective[]; expiresAt: number } | null = null
const CACHE_MS = 5 * 60_000

async function loadActive(workspaceId: string): Promise<ActiveObjective[]> {
  if (cache && cache.workspaceId === workspaceId && Date.now() < cache.expiresAt) return cache.objectives
  const rows = await db.select().from(strategicHorizons)
    .where(and(eq(strategicHorizons.workspaceId, workspaceId), eq(strategicHorizons.status, 'active')))
    .catch(() => [])
  const out: ActiveObjective[] = []
  for (const h of rows) {
    const objs = (h.objectives as Array<Record<string, unknown>>) ?? []
    for (const o of objs) {
      const statement = String(o['statement'] ?? '')
      if (!statement) continue
      out.push({
        horizonId: h.id, horizon: h.horizon,
        text:   statement,
        vector: embed(statement),
      })
    }
  }
  cache = { workspaceId, objectives: out, expiresAt: Date.now() + CACHE_MS }
  return out
}

/** Score 0..1 representing how aligned `text` is with active objectives. */
export async function alignmentScore(workspaceId: string, text: string): Promise<{ score: number; matches: Array<{ horizon: string; objective: string; score: number }> }> {
  const objectives = await loadActive(workspaceId)
  if (objectives.length === 0) return { score: 0, matches: [] }
  const v = embed(text)
  let bestScore = 0
  const matches: Array<{ horizon: string; objective: string; score: number }> = []
  for (const o of objectives) {
    // cosine on unit vectors = dot
    let dot = 0
    for (let i = 0; i < v.length; i++) dot += (v[i] ?? 0) * (o.vector[i] ?? 0)
    if (dot > 0.05) matches.push({ horizon: o.horizon, objective: o.text, score: Number(dot.toFixed(4)) })
    if (dot > bestScore) bestScore = dot
  }
  matches.sort((a, b) => b.score - a.score)
  return { score: Number(bestScore.toFixed(4)), matches: matches.slice(0, 3) }
}

/** Invalidate the cache (call after a horizon update). */
export function invalidateAlignmentCache() { cache = null }
