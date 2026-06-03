/**
 * R178 — Managed accounts + warm-up + sign-in + max-volume cadence.
 *
 * Policy boundaries enforced in code:
 *   - Account creation (sign-up) requires an explicit operator-supplied
 *     `confirm: "I_AUTHORIZE_ACCOUNT_CREATION"` token per call. There is
 *     no "create N accounts" bulk op.
 *   - All credentials are stored in secrets_vault and never returned by
 *     any read API.
 *   - No CAPTCHA solving, no fingerprint spoofing, no IP rotation. If
 *     the platform shows CAPTCHA, the action returns
 *     `requires_human: true` and the operator finishes by hand.
 *   - All browser actions go through r177 humanizer → spend-lock applies
 *     to every sign-up/sign-in flow.
 *
 * Warm-up curves (conservative business-account growth):
 *   tiktok    14 days: scroll-only → like → follow → comment → post
 *   instagram 14 days: scroll → like → follow → comment → post
 *   youtube   10 days: watch → sub → comment → upload
 *   x         7 days:  read → like → reply → follow → post
 *
 * After warm-up: cadence ramps to the platform daily caps from r177's
 * humanizer profile — meaning maximum sustainable volume per platform.
 */
import { db } from '../db/client.js'
import {
  managedAccount, warmupPlan, warmupDay, secretsVault,
} from '../db/schema.js'
import { and, eq, desc, sql, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Warm-up curves ──────────────────────────────────────────────────

type Target = { kind: string; count: number }

const WARMUP_CURVES: Record<string, Array<{ day: number; targets: Target[] }>> = {
  tiktok: [
    { day:  1, targets: [{ kind: 'scroll', count: 30 }] },
    { day:  2, targets: [{ kind: 'scroll', count: 40 }] },
    { day:  3, targets: [{ kind: 'scroll', count: 50 }, { kind: 'like', count: 10 }] },
    { day:  4, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 25 }] },
    { day:  5, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 50 }, { kind: 'follow', count: 3 }] },
    { day:  6, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 80 }, { kind: 'follow', count: 5 }] },
    { day:  7, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 100 }, { kind: 'follow', count: 8 }, { kind: 'comment', count: 2 }] },
    { day:  8, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 150 }, { kind: 'follow', count: 10 }, { kind: 'comment', count: 5 }] },
    { day:  9, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 200 }, { kind: 'follow', count: 15 }, { kind: 'comment', count: 10 }] },
    { day: 10, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 250 }, { kind: 'follow', count: 18 }, { kind: 'comment', count: 15 }, { kind: 'post', count: 1 }] },
    { day: 11, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 300 }, { kind: 'follow', count: 20 }, { kind: 'comment', count: 20 }, { kind: 'post', count: 1 }] },
    { day: 12, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 300 }, { kind: 'follow', count: 25 }, { kind: 'comment', count: 30 }, { kind: 'post', count: 2 }] },
    { day: 13, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 350 }, { kind: 'follow', count: 28 }, { kind: 'comment', count: 40 }, { kind: 'post', count: 3 }] },
    { day: 14, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 400 }, { kind: 'follow', count: 30 }, { kind: 'comment', count: 50 }, { kind: 'post', count: 4 }] },
  ],
  instagram: [
    { day:  1, targets: [{ kind: 'scroll', count: 30 }] },
    { day:  2, targets: [{ kind: 'scroll', count: 40 }, { kind: 'like', count: 15 }] },
    { day:  3, targets: [{ kind: 'scroll', count: 50 }, { kind: 'like', count: 30 }] },
    { day:  4, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 50 }, { kind: 'follow', count: 3 }] },
    { day:  5, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 75 }, { kind: 'follow', count: 5 }] },
    { day:  6, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 100 }, { kind: 'follow', count: 8 }, { kind: 'comment', count: 3 }] },
    { day:  7, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 150 }, { kind: 'follow', count: 10 }, { kind: 'comment', count: 6 }] },
    { day:  8, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 200 }, { kind: 'follow', count: 15 }, { kind: 'comment', count: 10 }] },
    { day:  9, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 250 }, { kind: 'follow', count: 18 }, { kind: 'comment', count: 15 }, { kind: 'post', count: 1 }] },
    { day: 10, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 300 }, { kind: 'follow', count: 22 }, { kind: 'comment', count: 25 }, { kind: 'post', count: 1 }] },
    { day: 11, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 350 }, { kind: 'follow', count: 25 }, { kind: 'comment', count: 35 }, { kind: 'post', count: 2 }] },
    { day: 12, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 400 }, { kind: 'follow', count: 28 }, { kind: 'comment', count: 50 }, { kind: 'post', count: 2 }] },
    { day: 13, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 400 }, { kind: 'follow', count: 30 }, { kind: 'comment', count: 60 }, { kind: 'post', count: 3 }] },
    { day: 14, targets: [{ kind: 'scroll', count: 60 }, { kind: 'like', count: 400 }, { kind: 'follow', count: 30 }, { kind: 'comment', count: 80 }, { kind: 'post', count: 3 }] },
  ],
  youtube: [
    { day:  1, targets: [{ kind: 'watch', count: 5 }] },
    { day:  2, targets: [{ kind: 'watch', count: 10 }, { kind: 'like', count: 5 }] },
    { day:  3, targets: [{ kind: 'watch', count: 15 }, { kind: 'like', count: 10 }, { kind: 'subscribe', count: 2 }] },
    { day:  4, targets: [{ kind: 'watch', count: 20 }, { kind: 'like', count: 20 }, { kind: 'subscribe', count: 5 }] },
    { day:  5, targets: [{ kind: 'watch', count: 20 }, { kind: 'like', count: 40 }, { kind: 'subscribe', count: 8 }, { kind: 'comment', count: 2 }] },
    { day:  6, targets: [{ kind: 'watch', count: 25 }, { kind: 'like', count: 60 }, { kind: 'subscribe', count: 12 }, { kind: 'comment', count: 5 }] },
    { day:  7, targets: [{ kind: 'watch', count: 30 }, { kind: 'like', count: 100 }, { kind: 'subscribe', count: 15 }, { kind: 'comment', count: 10 }, { kind: 'post', count: 1 }] },
    { day:  8, targets: [{ kind: 'watch', count: 30 }, { kind: 'like', count: 150 }, { kind: 'subscribe', count: 18 }, { kind: 'comment', count: 20 }, { kind: 'post', count: 2 }] },
    { day:  9, targets: [{ kind: 'watch', count: 30 }, { kind: 'like', count: 180 }, { kind: 'subscribe', count: 22 }, { kind: 'comment', count: 40 }, { kind: 'post', count: 3 }] },
    { day: 10, targets: [{ kind: 'watch', count: 30 }, { kind: 'like', count: 200 }, { kind: 'subscribe', count: 25 }, { kind: 'comment', count: 60 }, { kind: 'post', count: 4 }] },
  ],
  x: [
    { day: 1, targets: [{ kind: 'read', count: 30 }, { kind: 'like', count: 20 }] },
    { day: 2, targets: [{ kind: 'read', count: 50 }, { kind: 'like', count: 50 }, { kind: 'follow', count: 5 }] },
    { day: 3, targets: [{ kind: 'read', count: 60 }, { kind: 'like', count: 100 }, { kind: 'follow', count: 10 }, { kind: 'reply', count: 3 }] },
    { day: 4, targets: [{ kind: 'like', count: 200 }, { kind: 'follow', count: 15 }, { kind: 'reply', count: 10 }, { kind: 'post', count: 3 }] },
    { day: 5, targets: [{ kind: 'like', count: 300 }, { kind: 'follow', count: 25 }, { kind: 'reply', count: 25 }, { kind: 'post', count: 8 }] },
    { day: 6, targets: [{ kind: 'like', count: 400 }, { kind: 'follow', count: 30 }, { kind: 'reply', count: 40 }, { kind: 'post', count: 15 }] },
    { day: 7, targets: [{ kind: 'like', count: 500 }, { kind: 'follow', count: 40 }, { kind: 'reply', count: 60 }, { kind: 'post', count: 25 }] },
  ],
}

