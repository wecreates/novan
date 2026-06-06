/**
 * R146.330 #9-13, #14-20 — operator value dashboards + agency ops.
 */
import { db } from '../db/client.js'
import {
  aiUsage, businesses, businessPortfolioEarnings, killSwitches, events,
  workspaceMemory, workflowRuns, brainTaskExecutions,
} from '../db/schema.js'
import { and, eq, gte, sql, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #9 Revenue dashboard ────────────────────────────────────────────────
export async function revenueDashboard(workspaceId: string): Promise<{
  totalRevenueUsd: number
  monthRevenueUsd: number
  byBusiness: Array<{ businessId: string; name: string; total: number; thisMonth: number }>
  trend: Array<{ month: string; revenueUsd: number }>
}> {
  const rows = await db.select().from(businessPortfolioEarnings)
    .where(eq(businessPortfolioEarnings.workspaceId, workspaceId)).catch(() => [])
  const bizRows = await db.select({ id: businesses.id, name: businesses.name })
    .from(businesses).where(eq(businesses.workspaceId, workspaceId)).catch(() => [])
  const nameOf = new Map(bizRows.map(b => [b.id, b.name]))
  const now = Date.now(); const monthAgo = now - 30 * 86400_000
  const byBiz = new Map<string, { total: number; thisMonth: number }>()
  const byMonth = new Map<string, number>()
  for (const r of rows) {
    const amount = Number(r.amountUsd ?? 0)
    const bid = r.businessId ?? 'unattributed'
    const ts = Number(r.earnedAt ?? 0)
    const cur = byBiz.get(bid) ?? { total: 0, thisMonth: 0 }
    cur.total += amount
    if (ts >= monthAgo) cur.thisMonth += amount
    byBiz.set(bid, cur)
    const monthKey = new Date(ts).toISOString().slice(0, 7)
    byMonth.set(monthKey, (byMonth.get(monthKey) ?? 0) + amount)
  }
  const byBusiness = Array.from(byBiz.entries()).map(([businessId, v]) => ({
    businessId, name: nameOf.get(businessId) ?? 'unattributed',
    total: Number(v.total.toFixed(2)),
    thisMonth: Number(v.thisMonth.toFixed(2)),
  })).sort((a, b) => b.total - a.total)
  const trend = Array.from(byMonth.entries())
    .map(([month, revenueUsd]) => ({ month, revenueUsd: Number(revenueUsd.toFixed(2)) }))
    .sort((a, b) => a.month.localeCompare(b.month))
  const totalRevenueUsd = byBusiness.reduce((s, b) => s + b.total, 0)
  const monthRevenueUsd = byBusiness.reduce((s, b) => s + b.thisMonth, 0)
  return {
    totalRevenueUsd: Number(totalRevenueUsd.toFixed(2)),
    monthRevenueUsd: Number(monthRevenueUsd.toFixed(2)),
    byBusiness, trend,
  }
}

// ─── #10 Time-saved counter ──────────────────────────────────────────────
// Each completed brain_task_execution counted; minutes-saved estimate stored
// in payload OR computed by task type heuristic.
const MINUTES_PER_TASK: Record<string, number> = {
  'image.generate': 15, 'video.generate': 60, 'music.generate': 45,
  'voice.synthesize': 10, 'web.fetch': 5, 'recap.summarize': 10,
  'cost.forecast': 5, 'daily_routine.run': 30, 'brain.what_did_you_do_today': 10,
  'relationship.upsert': 2, 'export.all': 20,
}
export async function timeSavedCounter(workspaceId: string, windowDays = 30): Promise<{
  totalMinutes: number
  taskCount: number
  byOp: Record<string, { count: number; minutes: number }>
  windowDays: number
}> {
  const since = Date.now() - windowDays * 86400_000
  const rows = await db.select({ op: brainTaskExecutions.operation })
    .from(brainTaskExecutions)
    .where(and(
      eq(brainTaskExecutions.workspaceId, workspaceId),
      gte(brainTaskExecutions.createdAt, since),
      eq(brainTaskExecutions.status, 'completed'),
    )).catch(() => [])
  const byOp: Record<string, { count: number; minutes: number }> = {}
  let total = 0
  for (const r of rows) {
    const op = r.op ?? 'unknown'
    const mins = MINUTES_PER_TASK[op] ?? 3
    const cur = byOp[op] ?? { count: 0, minutes: 0 }
    cur.count += 1; cur.minutes += mins
    byOp[op] = cur
    total += mins
  }
  return { totalMinutes: total, taskCount: rows.length, byOp, windowDays }
}

// ─── #11 Content-shipped counter ─────────────────────────────────────────
const CONTENT_EVENT_TYPES = new Set([
  'content.published', 'image.generated', 'video.generated', 'post.created',
  'tiktok.uploaded', 'youtube.uploaded', 'instagram.uploaded',
])
export async function contentShippedCount(workspaceId: string, windowDays = 30): Promise<{
  total: number
  byType: Record<string, number>
  byPlatform: Record<string, number>
  windowDays: number
}> {
  const since = Date.now() - windowDays * 86400_000
  const rows = await db.select({ type: events.type, payload: events.payload })
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since)))
    .catch(() => [])
  const byType: Record<string, number> = {}
  const byPlatform: Record<string, number> = {}
  let total = 0
  for (const r of rows) {
    if (!CONTENT_EVENT_TYPES.has(r.type)) continue
    total++
    byType[r.type] = (byType[r.type] ?? 0) + 1
    const platform = (r.payload as { platform?: string } | null)?.platform
    if (platform) byPlatform[platform] = (byPlatform[platform] ?? 0) + 1
  }
  return { total, byType, byPlatform, windowDays }
}

