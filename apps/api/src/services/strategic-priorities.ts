/**
 * strategic-priorities.ts — Operator-set priority surfaces over missions.
 *
 * No new schema — leverages strategic_goals.tags as the category axis.
 * Categories: deployment_objective, business_priority, reliability_target,
 *             cost_target, security_priority, roadmap_priority, mission
 *
 * `mission` (default) = general operator goal. Other tags pin the
 * priority to a specific operational domain so trend-analysis,
 * recommendation-engine, and the war-room can filter by domain.
 */
import { db }                          from '../db/client.js'
import { strategicGoals }              from '../db/schema.js'
import { and, desc, eq, sql }          from 'drizzle-orm'

export const PRIORITY_CATEGORIES = [
  'deployment_objective',
  'business_priority',
  'reliability_target',
  'cost_target',
  'security_priority',
  'roadmap_priority',
  'mission',
] as const
export type PriorityCategory = (typeof PRIORITY_CATEGORIES)[number]

export async function listByCategory(workspaceId: string, category?: PriorityCategory) {
  const rows = await db.select().from(strategicGoals)
    .where(and(eq(strategicGoals.workspaceId, workspaceId)))
    .orderBy(desc(strategicGoals.updatedAt))
    .catch(() => [])

  if (!category) return rows
  return rows.filter(r => Array.isArray(r.tags) && r.tags.includes(category))
}

export async function categoryHeatmap(workspaceId: string): Promise<Record<PriorityCategory, { total: number; active: number; completed: number; avgProgress: number }>> {
  const rows = await db.select().from(strategicGoals)
    .where(eq(strategicGoals.workspaceId, workspaceId))
    .catch(() => [])

  const out = {} as Record<PriorityCategory, { total: number; active: number; completed: number; avgProgress: number }>
  for (const c of PRIORITY_CATEGORIES) {
    out[c] = { total: 0, active: 0, completed: 0, avgProgress: 0 }
  }
  for (const r of rows) {
    const tags = (Array.isArray(r.tags) ? r.tags : []) as string[]
    const matched: PriorityCategory[] = []
    for (const c of PRIORITY_CATEGORIES) if (tags.includes(c)) matched.push(c)
    if (matched.length === 0) matched.push('mission')
    for (const c of matched) {
      out[c].total++
      if (r.status === 'active')    out[c].active++
      if (r.status === 'completed') out[c].completed++
      out[c].avgProgress += Number(r.progress ?? 0)
    }
  }
  for (const c of PRIORITY_CATEGORIES) {
    if (out[c].total > 0) out[c].avgProgress = Number((out[c].avgProgress / out[c].total).toFixed(2))
  }
  return out
}

/** Get the dominant priority categories — used to bias recommendations. */
export async function dominantCategories(workspaceId: string): Promise<PriorityCategory[]> {
  const heat = await categoryHeatmap(workspaceId)
  return PRIORITY_CATEGORIES
    .filter(c => heat[c].active > 0)
    .sort((a, b) => heat[b].active - heat[a].active)
    .slice(0, 3)
}

export interface ContinuityHints {
  unresolvedRisks:       Array<{ source: string; description: string; age_days: number }>
  recurringBottlenecks:  Array<{ signature: string; type: string; occurrences: number }>
  longTermTrendNotes:    string[]
}
