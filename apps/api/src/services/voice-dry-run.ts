/**
 * voice-dry-run.ts — simulate a voice command's effect before any
 * execution. Two layers:
 *
 *   1. `simulate(plan, command)` — PURE. Returns a `DryRunReport`
 *      describing exactly what would happen: planned steps, risk score,
 *      cost estimate, permissions, browser preview (when applicable),
 *      blocked actions, rollback strategy, and the spoken preview text.
 *
 *   2. DB-backed lifecycle: `recordDryRun → approveDryRun (spoken+UI) →
 *      executeDryRun`. A run must be approved through BOTH spoken AND
 *      UI channels before `executeDryRun` will let the side effect run.
 *      Every state transition emits an audit `voice.dry_run.*` event.
 *
 * Rules enforced here (not only in the UI):
 *   - No silent execution: only `executeDryRun()` runs the side effect,
 *     and only after explicit dual-channel approval.
 *   - No purchases / payment / destructive account actions: re-checked
 *     here as a defense-in-depth, even though `classifyCommand()` runs
 *     earlier in the pipeline.
 *   - Browser intents always produce a browser preview that explicitly
 *     enumerates blocked field categories (payment, checkout, destructive)
 *     so the operator sees exactly what Novan would NOT do.
 *   - Audit: every dry-run row is queryable and every transition emits
 *     an event.
 */
import { db } from '../db/client.js'
import { voiceDryRuns, events } from '../db/schema.js'
import { and, eq, desc, gte, lt, inArray } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { ActionPlan } from './voice-command-router.js'
import { classifyCommand } from './voice-safety.js'
import { runPreflight, type GuardDecision } from './budget-guard.js'
import { checkConstitution } from './ai-constitution.js'

// ─── Typed browser action plan ──────────────────────────────────────────
// Shared message shape between dry-run and the browser worker. The worker
// MUST honor `blockedFieldCategories` and `blockedClickCategories`; any
// attempt to fill / click a blocked category is a worker bug, not a
// safety bug. Persisted on the dry-run row so post-mortems can prove the
// contract Novan handed to the worker.

export interface BrowserActionPlan {
  version:                 1
  url:                     string | null
  account:                 string | null
  /** Whether the worker is allowed to do anything at all. */
  allowed:                 boolean
  /** What the worker is asked to do. Read-only operations only — Novan
   *  never describes typing payment or credentials. */
  plannedClicks:           string[]
  plannedFields:           Array<{ field: string; valueHint: string; sensitive: boolean }>
  /** Categories the worker is FORBIDDEN to interact with even if asked. */
  blockedFieldCategories:  string[]
  blockedClickCategories:  string[]
  /** Hard refusal reason — when set the worker must close the session. */
  refusalReason:           string | null
}

export type DryRunStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'expired'

export interface BrowserPreview {
  url:                  string | null
  account:              string | null         // operator-supplied account hint, if any
  plannedClicks:        string[]              // human-readable
  plannedFields:        Array<{ field: string; valueHint: string; sensitive: boolean }>
  blockedFieldCategories: string[]            // payment, checkout, destructive
  blockedClickCategories: string[]            // "Buy", "Subscribe", "Delete account"…
  /** Hard refusal — if true the dry-run will never approve, regardless of operator. */
  fullyBlocked:         boolean
  reason:               string | null
}

export interface BudgetVerdict {
  approved:    boolean
  blockReason: string | null
  capId:       string | null
  guardId:     string | null
  estimatedCostUsd: number
}

export interface DryRunReport {
  command:             string
  intentKind:          string
  intentTarget:        string | null
  verdict:             ActionPlan['verdict']
  risk:                ActionPlan['risk']
  riskScore:           number                 // 0..1
  estimatedCostUsd:    number
  permissions:         string[]
  plannedSteps:        string[]
  browserPreview:      BrowserPreview | null
  browserActionPlan:   BrowserActionPlan | null
  affectedSystems:     string[]
  blockedActions:      string[]
  rollbackAvailable:   boolean
  rollbackStrategy:    string | null
  spokenPreview:       string
  /** True for plans that need an explicit dual-channel approval. */
  requiresApproval:    boolean
  /** True if the command is hard-blocked at the safety layer. */
  hardBlocked:         boolean
  /** Original execute hook from the routed plan — frozen at simulate time
   *  so the server executor can replay it later. */
  executeHook:         { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> } | null
  /** Budget guard decision; null when not applicable. */
  budgetDecision:      BudgetVerdict | null
}

