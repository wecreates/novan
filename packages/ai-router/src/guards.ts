/**
 * Runtime Guard Functions — pure, no DB, no side effects.
 *
 * Budget checks, kill switch evaluation, runaway detection.
 * All decision logic lives here; persistence is the caller's responsibility.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BudgetCap {
  id:                  string
  scopeType:           string
  scopeId:             string
  maxDailyUsd:         number        // 0 = unlimited
  maxMonthlyUsd:       number
  maxPerExecutionUsd:  number
  maxWorkflowUsd:      number
  currentDailyUsd:     number
  currentMonthlyUsd:   number
  enabled:             boolean
}

export interface PreflightResult {
  approved:    boolean
  blockReason: string | null
  capId:       string | null
  checkedCaps: string[]
}

export interface KillSwitchRecord {
  switchType: string   // global | remote_worker | provider | browser_job | ai_request | project | user | workflow | queue
  scopeId?:   string   // optional scoped entity (projectId, userId, workflowId)
  enabled:    boolean
}

export interface RunawayLimits {
  maxLoopDepth:    number    // default 50
  maxRetryDepth:   number    // default 10
  maxDurationMs:   number    // default 30 min
  maxQueuedMs:     number    // default 60 min
}

export const DEFAULT_RUNAWAY_LIMITS: RunawayLimits = {
  maxLoopDepth:  50,
  maxRetryDepth: 10,
  maxDurationMs: 30 * 60_000,
  maxQueuedMs:   60 * 60_000,
}

export type RunawayReason2 =
  | 'loop_depth_exceeded'
  | 'retry_depth_exceeded'
  | 'execution_timeout'
  | 'queue_timeout'
  | 'recursive_agent'
  | 'repeated_failure'

export interface RunawayCheckResult2 {
  isRunaway:  boolean
  reason:     RunawayReason2 | null
  detail:     string
}

// ─── Budget guard ─────────────────────────────────────────────────────────────

/**
 * Check estimated cost against all applicable budget caps.
 * Returns approved=false + first blocking cap on budget breach.
 */
export function checkBudgetPreflight(
  estimatedCostUsd: number,
  caps:             BudgetCap[],
  isWorkflow = false,
): PreflightResult {
  const checkedCaps: string[] = []

  for (const cap of caps) {
    if (!cap.enabled) continue
    checkedCaps.push(cap.id)

    // Per-execution cap
    if (cap.maxPerExecutionUsd > 0 && estimatedCostUsd > cap.maxPerExecutionUsd) {
      return {
        approved: false,
        blockReason: `Estimated cost $${estimatedCostUsd.toFixed(4)} exceeds per-execution cap $${cap.maxPerExecutionUsd.toFixed(4)} (${cap.scopeType}:${cap.scopeId})`,
        capId: cap.id,
        checkedCaps,
      }
    }

    // Workflow-level cap
    if (isWorkflow && cap.maxWorkflowUsd > 0 && estimatedCostUsd > cap.maxWorkflowUsd) {
      return {
        approved: false,
        blockReason: `Estimated cost $${estimatedCostUsd.toFixed(4)} exceeds workflow cap $${cap.maxWorkflowUsd.toFixed(4)} (${cap.scopeType}:${cap.scopeId})`,
        capId: cap.id,
        checkedCaps,
      }
    }

    // Daily cap
    if (cap.maxDailyUsd > 0 && cap.currentDailyUsd + estimatedCostUsd > cap.maxDailyUsd) {
      return {
        approved: false,
        blockReason: `Daily budget would be exceeded: $${(cap.currentDailyUsd + estimatedCostUsd).toFixed(4)} > $${cap.maxDailyUsd.toFixed(4)} (${cap.scopeType}:${cap.scopeId})`,
        capId: cap.id,
        checkedCaps,
      }
    }

    // Monthly cap
    if (cap.maxMonthlyUsd > 0 && cap.currentMonthlyUsd + estimatedCostUsd > cap.maxMonthlyUsd) {
      return {
        approved: false,
        blockReason: `Monthly budget would be exceeded: $${(cap.currentMonthlyUsd + estimatedCostUsd).toFixed(4)} > $${cap.maxMonthlyUsd.toFixed(4)} (${cap.scopeType}:${cap.scopeId})`,
        capId: cap.id,
        checkedCaps,
      }
    }
  }

  return { approved: true, blockReason: null, capId: null, checkedCaps }
}

// ─── Kill switch evaluation ───────────────────────────────────────────────────

/**
 * Check if any kill switch blocks execution.
 * Returns the first active switch that applies (most specific wins first).
 */
