/**
 * memory-compression.ts — Relevance-ranked + decay-aware memory access.
 *
 * Wraps the strategic-memory tables with:
 *   - decay:  older entries lose priority unless reinforced (occurrence,
 *             applied count)
 *   - relevance ranking by tag/category match against active missions
 *   - mission-centric retrieval (return memory items most aligned with
 *             a given mission)
 *
 * No new schema. Pure ranking over existing rows.
 */
import { db }                          from '../db/client.js'
import {
  successfulFixes, failureMemory, strategicGoals,
} from '../db/schema.js'
import { and, desc, eq }               from 'drizzle-orm'

const DAY = 24 * 60 * 60_000
const DECAY_HALF_LIFE_DAYS = 30

/** Exponential decay: weight = 0.5 ^ (age_days / half_life). */
function decay(ageDays: number): number {
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS)
}

function ageDays(ts: number | null | undefined): number {
  if (!ts) return 9999
  return Math.max(0, (Date.now() - ts) / DAY)
}

export interface RankedMemoryItem {
  kind:       'successful_fix' | 'failure_pattern'
  id:         string
  text:       string
  reinforcement: number  // success_count or occurrence_count
  ageDays:    number
  decayWeight: number    // 0..1
  relevanceScore: number // decayWeight * reinforcement
  matchedTags?: string[]
}

/** Return top N memory items ranked by decay × reinforcement, optionally filtered by tag match. */
export async function rankedMemory(workspaceId: string, opts?: { limit?: number; missionTags?: string[] }): Promise<RankedMemoryItem[]> {
  const limit = opts?.limit ?? 20
  const missionTags = (opts?.missionTags ?? []).map(t => t.toLowerCase())

  const [fixes, failures] = await Promise.all([
    db.select().from(successfulFixes).where(eq(successfulFixes.workspaceId, workspaceId)).catch(() => []),
    db.select().from(failureMemory).where(eq(failureMemory.workspaceId, workspaceId)).catch(() => []),
  ])

  const out: RankedMemoryItem[] = []

  for (const f of fixes) {
    const age = ageDays(f.lastAppliedAt ? Number(f.lastAppliedAt) : Number(f.createdAt ?? 0))
    const w = decay(age)
    const reinforce = Number(f.successCount ?? 0)
    const text = `${String(f.fixDescription ?? '').slice(0, 200)} (for: ${String(f.failureSignature ?? '').slice(0, 80)})`
    const matched = missionTags.length === 0 ? undefined :
      missionTags.filter(t => text.toLowerCase().includes(t))
    const tagBoost = matched && matched.length > 0 ? 1.5 : 1
    out.push({
      kind: 'successful_fix', id: f.id,
      text, reinforcement: reinforce,
      ageDays: Number(age.toFixed(1)),
      decayWeight: Number(w.toFixed(3)),
      relevanceScore: Number((w * reinforce * tagBoost).toFixed(3)),
      ...(matched !== undefined ? { matchedTags: matched } : {}),
    })
  }

  for (const f of failures) {
    const age = ageDays(f.lastSeenAt ? Number(f.lastSeenAt) : Number(f.firstSeenAt ?? 0))
    const w = decay(age)
    const reinforce = Number(f.occurrenceCount ?? 0)
    const text = `${String(f.failureType ?? '')}: ${String(f.signature ?? '').slice(0, 200)}`
    const matched = missionTags.length === 0 ? undefined :
      missionTags.filter(t => text.toLowerCase().includes(t))
    const tagBoost = matched && matched.length > 0 ? 1.5 : 1
    out.push({
      kind: 'failure_pattern', id: f.id,
      text, reinforcement: reinforce,
      ageDays: Number(age.toFixed(1)),
      decayWeight: Number(w.toFixed(3)),
      relevanceScore: Number((w * reinforce * tagBoost).toFixed(3)),
      ...(matched !== undefined ? { matchedTags: matched } : {}),
    })
  }

  out.sort((a, b) => b.relevanceScore - a.relevanceScore)
  return out.slice(0, limit)
}

/** Mission-centric retrieval — pull memory most relevant to one mission. */
export async function missionMemory(workspaceId: string, missionId: string, limit = 10): Promise<{ mission: { id: string; title: string; tags: string[] } | null; memory: RankedMemoryItem[] }> {
  const mission = await db.select().from(strategicGoals)
    .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.id, missionId)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[memory-compression]', e.message); return null })
  if (!mission) return { mission: null, memory: [] }

  const tags = (Array.isArray(mission.tags) ? mission.tags : []) as string[]
  // Also pull keywords from the title (split on non-word, filter short)
  const titleWords = String(mission.title ?? '').toLowerCase().split(/\W+/).filter(w => w.length >= 4)
  const allTags = [...new Set([...tags, ...titleWords])]

  const memory = await rankedMemory(workspaceId, { limit, missionTags: allTags })
  return {
    mission: { id: mission.id, title: String(mission.title ?? ''), tags: [...tags] },
    memory,
  }
}

/** Stale-memory prune candidates — items below threshold for cleanup review. */
export async function prunableMemory(workspaceId: string, opts?: { decayThreshold?: number; minReinforcement?: number }): Promise<RankedMemoryItem[]> {
  const decayMin = opts?.decayThreshold   ?? 0.05  // ~130 days old by default
  const reMin    = opts?.minReinforcement ?? 1
  const ranked = await rankedMemory(workspaceId, { limit: 500 })
  return ranked.filter(r => r.decayWeight < decayMin && r.reinforcement <= reMin)
}
