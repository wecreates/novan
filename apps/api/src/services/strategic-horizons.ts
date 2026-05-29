/**
 * strategic-horizons.ts — Tier-2: 90d/1y/3y planning surface.
 *
 * One row = one horizon. Objectives are structured so the recommendation
 * engine and forecasting can read them as targets to align toward.
 *
 * Honest scope: storage + CRUD. Cron-driven review reminders. No LLM
 * generation of objectives — operator writes them.
 */
import { db } from '../db/client.js'
import { strategicHorizons } from '../db/schema.js'
import { and, eq, desc, lte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { notify } from './notifications.js'

export type Horizon = '90d' | '180d' | '1y' | '3y'
export type HorizonStatus = 'active' | 'paused' | 'retired'

export interface Objective {
  id:           string
  statement:    string
  metric:       string
  target:       number | string
  currentValue?: number | string
  status:       'on_track' | 'at_risk' | 'off_track' | 'achieved' | 'abandoned'
  updatedAt?:   number
}

const HORIZON_MS: Record<Horizon, number> = {
  '90d':  90  * 24 * 60 * 60_000,
  '180d': 180 * 24 * 60 * 60_000,
  '1y':   365 * 24 * 60 * 60_000,
  '3y':   3 * 365 * 24 * 60 * 60_000,
}

export interface CreateHorizonInput {
  workspaceId:  string
  horizon:      Horizon
  title:        string
  objectives?:  Objective[]
  constraints?: Array<{ id: string; statement: string }>
  reviewAt?:    number
}

export async function createHorizon(i: CreateHorizonInput): Promise<string> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(strategicHorizons).values({
    id, workspaceId: i.workspaceId,
    horizon: i.horizon, title: i.title,
    objectives:  (i.objectives  ?? []) as unknown as Array<Record<string, unknown>>,
    constraints: (i.constraints ?? []) as unknown as Array<Record<string, unknown>>,
    reviewAt: i.reviewAt ?? (now + Math.min(7 * 24 * 60 * 60_000, HORIZON_MS[i.horizon] / 12)),
    status: 'active',
    createdAt: now, updatedAt: now,
  }).catch((e: Error) => { console.error('[strategic-horizons]', e.message); return null })
  return id
}

export async function updateObjective(workspaceId: string, horizonId: string, objective: Objective): Promise<void> {
  const row = await db.select().from(strategicHorizons)
    .where(and(eq(strategicHorizons.workspaceId, workspaceId), eq(strategicHorizons.id, horizonId)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[strategic-horizons]', e.message); return null })
  if (!row) return
  const objs = (row.objectives as unknown as Objective[]) ?? []
  const idx  = objs.findIndex(o => o.id === objective.id)
  const next = { ...objective, updatedAt: Date.now() }
  if (idx >= 0) objs[idx] = next; else objs.push(next)
  await db.update(strategicHorizons).set({
    objectives: objs as unknown as Array<Record<string, unknown>>, updatedAt: Date.now(),
  }).where(eq(strategicHorizons.id, horizonId)).catch((e: Error) => { console.error('[strategic-horizons]', e.message); return null })
}

export async function listHorizons(workspaceId: string, opts?: { horizon?: Horizon; status?: HorizonStatus }) {
  const conds = [eq(strategicHorizons.workspaceId, workspaceId)]
  if (opts?.horizon) conds.push(eq(strategicHorizons.horizon, opts.horizon))
  if (opts?.status)  conds.push(eq(strategicHorizons.status,  opts.status))
  return db.select().from(strategicHorizons)
    .where(and(...conds))
    .orderBy(desc(strategicHorizons.updatedAt))
    .catch(() => [])
}

export async function setStatus(workspaceId: string, id: string, status: HorizonStatus): Promise<void> {
  await db.update(strategicHorizons).set({ status, updatedAt: Date.now() })
    .where(and(eq(strategicHorizons.workspaceId, workspaceId), eq(strategicHorizons.id, id)))
    .catch((e: Error) => { console.error('[strategic-horizons]', e.message); return null })
}

/** Cron-callable: find horizons whose review_at has passed and notify. */
export async function sweepDueReviews(workspaceId: string): Promise<{ notified: number }> {
  const due = await db.select().from(strategicHorizons)
    .where(and(
      eq(strategicHorizons.workspaceId, workspaceId),
      eq(strategicHorizons.status, 'active'),
      lte(strategicHorizons.reviewAt, Date.now()),
    )).catch(() => [])
  for (const h of due) {
    await notify({
      workspaceId,
      type: 'horizon.review_due',
      title: `Horizon review due: ${h.title} (${h.horizon})`,
      body:  `Objectives: ${((h.objectives as unknown as Objective[]) ?? []).map(o => o.statement).slice(0, 3).join('; ')}`,
      severity: 'normal',
      signature: `horizon:${h.id}:${h.reviewAt}`,
    }).catch((e: Error) => { console.error('[strategic-horizons]', e.message); return null })
    // Push reviewAt forward by 1/12th of horizon to avoid re-notifying
    const horizonMs = HORIZON_MS[h.horizon as Horizon] ?? 90 * 24 * 60 * 60_000
    await db.update(strategicHorizons).set({
      reviewAt: Date.now() + horizonMs / 12, updatedAt: Date.now(),
    }).where(eq(strategicHorizons.id, h.id)).catch((e: Error) => { console.error('[strategic-horizons]', e.message); return null })
  }
  return { notified: due.length }
}