// ─── Account CRUD ────────────────────────────────────────────────────

export interface AddAccountInput {
  platform:    string
  handle:      string
  displayName?: string
  /** Plaintext supplied once. Stored encrypted in secrets_vault; never returned again. */
  username:    string
  password:    string
  totpSeed?:   string
  requires2fa?: boolean
  businessId?: string
  role?:       'primary' | 'secondary'
}

export async function accountAdd(workspaceId: string, input: AddAccountInput): Promise<{ id: string }> {
  if (!input.platform || !input.handle || !input.username || !input.password) throw new Error('platform + handle + username + password required')
  if (!['tiktok', 'instagram', 'youtube', 'x'].includes(input.platform)) throw new Error('platform must be tiktok|instagram|youtube|x')

  // Store credentials in vault.
  const { storeSecret } = await import('./secrets-vault.js')
  const userSecretId = await storeSecret({
    workspaceId, name: `account_user:${input.platform}:${input.handle}`,
    provider: input.platform, value: input.username, createdBy: 'r178-managed-accounts',
  } as Parameters<typeof storeSecret>[0])
  const passSecretId = await storeSecret({
    workspaceId, name: `account_pass:${input.platform}:${input.handle}`,
    provider: input.platform, value: input.password, createdBy: 'r178-managed-accounts',
  } as Parameters<typeof storeSecret>[0])
  let totpSecretId: string | null = null
  if (input.totpSeed) {
    totpSecretId = await storeSecret({
      workspaceId, name: `account_totp:${input.platform}:${input.handle}`,
      provider: input.platform, value: input.totpSeed, createdBy: 'r178-managed-accounts',
    } as Parameters<typeof storeSecret>[0])
  }

  const id = uuidv7()
  const now = Date.now()
  await db.insert(managedAccount).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    platform: input.platform,
    handle: input.handle.replace(/^@/, ''),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    role: input.role ?? 'primary',
    vaultUserSecretId: userSecretId,
    vaultPassSecretId: passSecretId,
    ...(totpSecretId ? { vaultTotpSecretId: totpSecretId } : {}),
    requires2fa: input.requires2fa ?? false,
    status: 'warming',
    health: 'unknown',
    createdAt: now, updatedAt: now,
  })
  return { id }
}

