/**
 * R358 — Account-birthday ramp.
 *
 * R350 anti-flag rule 9:
 *   Day 1-7  (account age 0-7 days):   1 upload/day max regardless of cap
 *   Day 8-30 (account age 7-30 days):  50% of SAFE_DAILY_VELOCITY
 *   Day 30+  (account age 30+ days):   full cap
 *
 * Birthdays live in workspace_memory.account.<platform>.birthday (epoch ms).
 * Operator sets these manually after each signup.
 */
import type { AgentConfig } from './config.js'

const DAY_MS  = 24 * 60 * 60 * 1000
const WEEK_MS = 7  * DAY_MS
const MONTH_MS = 30 * DAY_MS

let cachedBirthdays: { ts: number; data: Record<string, number> } | null = null
const CACHE_MS = 60_000

export async function fetchAllBirthdays(cfg: AgentConfig): Promise<Record<string, number>> {
  if (cachedBirthdays && Date.now() - cachedBirthdays.ts < CACHE_MS) return cachedBirthdays.data
  try {
    const res = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ workspace_id: cfg.workspaceId, plan: [{ op: 'account.birthdays', params: {} }] }),
    })
    if (!res.ok) { console.warn(`[birthday-ramp] HTTP ${res.status}`); return {} }
    const j = await res.json() as { data?: { results?: Array<{ ok: boolean; data: Record<string, number> }> } }
    const data = j.data?.results?.[0]?.data ?? {}
    cachedBirthdays = { ts: Date.now(), data }
    return data
  } catch (e) {
    console.warn(`[birthday-ramp] fetch threw: ${(e as Error).message}`)
    return {}
  }
}

/**
 * Given a platform's full daily cap, return the clamped cap based on the
 * account's age. If no birthday is recorded, assume "mature" and return the
 * full cap (operator can set a birthday after signup if they want stricter
 * pacing).
 */
export function clampCapForAge(fullCap: number, birthdayMs: number | null | undefined, nowMs = Date.now()): number {
  if (!birthdayMs || birthdayMs <= 0) return fullCap
  const ageMs = nowMs - birthdayMs
  if (ageMs < WEEK_MS)  return 1                              // 0-7 days
  if (ageMs < MONTH_MS) return Math.max(1, Math.floor(fullCap / 2))  // 7-30 days
  return fullCap                                              // 30+ days
}

export function ageDescriptor(birthdayMs: number | null | undefined, nowMs = Date.now()): string {
  if (!birthdayMs) return 'mature'
  const days = Math.floor((nowMs - birthdayMs) / DAY_MS)
  if (days < 7)  return `warming (day ${days+1}/7)`
  if (days < 30) return `ramping (day ${days+1}/30, 50% cap)`
  return `mature (${days}d)`
}
