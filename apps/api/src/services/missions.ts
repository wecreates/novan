/**
 * missions.ts — Operator missions/goals layer over the existing
 * strategic_goals table. No new schema.
 *
 * Mission = strategic_goal with horizon ∈ {sprint|quarter|year}.
 */
import { db }                          from '../db/client.js'
import { strategicGoals, events }      from '../db/schema.js'
import { and, asc, eq, sql }           from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

// Map to the existing `goal_status` Postgres enum: draft|active|paused|completed|abandoned
export type MissionStatus = 'draft' | 'active' | 'paused' | 'completed' | 'abandoned'

export interface CreateMissionInput {
  workspaceId:    string
  title:          string
  description?:   string
  horizon?:       'sprint' | 'quarter' | 'year'
  targetDate?:    number
  keyResults?:    Array<{ text: string; done?: boolean }>
  owners?:        string[]
  tags?:          string[]
  parentGoalId?:  string
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'missions', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[missions]', e.message); return null })
}

export async function createMission(i: CreateMissionInput): Promise<string> {
  const id  = uuidv7()
  const now = Date.now()
  await db.insert(strategicGoals).values({
    id, workspaceId: i.workspaceId,
    title:       i.title.slice(0, 300),
    description: i.description ?? null,
    status:      'active',
    horizon:     i.horizon ?? 'quarter',
    targetDate:  i.targetDate ?? null,
    progress:    0,
    keyResults:  i.keyResults ?? [],
    owners:      i.owners ?? [],
    tags:        i.tags ?? [],
    parentGoalId: i.parentGoalId ?? null,
    businessId:  null,
    createdAt:   now, updatedAt: now,
  })
  await emit(i.workspaceId, 'mission.created', { id, title: i.title })
  return id
}

export async function listMissions(workspaceId: string, opts?: { status?: MissionStatus }) {
  const conds = [eq(strategicGoals.workspaceId, workspaceId)]
  if (opts?.status) conds.push(eq(strategicGoals.status, opts.status))
  return db.select().from(strategicGoals)
    .where(and(...conds))
    .orderBy(asc(strategicGoals.targetDate), asc(strategicGoals.createdAt))
}

export async function updateMissionStatus(id: string, workspaceId: string, status: MissionStatus) {
  const completedAt = status === 'completed' ? Date.now() : null
  await db.update(strategicGoals)
    .set({ status, completedAt, updatedAt: Date.now() })
    .where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))
  await emit(workspaceId, 'mission.status_changed', { id, status })
}

export async function setMissionProgress(id: string, workspaceId: string, progress: number) {
  const clamped = Math.max(0, Math.min(1, progress))
  await db.update(strategicGoals)
    .set({ progress: clamped, updatedAt: Date.now() })
    .where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))
}

export async function getMission(id: string) {
  return db.select().from(strategicGoals).where(eq(strategicGoals.id, id)).limit(1).then(r => r[0] ?? null)
}

export async function activeMissionSummary(workspaceId: string) {
  const rows = await db.select({
    horizon: strategicGoals.horizon,
    status:  strategicGoals.status,
    c:       sql<number>`count(*)::int`,
  }).from(strategicGoals)
    .where(eq(strategicGoals.workspaceId, workspaceId))
    .groupBy(strategicGoals.horizon, strategicGoals.status)
  return rows.map(r => ({ horizon: r.horizon, status: r.status, count: Number(r.c) }))
}