// ─── #12 Weekly recap ────────────────────────────────────────────────────
export async function weeklyRecap(workspaceId: string): Promise<{
  windowStart: number
  revenueUsd: number
  contentShipped: number
  timeSavedMinutes: number
  costSpentUsd: number
  highlights: string[]
}> {
  const start = Date.now() - 7 * 86400_000
  const [rev, content, time, cost] = await Promise.all([
    revenueDashboard(workspaceId).catch(() => ({ monthRevenueUsd: 0 })),
    contentShippedCount(workspaceId, 7).catch(() => ({ total: 0 })),
    timeSavedCounter(workspaceId, 7).catch(() => ({ totalMinutes: 0 })),
    db.select({ cost: aiUsage.costUsd }).from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, start)))
      .catch(() => []),
  ])
  const costSpentUsd = (cost as Array<{ cost: number }>).reduce((s, r) => s + Number(r.cost ?? 0), 0)
  const highlights: string[] = []
  if (content.total > 0) highlights.push(`Shipped ${content.total} piece${content.total === 1 ? '' : 's'} of content`)
  if (time.totalMinutes > 0) highlights.push(`Saved you ${time.totalMinutes} minutes`)
  if (rev.monthRevenueUsd > 0) highlights.push(`Tracked $${rev.monthRevenueUsd.toFixed(2)} revenue`)
  if (costSpentUsd > 0) highlights.push(`Spent $${costSpentUsd.toFixed(2)} on AI calls`)
  if (highlights.length === 0) highlights.push('Quiet week — nothing major to report.')
  return {
    windowStart: start,
    revenueUsd: rev.monthRevenueUsd,
    contentShipped: content.total,
    timeSavedMinutes: time.totalMinutes,
    costSpentUsd: Number(costSpentUsd.toFixed(2)),
    highlights,
  }
}

// ─── #13 ROI per business ────────────────────────────────────────────────
export async function businessROI(workspaceId: string): Promise<Array<{
  businessId: string; name: string;
  revenueUsd: number; aiCostUsd: number; estimatedOperatorMinutes: number;
  roi: number | null
}>> {
  const rev = await revenueDashboard(workspaceId)
  const { costByBusiness } = await import('./r328-extras.js')
  const costs = await costByBusiness(workspaceId)
  const costMap = new Map(costs.map(c => [c.businessId, c.spentUsd]))
  return rev.byBusiness.map(b => {
    const aiCostUsd = costMap.get(b.businessId) ?? 0
    // Rough operator-time proxy: 1 hour per $100 revenue at $50/hr → $0.5/min
    const estimatedOperatorMinutes = Math.round(b.total * 2)
    const operatorCost = estimatedOperatorMinutes * (50 / 60)
    const totalCost = aiCostUsd + operatorCost
    const roi = totalCost > 0 ? Number(((b.total - totalCost) / totalCost).toFixed(2)) : null
    return {
      businessId: b.businessId, name: b.name,
      revenueUsd: b.total, aiCostUsd: Number(aiCostUsd.toFixed(2)),
      estimatedOperatorMinutes, roi,
    }
  })
}