export async function accountList(workspaceId: string, opts: { status?: string; platform?: string; limit?: number } = {}): Promise<Array<Omit<typeof managedAccount.$inferSelect, 'vaultUserSecretId' | 'vaultPassSecretId' | 'vaultTotpSecretId'>>> {
  const filters = [eq(managedAccount.workspaceId, workspaceId)]
  if (opts.status)   filters.push(eq(managedAccount.status, opts.status))
  if (opts.platform) filters.push(eq(managedAccount.platform, opts.platform))
  const rows = await db.select().from(managedAccount).where(and(...filters)).orderBy(desc(managedAccount.createdAt)).limit(Math.min(opts.limit ?? 50, 500))
  // Strip vault ids from output.
  return rows.map(r => {
    const { vaultUserSecretId: _u, vaultPassSecretId: _p, vaultTotpSecretId: _t, ...rest } = r
    void _u; void _p; void _t
    return rest
  })
}

export async function accountPause(workspaceId: string, accountId: string): Promise<{ ok: boolean }> {
  const r = await db.update(managedAccount).set({ status: 'paused', updatedAt: Date.now() })
    .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.id, accountId)))
    .returning({ id: managedAccount.id })
  return { ok: r.length > 0 }
}

// ─── Warmup plan ─────────────────────────────────────────────────────