export function evaluateKillSwitches(
  switches:     KillSwitchRecord[],
  context: {
    jobType?:    string    // remote_worker | browser_job | ai_request
    providerId?: string
    projectId?:  string
    userId?:     string
    workflowId?: string
    queueName?:  string
  },
): { blocked: boolean; switchType: string | null; detail: string } {
  const enabled = switches.filter((s) => s.enabled)

  for (const sw of enabled) {
    switch (sw.switchType) {
      case 'global':
        return { blocked: true, switchType: 'global', detail: 'Global kill switch active' }

      case 'remote_worker':
        if (!context.jobType || context.jobType === 'remote') {
          return { blocked: true, switchType: 'remote_worker', detail: 'Remote worker kill switch active' }
        }
        break

      case 'browser_job':
        if (context.jobType === 'browser') {
          return { blocked: true, switchType: 'browser_job', detail: 'Browser job kill switch active' }
        }
        break

      case 'ai_request':
        if (!context.jobType || context.jobType === 'ai') {
          return { blocked: true, switchType: 'ai_request', detail: 'AI request kill switch active' }
        }
        break

      case 'provider':
        if (sw.scopeId && sw.scopeId === context.providerId) {
          return { blocked: true, switchType: 'provider', detail: `Provider ${sw.scopeId} kill switch active` }
        } else if (!sw.scopeId) {
          return { blocked: true, switchType: 'provider', detail: 'All-provider kill switch active' }
        }
        break

      case 'project':
        if (sw.scopeId && sw.scopeId === context.projectId) {
          return { blocked: true, switchType: 'project', detail: `Project ${sw.scopeId} kill switch active` }
        }
        break

      case 'user':
        if (sw.scopeId && sw.scopeId === context.userId) {
          return { blocked: true, switchType: 'user', detail: `User ${sw.scopeId} kill switch active` }
        }
        break

      case 'workflow':
        if (sw.scopeId && sw.scopeId === context.workflowId) {
          return { blocked: true, switchType: 'workflow', detail: `Workflow ${sw.scopeId} kill switch active` }
        }
        break

      case 'queue':
        if (sw.scopeId && sw.scopeId === context.queueName) {
          return { blocked: true, switchType: 'queue', detail: `Queue ${sw.scopeId} kill switch active` }
        }
        break
    }
  }

  return { blocked: false, switchType: null, detail: '' }
}

// ─── Runaway detection ────────────────────────────────────────────────────────

/**
 * Detect runaway execution based on depth, duration, and failure counts.
 */
export function detectRunaway2(
  params: {
    loopDepth:       number
    retryDepth:      number
    durationMs:      number
    queuedMs:        number
    agentCallStack?: string[]   // detect recursive agents
    recentFailures?: number     // count of failures in last N attempts
  },
  limits: RunawayLimits = DEFAULT_RUNAWAY_LIMITS,
): RunawayCheckResult2 {
  if (params.loopDepth > limits.maxLoopDepth) {
    return {
      isRunaway: true,
      reason:    'loop_depth_exceeded',
      detail:    `Loop depth ${params.loopDepth} exceeds limit ${limits.maxLoopDepth}`,
    }
  }

  if (params.retryDepth > limits.maxRetryDepth) {
    return {
      isRunaway: true,
      reason:    'retry_depth_exceeded',
      detail:    `Retry depth ${params.retryDepth} exceeds limit ${limits.maxRetryDepth}`,
    }
  }

  if (params.durationMs > limits.maxDurationMs) {
    return {
      isRunaway: true,
      reason:    'execution_timeout',
      detail:    `Execution duration ${Math.round(params.durationMs / 1000)}s exceeds limit ${Math.round(limits.maxDurationMs / 1000)}s`,
    }
  }

  if (params.queuedMs > limits.maxQueuedMs) {
    return {
      isRunaway: true,
      reason:    'queue_timeout',
      detail:    `Queued time ${Math.round(params.queuedMs / 1000)}s exceeds limit ${Math.round(limits.maxQueuedMs / 1000)}s`,
    }
  }

  // Recursive agent detection
  if (params.agentCallStack && params.agentCallStack.length > 0) {
    const seen = new Set<string>()
    for (const frame of params.agentCallStack) {
      if (seen.has(frame)) {
        return {
          isRunaway: true,
          reason:    'recursive_agent',
          detail:    `Recursive agent call detected: ${frame}`,
        }
      }
      seen.add(frame)
    }
  }

  // Repeated failure detection (>70% failure rate)
  if (params.recentFailures !== undefined && params.retryDepth > 2) {
    const failureRate = params.recentFailures / Math.max(params.retryDepth, 1)
    if (failureRate > 0.7) {
      return {
        isRunaway: true,
        reason:    'repeated_failure',
        detail:    `Failure rate ${Math.round(failureRate * 100)}% (${params.recentFailures}/${params.retryDepth}) exceeds threshold`,
      }
    }
  }

  return { isRunaway: false, reason: null, detail: '' }
}

// ─── Runaway limits helper ────────────────────────────────────────────────────

/** Merge user-provided partial limits with defaults. */
export function mergeRunawayLimits(partial?: Partial<RunawayLimits>): RunawayLimits {
  return { ...DEFAULT_RUNAWAY_LIMITS, ...partial }
}