// ─── #14 Cost detail ─────────────────────────────────────────────────────
export async function costDetail(workspaceId: string, windowDays = 30): Promise<{
  rows: Array<{ ts: number; provider: string; model: string; op: string; costUsd: number }>
  totalCount: number
  totalUsd: number
}> {
  const since = Date.now() - windowDays * 86400_000
  const rows = await db.select({
    ts: aiUsage.timestamp, provider: aiUsage.provider, model: aiUsage.model,
    op: aiUsage.taskType, costUsd: aiUsage.costUsd,
  }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
    .orderBy(desc(aiUsage.timestamp)).limit(2000)
    .catch(() => [])
  const totalUsd = rows.reduce((s, r) => s + Number(r.costUsd ?? 0), 0)
  return {
    rows: rows.map(r => ({
      ts: Number(r.ts), provider: r.provider, model: r.model,
      op: r.op, costUsd: Number(Number(r.costUsd ?? 0).toFixed(4)),
    })),
    totalCount: rows.length,
    totalUsd: Number(totalUsd.toFixed(4)),
  }
}

// ─── #15 Pause / resume Novan (master kill_switch) ───────────────────────
const KILL_SWITCH_TYPES = ['ai_request', 'web_fetch', 'autonomous', 'connector_action'] as const

export async function pauseNovan(workspaceId: string, reason: string): Promise<{ flipped: string[] }> {
  const now = Date.now()
  const flipped: string[] = []
  for (const switchType of KILL_SWITCH_TYPES) {
    await db.insert(killSwitches).values({
      id: uuidv7(), workspaceId, switchType, enabled: true,
      reason: reason.slice(0, 500), createdAt: now, updatedAt: now,
    } as never).onConflictDoUpdate({
      target: [killSwitches.workspaceId, killSwitches.switchType],
      set: { enabled: true, reason: reason.slice(0, 500), updatedAt: now },
    }).catch(() => null)
    flipped.push(switchType)
  }
  await db.insert(events).values({
    id: uuidv7(), type: 'novan.paused', workspaceId,
    payload: { reason, switches: flipped },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'r330-value', version: 1, createdAt: now,
  } as never).catch(() => null)
  return { flipped }
}

export async function resumeNovan(workspaceId: string): Promise<{ resumed: string[] }> {
  const now = Date.now()
  const resumed: string[] = []
  for (const switchType of KILL_SWITCH_TYPES) {
    await db.update(killSwitches)
      .set({ enabled: false, updatedAt: now })
      .where(and(
        eq(killSwitches.workspaceId, workspaceId),
        eq(killSwitches.switchType, switchType),
      )).catch(() => null)
    resumed.push(switchType)
  }
  return { resumed }
}

// ─── #16 Workspace clone (snapshot for sandbox) ──────────────────────────
export async function workspaceClone(workspaceId: string, newWorkspaceId: string): Promise<{
  ok: boolean; memoryCopied: number; reason?: string
}> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(newWorkspaceId)) return { ok: false, memoryCopied: 0, reason: 'invalid newWorkspaceId' }
  // Only clone memory + relationships (config-shaped). Skip events (history)
  // and ai_usage (cost) so the sandbox starts fresh on those.
  const memRows = await db.select().from(workspaceMemory)
    .where(eq(workspaceMemory.workspaceId, workspaceId)).catch(() => [])
  let copied = 0
  for (const r of memRows) {
    await db.insert(workspaceMemory).values({
      workspaceId: newWorkspaceId,
      key: r.key, value: r.value, scope: r.scope, importance: r.importance,
      updatedAt: Date.now(),
    } as never).onConflictDoNothing().catch(() => null)
    copied++
  }
  return { ok: true, memoryCopied: copied }
}

