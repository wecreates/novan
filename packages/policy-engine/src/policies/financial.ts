/**
 * Financial action policy.
 *
 * Rules:
 *   - ALL financial actions ALWAYS require approval — no exceptions
 *   - observe_only / recommend_only → deny
 *   - All others → require_approval with critical risk
 */
import type { Policy, PolicyContext, PolicyResult } from '../types.js'

export const financialActionPolicy: Policy = {
  id:          'policy:financial-action',
  name:        'Financial Action Policy',
  description: 'All financial actions require human approval — no exceptions',
  category:    'financial',

  evaluate(ctx: PolicyContext): PolicyResult {
    const base = { policyId: this.id, policyName: this.name }

    if (ctx.autonomyLevel === 'observe_only' || ctx.autonomyLevel === 'recommend_only') {
      return {
        ...base,
        verdict:   'deny',
        reason:    'Financial actions are not permitted at current autonomy level',
        riskLevel: 'critical',
        blockedContext: {
          reason:  'insufficient_autonomy_for_financial_action',
          context: { action: ctx.action, autonomyLevel: ctx.autonomyLevel },
        },
      }
    }

    // Even restricted_supervised_orchestration requires approval for financial actions
    return {
      ...base,
      verdict:   'require_approval',
      reason:    'Financial actions always require human approval',
      riskLevel: 'critical',
      approvalContext: {
        operationLabel: `Financial: ${ctx.subject ?? ctx.action}`,
        risk:           'critical',
        expiresInMs:    2 * 60 * 60 * 1000,  // 2h — shorter window for financial
        metadata:       { action: ctx.action, subject: ctx.subject ?? null, ...ctx.metadata },
      },
    }
  },
}
