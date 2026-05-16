/**
 * Legacy exports — preserves the original minimal API.
 * New code should use evaluatePolicy() from engine.ts instead.
 */
import type { Policy, PolicyContext, PolicyResult } from './types.js'

export function evaluatePolicies(
  policies: Policy[],
  ctx:      PolicyContext,
): PolicyResult {
  let requireApproval: PolicyResult | null = null
  for (const policy of policies) {
    const result = policy.evaluate(ctx)
    if (result.verdict === 'deny') return result
    if (result.verdict === 'require_approval' && requireApproval === null) requireApproval = result
  }
  return requireApproval ?? {
    verdict:    'allow',
    policyId:   'default',
    policyName: 'Default Allow',
    reason:     'allowed',
    riskLevel:  'low',
  }
}

export const ALLOW_ALL_POLICY: Policy = {
  id:          'built-in:allow-all',
  name:        'Allow All',
  description: 'Permits all actions (default passthrough)',
  category:    'global',
  evaluate:    (_ctx: PolicyContext): PolicyResult => ({
    verdict:    'allow',
    policyId:   'built-in:allow-all',
    policyName: 'Allow All',
    reason:     'Always allow',
    riskLevel:  'low',
  }),
}
