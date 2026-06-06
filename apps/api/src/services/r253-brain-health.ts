/**
 * R146.253 — Unified brain health snapshot.
 *
 * Aggregates the most important signals into one envelope so the
 * operator (and the brain.loop itself, when triaging) can ask a single
 * question instead of stitching 6 ops together:
 *
 *   {
 *     overall: 'healthy' | 'degraded' | 'critical',
 *     cost:    { spent, cap, over },           // R248
 *     backup:  { ageHours, status },           // R218
 *     applier: { status, lastEventAt },        // R231
 *     cron:    { missing, autoClosed },        // R245
 *     errors:  { last1h, last24h },            // recent error event count
 *     skills:  { total, recentWinRate },       // R206
 *   }
 *
 * 'critical' if cost.over OR backup.status=missing OR applier.status=never
 * 'degraded' if any other non-green signal
 * 'healthy'  otherwise
 *
 * Read-only, cheap, safe for chat injection.
 */
import { db } from '../db/client.js'
import { events, operatorSkills, skillOutcomes } from '../db/schema.js'
import { and, eq, gte, sql } from 'drizzle-orm'

export type Health = 'healthy' | 'degraded' | 'critical'

// R146.268 — 30s in-process cache. brainHealth() is called from
// novan-chat per turn (R260), the metrics tab (R261), and the alert
// tick (R255). Without caching that's 6+ queries × N concurrent chats.
const CACHE_TTL_MS = 30_000
const _cache = new Map<string, { snap: BrainHealth; at: number }>()
export function invalidateBrainHealth(workspaceId?: string): void {
  if (workspaceId) _cache.delete(workspaceId)
  else _cache.clear()
}

export interface BrainHealth {
  overall: Health
  cost:    { spent: number; cap: number; over: boolean }
  backup:  { ageHours: number | null; status: string }
  applier: { status: string; lastEventAt: number | null }
  cron:    { missing: number; autoClosed: number }
  errors:  { last1h: number; last24h: number }
  skills:  { total: number; recentWinRate: number | null }
  at:      number
}

export async function brainHealth(workspaceId: string): Promise<BrainHealth> {
  const cached = _cache.get(workspaceId)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.snap
  const now = Date.now()
  const h1  = now - 60 * 60_000
  const d1  = now - 24 * 60 * 60_000

  const [
    cost,
    backup,
    applier,
    cron,
    errs1h,
    errs24h,
    skillStats,
    outcomes,
  ] = await Promise.all([
    import('./r248-cost-cap.js').then(m => m.checkDailyCostCap(workspaceId)).catch(() => null),
    import('./r218-backup-health.js').then(m => m.backupHealth()).catch(() => null),
    import('./r231-applier-health.js').then(m => m.applierHealth()).catch(() => null),
    import('./r245-cron-presence-watch.js').then(m => m.checkCronPresence()).catch(() => null),
    db.select({ n: sql<number>`COUNT(*)::int` }).from(events)
      .where(and(eq(events.type, 'cron.error'), gte(events.createdAt, h1)))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`COUNT(*)::int` }).from(events)
      .where(and(eq(events.type, 'cron.error'), gte(events.createdAt, d1)))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ n: sql<number>`COUNT(*)::int` }).from(operatorSkills)
      .where(eq(operatorSkills.workspaceId, workspaceId))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ won: skillOutcomes.won })
      .from(skillOutcomes)
      .where(and(eq(skillOutcomes.workspaceId, workspaceId), gte(skillOutcomes.createdAt, d1)))
      .limit(50)
      .catch(() => [] as Array<{ won: boolean }>),
  ])

  const recentWinRate = outcomes.length > 0
    ? Number((outcomes.filter(o => o.won).length / outcomes.length).toFixed(2))
    : null

  const c = cost ?? { spent: 0, cap: 0, over: false, remaining: 0 }
  const b = backup ?? { ageHours: null, status: 'unknown' }
  const a = applier ?? { status: 'unknown', lastEventAt: null }
  const cr = cron ?? { missing: [], autoClosed: 0 }

  let overall: Health = 'healthy'
  if (c.over || b.status === 'missing' || a.status === 'never') overall = 'critical'
  else if (b.status !== 'fresh' || a.status !== 'alive' || cr.missing.length > 0 || errs1h > 5) overall = 'degraded'

  const snap: BrainHealth = {
    overall,
    cost:    { spent: c.spent, cap: c.cap, over: c.over },
    backup:  { ageHours: b.ageHours, status: b.status },
    applier: { status: a.status, lastEventAt: a.lastEventAt },
    cron:    { missing: cr.missing.length, autoClosed: cr.autoClosed },
    errors:  { last1h: errs1h, last24h: errs24h },
    skills:  { total: skillStats, recentWinRate },
    at: now,
  }
  _cache.set(workspaceId, { snap, at: now })
  return snap
}
