/**
 * Content publishing policy.
 *
 * Rules:
 *   - ALL publishing actions require approval regardless of autonomy level
 *   - Risk: high
 */
import type { Policy, PolicyContext, PolicyResult } from '../types.js'

export const contentPublishingPolicy: Policy = {
  id:          'policy:content-publishing',
  name:        'Content Publishing Policy',
  description: 'All content publishing requires human approval',
  category:    'publish',

  evaluate(ctx: PolicyContext): PolicyResult {
    const base = { policyId: this.id, policyName: this.name }

    if (ctx.autonomyLevel === 'observe_only' || ctx.autonomyLevel === 'recommend_only') {
      return {
        ...base,
        verdict:   'deny',
        reason:    'Publishing not permitted at current autonomy level',
        riskLevel: 'high',
        blockedContext: { reason: 'insufficient_autonomy', context: { action: ctx.action } },
      }
    }

    return {
      ...base,
      verdict:   'require_approval',
      reason:    'Content publishing always requires human approval',
      riskLevel: 'high',
      approvalContext: {
        operationLabel: `Publish: ${ctx.subject ?? ctx.action}`,
        risk:           'high',
        expiresInMs:    8 * 60 * 60 * 1000,
        metadata:       { action: ctx.action, subject: ctx.subject ?? null, ...ctx.metadata },
      },
    }
  },
}
