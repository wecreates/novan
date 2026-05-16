/**
 * Cost + Safety Governor
 *
 * Pure functions for pre-flight job checks, kill-switch evaluation,
 * runaway detection, throttle levels, and budget alert firing.
 * All state lives in the DB — these functions are stateless helpers.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobType = 'ai' | 'browser' | 'remote' | 'workflow'
export type KillSwitchType = 'remote_worker' | 'provider' | 'browser_job' | 'ai_request'
export type ThrottleLevel = 'normal' | 'throttled' | 'blocked'
export type RunawayReason = 'cost_exceeded' | 'duration_exceeded' | 'retry_exceeded' | 'manual'
export type AlertType = 'daily' | 'weekly' | 'monthly' | 'per_job'

export interface BudgetRules {
  dailyLimitUsd:          number   // 0 = unlimited
  weeklyLimitUsd:         number
  monthlyLimitUsd:        number
  maxPerJobUsd:           number   // 0 = unlimited
  maxBrowserSessionSecs:  number   // 0 = unlimited
  maxAiRequestSecs:       number   // 0 = unlimited
  maxRetries:             number   // 0 = unlimited
  maxConcurrentRemote:    number   // 0 = unlimited
  hardStop:               boolean  // if true, block at 100% instead of 80%
  alertThreshold:         number   // fraction 0–1
}

export interface SpendState {
  dailySpendUsd:   number
  weeklySpendUsd:  number
  monthlySpendUsd: number
}

export interface JobCheckResult {
  allowed:  boolean
  reason?:  string
  throttle: ThrottleLevel
}

export interface RunawayCheckResult {
  isRunaway: boolean
  reason?:   RunawayReason
}

export interface AlertCheckResult {
  fired:     boolean
  alertType: AlertType
  pct:       number
  limitUsd:  number
  currentUsd: number
}

// ─── Pre-flight job cost check ────────────────────────────────────────────────

/**
 * Returns whether a job is allowed to start given current spend + limits.
 * maxPerJobUsd: 0 = skip check. dailyLimitUsd: 0 = skip check.
 */
export function checkJobAllowed(
  jobType:       JobType,
  estimatedUsd:  number,
  spend:         SpendState,
  rules:         BudgetRules,
  activeSwitches: KillSwitchType[],
): JobCheckResult {
  // Kill-switch check
  const switchForType: Record<JobType, KillSwitchType> = {
    ai:       'ai_request',
    browser:  'browser_job',
    remote:   'remote_worker',
    workflow: 'remote_worker',
  }
  if (activeSwitches.includes(switchForType[jobType])) {
    return { allowed: false, reason: `Kill switch active: ${switchForType[jobType]}`, throttle: 'blocked' }
  }

  // Per-job cost cap
  if (rules.maxPerJobUsd > 0 && estimatedUsd > rules.maxPerJobUsd) {
    return {
      allowed: false,
      reason:  `Estimated cost $${estimatedUsd.toFixed(4)} exceeds per-job limit $${rules.maxPerJobUsd.toFixed(4)}`,
      throttle: 'blocked',
    }
  }

  // Daily budget
  if (rules.dailyLimitUsd > 0) {
    const projectedDaily = spend.dailySpendUsd + estimatedUsd
    if (projectedDaily > rules.dailyLimitUsd) {
      return {
        allowed: false,
        reason:  `Daily budget exhausted ($${spend.dailySpendUsd.toFixed(4)} / $${rules.dailyLimitUsd.toFixed(2)})`,
        throttle: 'blocked',
      }
    }
  }

  // Weekly budget
  if (rules.weeklyLimitUsd > 0) {
    const projectedWeekly = spend.weeklySpendUsd + estimatedUsd
    if (projectedWeekly > rules.weeklyLimitUsd) {
      return {
        allowed: false,
        reason:  `Weekly budget exhausted ($${spend.weeklySpendUsd.toFixed(4)} / $${rules.weeklyLimitUsd.toFixed(2)})`,
        throttle: 'blocked',
      }
    }
  }

  // Monthly budget
  if (rules.monthlyLimitUsd > 0) {
    const projectedMonthly = spend.monthlySpendUsd + estimatedUsd
    if (projectedMonthly > rules.monthlyLimitUsd) {
      return {
        allowed: false,
        reason:  `Monthly budget exhausted ($${spend.monthlySpendUsd.toFixed(4)} / $${rules.monthlyLimitUsd.toFixed(2)})`,
        throttle: 'blocked',
      }
    }
  }

  // Throttle level (approaching limit)
  const throttle = getThrottleLevel(spend, rules)
  return { allowed: true, throttle }
}

// ─── Throttle level ───────────────────────────────────────────────────────────