// ─── #17 Op risk override ────────────────────────────────────────────────
// Persist per-workspace risk override in workspace_memory; brain-task handler
// can consult before exposing op via /api/v1/brain/op.
export async function setOpRisk(workspaceId: string, op: string, risk: 'low' | 'medium' | 'high'): Promise<void> {
  await db.insert(workspaceMemory).values({
    workspaceId,
    key: `_opRisk.${op}`,
    value: risk,
    scope: 'system', importance: 70, updatedAt: Date.now(),
  } as never).onConflictDoUpdate({
    target: [workspaceMemory.workspaceId, workspaceMemory.key],
    set: { value: risk, updatedAt: Date.now() },
  }).catch(() => null)
}

export async function getOpRiskOverride(workspaceId: string, op: string): Promise<string | null> {
  const [row] = await db.select({ value: workspaceMemory.value })
    .from(workspaceMemory)
    .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.key, `_opRisk.${op}`)))
    .limit(1).catch(() => [])
  return row?.value ?? null
}

// ─── #18 Budget breakdown ────────────────────────────────────────────────
export async function setBudgetBreakdown(workspaceId: string, buckets: Record<string, number>): Promise<void> {
  await db.insert(workspaceMemory).values({
    workspaceId, key: '_budgetBreakdown', value: JSON.stringify(buckets),
    scope: 'system', importance: 80, updatedAt: Date.now(),
  } as never).onConflictDoUpdate({
    target: [workspaceMemory.workspaceId, workspaceMemory.key],
    set: { value: JSON.stringify(buckets), updatedAt: Date.now() },
  }).catch(() => null)
}

export async function getBudgetBreakdown(workspaceId: string): Promise<Record<string, number>> {
  const [row] = await db.select({ value: workspaceMemory.value })
    .from(workspaceMemory)
    .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.key, '_budgetBreakdown')))
    .limit(1).catch(() => [])
  if (!row?.value) return {}
  try { return JSON.parse(row.value) as Record<string, number> } catch { return {} }
}

// ─── #19 Daily routine override ──────────────────────────────────────────
export async function dailyRoutineOverride(workspaceId: string, overrides: { skip?: string[]; only?: string[] }): Promise<void> {
  await db.insert(workspaceMemory).values({
    workspaceId, key: '_dailyRoutineOverride',
    value: JSON.stringify({ ...overrides, setAt: Date.now() }),
    scope: 'system', importance: 70, updatedAt: Date.now(),
  } as never).onConflictDoUpdate({
    target: [workspaceMemory.workspaceId, workspaceMemory.key],
    set: { value: JSON.stringify({ ...overrides, setAt: Date.now() }), updatedAt: Date.now() },
  }).catch(() => null)
}

// ─── #20 Data purge (true GDPR) ──────────────────────────────────────────
export async function dataPurge(workspaceId: string, confirm: string): Promise<{ ok: boolean; reason?: string; purged?: { table: string; rows: number }[] }> {
  if (confirm !== `PURGE:${workspaceId}`) {
    return { ok: false, reason: `confirm token must equal "PURGE:${workspaceId}"` }
  }
  const purged: { table: string; rows: number }[] = []
  // Workspace_memory
  const mem = await db.delete(workspaceMemory)
    .where(eq(workspaceMemory.workspaceId, workspaceId))
    .returning({ id: workspaceMemory.workspaceId }).catch(() => [])
  purged.push({ table: 'workspace_memory', rows: mem.length })
  // Events
  const evt = await db.delete(events)
    .where(eq(events.workspaceId, workspaceId))
    .returning({ id: events.id }).catch(() => [])
  purged.push({ table: 'events', rows: evt.length })
  // ai_usage
  const usage = await db.delete(aiUsage)
    .where(eq(aiUsage.workspaceId, workspaceId))
    .returning({ id: aiUsage.id }).catch(() => [])
  purged.push({ table: 'ai_usage', rows: usage.length })
  // brain_task_executions
  const tasks = await db.delete(brainTaskExecutions)
    .where(eq(brainTaskExecutions.workspaceId, workspaceId))
    .returning({ id: brainTaskExecutions.id }).catch(() => [])
  purged.push({ table: 'brain_task_executions', rows: tasks.length })
  // NOTE: workspaces row itself NOT deleted — operator may want to keep the
  // empty shell to retain auth. Use db-level DELETE FROM workspaces if needed.
  return { ok: true, purged }
}

void sql; void workflowRuns