// ─── Step planners per intent kind ──────────────────────────────────────

const PERMISSION_BY_INTENT: Record<string, string[]> = {
  'research.pause':  ['agents.control'],
  'agent.pause':     ['agents.control'],
  'agent.audit':     ['agents.audit'],
  'browser.open':    ['browser.use'],
  'image.generate':  ['image.generate'],
  'research.start':  ['agents.run'],
}
const COST_BY_INTENT: Record<string, number> = {
  'research.start': 0.40,
  'research.pause': 0.00,
  'agent.pause':    0.00,
  'agent.audit':    0.05,
  'browser.open':   0.02,
  'image.generate': 0.10,
}
/** Roughly which top-level systems a plan touches. Used for the UI's
 * "affected accounts/systems" list. */
const AFFECTED_BY_INTENT: Record<string, string[]> = {
  'research.start':  ['research', 'memory', 'budget'],
  'research.pause':  ['research'],
  'agent.pause':     ['agents'],
  'agent.audit':     ['agents', 'security'],
  'browser.open':    ['browser_control'],
  'image.generate':  ['image_studio', 'budget'],
}
const ROLLBACK_STRATEGY: Record<string, string> = {
  'research.start':  'cancel queued job before first LLM call',
  'research.pause':  'resume from /agents page',
  'agent.pause':     'resume from /agents page',
  'agent.audit':     'audit is read-only — no rollback needed',
  'browser.open':    'close browser session; no persistent state',
  'image.generate':  'discard generated draft from /image-studio',
}

/** Browser-action sensitivity classifier — these never auto-execute. */
const PAYMENT_RE     = /\b(card|credit|cvv|cvc|expiry|expiration|billing|pay(?:ment)?|checkout|purchase|order)\b/i
const ACCOUNT_RE     = /\b(account|profile|email|password|login|sign[- ]?in|2fa|mfa|otp)\b/i
const DESTRUCTIVE_RE = /\b(delete|remove|deactivate|close account|cancel subscription|wipe|drop)\b/i

function toBrowserActionPlan(preview: BrowserPreview): BrowserActionPlan {
  return {
    version: 1,
    url:                    preview.url,
    account:                preview.account,
    allowed:                !preview.fullyBlocked,
    plannedClicks:          preview.plannedClicks,
    plannedFields:          preview.plannedFields,
    blockedFieldCategories: preview.blockedFieldCategories,
    blockedClickCategories: preview.blockedClickCategories,
    refusalReason:          preview.fullyBlocked ? preview.reason : null,
  }
}

function planBrowserPreview(command: string, planExecute: ActionPlan['execute']): BrowserPreview {
  const url = (planExecute?.body as { url?: string } | undefined)?.url ?? null
  const blockedFieldCategories: string[] = []
  const blockedClickCategories: string[] = []
  if (PAYMENT_RE.test(command) || (url && PAYMENT_RE.test(url))) {
    blockedFieldCategories.push('payment')
    blockedClickCategories.push('checkout', 'buy', 'subscribe')
  }
  if (ACCOUNT_RE.test(command)) {
    blockedFieldCategories.push('account_credentials')
    blockedClickCategories.push('sign-in', 'change password')
  }
  if (DESTRUCTIVE_RE.test(command)) {
    blockedFieldCategories.push('destructive')
    blockedClickCategories.push('delete', 'close account')
  }
  const fullyBlocked = blockedFieldCategories.includes('payment') || blockedFieldCategories.includes('destructive')

  // We never auto-fill anything sensitive; the operator must use the web
  // UI for those. Planned steps describe what the browser worker WOULD
  // be asked to do, not what we actually allow.
  const plannedClicks = [
    'open the URL in an isolated browser session',
    'capture page content for the operator',
  ]
  return {
    url,
    account: null,
    plannedClicks,
    plannedFields: [],
    blockedFieldCategories,
    blockedClickCategories,
    fullyBlocked,
    reason: fullyBlocked
      ? 'Payment / destructive categories detected — voice cannot authorize this.'
      : null,
  }
}

