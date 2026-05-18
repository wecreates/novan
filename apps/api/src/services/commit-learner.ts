/**
 * commit-learner.ts — Links code commits to subsequent outcomes.
 *
 * For each captured snapshot whose committedAt is in the window
 * [now - 14d, now - 1d] (i.e. enough time has passed to observe outcome):
 *   - Count incidents opened AFTER the commit, within horizonDays
 *   - Count drift warnings created AFTER the commit, within horizonDays
 *   - Compare match rate of chains created before vs after commit
 *   - Verdict: regression | neutral | positive
 *
 * Idempotent via UNIQUE(workspace_id, git_sha).
 */
import { db } from '../db/client.js'
import { codeStateSnapshots, commitOutcomes, incidents, driftWarnings, reasoningChains } from '../db/schema.js'
import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const HORIZON_DAYS = 7

export async function linkCommitsToOutcomes(workspaceId: string): Promise<{ evaluated: number; regressions: number; positives: number; neutrals: number }> {
  const now = Date.now()
  const minAge = now - 14 * 24 * 60 * 60_000   // commits older than 14d skip (already evaluated)
  const minHorizon = now - (HORIZON_DAYS + 1) * 24 * 60 * 60_000  // need ≥horizon+1 days

  const snapshots = await db.select().from(codeStateSnapshots)
    .where(and(
      eq(codeStateSnapshots.workspaceId, workspaceId),
      gte(codeStateSnapshots.committedAt, minAge),
      lt(codeStateSnapshots.committedAt,  minHorizon),
    ))
    .catch(() => [])

  let evaluated = 0, regressions = 0, positives = 0, neutrals = 0
  for (const snap of snapshots) {
    // Skip if already evaluated
    const existing = await db.select({ id: commitOutcomes.id }).from(commitOutcomes)
      .where(and(eq(commitOutcomes.workspaceId, workspaceId), eq(commitOutcomes.gitSha, snap.gitSha)))
      .limit(1).then(r => r[0]).catch(() => null)
    if (existing) continue

    const windowStart = snap.committedAt
    const windowEnd   = snap.committedAt + HORIZON_DAYS * 24 * 60 * 60_000

    const [incCount, driftCount, beforeChains, afterChains] = await Promise.all([
      db.select({ n: sql<number>`count(*)::int` }).from(incidents)
        .where(and(eq(incidents.workspaceId, workspaceId), gte(incidents.createdAt, windowStart), lt(incidents.createdAt, windowEnd)))
        .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
      db.select({ n: sql<number>`count(*)::int` }).from(driftWarnings)
        .where(and(eq(driftWarnings.workspaceId, workspaceId), gte(driftWarnings.createdAt, windowStart), lt(driftWarnings.createdAt, windowEnd)))
        .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
      chainStats(workspaceId, windowStart - HORIZON_DAYS * 24 * 60 * 60_000, windowStart),
      chainStats(workspaceId, windowStart, windowEnd),
    ])

    const baselineMatch = beforeChains.decided > 0 ? beforeChains.matched / beforeChains.decided : null
    const afterMatch    = afterChains.decided  > 0 ? afterChains.matched  / afterChains.decided  : null
    const matchRateDelta = (baselineMatch !== null && afterMatch !== null)
      ? Number((afterMatch - baselineMatch).toFixed(3)) : null

    let verdict: 'positive' | 'neutral' | 'regression' = 'neutral'
    const notes: string[] = []
    if (incCount > beforeChains.incCount + 1) {
      verdict = 'regression'
      notes.push(`incidents rose: ${beforeChains.incCount}→${incCount} in ${HORIZON_DAYS}d window`)
    }
    if (driftCount > 3) {
      verdict = 'regression'
      notes.push(`${driftCount} drift warnings after commit`)
    }
    if (matchRateDelta !== null && matchRateDelta < -0.10) {
      verdict = 'regression'
      notes.push(`match-rate dropped ${(matchRateDelta * 100).toFixed(0)}%`)
    }
    if (verdict === 'neutral' && matchRateDelta !== null && matchRateDelta > 0.10) {
      verdict = 'positive'
      notes.push(`match-rate improved ${(matchRateDelta * 100).toFixed(0)}%`)
    }
    if (verdict === 'neutral' && incCount === 0 && driftCount === 0) {
      notes.push('clean window — no incidents, no drift')
    }

    await db.insert(commitOutcomes).values({
      id: uuidv7(), workspaceId,
      gitSha: snap.gitSha,
      evaluatedAt: Date.now(), horizonDays: HORIZON_DAYS,
      incidentsAfter: incCount,
      driftWarningsAfter: driftCount,
      matchRateDelta,
      verdict, notes,
    }).onConflictDoNothing().catch(() => null)

    evaluated++
    if (verdict === 'regression') regressions++
    else if (verdict === 'positive') positives++
    else neutrals++
  }
  return { evaluated, regressions, positives, neutrals }
}

async function chainStats(workspaceId: string, start: number, end: number) {
  const rows = await db.select().from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      gte(reasoningChains.createdAt, start),
      lt(reasoningChains.createdAt, end),
    )).catch(() => [])
  let matched = 0, unmatched = 0
  for (const r of rows) {
    if (!r.outcomeKnown) continue
    if (r.outcomeMatched === true)  matched++
    if (r.outcomeMatched === false) unmatched++
  }
  return { matched, unmatched, decided: matched + unmatched, incCount: 0 }   // incCount unused but typed
}

export async function recentCommitOutcomes(workspaceId: string, limit = 20) {
  return db.select().from(commitOutcomes)
    .where(eq(commitOutcomes.workspaceId, workspaceId))
    .orderBy(sql`${commitOutcomes.evaluatedAt} desc`)
    .limit(limit).catch(() => [])
}