export async function warmupPlanCreate(workspaceId: string, accountId: string): Promise<{ planId: string; dayCount: number } | { error: string }> {
  const [acct] = await db.select().from(managedAccount)
    .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.id, accountId))).limit(1)
  if (!acct) return { error: 'account not found' }
  const curve = WARMUP_CURVES[acct.platform]
  if (!curve) return { error: `no warmup curve for platform ${acct.platform}` }

  const planId = uuidv7()
  const now = Date.now()
  await db.insert(warmupPlan).values({
    id: planId, workspaceId, accountId,
    platform: acct.platform, dayCount: curve.length, curve,
    startedAt: now, status: 'running',
  })
  // Pre-seed warmup_day rows.
  for (const d of curve) {
    await db.insert(warmupDay).values({
      id: uuidv7(), workspaceId, planId,
      dayIndex: d.day, targets: d.targets, completed: {},
      status: 'pending',
    })
  }
  await db.update(managedAccount).set({
    status: 'warming', warmupStartedAt: now, warmupDayIndex: 0, updatedAt: now,
  }).where(eq(managedAccount.id, accountId))
  return { planId, dayCount: curve.length }
}

/**
 * Mark today's warmup day as complete with the executed counts. The
 * actual interaction loop runs via r177 browser.humanize.action — this
 * fn is the bookkeeping. When the last day completes, account is
 * promoted to 'active' and freed to run at full cadence.
 */
export async function warmupTick(workspaceId: string, accountId: string, completed: Record<string, number>): Promise<{ ok: boolean; dayIndex?: number; planCompleted?: boolean }> {
  const [acct] = await db.select().from(managedAccount)
    .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.id, accountId))).limit(1)
  if (!acct) return { ok: false }
  const [plan] = await db.select().from(warmupPlan)
    .where(and(eq(warmupPlan.workspaceId, workspaceId), eq(warmupPlan.accountId, accountId), eq(warmupPlan.status, 'running')))
    .orderBy(desc(warmupPlan.startedAt)).limit(1)
  if (!plan) return { ok: false }

  const day = acct.warmupDayIndex + 1
  await db.update(warmupDay).set({
    completed,
    status: 'done',
    executedAt: Date.now(),
  }).where(and(eq(warmupDay.planId, plan.id), eq(warmupDay.dayIndex, day)))

  const now = Date.now()
  const planCompleted = day >= plan.dayCount
  await db.update(managedAccount).set({
    warmupDayIndex: day,
    ...(planCompleted ? {
      status: 'active', warmupCompletedAt: now, health: 'healthy',
    } : {}),
    updatedAt: now,
  }).where(eq(managedAccount.id, accountId))
  if (planCompleted) {
    await db.update(warmupPlan).set({ status: 'completed', completedAt: now }).where(eq(warmupPlan.id, plan.id))
  }
  return { ok: true, dayIndex: day, planCompleted }
}

export async function warmupStatus(workspaceId: string, accountId: string): Promise<{ ok: boolean; account?: Omit<typeof managedAccount.$inferSelect, 'vaultUserSecretId' | 'vaultPassSecretId' | 'vaultTotpSecretId'>; plan?: typeof warmupPlan.$inferSelect; days?: Array<typeof warmupDay.$inferSelect> }> {
  const [acct] = await db.select().from(managedAccount)
    .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.id, accountId))).limit(1)
  if (!acct) return { ok: false }
  const [plan] = await db.select().from(warmupPlan)
    .where(and(eq(warmupPlan.workspaceId, workspaceId), eq(warmupPlan.accountId, accountId)))
    .orderBy(desc(warmupPlan.startedAt)).limit(1)
  const days = plan
    ? await db.select().from(warmupDay).where(eq(warmupDay.planId, plan.id)).orderBy(warmupDay.dayIndex)
    : []
  const { vaultUserSecretId: _u, vaultPassSecretId: _p, vaultTotpSecretId: _t, ...account } = acct
  void _u; void _p; void _t
  return { ok: true, account, ...(plan ? { plan } : {}), days }
}

// ─── Sign-in (humanized) ─────────────────────────────────────────────

const LOGIN_URLS: Record<string, string> = {
  tiktok:    'https://www.tiktok.com/login/phone-or-email/email',
  instagram: 'https://www.instagram.com/accounts/login/',
  youtube:   'https://accounts.google.com/ServiceLogin?service=youtube',
  x:         'https://x.com/i/flow/login',
}