function planSteps(plan: ActionPlan): string[] {
  const intent = plan.intent.kind
  const target = plan.intent.target ?? null
  if (intent.startsWith('brain.')) {
    const params = plan.navigate?.params ?? {}
    const url = `/brain${Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''}`
    return [
      `navigate to ${url}`,
      ...(params.focus ? [`focus camera on "${params.focus}"`] : []),
      ...(params.template ? [`switch layout template to "${params.template}"`] : []),
      ...(params.lod ? [`set LOD to "${params.lod}"`] : []),
      ...(params.node ? [`open detail drawer for "${params.node}"`] : []),
      ...(params.replay_at ? [`scrub timeline to ${new Date(Number(params.replay_at)).toISOString()}`] : []),
    ]
  }
  if (intent === 'research.start')   return [`enqueue research job${target ? ` on "${target}"` : ''}`, 'allocate token budget', 'spawn researcher agents (asynchronous)']
  if (intent === 'research.pause')   return ['signal all running research workers to halt', 'preserve partial findings to memory']
  if (intent === 'agent.pause') {
    const scope = String(plan.intent.args['scope'] ?? 'all')
    return [`set ${scope} agents to paused`, 'queued work remains in BullMQ', 'no jobs cancelled — resume restores state']
  }
  if (intent === 'agent.audit')      return ['scan active agent runs', 'check recent patches for safety regressions', 'produce audit report (read-only)']
  if (intent === 'image.generate')   return ['enqueue image-gen job', 'render draft (not auto-published)', 'place result in /image-studio queue']
  if (intent === 'browser.open') {
    const url = (plan.execute?.body as { url?: string } | undefined)?.url ?? 'the target URL'
    return [`spawn isolated browser worker`, `navigate to ${url}`, 'capture page state and return']
  }
  if (intent === 'war_room.today')   return ['aggregate today\'s events from runtime + economy + governance', 'return short summary']
  if (intent.startsWith('war_room.') || intent.startsWith('exec.')) return ['read-only aggregation; no side effects']
  return ['no further side effects — read-only']
}

function riskScore(plan: ActionPlan, blockedCount: number): number {
  let s = 0
  if (plan.risk === 'high')   s += 0.7
  if (plan.risk === 'medium') s += 0.4
  if (plan.risk === 'low')    s += 0.1
  if (plan.verdict === 'confirm') s += 0.15
  if (plan.verdict === 'reject')  s = 1
  if (blockedCount > 0) s += 0.15
  return Math.min(1, Number(s.toFixed(2)))
}

function spokenPreview(intent: string, risk: string, hardBlocked: boolean, browserBlocked: boolean): string {
  if (hardBlocked) return 'Refusing. This action is hard-blocked. No purchase or payment action will be taken.'
  const lead =
    risk === 'high'   ? 'Here is what I would do — this is high risk.' :
    risk === 'medium' ? 'Here is what I would do.' :
    'Here is what I would do.'
  const guard = browserBlocked
    ? 'No purchase, payment, or destructive account action will be taken.'
    : 'No purchase or payment action will be taken.'
  return `${lead} This requires approval. ${guard} Confirm if you want me to continue.`
}

/**
 * Pure simulator. Given a routed plan + the original transcript, return
 * a complete dry-run report. Never throws; never executes side effects.
 */
