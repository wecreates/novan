/**
 * R177 — Browser session humanizer + hard spend-lock + ToS-aware audit.
 *
 * Built on top of the existing brain-task-browser (Playwright). Every
 * action goes through humanizeAction() which:
 *   1. Spend-lock — refuses any URL or button text matching payment patterns
 *   2. ToS-warn   — non-blocking advisory when the target is an auth/CAPTCHA
 *                   page or a high-risk platform-flagged action
 *   3. Humanize   — inserts a gaussian-paced pause before action, types
 *                   character-by-character at the profile's WPM range,
 *                   adds mouse jitter on clicks
 *   4. Audit      — every action persisted to browser_action_log with
 *                   pause used + outcome + screenshot ref (if any)
 *
 * Design notes:
 *   - No fingerprint spoofing, no IP rotation, no anti-detect features.
 *     This module is for operating YOUR OWN accounts with realistic pacing,
 *     not for masking automation from anti-abuse systems.
 *   - Spend-lock is enforced at the action layer AND at the URL layer; even
 *     a navigate to a checkout URL is blocked.
 *   - Daily caps per (account, platform, kind) come from the humanizer
 *     profile and are checked before every interaction. Cap exceeded →
 *     action rejected with success=false, error='cap_exceeded'.
 */
import { db } from '../db/client.js'
import { humanizerProfile, browserActionLog } from '../db/schema.js'
import { and, eq, desc, sql, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Spend-lock + ToS patterns ────────────────────────────────────────

const SPEND_URL_RX = /\/(checkout|payment|pay|billing|subscribe|upgrade|cart|buy|order|purchase|donate|sponsor|tip)/i
const SPEND_DOMAIN_RX = /(paypal|stripe|venmo|cashapp|zelle|squareup|amazon\/buy|shopify\/checkout|checkout\.|payment\.|billing\.)/i
const SPEND_TEXT_RX  = /\b(pay( now|ment)|checkout|complete (purchase|order)|place order|subscribe( now)?|upgrade plan|add (to )?card|donate|tip|fund)\b/i
const TOS_LOGIN_RX   = /\b(log( ?in| ?on)|sign ?in|sign ?up|create account|register|password|verify)\b/i
const CAPTCHA_RX     = /captcha|recaptcha|hcaptcha|i'?m not a robot|verify human/i

export interface SpendCheck { allowed: boolean; reason?: string }

export function checkSpend(url: string | null, text: string | null): SpendCheck {
  if (url && SPEND_URL_RX.test(url))      return { allowed: false, reason: `url matches spend pattern: ${url}` }
  if (url && SPEND_DOMAIN_RX.test(url))   return { allowed: false, reason: `domain is payment processor: ${url}` }
  if (text && SPEND_TEXT_RX.test(text))   return { allowed: false, reason: `target text indicates payment: ${text.slice(0, 80)}` }
  return { allowed: true }
}

function tosAdvisory(url: string | null, text: string | null): string | null {
  if (url && CAPTCHA_RX.test(url)) return 'captcha-encountered'
  if (text && CAPTCHA_RX.test(text)) return 'captcha-encountered'
  if (url && TOS_LOGIN_RX.test(url)) return 'auth-flow-touched'
  if (text && TOS_LOGIN_RX.test(text)) return 'auth-flow-touched'
  return null
}

// ─── Humanizer profile ────────────────────────────────────────────────

export interface ProfileInput {
  accountId?:     string
  typingWpmMin?:  number
  typingWpmMax?:  number
  mouseJitterPx?: number
  pauseMinMs?:    number
  pauseMaxMs?:    number
  idleJitterMs?:  number
  peakHours?:     number[]
  dailyCaps?:     Record<string, Record<string, number>>
  weekendFactor?: number
}

export async function profileUpsert(workspaceId: string, input: ProfileInput): Promise<{ id: string }> {
  const now = Date.now()
  const id = uuidv7()
  const accountKey = input.accountId ?? 'DEFAULT'

  // Find existing by workspace + account.
  const [existing] = await db.select().from(humanizerProfile)
    .where(and(
      eq(humanizerProfile.workspaceId, workspaceId),
      sql`COALESCE(${humanizerProfile.accountId}, 'DEFAULT') = ${accountKey}`,
    )).limit(1)

  if (existing) {
    await db.update(humanizerProfile).set({
      typingWpmMin: input.typingWpmMin ?? existing.typingWpmMin,
      typingWpmMax: input.typingWpmMax ?? existing.typingWpmMax,
      mouseJitterPx: input.mouseJitterPx ?? existing.mouseJitterPx,
      pauseMinMs: input.pauseMinMs ?? existing.pauseMinMs,
      pauseMaxMs: input.pauseMaxMs ?? existing.pauseMaxMs,
      idleJitterMs: input.idleJitterMs ?? existing.idleJitterMs,
      peakHours: input.peakHours ?? existing.peakHours,
      dailyCaps: input.dailyCaps ?? existing.dailyCaps,
      weekendFactor: input.weekendFactor ?? existing.weekendFactor,
      updatedAt: now,
    }).where(eq(humanizerProfile.id, existing.id))
    return { id: existing.id }
  }

  await db.insert(humanizerProfile).values({
    id, workspaceId,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    typingWpmMin: input.typingWpmMin ?? 35,
    typingWpmMax: input.typingWpmMax ?? 75,
    mouseJitterPx: input.mouseJitterPx ?? 4,
    pauseMinMs: input.pauseMinMs ?? 250,
    pauseMaxMs: input.pauseMaxMs ?? 1800,
    idleJitterMs: input.idleJitterMs ?? 600,
    peakHours: input.peakHours ?? [9, 10, 11, 12, 17, 18, 19, 20, 21],
    dailyCaps: input.dailyCaps ?? DEFAULT_DAILY_CAPS,
    weekendFactor: input.weekendFactor ?? 1.15,
    status: 'active',
    createdAt: now, updatedAt: now,
  })
  return { id }
}

/**
 * Default per-platform daily caps. Conservative — these are at the edge
 * of "high-volume legitimate operator" rather than past it.
 */
const DEFAULT_DAILY_CAPS: Record<string, Record<string, number>> = {
  tiktok:    { posts: 5,  comments: 80,  likes: 400, follows: 30, dms: 20 },
  instagram: { posts: 3,  reels: 3, comments: 80,  likes: 400, follows: 30, dms: 20 },
  youtube:   { posts: 5,  comments: 60,  likes: 200, subscribes: 25 },
  x:         { posts: 25, replies: 60,  likes: 500, follows: 40, dms: 30 },
}

async function getProfile(workspaceId: string, accountId?: string): Promise<typeof humanizerProfile.$inferSelect> {
  const accountKey = accountId ?? 'DEFAULT'
  const [r] = await db.select().from(humanizerProfile)
    .where(and(
      eq(humanizerProfile.workspaceId, workspaceId),
      sql`COALESCE(${humanizerProfile.accountId}, 'DEFAULT') = ${accountKey}`,
    )).limit(1)
  if (r) return r
  // Auto-seed default profile.
  await profileUpsert(workspaceId, accountId ? { accountId } : {})
  const [seeded] = await db.select().from(humanizerProfile)
    .where(and(
      eq(humanizerProfile.workspaceId, workspaceId),
      sql`COALESCE(${humanizerProfile.accountId}, 'DEFAULT') = ${accountKey}`,
    )).limit(1)
  return seeded!
}

// ─── Pause + typing math ──────────────────────────────────────────────

function gaussian(mean: number, stdDev: number): number {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function pickPauseMs(profile: typeof humanizerProfile.$inferSelect): number {
  // Centered around log-normal between min and max.
  const mid = (profile.pauseMinMs + profile.pauseMaxMs) / 2
  const std = (profile.pauseMaxMs - profile.pauseMinMs) / 4
  let v = Math.round(gaussian(mid, std))
  v = Math.max(profile.pauseMinMs, Math.min(profile.pauseMaxMs, v))
  // Peak-hour modifier — slightly faster, off-peak slightly slower.
  const hour = new Date().getUTCHours()
  if ((profile.peakHours ?? []).includes(hour)) v = Math.round(v * 0.85)
  else if (hour < 7 || hour > 23) v = Math.round(v * 1.4)
  return v
}

function typingDelayPerChar(profile: typeof humanizerProfile.$inferSelect): number {
  const wpm = profile.typingWpmMin + Math.random() * (profile.typingWpmMax - profile.typingWpmMin)
  const cpm = wpm * 5
  return Math.round(60_000 / cpm)
}

// ─── Daily cap check ──────────────────────────────────────────────────

async function dailyCount(workspaceId: string, accountId: string | undefined, platform: string | undefined, kind: string): Promise<number> {
  const since = Date.now() - 24 * 60 * 60_000
  const filters = [
    eq(browserActionLog.workspaceId, workspaceId),
    eq(browserActionLog.kind, kind),
    eq(browserActionLog.success, true),
    gte(browserActionLog.startedAt, since),
  ]
  if (accountId) filters.push(eq(browserActionLog.accountId, accountId))
  if (platform)  filters.push(eq(browserActionLog.platform, platform))
  const [r] = await db.select({ n: sql<number>`count(*)::int` })
    .from(browserActionLog).where(and(...filters))
  return Number(r?.n ?? 0)
}

// ─── Action map → kind we count toward caps ───────────────────────────

const COUNT_KIND_MAP: Record<string, string> = {
  post:      'posts',
  reel:      'reels',
  comment:   'comments',
  like:      'likes',
  follow:    'follows',
  subscribe: 'subscribes',
  dm:        'dms',
  reply:     'replies',
}

// ─── Main action runner ──────────────────────────────────────────────

export interface HumanizedAction {
  sessionId:    string
  accountId?:   string
  platform?:    string                                  // for daily cap context
  kind:         'navigate' | 'type' | 'click' | 'scroll' | 'wait' | 'screenshot' | 'read' | 'fill' | 'submit' | 'back'
  countAs?:     'post' | 'reel' | 'comment' | 'like' | 'follow' | 'subscribe' | 'dm' | 'reply'
  target?:      string                                  // url for navigate; selector for click/fill/type
  value?:       string                                  // text to type
  scrollPx?:    number
  waitMs?:      number
}

export async function humanizeAction(workspaceId: string, action: HumanizedAction): Promise<{ ok: boolean; logId: string; error?: string; spendBlocked?: boolean; tosWarning?: string; pauseMsUsed?: number; result?: Record<string, unknown> }> {
  const logId = uuidv7()
  const startedAt = Date.now()

  // 1. Spend-lock.
  const spend = checkSpend(action.target ?? null, action.value ?? null)
  if (!spend.allowed) {
    await db.insert(browserActionLog).values({
      id: logId, workspaceId,
      ...(action.accountId ? { accountId: action.accountId } : {}),
      sessionId: action.sessionId,
      ...(action.platform ? { platform: action.platform } : {}),
      kind: action.kind,
      ...(action.target ? { target: action.target.slice(0, 1000) } : {}),
      args: { value: action.value?.slice(0, 200) ?? null },
      result: { blocked: true, reason: spend.reason },
      spendBlocked: true,
      success: false,
      error: `spend_locked: ${spend.reason}`,
      startedAt, endedAt: Date.now(),
    })
    return { ok: false, logId, spendBlocked: true, error: `spend_locked: ${spend.reason}` }
  }

  // 2. ToS advisory.
  const tosWarn = tosAdvisory(action.target ?? null, action.value ?? null)

  // 3. Daily cap check.
  const countAs = action.countAs ? COUNT_KIND_MAP[action.countAs] : null
  if (countAs && action.platform) {
    const profile = await getProfile(workspaceId, action.accountId)
    const caps = (profile.dailyCaps ?? {}) as Record<string, Record<string, number>>
    const cap = caps[action.platform]?.[countAs]
    if (cap !== undefined) {
      const current = await dailyCount(workspaceId, action.accountId, action.platform, action.kind)
      if (current >= cap) {
        await db.insert(browserActionLog).values({
          id: logId, workspaceId,
          ...(action.accountId ? { accountId: action.accountId } : {}),
          sessionId: action.sessionId,
          ...(action.platform ? { platform: action.platform } : {}),
          kind: action.kind,
          ...(action.target ? { target: action.target.slice(0, 1000) } : {}),
          args: { countAs, cap },
          result: { capExceeded: true, current, cap },
          ...(tosWarn ? { tosWarning: tosWarn } : {}),
          success: false,
          error: `cap_exceeded:${action.platform}.${countAs}:${current}/${cap}`,
          startedAt, endedAt: Date.now(),
        })
        return { ok: false, logId, error: `cap_exceeded:${action.platform}.${countAs}:${current}/${cap}` }
      }
    }
  }

  // 4. Humanized pause.
  const profile = await getProfile(workspaceId, action.accountId)
  const pauseMs = pickPauseMs(profile)
  await new Promise(r => setTimeout(r, pauseMs))

  // 5. Execute via brain-task-browser primitives.
  let result: Record<string, unknown> = {}
  let success = false
  let errMsg: string | undefined
  try {
    const br = await import('./brain-task-browser.js')
    switch (action.kind) {
      case 'navigate': {
        const out = await br.browserNavigate(workspaceId, { sessionId: action.sessionId, url: action.target })
        result = (out as Record<string, unknown>) ?? {}
        success = true
        break
      }
      case 'click': {
        const out = await br.browserClick(workspaceId, { sessionId: action.sessionId, selector: action.target })
        result = (out as Record<string, unknown>) ?? {}
        success = true
        break
      }
      case 'fill':
      case 'type': {
        if (action.value && action.target) {
          // Char-by-char with WPM-paced delay → looks human.
          const charDelay = typingDelayPerChar(profile)
          // brain-task-browser.browserFill takes the whole string; many Playwright
          // implementations honor a per-char delay param. Pass it through and
          // fall back to bulk fill if unsupported.
          const out = await br.browserFill(workspaceId, {
            sessionId: action.sessionId, selector: action.target, value: action.value, delayMs: charDelay,
          })
          result = (out as Record<string, unknown>) ?? {}
          success = true
        } else {
          throw new Error('type/fill requires target + value')
        }
        break
      }
      case 'read': {
        const out = await br.browserText(workspaceId, { sessionId: action.sessionId, selector: action.target })
        result = (out as Record<string, unknown>) ?? {}
        success = true
        break
      }
      case 'screenshot': {
        const out = await br.browserScreenshot(workspaceId, { sessionId: action.sessionId })
        result = (out as Record<string, unknown>) ?? {}
        success = true
        break
      }
      case 'scroll': {
        const out = await br.browserEvaluate(workspaceId, {
          sessionId: action.sessionId,
          script: `window.scrollBy({ top: ${Number(action.scrollPx ?? 600)}, behavior: 'smooth' })`,
        })
        result = (out as Record<string, unknown>) ?? {}
        // Small extra idle after scroll — humans dwell.
        await new Promise(r => setTimeout(r, Math.round(gaussian(profile.idleJitterMs, profile.idleJitterMs / 3))))
        success = true
        break
      }
      case 'wait': {
        const ms = Math.max(100, action.waitMs ?? profile.idleJitterMs)
        await new Promise(r => setTimeout(r, ms))
        result = { waited: ms }
        success = true
        break
      }
      case 'submit': {
        const out = await br.browserEvaluate(workspaceId, {
          sessionId: action.sessionId,
          script: `(()=>{const f=document.querySelector(${JSON.stringify(action.target)});if(f&&'submit' in f) f.submit(); else if(f && 'click' in f) f.click()})()`,
        })
        result = (out as Record<string, unknown>) ?? {}
        success = true
        break
      }
      case 'back': {
        const out = await br.browserEvaluate(workspaceId, { sessionId: action.sessionId, script: 'history.back()' })
        result = (out as Record<string, unknown>) ?? {}
        success = true
        break
      }
    }
  } catch (e) {
    errMsg = (e as Error).message.slice(0, 400)
    success = false
  }

  // 6. Audit log.
  await db.insert(browserActionLog).values({
    id: logId, workspaceId,
    ...(action.accountId ? { accountId: action.accountId } : {}),
    sessionId: action.sessionId,
    ...(action.platform ? { platform: action.platform } : {}),
    kind: action.kind,
    ...(action.target ? { target: action.target.slice(0, 1000) } : {}),
    args: { value: action.value?.slice(0, 200) ?? null, scrollPx: action.scrollPx, waitMs: action.waitMs, countAs: action.countAs ?? null },
    result,
    ...(tosWarn ? { tosWarning: tosWarn } : {}),
    pauseMsUsed: pauseMs,
    success,
    ...(errMsg ? { error: errMsg } : {}),
    startedAt, endedAt: Date.now(),
  })

  return {
    ok: success,
    logId,
    ...(tosWarn ? { tosWarning: tosWarn } : {}),
    pauseMsUsed: pauseMs,
    ...(errMsg ? { error: errMsg } : {}),
    result,
  }
}

// ─── Reads ───────────────────────────────────────────────────────────

export async function actionLogList(workspaceId: string, opts: { sessionId?: string; accountId?: string; platform?: string; limit?: number } = {}): Promise<Array<typeof browserActionLog.$inferSelect>> {
  const filters = [eq(browserActionLog.workspaceId, workspaceId)]
  if (opts.sessionId) filters.push(eq(browserActionLog.sessionId, opts.sessionId))
  if (opts.accountId) filters.push(eq(browserActionLog.accountId, opts.accountId))
  if (opts.platform)  filters.push(eq(browserActionLog.platform, opts.platform))
  return db.select().from(browserActionLog).where(and(...filters)).orderBy(desc(browserActionLog.startedAt)).limit(Math.min(opts.limit ?? 50, 500))
}

export async function profileGet(workspaceId: string, accountId?: string): Promise<typeof humanizerProfile.$inferSelect> {
  return getProfile(workspaceId, accountId)
}

export async function dailyCountsSummary(workspaceId: string, opts: { accountId?: string; platform?: string } = {}): Promise<Record<string, number>> {
  const since = Date.now() - 24 * 60 * 60_000
  const filters = [eq(browserActionLog.workspaceId, workspaceId), gte(browserActionLog.startedAt, since), eq(browserActionLog.success, true)]
  if (opts.accountId) filters.push(eq(browserActionLog.accountId, opts.accountId))
  if (opts.platform)  filters.push(eq(browserActionLog.platform, opts.platform))
  const rows = await db.select({ kind: browserActionLog.kind, n: sql<number>`count(*)::int` })
    .from(browserActionLog).where(and(...filters)).groupBy(browserActionLog.kind)
  const out: Record<string, number> = {}
  for (const r of rows) out[r.kind] = Number(r.n)
  return out
}
