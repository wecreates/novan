/**
 * Automation frequency policy — rate limiting.
 *
 * Prevents runaway automation by capping actions per time window.
 * Default: 100 actions per hour per workspace.
 */
import type { Policy, PolicyContext, PolicyResult } from '../types.js'

const DEFAULT_MAX_ACTIONS  = 100
const DEFAULT_WINDOW_MS    = 60 * 60 * 1000  // 1 hour
const SOFT_LIMIT_THRESHOLD = 0.8              // require_approval at 80% usage

export const automationFrequencyPolicy: Policy = {
  id:          'policy:automation-frequency',
  name:        'Automation Frequency Policy',
  description: 'Rate-limits automation actions per workspace per time window',
  category:    'automation',

  evaluate(ctx: PolicyContext): PolicyResult {
    const base       = { policyId: this.id, policyName: this.name }
    const maxActions = ctx.maxActionsPerWindow ?? DEFAULT_MAX_ACTIONS
    const recent     = ctx.recentActionCount   ?? 0
    const windowMs   = ctx.frequencyWindowMs   ?? DEFAULT_WINDOW_MS
    const windowMins = Math.round(windowMs / 60_000)

    if (recent >= maxActions) {
      return {
        ...base,
        verdict:   'deny',
        reason:    `Rate limit exceeded: ${recent}/${maxActions} actions in ${windowMins} minutes`,
        riskLevel: 'medium',
        blockedContext: {
          reason:  'rate_limit_exceeded',
          context: { recent, maxActions, windowMs },
        },
      }
    }

    const usageRatio = recent / maxActions
    if (usageRatio >= SOFT_LIMIT_THRESHOLD) {
      return {
        ...base,
        verdict:   'require_approval',
        reason:    `Approaching rate limit: ${recent}/${maxActions} actions (${Math.round(usageRatio * 100)}% used)`,
        riskLevel: 'medium',
        approvalContext: {
          operationLabel: `Continue automation (${recent}/${maxActions} actions used)`,
          risk:           'medium',
          expiresInMs:    windowMs,
          metadata:       { recent, maxActions, usageRatio },
        },
      }
    }

    return { ...base, verdict: 'allow', reason: `Frequency OK: ${recent}/${maxActions}`, riskLevel: 'low' }
  },
}
