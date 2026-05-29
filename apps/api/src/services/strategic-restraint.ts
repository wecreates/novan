/**
 * strategic-restraint.ts — the "should we act?" guard (#42).
 *
 * The directive explicitly asks Novan to learn when NOT to act, when
 * complexity is unnecessary, and when autonomy is unsafe. This module
 * is a small, deterministic decision layer that other services call
 * BEFORE they fire an alert, queue an automation, or suggest a new
 * recommendation.
 *
 * Pure functions only. Two decisions exposed:
 *
 *   shouldNotifyOperator(load, severity, dedupe)
 *     → answers: "given the operator's current cognitive load and how
 *       loud the recent stream has been, is it appropriate to fire one
 *       more alert?" Returns { allow, reason, suggested_severity }.
 *
 *   shouldAutoAct(plan, load, prefs)
 *     → answers: "should this autonomous action proceed without human
 *       review?" Returns { allow, reason, deferTo } where deferTo is
 *       'operator', 'dry_run', or 'queue'.
 *
 * Both functions are conservative by design: the default answer is
 * "defer / dedupe / require approval" whenever uncertainty is present.
 * That is the spirit of #42 — restraint preserves long-term trust.
 */

export type Severity = 'normal' | 'high' | 'critical'
export type LoadMode = 'calm' | 'normal' | 'deep' | 'overload'

export interface NotifyContext {
  /** Operator's current cognitive load score (0..1) from #18. */
  loadScore:    number
  loadMode:     LoadMode
  /** Notifications already delivered to this operator in the recent window. */
  recentNotifications: number
  /** Time since the operator last cleared their notification tray (ms). */
  msSinceLastAck:      number
  /** True if a notification with the same signature was sent recently. */
  duplicateSignature:  boolean
}

export interface NotifyDecision {
  allow:             boolean
  reason:            string
  suggestedSeverity: Severity
  /** When `allow=false`, when to retry (ms from now). 0 = drop forever. */
  retryAfterMs:      number
}

/**
 * Should we fire one more notification right now? Pure.
 */
export function shouldNotifyOperator(severity: Severity, ctx: NotifyContext): NotifyDecision {
  // Critical alerts always fire (operator safety override) but get
  // de-duplicated against the same signature within 60 s.
  if (severity === 'critical') {
    if (ctx.duplicateSignature) {
      return { allow: false, reason: 'duplicate-critical within window', suggestedSeverity: 'critical', retryAfterMs: 60_000 }
    }
    return { allow: true, reason: 'critical-bypass', suggestedSeverity: 'critical', retryAfterMs: 0 }
  }

  // Overload mode: only critical alerts get through.
  if (ctx.loadMode === 'overload') {
    return { allow: false, reason: 'operator overloaded — suppress non-critical', suggestedSeverity: severity, retryAfterMs: 5 * 60_000 }
  }

  // Duplicate within window — drop and ask the caller to suppress for a while.
  if (ctx.duplicateSignature) {
    return { allow: false, reason: 'duplicate signature', suggestedSeverity: severity, retryAfterMs: 5 * 60_000 }
  }

  // Alert fatigue: if many notifications have stacked up without ack,
  // downgrade severity and slow the cadence.
  if (ctx.recentNotifications > 10 && ctx.msSinceLastAck > 30 * 60_000) {
    return {
      allow: severity === 'high',                                        // only let `high` through
      reason: 'alert fatigue — operator tray uncleared 30+ min',
      suggestedSeverity: severity === 'high' ? 'normal' : severity,
      retryAfterMs: 10 * 60_000,
    }
  }

  // Deep mode: drop "normal" severity (let high through).
  if (ctx.loadMode === 'deep' && severity === 'normal') {
    return { allow: false, reason: 'deep-mode — defer normal alerts', suggestedSeverity: 'normal', retryAfterMs: 10 * 60_000 }
  }

  return { allow: true, reason: 'within thresholds', suggestedSeverity: severity, retryAfterMs: 0 }
}

// ─── Autonomous action gate ─────────────────────────────────────────────

export interface AutoActContext {
  /** Plan's risk level (low | medium | high). */
  risk:        'low' | 'medium' | 'high'
  /** True if the plan is hard-blocked by an upstream safety classifier. */
  hardBlocked: boolean
  /** True if a budget guard refused the plan. */
  budgetBlocked: boolean
  /** Operator's current load mode (#18). */
  loadMode:    LoadMode
  /** True if this plan kind has executed successfully ≥3 times for this
   *  operator in the last 30 days. */
  trustedPattern: boolean
  /** Operator's hands-free preference. */
  handsFreeEnabled: boolean
}

export interface AutoActDecision {
  allow:    boolean
  reason:   string
  deferTo:  'execute' | 'dry_run' | 'operator' | 'reject'
}

/**
 * Should an autonomous plan execute right now, or should it be deferred?
 * Pure. Conservative defaults; every "yes" requires explicit justification.
 */
export function shouldAutoAct(ctx: AutoActContext): AutoActDecision {
  if (ctx.hardBlocked)
    return { allow: false, reason: 'hard-blocked by safety classifier', deferTo: 'reject' }
  if (ctx.budgetBlocked)
    return { allow: false, reason: 'budget cap reached', deferTo: 'reject' }

  // High-risk plans always go through the dry-run drawer regardless of HF.
  if (ctx.risk === 'high')
    return { allow: false, reason: 'high-risk plan — dual-channel approval required', deferTo: 'dry_run' }

  // Medium-risk: defer to dry-run unless the operator has hands-free
  // enabled AND this exact plan kind is a trusted pattern.
  if (ctx.risk === 'medium') {
    if (ctx.handsFreeEnabled && ctx.trustedPattern && ctx.loadMode !== 'overload')
      return { allow: true,  reason: 'medium-risk trusted pattern under hands-free', deferTo: 'execute' }
    return   { allow: false, reason: 'medium-risk — preview before execute',         deferTo: 'dry_run' }
  }

  // Low-risk: if the operator is overloaded, hold for the next calm
  // window even when hands-free would otherwise allow it.
  if (ctx.loadMode === 'overload')
    return { allow: false, reason: 'operator overloaded — defer non-essential automation', deferTo: 'operator' }

  return { allow: true, reason: 'low-risk autonomous action permitted', deferTo: 'execute' }
}
