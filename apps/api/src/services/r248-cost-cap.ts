/**
 * R146.248 — Per-workspace daily AI cost cap. Reads accumulated
 * ai_usage cost for the current UTC day. If it exceeds the workspace's
 * DAILY_AI_COST_CAP_USD env or the operatorPrefs override (future),
 * subsequent streamChat calls short-circuit with a 'budget_exceeded'
 * error envelope.
 *
 * Cached 60s — recompute is cheap (single agg over indexed timestamp)
 * but doing it on every chat call would still add up at scale.
 */
import { db } from '../db/client.js'
import { aiUsage } from '../db/schema.js'
import { and, eq, gte, sql } from 'drizzle-orm'

// R146.287 — NaN guard. Number('garbage') === NaN; spent >= NaN is always
// false → cap silently disabled. Fall back to $5 on any non-finite env.
const _capEnv = Number(process.env['DAILY_AI_COST_CAP_USD'] ?? '5.00')
const DEFAULT_CAP_USD = Number.isFinite(_capEnv) && _capEnv > 0 ? _capEnv : 5
const CACHE_TTL_MS = 60_000

interface CapCheck { spent: number; cap: number; over: boolean; remaining: number }
const _cache = new Map<string, { snap: CapCheck; at: number }>()

/** Returns current spent vs cap. Cached 60s per workspace. */
export async function checkDailyCostCap(workspaceId: string): Promise<CapCheck> {
  const cached = _cache.get(workspaceId)
  const now = Date.now()
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.snap

  const dayStartUtc = new Date()
  dayStartUtc.setUTCHours(0, 0, 0, 0)
  const sinceMs = dayStartUtc.getTime()

  const [row] = await db.select({
    spent: sql<number>`COALESCE(SUM(${aiUsage.costUsd}), 0)::float`,
  }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, sinceMs)))
    .catch(() => [])
  const spent = Number(row?.spent ?? 0)
  const snap: CapCheck = {
    spent: Number(spent.toFixed(4)),
    cap: DEFAULT_CAP_USD,
    over: spent >= DEFAULT_CAP_USD,
    remaining: Math.max(0, DEFAULT_CAP_USD - spent),
  }
  _cache.set(workspaceId, { snap, at: now })
  return snap
}

/** Force-invalidate cache (e.g. after operator raises cap). */
export function invalidateCostCap(workspaceId?: string): void {
  if (workspaceId) _cache.delete(workspaceId)
  else _cache.clear()
}

/** Returns a list of workspaces currently OVER cap for the day. */
export async function findOverCapWorkspaces(): Promise<Array<{ workspaceId: string; spent: number; cap: number }>> {
  const dayStartUtc = new Date()
  dayStartUtc.setUTCHours(0, 0, 0, 0)
  const sinceMs = dayStartUtc.getTime()
  const rows = await db.select({
    workspaceId: aiUsage.workspaceId,
    spent: sql<number>`SUM(${aiUsage.costUsd})::float`,
  }).from(aiUsage)
    .where(gte(aiUsage.timestamp, sinceMs))
    .groupBy(aiUsage.workspaceId)
    .catch(() => [])
  return rows
    .filter(r => Number(r.spent) >= DEFAULT_CAP_USD)
    .map(r => ({
      workspaceId: r.workspaceId,
      spent: Number((r.spent || 0).toFixed(4)),
      cap: DEFAULT_CAP_USD,
    }))
}
