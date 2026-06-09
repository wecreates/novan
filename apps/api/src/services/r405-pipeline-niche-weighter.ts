/**
 * R405 — Pipeline niche-weight recommender.
 *
 * Given R404 niche performance, recommends per-niche generation counts for
 * the next trend pipeline run. Niches with higher winner_rate get more
 * generations. New niches (winner_rate not yet computable due to no
 * uploads) get a small exploration budget.
 *
 * Returns Record<niche, recommendedCount>. Total budget is the sum of
 * `total` param. Distribution uses weighted softmax over winnerRate.
 */
import { rankNichePerformance } from './r404-niche-performance.js'

const NEW_NICHE_EXPLORATION_FLOOR = 1
const KNOWN_NICHES = ['botanical', 'vintage', 'darkacademia', 'cottagecore', 'astrology', 'mycology']

function softmax(weights: number[], temperature = 1): number[] {
  const max = Math.max(...weights, 0)
  const exps = weights.map(w => Math.exp((w - max) / temperature))
  const sum = exps.reduce((a, b) => a + b, 0)
  return sum === 0 ? exps.map(() => 1 / exps.length) : exps.map(e => e / sum)
}

export interface NicheWeightInput {
  workspaceId:    string
  totalBudget?:   number     // default 10
}

export interface NicheWeightResult {
  recommendations: Array<{ niche: string; recommendedCount: number; winnerRate: number; reason: string }>
  totalBudget:     number
}

export async function recommendNicheWeights(input: NicheWeightInput): Promise<NicheWeightResult> {
  const totalBudget = Math.max(3, Math.min(50, input.totalBudget ?? 10))
  const perf = await rankNichePerformance(input.workspaceId)
  const observed = new Map(perf.niches.map(n => [n.niche, n]))

  // Two-bucket allocation:
  // 70% of budget to PROVEN niches (have winners), weighted by winner_rate
  // 30% to EXPLORATION (new niches we haven't tried, or low-data niches)
  const provenBudget = Math.round(totalBudget * 0.7)
  const explorationBudget = totalBudget - provenBudget

  const proven = perf.niches.filter(n => n.winnerCount > 0)
  const recommendations: NicheWeightResult['recommendations'] = []

  if (proven.length > 0) {
    const weights = proven.map(n => n.winnerRate * 10 + n.totalUsd * 0.1)
    const dist = softmax(weights, 1)
    for (let i = 0; i < proven.length; i++) {
      const n = proven[i]!
      const count = Math.max(1, Math.round(provenBudget * dist[i]!))
      recommendations.push({
        niche: n.niche,
        recommendedCount: count,
        winnerRate: n.winnerRate,
        reason: `proven niche (${n.winnerCount}/${n.designCount} winners, $${n.totalUsd})`,
      })
    }
  }

  // Exploration: niches we haven't tried + niches with 0 winners but recent uploads
  const explored = new Set(perf.niches.map(n => n.niche))
  const unexplored = KNOWN_NICHES.filter(n => !explored.has(n))
  const allExploration = [
    ...unexplored.map(n => ({ niche: n, reason: 'unexplored niche' })),
    ...perf.niches.filter(n => n.winnerCount === 0 && n.uploadCount > 0)
      .map(n => ({ niche: n.niche, reason: `${n.uploadCount} uploads, 0 winners yet` })),
  ]
  if (allExploration.length > 0) {
    const each = Math.max(NEW_NICHE_EXPLORATION_FLOOR, Math.floor(explorationBudget / allExploration.length))
    for (const e of allExploration.slice(0, explorationBudget)) {
      recommendations.push({
        niche: e.niche,
        recommendedCount: each,
        winnerRate: observed.get(e.niche)?.winnerRate ?? 0,
        reason: e.reason,
      })
    }
  }

  return { recommendations, totalBudget }
}
