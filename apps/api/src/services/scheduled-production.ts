/**
 * scheduled-production.ts — cron-driven daily content quota.
 *
 * Stores production schedules per workspace (e.g. "3 shorts daily at 9am
 * on the fitness channel"). A scheduler tick (called by the existing
 * cron infra in scheduled-tasks) checks each active schedule and:
 *   1. Picks a brief from the schedule's prompt-bank (round-robin or random)
 *   2. Runs editOne to produce the video (with TTS + captions + brand kit)
 *   3. Optionally auto-publishes to configured channels (requires confirmAutoPublish:true)
 *   4. Logs the production attempt to the events stream
 *
 * Schedules persisted as JSON in SCHEDULES_DIR.
 */

import { existsSync, mkdirSync as fsmkdirSync } from 'node:fs'
import { writeFile, readFile, readdir, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCHEDULES_DIR = process.env['SCHEDULES_DIR'] ?? join(tmpdir(), 'novan-schedules')
if (!existsSync(SCHEDULES_DIR)) fsmkdirSync(SCHEDULES_DIR, { recursive: true })

export interface ProductionSchedule {
  id:                string
  workspaceId:       string
  name:              string
  format:            'long' | 'short' | 'square'
  /** Bank of briefs the scheduler rotates through. */
  prompts:           string[]
  /** Videos per day to produce. */
  dailyQuota:        number
  outDir:            string
  /** Hours of the day (0-23) to fire at, interpreted in `timezone`.
   *  e.g. [9, 14, 19] for "post at 9am, 2pm, 7pm operator-local". */
  hoursOfDay:        number[]
  /** IANA timezone the `hoursOfDay` is evaluated against (e.g. "America/New_York",
   *  "Europe/Berlin", "Asia/Tokyo"). Defaults to "UTC". Previously the
   *  scheduler used the API server's local TZ which broke whenever the
   *  server was deployed in a different region than the operator's
   *  audience — a US-targeted YouTube channel scheduled for 9am ET was
   *  firing at 4am ET on a UTC-deployed API. */
  timezone?:         string
  /** Channel IDs to auto-publish to. Empty = produce only. */
  publishChannels:   string[]
  /** Operator-acknowledged auto-publish gate. False = produce only. */
  confirmAutoPublish: boolean
  enabled:           boolean
  lastRunAt?:        number
  nextPromptIndex:   number
  createdAt:         number
  /** Business id to attribute production to. When set, the scheduler
   *  auto-scales the effective daily quota based on the business's gap
   *  to the $10k/mo floor (subject to maxDailyQuotaCap). */
  businessId?:       string
  /** Hard ceiling on auto-scaled daily quota. ToS + operator-sanity
   *  constraint — the brain never produces more than this per day
   *  regardless of gap pressure. Defaults to dailyQuota × 2. */
  maxDailyQuotaCap?: number
}

function schedulePath(id: string): string { return join(SCHEDULES_DIR, `${id}.json`) }

export async function saveSchedule(s: Omit<ProductionSchedule, 'createdAt' | 'nextPromptIndex'> & { nextPromptIndex?: number }): Promise<{ ok: boolean; id: string }> {
  const full: ProductionSchedule = {
    ...s, createdAt: Date.now(), nextPromptIndex: s.nextPromptIndex ?? 0,
  }
  await writeFile(schedulePath(s.id), JSON.stringify(full, null, 2), 'utf8')
  // Auto-populate world-model — schedule becomes graph-visible immediately
  // (instead of waiting for the next 30-min twin sweep).
  try {
    const { upsertNode } = await import('./world-model.js')
    await upsertNode({
      id: `schedule:${full.id}`, workspaceId: full.workspaceId, kind: 'schedule',
      label: full.name,
      attrs: { format: full.format, dailyQuota: full.dailyQuota, enabled: full.enabled },
      health: full.enabled ? 1.0 : 0.4, importance: 0.6,
    })
  } catch { /* */ }
  return { ok: true, id: s.id }
}

export async function deleteSchedule(id: string): Promise<{ ok: boolean }> {
  const p = schedulePath(id)
  if (!existsSync(p)) return { ok: false }
  await unlink(p)
  return { ok: true }
}

export async function listSchedules(workspaceId?: string): Promise<ProductionSchedule[]> {
  const files = await readdir(SCHEDULES_DIR)
  const out: ProductionSchedule[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const s = JSON.parse(await readFile(join(SCHEDULES_DIR, f), 'utf8')) as ProductionSchedule
      if (workspaceId && s.workspaceId !== workspaceId) continue
      out.push(s)
    } catch { /* */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function getSchedule(id: string): Promise<ProductionSchedule | null> {
  const p = schedulePath(id)
  if (!existsSync(p)) return null
  try { return JSON.parse(await readFile(p, 'utf8')) as ProductionSchedule } catch { return null }
}

/**
 * Should this schedule fire right now? Checks: enabled + within
 * scheduled hour + hasn't already fired this hour.
 */
/** Format an Instant as (hour, yyyy-mm-dd) in the given IANA timezone.
 *  Using Intl.DateTimeFormat is the only way to get correct results
 *  during DST transitions without pulling in a date library. */
function inTimezone(at: Date, tz: string): { hour: number; date: string } {
  // hour in target TZ
  const hourStr = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(at)
  // Intl returns "24" for midnight on some Node versions — normalize.
  const hour = (Number(hourStr) || 0) % 24
  // yyyy-mm-dd in target TZ. en-CA gives ISO 8601 short-date.
  const date = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(at)
  return { hour, date }
}

function shouldFire(s: ProductionSchedule, now = new Date()): boolean {
  if (!s.enabled) return false
  if (s.prompts.length === 0) return false
  const tz = s.timezone ?? 'UTC'
  let cur: { hour: number; date: string }
  try { cur = inTimezone(now, tz) }
  catch {
    // Invalid IANA TZ — fall back to UTC + emit no spam; operator can
    // see the issue when the schedule never fires.
    cur = inTimezone(now, 'UTC')
  }
  if (!s.hoursOfDay.includes(cur.hour)) return false
  if (s.lastRunAt) {
    const last = inTimezone(new Date(s.lastRunAt), tz)
    if (last.date === cur.date && last.hour === cur.hour) return false
  }
  return true
}

/**
 * Compute the effective daily quota for a schedule. If the schedule is
 * attached to a business and the business is short of its $10k/mo
 * target, push the quota up — but never past `maxDailyQuotaCap` (operator
 * cap) or 2× the base quota (sanity cap for ToS preservation).
 *
 * The scaling factor is conservative: at 50% of target → 1.5× quota;
 * at 25% of target → 2× quota. We never multiply by more than 2 because
 * doubling output without doubling quality kills the channel (per the
 * YouTube playbook §12 — length inflation + thumbnail drift are the
 * dominant failure modes when operators chase volume).
 */
async function effectiveDailyQuota(s: ProductionSchedule): Promise<{ quota: number; reason: string }> {
  const base = s.dailyQuota
  if (!s.businessId) return { quota: base, reason: 'no business attached' }
  try {
    const { statusFor } = await import('./business-portfolio.js')
    const status = await statusFor(s.workspaceId, s.businessId)
    if (!status) return { quota: base, reason: 'business not found' }
    const cap = s.maxDailyQuotaCap ?? Math.ceil(base * 2)
    if (status.last30DaysUsd >= status.monthlyTargetUsd) {
      // Over target — back off to the base cadence.
      return { quota: base, reason: `over $10k target — base quota retained` }
    }
    const pctOfTarget = status.last30DaysUsd / Math.max(1, status.monthlyTargetUsd)
    // Linear interpolation: 100% of target → 1.0×, 25% of target → 2.0×.
    // Below 25% we hold at 2.0× (the cap) because any higher cadence is
    // unsafe per the playbook.
    const mult = pctOfTarget <= 0.25 ? 2.0
              : pctOfTarget >= 1.0  ? 1.0
              : 2.0 - ((pctOfTarget - 0.25) / 0.75) * 1.0
    const scaled = Math.min(cap, Math.ceil(base * mult))
    return {
      quota: scaled,
      reason: `business at ${(pctOfTarget * 100).toFixed(0)}% of $${status.monthlyTargetUsd} target — scaling ${base}/day → ${scaled}/day (cap=${cap})`,
    }
  } catch (e) {
    return { quota: base, reason: `quota-scale failed: ${(e as Error).message}` }
  }
}

export interface TickResult {
  schedulesChecked: number
  fired:            number
  produced:         number
  published:        number
  errors:           string[]
}

/**
 * Run one tick. Called by the cron job. Iterates every enabled schedule,
 * fires any that match the current hour, produces + optionally publishes.
 */
/** In-process re-entrancy guard. The cron scheduler can fire a new tick
 *  while a slow one is still draining schedules; without this, two
 *  concurrent tick() invocations both see `lastRunAt` in the prior hour
 *  for the same schedule and both call editOne() — duplicate videos,
 *  duplicate publishes, duplicate under-target events. Schedules live in
 *  JSON files on disk, so the API is single-instance-per-host by design;
 *  an in-process flag is the correct scope. Multi-instance deploy would
 *  additionally need a distributed lock. */
let _tickRunning = false

export async function tick(): Promise<TickResult> {
  const result: TickResult = { schedulesChecked: 0, fired: 0, produced: 0, published: 0, errors: [] }
  if (_tickRunning) {
    result.errors.push('tick: previous tick still running — skipped to avoid duplicate fires')
    return result
  }
  // R146.325 (#3) — Postgres advisory lock so multi-instance API doesn't
  // double-fire. tryAdvisoryLock returns true also on DB-unreachable
  // (defensive: in-process flag still protects single-instance).
  const { tryAdvisoryLock, releaseAdvisoryLock } = await import('../util/advisory-lock.js')
  const lockName = 'tick:scheduled-production'
  const gotLock = await tryAdvisoryLock(lockName)
  if (!gotLock) {
    result.errors.push('tick: another instance holds the advisory lock — skipped')
    return result
  }
  _tickRunning = true
  try {
  const schedules = await listSchedules()
  result.schedulesChecked = schedules.length
  const now = new Date()

  // Per-workspace kill_switch check — if the operator pulled the
  // `ai_request` switch on a workspace, production halts immediately.
  // We pre-load enabled switches in one query so the inner loop stays O(1).
  const { db } = await import('../db/client.js')
  const { killSwitches } = await import('../db/schema.js')
  const { eq, and } = await import('drizzle-orm')
  const haltedWorkspaces = new Set<string>()
  try {
    // R146.325 (#4) — batch the N+1 into a single IN query.
    const wsList = Array.from(new Set(schedules.map(s => s.workspaceId)))
    if (wsList.length > 0) {
      const { inArray } = await import('drizzle-orm')
      const rows = await db.select({ ws: killSwitches.workspaceId, enabled: killSwitches.enabled })
        .from(killSwitches)
        .where(and(
          inArray(killSwitches.workspaceId, wsList),
          eq(killSwitches.switchType, 'ai_request'),
        ))
      for (const r of rows) if (r.enabled) haltedWorkspaces.add(r.ws)
    }
  } catch { /* if kill-switch lookup fails, default to fire — operator has /api/v1/x/kill-switch endpoint for hard stop */ }

  for (const s of schedules) {
    if (haltedWorkspaces.has(s.workspaceId)) {
      result.errors.push(`schedule ${s.id}: skipped — ai_request kill_switch active on workspace ${s.workspaceId}`)
      continue
    }
    if (!shouldFire(s, now)) continue
    result.fired++

    // Gap-driven cadence signal: if the schedule is attached to a
    // business and the business is short of its $10k floor, emit a
    // `production.under_target` event so the brain knows to propose
    // scaling cadence (NOT a silent mutation — operator must approve
    // any schedule change). The effectiveDailyQuota math is reported
    // alongside the event for transparency.
    if (s.businessId) {
      try {
        const { quota: targetQuota, reason } = await effectiveDailyQuota(s)
        if (targetQuota > s.dailyQuota) {
          const { db: _db } = await import('../db/client.js')
          const { events: _events } = await import('../db/schema.js')
          const { v7: _uuidv7 } = await import('uuid')
          await _db.insert(_events).values({
            id: _uuidv7(), type: 'production.under_target', workspaceId: s.workspaceId,
            payload: {
              scheduleId: s.id, businessId: s.businessId,
              currentDailyQuota: s.dailyQuota, suggestedDailyQuota: targetQuota,
              reason,
            },
            traceId: _uuidv7(), correlationId: _uuidv7(), causationId: null,
            source: 'scheduled-production', version: 1, createdAt: Date.now(),
          }).catch((e: Error) => { console.error('[scheduled-production]', e.message); return null })
        }
      } catch { /* tolerated */ }
    }

    const brief = s.prompts[s.nextPromptIndex % s.prompts.length]!
    const outPath = join(s.outDir, `sched-${s.id}-${Date.now().toString(36)}.mp4`)
    try {
      await mkdir(s.outDir, { recursive: true })
      const { editOne } = await import('./video-editor-agent.js')
      const r = await editOne({
        brief, outPath, format: s.format,
        workspaceId: s.workspaceId,
      })
      if (r.ok) {
        result.produced++
        // Auto-publish if confirmed + channels configured
        if (s.confirmAutoPublish && s.publishChannels.length > 0 && r.outPath) {
          try {
            const { publishAcrossChannels } = await import('./channel-manager.js')
            const pub = await publishAcrossChannels({
              videoPath: r.outPath,
              workspaceId: s.workspaceId,
              channelIds: s.publishChannels,
              confirm: true,
            })
            result.published += pub.filter(p => p.ok).length
          } catch (e) { result.errors.push(`publish: ${(e as Error).message}`) }
        }
      } else {
        result.errors.push(`schedule ${s.id}: ${r.error ?? 'edit failed'}`)
      }
    } catch (e) {
      result.errors.push(`schedule ${s.id}: ${(e as Error).message}`)
    }

    // Advance rotation + mark. Persist the claim BEFORE producing where
    // possible would be ideal, but editOne is the long-running step and
    // the file write is fast — the in-process guard above is what
    // prevents re-entrant duplicate fires.
    s.nextPromptIndex = (s.nextPromptIndex + 1) % s.prompts.length
    s.lastRunAt = Date.now()
    await writeFile(schedulePath(s.id), JSON.stringify(s, null, 2), 'utf8')
  }

  return result
  } finally {
    _tickRunning = false
    await releaseAdvisoryLock(lockName)
  }
}