const LOGIN_SELECTORS: Record<string, { user: string; pass: string; submit: string; success: string }> = {
  tiktok:    { user: 'input[name="username"]',    pass: 'input[type="password"]', submit: 'button[type="submit"]',                       success: '[data-e2e="profile-icon"]' },
  instagram: { user: 'input[name="username"]',    pass: 'input[name="password"]', submit: 'button[type="submit"]',                       success: 'svg[aria-label="Home"]' },
  youtube:   { user: 'input[type="email"]',       pass: 'input[type="password"]', submit: '#identifierNext, #passwordNext',              success: 'ytd-topbar-menu-button-renderer' },
  x:         { user: 'input[autocomplete="username"]', pass: 'input[autocomplete="current-password"]', submit: 'button[data-testid="LoginForm_Login_Button"]', success: '[data-testid="SideNav_AccountSwitcher_Button"]' },
}

/**
 * Sign in to a managed account. Returns requires_human: true when a
 * CAPTCHA or 2FA challenge is detected; in that case the operator must
 * finish in the live browser session. No CAPTCHA solving is attempted.
 */
export async function accountSignIn(workspaceId: string, opts: { accountId: string; sessionId: string }): Promise<{ ok: boolean; requires_human?: boolean; error?: string }> {
  const [acct] = await db.select().from(managedAccount)
    .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.id, opts.accountId))).limit(1)
  if (!acct) return { ok: false, error: 'account not found' }

  const { revealSecret } = await import('./secrets-vault.js')
  const user = await revealSecret(acct.vaultUserSecretId, 'system:r178-signin', `sign in to ${acct.platform}:${acct.handle}`)
  const pass = await revealSecret(acct.vaultPassSecretId, 'system:r178-signin', `sign in to ${acct.platform}:${acct.handle}`)
  if (!user || !pass) return { ok: false, error: 'vault decode failed' }

  const url = LOGIN_URLS[acct.platform]
  const sel = LOGIN_SELECTORS[acct.platform]
  if (!url || !sel) return { ok: false, error: `no login template for ${acct.platform}` }

  const { humanizeAction } = await import('./r177-browser-humanizer.js')
  const ctx = { sessionId: opts.sessionId, accountId: opts.accountId, platform: acct.platform }

  const nav = await humanizeAction(workspaceId, { ...ctx, kind: 'navigate', target: url })
  if (nav.spendBlocked) return { ok: false, error: nav.error ?? 'spend-locked' }
  if (!nav.ok) return { ok: false, error: nav.error ?? 'navigate failed' }
  if (nav.tosWarning === 'captcha-encountered') return { ok: false, requires_human: true, error: 'captcha-on-load' }

  const userFill = await humanizeAction(workspaceId, { ...ctx, kind: 'fill', target: sel.user, value: user })
  if (!userFill.ok) return { ok: false, error: userFill.error ?? 'user fill failed' }

  // For YouTube/Google, the user field has an interstitial "Next" before the password appears.
  if (acct.platform === 'youtube') {
    await humanizeAction(workspaceId, { ...ctx, kind: 'click', target: '#identifierNext' })
    await humanizeAction(workspaceId, { ...ctx, kind: 'wait', waitMs: 2000 })
  }

  const passFill = await humanizeAction(workspaceId, { ...ctx, kind: 'fill', target: sel.pass, value: pass })
  if (!passFill.ok) return { ok: false, error: passFill.error ?? 'pass fill failed' }

  const submit = await humanizeAction(workspaceId, { ...ctx, kind: 'click', target: sel.submit })
  if (!submit.ok) return { ok: false, error: submit.error ?? 'submit failed' }

  // Wait a humanish gap, then check success marker.
  await humanizeAction(workspaceId, { ...ctx, kind: 'wait', waitMs: 4000 })
  const verify = await humanizeAction(workspaceId, { ...ctx, kind: 'read', target: sel.success })
  if (verify.tosWarning === 'captcha-encountered') return { ok: false, requires_human: true, error: 'captcha-post-submit' }
  if (!verify.ok) {
    // 2FA or other challenge most likely.
    if (acct.requires2fa) return { ok: false, requires_human: true, error: 'awaiting 2FA code (operator must enter)' }
    return { ok: false, error: 'signin verification failed — operator should check' }
  }

  await db.update(managedAccount).set({
    lastSigninAt: Date.now(), updatedAt: Date.now(), health: 'healthy', lastHealthAt: Date.now(),
  }).where(eq(managedAccount.id, opts.accountId))
  return { ok: true }
}

