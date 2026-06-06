/**
 * R146.243 — Skill prompt evolution. When a skill's win rate drops
 * below a threshold over its last N uses, spawn an LLM rewrite of
 * the instructions and bump the version. Older versions are not
 * preserved (the bandit auto-prunes via Thompson) — but the outcome
 * ledger keeps audit trail.
 *
 * Trigger: cron tick reads skills with uses ≥ MIN_USES, win rate <
 * LOSING_THRESHOLD over the last N outcomes. Skips skills marked
 * with frozen:true in the meta column (future).
 */
import { db } from '../db/client.js'
import { operatorSkills, skillOutcomes } from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { spawnSubagent } from './r208-subagent.js'

const MIN_USES = 10
const LOSING_THRESHOLD = 0.4
const RECENT_N = 10
const COOLDOWN_MS = 24 * 60 * 60_000  // don't re-evolve same skill within 24h

interface EvolveCandidate {
  name:         string
  description:  string
  instructions: string
  uses:         number
  wins:         number
  recentLossRate: number
  updatedAt:    number
}

async function findCandidates(workspaceId: string): Promise<EvolveCandidate[]> {
  const skills = await db.select().from(operatorSkills)
    .where(and(
      eq(operatorSkills.workspaceId, workspaceId),
      gte(operatorSkills.uses, MIN_USES),
    )).catch(() => [])
  const candidates: EvolveCandidate[] = []
  const now = Date.now()
  for (const s of skills) {
    if (now - s.updatedAt < COOLDOWN_MS) continue
    const overallRate = s.wins / s.uses
    // Quick filter — if overall is healthy, skip
    if (overallRate >= LOSING_THRESHOLD * 1.5) continue
    // Recent outcomes
    const recent = await db.select({ won: skillOutcomes.won })
      .from(skillOutcomes)
      .where(and(
        eq(skillOutcomes.workspaceId, workspaceId),
        eq(skillOutcomes.skillName, s.name),
      ))
      .orderBy(desc(skillOutcomes.createdAt))
      .limit(RECENT_N)
      .catch(() => [])
    if (recent.length < Math.min(RECENT_N, 5)) continue
    const recentLosses = recent.filter(r => r.won === false).length
    const recentLossRate = recentLosses / recent.length
    if (recentLossRate <= 1 - LOSING_THRESHOLD) continue
    candidates.push({
      name: s.name, description: s.description, instructions: s.instructions,
      uses: s.uses, wins: s.wins, recentLossRate, updatedAt: s.updatedAt,
    })
  }
  return candidates
}

async function rewriteInstructions(workspaceId: string, c: EvolveCandidate): Promise<string | null> {
  const prompt =
    `You're improving a skill that has been losing too often.\n\n` +
    `Skill: ${c.name}\n` +
    `Description: ${c.description}\n` +
    `Current instructions:\n"""\n${c.instructions}\n"""\n\n` +
    `Recent stats: ${c.uses} total uses, ${c.wins} wins (${(c.wins/c.uses*100).toFixed(0)}% overall). ` +
    `Last ${RECENT_N} runs: ${(c.recentLossRate*100).toFixed(0)}% loss rate.\n\n` +
    `Rewrite the instructions to be MORE SPECIFIC, MORE ACTIONABLE, and MORE DEFENSIVE. ` +
    `Common failure modes to address: assumes a tool exists when it doesn't, hallucinated brain op names, ` +
    `over-broad reply that doesn't surface concrete numbers. Keep the same skill scope (don't ` +
    `change what it does). Return the new instructions text only — no preamble.`
  const r = await spawnSubagent(workspaceId, {
    parentOp: 'skill.evolve',
    task: 'reasoning',
    prompt,
    maxOutputTokens: 1500,
  })
  if (r.error || !r.text || r.text.length < 50) return null
  return r.text.trim()
}

export async function evolveLosingSkills(workspaceId: string): Promise<{ evolved: number; candidates: number; details: Array<{ name: string; oldVersion: number; newVersion: number }> }> {
  const candidates = await findCandidates(workspaceId)
  const details: Array<{ name: string; oldVersion: number; newVersion: number }> = []
  for (const c of candidates) {
    const newInstr = await rewriteInstructions(workspaceId, c).catch(() => null)
    if (!newInstr) continue
    const [updated] = await db.update(operatorSkills)
      .set({
        instructions: newInstr,
        version: sql`${operatorSkills.version} + 1`,
        updatedAt: Date.now(),
        // Reset wins/uses so the bandit retries from scratch on the new prompt.
        // The skill_outcomes ledger keeps the history.
        wins: 0,
        uses: 0,
      })
      .where(and(eq(operatorSkills.workspaceId, workspaceId), eq(operatorSkills.name, c.name)))
      .returning({ version: operatorSkills.version })
      .catch(() => [])
    if (updated) {
      details.push({ name: c.name, oldVersion: updated.version - 1, newVersion: updated.version })
    }
  }
  return { evolved: details.length, candidates: candidates.length, details }
}