export function simulate(plan: ActionPlan, command: string): DryRunReport {
  const safety = classifyCommand(command)
  const hardBlocked = safety.kind === 'block' || plan.verdict === 'reject'

  const intent = plan.intent.kind
  const target = plan.intent.target ?? null
  const permissions = (plan.permission ? [plan.permission] : PERMISSION_BY_INTENT[intent]) ?? []
  const affectedSystems = AFFECTED_BY_INTENT[intent] ?? (intent.startsWith('brain.') ? ['brain'] : intent.startsWith('war_room.') ? ['war_room'] : [])
  const browserPreview = intent === 'browser.open' ? planBrowserPreview(command, plan.execute) : null

  const blockedActions: string[] = []
  if (hardBlocked) blockedActions.push(safety.kind === 'block' ? `hard-block:${safety.matched}` : 'hard-block:safety_classifier')
  if (browserPreview?.fullyBlocked) blockedActions.push('browser-preview:fully_blocked')
  if (browserPreview?.blockedFieldCategories.length) {
    for (const c of browserPreview.blockedFieldCategories) blockedActions.push(`browser-field:${c}`)
  }

  const steps = planSteps(plan)
  const rollbackStrategy = ROLLBACK_STRATEGY[intent] ?? null
  const rollbackAvailable = !!rollbackStrategy && !hardBlocked

  return {
    command,
    intentKind:        intent,
    intentTarget:      target,
    verdict:           plan.verdict,
    risk:              plan.risk,
    riskScore:         riskScore(plan, blockedActions.length),
    estimatedCostUsd:  COST_BY_INTENT[intent] ?? 0,
    permissions,
    plannedSteps:      steps,
    browserPreview,
    browserActionPlan: browserPreview ? toBrowserActionPlan(browserPreview) : null,
    affectedSystems,
    blockedActions,
    rollbackAvailable,
    rollbackStrategy,
    spokenPreview:     spokenPreview(intent, plan.risk, hardBlocked, !!browserPreview?.fullyBlocked),
    requiresApproval:  plan.verdict === 'confirm' || (browserPreview !== null && !browserPreview.fullyBlocked),
    hardBlocked,
    executeHook:       plan.execute ? {
      method: plan.execute.method, path: plan.execute.path,
      ...(plan.execute.body ? { body: plan.execute.body } : {}),
    } : null,
    budgetDecision:    null,                  // populated later by recordDryRun via runPreflight
  }
}

/**
 * When the route handler sees a non-trivial mutating plan, it should
 * invoke a dry-run rather than executing directly. This helper makes
 * the rule explicit so the route stays small.
 */
export function shouldDryRun(plan: ActionPlan): boolean {
  if (plan.verdict === 'reject')   return false       // hard-blocks return immediately
  if (plan.verdict === 'navigate') return false       // navigations are revertible
  if (plan.verdict === 'execute')  return false       // read-only / safe execute path
  // verdict === 'confirm'
  return plan.risk !== 'low' || plan.intent.kind === 'browser.open' || plan.intent.kind === 'agent.pause'
}

// ─── DB lifecycle ───────────────────────────────────────────────────────

const TTL_MS = 5 * 60_000

async function emitAudit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/voice-dry-run', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[voice-dry-run]', e.message); return null })
}

export interface RecordDryRunInput {
  workspaceId: string
  userId?:     string | null
  sessionId?:  string | null
  command:     string
  plan:        ActionPlan
}

