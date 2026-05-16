/**
 * Workflow execution policy.
 *
 * Rules:
 *   - observe_only / recommend_only → deny
 *   - safe_low_risk_automation: allow low-risk workflows, require approval for medium+
 *   - approval_required_execution: allow low/medium, require approval for high/critical
 *   - restricted_supervised_orchestration: allow up to high, require approval for critical
 */
import type { Policy, PolicyContext, PolicyResult, RiskLevel } from '../types.js'
import { canAutoExecute } from '../autonomy.js'

function getWorkflowRisk(ctx: PolicyContext): RiskLevel {
  const meta = ctx.metadata ?? {}
  const r = meta['risk']
  if (typeof r === 'string') {
    if (r === 'low' || r === 'medium' || r === 'high' || r === 'critical') return r
  }
  // Default: medium risk for unknown workflows
  return 'medium'
}

export const workflowExecutionPolicy: Policy = {
  id:          'policy:workflow-execution',
  name:        'Workflow Execution Policy',
  description: 'Controls workflow trigger and execution based on risk and autonomy',
  category:    'workflow',

  evaluate(ctx: PolicyContext): PolicyResult {
    const base   = { policyId: this.id, policyName: this.name }
    const wfRisk = getWorkflowRisk(ctx)

    if (ctx.autonomyLevel === 'observe_only' || ctx.autonomyLevel === 'recommend_only') {
      return {
        ...base,
        verdict:   'deny',
        reason:    'Workflow execution not permitted at current autonomy level',
        riskLevel: wfRisk,
        blockedContext: { reason: 'insufficient_autonomy', context: { action: ctx.action } },
      }
    }

    if (canAutoExecute(ctx.autonomyLevel, wfRisk)) {
      return { ...base, verdict: 'allow', reason: `Workflow auto-execution permitted at risk '${wfRisk}'`, riskLevel: wfRisk }
    }

    return {
      ...base,
      verdict:   'require_approval',
      reason:    `Workflow risk '${wfRisk}' requires approval at autonomy level '${ctx.autonomyLevel}'`,
      riskLevel: wfRisk,
      approvalContext: {
        operationLabel: `Workflow: ${ctx.subject ?? ctx.action}`,
        risk:           wfRisk,
        expiresInMs:    24 * 60 * 60 * 1000,
        metadata:       { action: ctx.action, workflowRisk: wfRisk, ...ctx.metadata },
      },
    }
  },
}
