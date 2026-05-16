/**
 * Browser execution policy.
 *
 * Rules:
 *   - observe_only / recommend_only → deny
 *   - health-check actions → allow at safe_low_risk_automation+
 *   - all other browser actions → require_approval (unless domain allowlisted)
 *   - restricted_supervised_orchestration with allowlisted domain → allow
 */
import type { Policy, PolicyContext, PolicyResult } from '../types.js'

const SAFE_BROWSER_ACTIONS = new Set(['browser.health-check', 'browser.ping'])

export const browserExecutionPolicy: Policy = {
  id:          'policy:browser-execution',
  name:        'Browser Execution Policy',
  description: 'Controls when browser automation may execute',
  category:    'browser',

  evaluate(ctx: PolicyContext): PolicyResult {
    const base = { policyId: this.id, policyName: this.name }

    // Observe/recommend levels cannot execute anything
    if (ctx.autonomyLevel === 'observe_only' || ctx.autonomyLevel === 'recommend_only') {
      return {
        ...base,
        verdict:   'deny',
        reason:    `Autonomy level '${ctx.autonomyLevel}' cannot execute browser actions`,
        riskLevel: 'high',
        blockedContext: { reason: 'insufficient_autonomy', context: { autonomyLevel: ctx.autonomyLevel } },
      }
    }

    // Safe health-check actions are always allowed at safe_low_risk_automation+
    if (SAFE_BROWSER_ACTIONS.has(ctx.action)) {
      return { ...base, verdict: 'allow', reason: 'Safe browser action allowlisted', riskLevel: 'low' }
    }

    // Domain allowlist check for supervised orchestration
    if (ctx.autonomyLevel === 'restricted_supervised_orchestration' && ctx.targetDomain !== undefined) {
      const allowed = ctx.allowlistedDomains ?? []
      if (allowed.includes(ctx.targetDomain)) {
        return { ...base, verdict: 'allow', reason: `Domain '${ctx.targetDomain}' is allowlisted`, riskLevel: 'medium' }
      }
    }

    // All other browser execution → require approval
    return {
      ...base,
      verdict:   'require_approval',
      reason:    'Browser execution requires human approval',
      riskLevel: 'high',
      approvalContext: {
        operationLabel: `Browser: ${ctx.action}${ctx.subject !== undefined ? ` on ${ctx.subject}` : ''}`,
        risk:           'high',
        expiresInMs:    24 * 60 * 60 * 1000,
        metadata:       { action: ctx.action, targetDomain: ctx.targetDomain ?? null },
      },
    }
  },
}
