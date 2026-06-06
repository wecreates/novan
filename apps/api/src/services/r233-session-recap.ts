/**
 * R146.233 — Single op returning everything an operator needs to see
 * what the autonomous capability layer has been doing. Wraps the
 * primitives shipped in R206-R232 and presents one consolidated view.
 */
import { db } from '../db/client.js'
import {
  events, operatorSkills, skillOutcomes, subagentRuns, adversarialVerdicts,
  workspaceMemory, sessionChapters, operatorWorkflowRuns, workflowJournal,
} from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'

export interface SessionRecap {
  windowHours: number
  skillsTotal: number
  skillsActive: number
  brainLoopRuns24h: number
  subagentRuns24h: number
  adversarialVerdicts24h: number
  workflowRuns24h: number
  memoriesTotal: number
  chaptersTotal: number
  recentCycleEvents: Array<{ type: string; count: number }>
  topSkills: Array<{ name: string; uses: number; wins: number; winRate: number }>
  costUsd24h: number
}

export async function sessionRecap(workspaceId: string): Promise<SessionRecap> {
  const since24 = Date.now() - 24 * 60 * 60_000

  // Skills overall
  const [skillTotal] = await db.select({ n: sql<number>`count(*)::int` })
    .from(operatorSkills).where(eq(operatorSkills.workspaceId, workspaceId))
  const [skillActive] = await db.select({ n: sql<number>`count(*)::int` })
    .from(operatorSkills).where(and(eq(operatorSkills.workspaceId, workspaceId), sql`${operatorSkills.uses} > 0`))

  // Top 5 skills by wins (then uses tie-breaker)
  const topSkills = await db.select({
    name: operatorSkills.name, uses: operatorSkills.uses, wins: operatorSkills.wins,
  }).from(operatorSkills).where(eq(operatorSkills.workspaceId, workspaceId))
    .orderBy(desc(operatorSkills.wins), desc(operatorSkills.uses)).limit(5)

  // Outcome / sub-agent / verdict counts in last 24h
  const [outcomes24] = await db.select({ n: sql<number>`count(*)::int` })
    .from(skillOutcomes).where(and(eq(skillOutcomes.workspaceId, workspaceId), gte(skillOutcomes.createdAt, since24)))
  const [sub24] = await db.select({ n: sql<number>`count(*)::int` })
    .from(subagentRuns).where(and(eq(subagentRuns.workspaceId, workspaceId), gte(subagentRuns.startedAt, since24)))
  const [adv24] = await db.select({ n: sql<number>`count(*)::int` })
    .from(adversarialVerdicts).where(and(eq(adversarialVerdicts.workspaceId, workspaceId), gte(adversarialVerdicts.createdAt, since24)))
  const [wf24] = await db.select({ n: sql<number>`count(*)::int` })
    .from(operatorWorkflowRuns).where(and(eq(operatorWorkflowRuns.workspaceId, workspaceId), gte(operatorWorkflowRuns.startedAt, since24)))

  // Memory + chapters totals
  const [mTotal] = await db.select({ n: sql<number>`count(*)::int` })
    .from(workspaceMemory).where(eq(workspaceMemory.workspaceId, workspaceId))
  const [cTotal] = await db.select({ n: sql<number>`count(*)::int` })
    .from(sessionChapters).where(eq(sessionChapters.workspaceId, workspaceId))

  // Cron + applier events in last 6h
  const since6 = Date.now() - 6 * 60 * 60_000
  const cycleRows = await db.select({ type: events.type, n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(
      sql`(${events.type} LIKE 'applier.%' OR ${events.type} LIKE 'cron.%')`,
      gte(events.createdAt, since6),
    ))
    .groupBy(events.type)
    .orderBy(desc(sql`count(*)`))

  // 24h cost
  const [cost] = await db.select({
    usd: sql<number>`COALESCE(SUM(${subagentRuns.costUsd}), 0)::float`,
  }).from(subagentRuns)
    .where(and(eq(subagentRuns.workspaceId, workspaceId), gte(subagentRuns.startedAt, since24)))

  // Avoid unused-import warning on workflowJournal (kept for future drift checks)
  void workflowJournal

  return {
    windowHours: 24,
    skillsTotal:  Number(skillTotal?.n ?? 0),
    skillsActive: Number(skillActive?.n ?? 0),
    brainLoopRuns24h: Number(outcomes24?.n ?? 0),
    subagentRuns24h:  Number(sub24?.n ?? 0),
    adversarialVerdicts24h: Number(adv24?.n ?? 0),
    workflowRuns24h:  Number(wf24?.n ?? 0),
    memoriesTotal:    Number(mTotal?.n ?? 0),
    chaptersTotal:    Number(cTotal?.n ?? 0),
    recentCycleEvents: cycleRows.map(r => ({ type: r.type, count: Number(r.n) })),
    topSkills: topSkills.map(s => ({
      name: s.name, uses: s.uses, wins: s.wins,
      winRate: s.uses > 0 ? Number((s.wins / s.uses).toFixed(3)) : 0,
    })),
    costUsd24h: Number((cost?.usd ?? 0).toFixed(4)),
  }
}