export async function recordDryRun(input: RecordDryRunInput): Promise<{ id: string; report: DryRunReport }> {
  const report = simulate(input.plan, input.command)
  const id = uuidv7()
  const now = Date.now()

  // ─── Real budget preflight ────────────────────────────────────────────
  // Run the budget guard against the heuristic cost estimate so the
  // operator sees an authoritative {approved, blockReason} before
  // approving. If the guard blocks, the dry-run is immediately rejected.
  let budgetDecision: BudgetVerdict | null = null
  if (!report.hardBlocked && report.estimatedCostUsd > 0) {
    const provider = input.plan.intent.kind          // intent kind doubles as budget scope key
    const guard: GuardDecision | null = await runPreflight({
      workspaceId:       input.workspaceId,
      executionId:       id,
      providerId:        provider,
      scopeType:         'workspace',
      scopeId:           input.workspaceId,
      estimatedCostUsd:  report.estimatedCostUsd,
    }).catch((e: Error) => { console.error('[voice-dry-run]', e.message); return null })
    if (guard) {
      budgetDecision = {
        approved:    guard.approved,
        blockReason: guard.blockReason,
        capId:       guard.capId,
        guardId:     guard.guardId,
        estimatedCostUsd: report.estimatedCostUsd,
      }
      if (!guard.approved) {
        report.blockedActions.push(`budget:${guard.blockReason ?? 'cap_reached'}`)
        // overwrite spoken preview so the operator hears the budget reason
        report.spokenPreview = `Budget refusal: ${guard.blockReason ?? 'cap reached'}. No purchase or payment action will be taken.`
      }
    }
  }
  report.budgetDecision = budgetDecision
  const budgetBlocked = budgetDecision !== null && !budgetDecision.approved
  const finalStatus = report.hardBlocked ? 'rejected' : budgetBlocked ? 'rejected' : 'pending'
  const finalReason = report.hardBlocked ? (report.blockedActions[0] ?? 'hard-blocked')
                    : budgetBlocked        ? `budget:${budgetDecision?.blockReason ?? 'cap_reached'}`
                    : null

  await db.insert(voiceDryRuns).values({
    id,
    workspaceId: input.workspaceId,
    userId:      input.userId ?? null,
    sessionId:   input.sessionId ?? null,
    command:     input.command,
    intentKind:  report.intentKind,
    intentTarget: report.intentTarget,
    verdict:     report.verdict,
    risk:        report.risk,
    riskScore:   report.riskScore,
    estimatedCostUsd: report.estimatedCostUsd,
    permissions:      report.permissions,
    plannedSteps:     report.plannedSteps,
    browserPreview:   report.browserPreview ?? null,
    browserActionPlan: report.browserActionPlan ?? null,
    affectedSystems:  report.affectedSystems,
    blockedActions:   report.blockedActions,
    rollbackAvailable: report.rollbackAvailable,
    rollbackStrategy:  report.rollbackStrategy,
    spokenPreview:     report.spokenPreview,
    status:            finalStatus,
    rejectedReason:    finalReason,
    executeHook:       report.executeHook,
    budgetDecision:    report.budgetDecision,
    createdAt: now,
    expiresAt: now + TTL_MS,
  }).catch((e: Error) => { console.error('[voice-dry-run]', e.message); return null })
  await emitAudit(input.workspaceId, 'voice.dry_run.created', {
    id, command: input.command, intent: report.intentKind, risk: report.risk,
    hardBlocked: report.hardBlocked, budgetApproved: budgetDecision?.approved ?? null,
    blockedActions: report.blockedActions,
  })
  return { id, report }
}

export interface ApproveDryRunInput {
  id:          string
  workspaceId: string
  source:      'spoken' | 'ui'
}

export async function approveDryRun(input: ApproveDryRunInput): Promise<{ ok: boolean; reason?: string; fullyApproved?: boolean }> {
  const row = await db.select().from(voiceDryRuns).where(eq(voiceDryRuns.id, input.id)).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-dry-run]', e.message); return null })
  if (!row)                                   return { ok: false, reason: 'not found' }
  if (row.workspaceId !== input.workspaceId)  return { ok: false, reason: 'workspace mismatch' }
  if (row.status === 'rejected')              return { ok: false, reason: row.rejectedReason ?? 'rejected' }
  if (row.status === 'executed')              return { ok: false, reason: 'already executed' }
  if (row.expiresAt < Date.now()) {
    await db.update(voiceDryRuns).set({ status: 'expired' }).where(eq(voiceDryRuns.id, input.id))
    return { ok: false, reason: 'expired' }
  }
  const next = {
    approvedViaSpoken: row.approvedViaSpoken || input.source === 'spoken',
    approvedViaUi:     row.approvedViaUi     || input.source === 'ui',
    approvedAt:        row.approvedAt ?? null,
    status:            row.status,
  }
  const fullyApproved = next.approvedViaSpoken && next.approvedViaUi
  if (fullyApproved && next.status === 'pending') {
    next.status = 'approved'
    next.approvedAt = Date.now()
  }
  await db.update(voiceDryRuns).set(next).where(eq(voiceDryRuns.id, input.id))
  await emitAudit(input.workspaceId, 'voice.dry_run.approval', {
    id: input.id, source: input.source, fullyApproved,
  })
  return { ok: true, fullyApproved }
}