export function getThrottleLevel(spend: SpendState, rules: BudgetRules): ThrottleLevel {
  const threshold = rules.alertThreshold > 0 ? rules.alertThreshold : 0.8

  if (rules.dailyLimitUsd > 0 && spend.dailySpendUsd / rules.dailyLimitUsd >= threshold) {
    return 'throttled'
  }
  if (rules.weeklyLimitUsd > 0 && spend.weeklySpendUsd / rules.weeklyLimitUsd >= threshold) {
    return 'throttled'
  }
  if (rules.monthlyLimitUsd > 0 && spend.monthlySpendUsd / rules.monthlyLimitUsd >= threshold) {
    return 'throttled'
  }
  return 'normal'
}

// ─── Session duration check ───────────────────────────────────────────────────

export function checkSessionDuration(
  jobType:      JobType,
  durationSecs: number,
  rules:        BudgetRules,
): { allowed: boolean; reason?: string } {
  if (jobType === 'browser' && rules.maxBrowserSessionSecs > 0) {
    if (durationSecs > rules.maxBrowserSessionSecs) {
      return {
        allowed: false,
        reason:  `Browser session duration ${durationSecs}s exceeds limit ${rules.maxBrowserSessionSecs}s`,
      }
    }
  }
  if (jobType === 'ai' && rules.maxAiRequestSecs > 0) {
    if (durationSecs > rules.maxAiRequestSecs) {
      return {
        allowed: false,
        reason:  `AI request duration ${durationSecs}s exceeds limit ${rules.maxAiRequestSecs}s`,
      }
    }
  }
  return { allowed: true }
}

// ─── Runaway detection ────────────────────────────────────────────────────────

export function detectRunaway(
  jobType:     JobType,
  costUsd:     number,
  durationMs:  number,
  retryCount:  number,
  rules:       BudgetRules,
): RunawayCheckResult {
  if (rules.maxPerJobUsd > 0 && costUsd > rules.maxPerJobUsd) {
    return { isRunaway: true, reason: 'cost_exceeded' }
  }

  const durationSecs = durationMs / 1000
  if (jobType === 'browser' && rules.maxBrowserSessionSecs > 0 && durationSecs > rules.maxBrowserSessionSecs) {
    return { isRunaway: true, reason: 'duration_exceeded' }
  }
  if (jobType === 'ai' && rules.maxAiRequestSecs > 0 && durationSecs > rules.maxAiRequestSecs) {
    return { isRunaway: true, reason: 'duration_exceeded' }
  }

  if (rules.maxRetries > 0 && retryCount > rules.maxRetries) {
    return { isRunaway: true, reason: 'retry_exceeded' }
  }

  return { isRunaway: false }
}

// ─── Budget alert detection ───────────────────────────────────────────────────

export function checkBudgetAlerts(
  spend:            SpendState,
  rules:            BudgetRules,
  lastAlertedPcts:  Partial<Record<AlertType, number>>,  // last pct that triggered an alert
): AlertCheckResult[] {
  const threshold = rules.alertThreshold > 0 ? rules.alertThreshold : 0.8
  const alerts: AlertCheckResult[] = []

  const checks: Array<{ type: AlertType; current: number; limit: number }> = [
    { type: 'daily',   current: spend.dailySpendUsd,   limit: rules.dailyLimitUsd   },
    { type: 'weekly',  current: spend.weeklySpendUsd,  limit: rules.weeklyLimitUsd  },
    { type: 'monthly', current: spend.monthlySpendUsd, limit: rules.monthlyLimitUsd },
  ]

  for (const { type, current, limit } of checks) {
    if (limit <= 0) continue
    const pct = current / limit
    if (pct >= threshold) {
      const lastPct = lastAlertedPcts[type] ?? 0
      // Only fire if we crossed a new 10% band (0.8, 0.9, 1.0)
      const band = Math.floor(pct * 10) / 10
      const lastBand = Math.floor(lastPct * 10) / 10
      if (band > lastBand) {
        alerts.push({ fired: true, alertType: type, pct, limitUsd: limit, currentUsd: current })
      }
    }
  }

  return alerts
}

// ─── Idle worker detection ────────────────────────────────────────────────────

/** Returns true if the worker has been idle longer than the threshold. */
export function isWorkerIdle(
  lastActivityMs:   number,
  nowMs:            number,
  idleThresholdMs:  number,
): boolean {
  return (nowMs - lastActivityMs) >= idleThresholdMs
}

// ─── Default rules ────────────────────────────────────────────────────────────

export const DEFAULT_BUDGET_RULES: BudgetRules = {
  dailyLimitUsd:         parseFloat(process.env['AI_BUDGET_DAILY_USD']   ?? '10'),
  weeklyLimitUsd:        0,
  monthlyLimitUsd:       parseFloat(process.env['AI_BUDGET_MONTHLY_USD'] ?? '100'),
  maxPerJobUsd:          0,
  maxBrowserSessionSecs: 0,
  maxAiRequestSecs:      0,
  maxRetries:            10,
  maxConcurrentRemote:   5,
  hardStop:              false,
  alertThreshold:        0.8,
}