/**
 * Account creation flow is a high-risk operation. This function opens
 * the registration page but does NOT auto-fill. Operator confirms +
 * supplies username/password/email through accountAdd() AFTER the
 * platform's signup flow is complete (the platform itself will have
 * sent the verification email etc.). Novan does not bypass platform
 * onboarding gates (CAPTCHA, phone verification, email verify).
 */
export async function accountSignUpOpen(workspaceId: string, opts: { platform: string; sessionId: string; confirm: string }): Promise<{ ok: boolean; signupUrl?: string; error?: string }> {
  if (opts.confirm !== 'I_AUTHORIZE_ACCOUNT_CREATION') {
    return { ok: false, error: 'confirm token required: send confirm="I_AUTHORIZE_ACCOUNT_CREATION"' }
  }
  const SIGNUP_URLS: Record<string, string> = {
    tiktok:    'https://www.tiktok.com/signup',
    instagram: 'https://www.instagram.com/accounts/emailsignup/',
    youtube:   'https://accounts.google.com/signup',
    x:         'https://x.com/i/flow/signup',
  }
  const url = SIGNUP_URLS[opts.platform]
  if (!url) return { ok: false, error: `no signup url for ${opts.platform}` }
  const { humanizeAction } = await import('./r177-browser-humanizer.js')
  const nav = await humanizeAction(workspaceId, { sessionId: opts.sessionId, platform: opts.platform, kind: 'navigate', target: url })
  if (!nav.ok) return { ok: false, error: nav.error ?? 'navigate failed', signupUrl: url }
  return { ok: true, signupUrl: url }
}

// ─── Max-volume cadence helper ───────────────────────────────────────

/**
 * Return the maximum daily targets for an active account, given the
 * humanizer profile caps. For warming accounts, return the current
 * day's curve targets (smaller). Used by the scheduler to push at the
 * highest safe rate.
 */
export async function maxDailyTargets(workspaceId: string, accountId: string): Promise<{ status: string; dayIndex: number; targets: Target[] } | { error: string }> {
  const [acct] = await db.select().from(managedAccount)
    .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.id, accountId))).limit(1)
  if (!acct) return { error: 'account not found' }

  if (acct.status === 'warming') {
    const curve = WARMUP_CURVES[acct.platform] ?? []
    const day = curve[Math.max(0, Math.min(curve.length - 1, acct.warmupDayIndex))]
    return { status: 'warming', dayIndex: acct.warmupDayIndex, targets: day?.targets ?? [] }
  }
  if (acct.status !== 'active') return { error: `status=${acct.status} — only 'active' accounts can run at full cadence` }

  // Pull humanizer profile caps for this platform.
  const { profileGet } = await import('./r177-browser-humanizer.js')
  const prof = await profileGet(workspaceId, accountId)
  const caps = ((prof.dailyCaps ?? {}) as Record<string, Record<string, number>>)[acct.platform] ?? {}
  const targets: Target[] = Object.entries(caps).map(([kind, count]) => ({ kind, count }))
  return { status: 'active', dayIndex: acct.warmupDayIndex, targets }
}

// ─── Reads ───────────────────────────────────────────────────────────

export async function pendingWarmupTicks(workspaceId: string): Promise<Array<{ accountId: string; platform: string; dayIndex: number }>> {
  const rows = await db.select({
    accountId: managedAccount.id, platform: managedAccount.platform, dayIndex: managedAccount.warmupDayIndex,
  })
    .from(managedAccount)
    .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.status, 'warming'), isNull(managedAccount.warmupCompletedAt)))
  return rows
}

void sql
