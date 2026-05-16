/**
 * Policy evaluation engine.
 *
 * Evaluates a PolicyContext against all applicable policies and returns:
 *   - Final verdict (deny > require_approval > allow)
 *   - Events to emit
 *   - Approval request data (if verdict = require_approval)
 *   - Blocked action data (if verdict = deny)
 */
import type {
  Policy, PolicyContext, PolicyResult, PolicyVerdict,
  PolicyEvaluationReport, PolicyEvent,
} from './types.js'
import { POLICIES_BY_CATEGORY } from './policies/index.js'
import { buildApprovalRequest } from './approval.js'
import { buildBlockedAction }   from './blocked-actions.js'

/** Verdict priority: deny > require_approval > allow */
function mergeVerdicts(a: PolicyVerdict, b: PolicyVerdict): PolicyVerdict {
  if (a === 'deny' || b === 'deny') return 'deny'
  if (a === 'require_approval' || b === 'require_approval') return 'require_approval'
  return 'allow'
}

/**
 * Evaluate context against the built-in policies for its action category,
 * plus any additional policies provided.
 */
export function evaluatePolicy(
  ctx:                PolicyContext,
  additionalPolicies: Policy[] = [],
): PolicyEvaluationReport {
  const applicablePolicies = [
    ...(POLICIES_BY_CATEGORY[ctx.actionCategory] ?? []),
    ...additionalPolicies,
  ]

  if (applicablePolicies.length === 0) {
    // No policies → default allow
    const defaultResult: PolicyResult = {
      policyId:   'built-in:default',
      policyName: 'Default Allow',
      verdict:    'allow',
      reason:     'No applicable policies — default allow',
      riskLevel:  'low',
    }
    return {
      context:        ctx,
      results:        [defaultResult],
      verdict:        'allow',
      decidingPolicy: defaultResult,
      events: [buildPolicyCheckedEvent(ctx, defaultResult), buildPolicyAllowedEvent(ctx, defaultResult)],
    }
  }

  const results: PolicyResult[] = []
  let finalVerdict: PolicyVerdict = 'allow'
  let decidingPolicy: PolicyResult | null = null

  for (const policy of applicablePolicies) {
    const result = policy.evaluate(ctx)
    results.push(result)

    const merged = mergeVerdicts(finalVerdict, result.verdict)
    if (merged !== finalVerdict) {
      finalVerdict   = merged
      decidingPolicy = result
    }
    // Deny wins immediately
    if (finalVerdict === 'deny') break
  }

  const fallbackResult: PolicyResult = {
    policyId:   'built-in:default',
    policyName: 'Default',
    verdict:    'allow',
    reason:     'allowed',
    riskLevel:  'low',
  }
  const deciding = decidingPolicy ?? results[results.length - 1] ?? fallbackResult

  const events: PolicyEvent[] = [buildPolicyCheckedEvent(ctx, deciding)]

  let approvalRequest: PolicyEvaluationReport['approvalRequest'] = undefined
  let blockedAction:   PolicyEvaluationReport['blockedAction']   = undefined

  if (finalVerdict === 'allow') {
    events.push(buildPolicyAllowedEvent(ctx, deciding))
  } else if (finalVerdict === 'require_approval') {
    events.push(buildApprovalRequiredEvent(ctx, deciding))
    approvalRequest = buildApprovalRequest(ctx, deciding)
  } else {
    events.push(buildPolicyDeniedEvent(ctx, deciding))
    events.push(buildActionBlockedEvent(ctx, deciding))
    blockedAction = buildBlockedAction(ctx, deciding)
  }

  const report: PolicyEvaluationReport = {
    context:        ctx,
    results,
    verdict:        finalVerdict,
    decidingPolicy: deciding,
    events,
  }
  if (approvalRequest !== undefined) report.approvalRequest = approvalRequest
  if (blockedAction   !== undefined) report.blockedAction   = blockedAction
  return report
}

// ─── Event builders ────────────────────────────────────────────────────────────

function buildPolicyCheckedEvent(ctx: PolicyContext, result: PolicyResult): PolicyEvent {
  return {
    type: 'policy.checked',
    payload: {
      workspaceId: ctx.workspaceId, action: ctx.action,
      policyId: result.policyId, policyName: result.policyName,
      verdict: result.verdict, riskLevel: result.riskLevel,
      agentId: ctx.agentId ?? null, traceId: ctx.traceId ?? null, timestamp: Date.now(),
    },
  }
}

function buildPolicyAllowedEvent(ctx: PolicyContext, result: PolicyResult): PolicyEvent {
  return {
    type: 'policy.allowed',
    payload: {
      workspaceId: ctx.workspaceId, action: ctx.action,
      policyId: result.policyId, reason: result.reason,
      agentId: ctx.agentId ?? null, traceId: ctx.traceId ?? null, timestamp: Date.now(),
    },
  }
}

function buildPolicyDeniedEvent(ctx: PolicyContext, result: PolicyResult): PolicyEvent {
  return {
    type: 'policy.denied',
    payload: {
      workspaceId: ctx.workspaceId, action: ctx.action,
      policyId: result.policyId, reason: result.reason, riskLevel: result.riskLevel,
      agentId: ctx.agentId ?? null, traceId: ctx.traceId ?? null, timestamp: Date.now(),
    },
  }
}

function buildApprovalRequiredEvent(ctx: PolicyContext, result: PolicyResult): PolicyEvent {
  return {
    type: 'approval.required',
    payload: {
      workspaceId: ctx.workspaceId, action: ctx.action,
      policyId: result.policyId, riskLevel: result.riskLevel,
      operationLabel: result.approvalContext?.operationLabel ?? ctx.action,
      agentId: ctx.agentId ?? null, traceId: ctx.traceId ?? null, timestamp: Date.now(),
    },
  }
}

function buildActionBlockedEvent(ctx: PolicyContext, result: PolicyResult): PolicyEvent {
  return {
    type: 'action.blocked',
    payload: {
      workspaceId: ctx.workspaceId, action: ctx.action,
      policyId: result.policyId, reason: result.reason, riskLevel: result.riskLevel,
      blockedContext: result.blockedContext ?? {},
      agentId: ctx.agentId ?? null, traceId: ctx.traceId ?? null, timestamp: Date.now(),
    },
  }
}