/**
 * Executor function shape — the route handler supplies one that uses
 * `fastify.inject(...)` so the dispatched call passes through the same
 * auth/rate-limit/middleware chain as a real HTTP request. Tests supply
 * a stub executor that records the dispatched call.
 */
export type DryRunExecutor = (hook: { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }, row: typeof voiceDryRuns.$inferSelect) => Promise<{ status: number; body: unknown }>

export interface ExecuteDryRunInput {
  id:          string
  workspaceId: string
  /** Which channel triggered execute — recorded for audit. */
  via?:        'spoken' | 'ui' | 'server'
  executor?:   DryRunExecutor
}

export async function executeDryRun(input: ExecuteDryRunInput): Promise<{ ok: boolean; reason?: string; result?: unknown; status?: number }> {
  const row = await db.select().from(voiceDryRuns).where(eq(voiceDryRuns.id, input.id)).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-dry-run]', e.message); return null })
  if (!row)                                   return { ok: false, reason: 'not found' }
  if (row.workspaceId !== input.workspaceId)  return { ok: false, reason: 'workspace mismatch' }
  if (row.status !== 'approved')              return { ok: false, reason: `status is ${row.status} — needs dual-channel approval first` }
  if (!row.approvedViaSpoken || !row.approvedViaUi) return { ok: false, reason: 'requires both spoken AND UI approval' }
  if (row.expiresAt < Date.now()) {
    await db.update(voiceDryRuns).set({ status: 'expired' }).where(eq(voiceDryRuns.id, input.id))
    return { ok: false, reason: 'expired before execute' }
  }

  // ── Constitution check — final hard gate before any side effect.
  // Even an approved row cannot run if it would violate an immutable
  // principle (operator sovereignty, auditability, truth, etc.).
  // Records the violation as a rejection so the audit trail is honest.
  const constitution = checkConstitution({
    kind:                    row.intentKind,
    autonomous:              input.via !== 'ui',          // spoken or server → autonomous-ish
    hidesFromOperator:       false,                       // dry-runs are always visible
    reducesOperatorAuthority: row.intentKind.startsWith('agent.pause') && (row.intentTarget === 'all' || row.intentTarget === null),
    modifiesGovernance:      false,
    fabricatesRecord:        false,
    selfModifies:            false,
    risk:                    row.risk as 'low' | 'medium' | 'high',
  })
  if (constitution.verdict === 'block') {
    await db.update(voiceDryRuns).set({
      status: 'rejected',
      rejectedReason: `constitution-block: ${constitution.reason}`,
      executedVia: input.via ?? null,
    }).where(eq(voiceDryRuns.id, input.id))
    await emitAudit(input.workspaceId, 'voice.dry_run.constitution_block', {
      id: input.id, violated: constitution.violated, reason: constitution.reason,
    })
    return { ok: false, reason: `constitution-block: ${constitution.reason}` }
  }

  const hook = row.executeHook as { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> } | null

  // For browser intents we replace the raw hook body with the typed
  // BrowserActionPlan so the worker enforces the contract.
  let dispatched: { status: number; body: unknown } | null = null
  try {
    if (hook && input.executor) {
      let invokeHook = hook
      if (row.intentKind === 'browser.open' && row.browserActionPlan) {
        invokeHook = {
          method: hook.method, path: hook.path,
          body: { ...(hook.body ?? {}), action_plan: row.browserActionPlan },
        }
      }
      dispatched = await input.executor(invokeHook, row)
    }
  } catch (e) {
    await db.update(voiceDryRuns).set({
      status: 'rejected', rejectedReason: `executor failed: ${(e as Error).message}`,
      executedVia: input.via ?? null,
    }).where(eq(voiceDryRuns.id, input.id))
    await emitAudit(input.workspaceId, 'voice.dry_run.execute_failed', { id: input.id, via: input.via, error: (e as Error).message })
    return { ok: false, reason: `executor failed: ${(e as Error).message}` }
  }

  // Treat any non-2xx as a server-side execute failure even if no throw.
  if (dispatched && (dispatched.status < 200 || dispatched.status >= 300)) {
    await db.update(voiceDryRuns).set({
      status: 'rejected',
      rejectedReason: `executor returned ${dispatched.status}`,
      executedVia: input.via ?? null,
      executeResult: dispatched.body as Record<string, unknown>,
    }).where(eq(voiceDryRuns.id, input.id))
    await emitAudit(input.workspaceId, 'voice.dry_run.execute_failed', { id: input.id, via: input.via, status: dispatched.status })
    return { ok: false, reason: `executor returned ${dispatched.status}`, status: dispatched.status, result: dispatched.body }
  }

  await db.update(voiceDryRuns).set({
    status: 'executed', executedAt: Date.now(),
    executeResult: (dispatched?.body ?? null) as Record<string, unknown> | null,
    executedVia:   input.via ?? null,
  }).where(eq(voiceDryRuns.id, input.id))
  await emitAudit(input.workspaceId, 'voice.dry_run.executed', {
    id: input.id, via: input.via, status: dispatched?.status ?? null,
    intent: row.intentKind,
  })
  return { ok: true, result: dispatched?.body ?? null, ...(dispatched?.status !== undefined ? { status: dispatched.status } : {}) }
}

/**
 * Sweep stale pending dry-runs whose expiry has passed. Idempotent;
 * intended for a 60-second cron. Returns how many rows transitioned.
 */
export async function sweepExpiredDryRuns(): Promise<{ expired: number }> {
  const rows = await db.select({ id: voiceDryRuns.id, workspaceId: voiceDryRuns.workspaceId })
    .from(voiceDryRuns)
    .where(and(
      inArray(voiceDryRuns.status, ['pending', 'approved']),
      lt(voiceDryRuns.expiresAt, Date.now()),
    ))
    .limit(500).catch(() => [])
  if (rows.length === 0) return { expired: 0 }
  await db.update(voiceDryRuns).set({ status: 'expired' })
    .where(inArray(voiceDryRuns.id, rows.map(r => r.id))).catch((e: Error) => { console.error('[voice-dry-run]', e.message); return null })
  // Audit (one event per workspace to avoid noise)
  const byWs = new Map<string, number>()
  for (const r of rows) byWs.set(r.workspaceId, (byWs.get(r.workspaceId) ?? 0) + 1)
  for (const [ws, n] of byWs) {
    await emitAudit(ws, 'voice.dry_run.swept_expired', { count: n }).catch((e: Error) => { console.error('[voice-dry-run]', e.message); return null })
  }
  return { expired: rows.length }
}

export async function listDryRuns(workspaceId: string, opts: { limit?: number; sinceMs?: number; status?: DryRunStatus } = {}) {
  const since = Date.now() - (opts.sinceMs ?? 7 * 86_400_000)
  const where = opts.status
    ? and(eq(voiceDryRuns.workspaceId, workspaceId), gte(voiceDryRuns.createdAt, since), eq(voiceDryRuns.status, opts.status))
    : and(eq(voiceDryRuns.workspaceId, workspaceId), gte(voiceDryRuns.createdAt, since))
  return db.select().from(voiceDryRuns).where(where)
    .orderBy(desc(voiceDryRuns.createdAt))
    .limit(opts.limit ?? 50).catch(() => [])
}

export async function getDryRun(id: string, workspaceId: string) {
  return db.select().from(voiceDryRuns)
    .where(and(eq(voiceDryRuns.id, id), eq(voiceDryRuns.workspaceId, workspaceId)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-dry-run]', e.message); return null })
}
