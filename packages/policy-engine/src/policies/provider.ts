/**
 * Provider usage policy — AI provider access controls.
 *
 * Rules:
 *   - Checks provider allowlist
 *   - Checks token budget (require_approval when > 80% used)
 *   - observe_only cannot use providers
 */
import type { Policy, PolicyContext, PolicyResult } from '../types.js'

const DEFAULT_ALLOWED_PROVIDERS = new Set(['openai', 'anthropic', 'google', 'ollama'])
const BUDGET_SOFT_THRESHOLD     = 0.8

export const providerUsagePolicy: Policy = {
  id:          'policy:provider-usage',
  name:        'Provider Usage Policy',
  description: 'Controls which AI providers may be used and enforces token budgets',
  category:    'provider',

  evaluate(ctx: PolicyContext): PolicyResult {
    const base = { policyId: this.id, policyName: this.name }

    if (ctx.autonomyLevel === 'observe_only') {
      return {
        ...base,
        verdict:   'deny',
        reason:    'Provider usage not permitted in observe_only mode',
        riskLevel: 'low',
        blockedContext: { reason: 'insufficient_autonomy', context: {} },
      }
    }

    // Provider allowlist check
    if (ctx.providerId !== undefined) {
      const allowlist = (ctx.metadata?.['allowedProviders'] as string[] | undefined) ?? [...DEFAULT_ALLOWED_PROVIDERS]
      if (!allowlist.includes(ctx.providerId)) {
        return {
          ...base,
          verdict:   'deny',
          reason:    `Provider '${ctx.providerId}' is not in the allowlist`,
          riskLevel: 'medium',
          blockedContext: { reason: 'provider_not_allowlisted', context: { providerId: ctx.providerId } },
        }
      }
    }

    // Token budget check
    if (ctx.tokenBudget !== undefined && ctx.tokenUsed !== undefined) {
      const ratio = ctx.tokenUsed / ctx.tokenBudget
      if (ratio >= 1.0) {
        return {
          ...base,
          verdict:   'deny',
          reason:    `Token budget exhausted: ${ctx.tokenUsed}/${ctx.tokenBudget}`,
          riskLevel: 'medium',
          blockedContext: { reason: 'token_budget_exhausted', context: { tokenUsed: ctx.tokenUsed, tokenBudget: ctx.tokenBudget } },
        }
      }
      if (ratio >= BUDGET_SOFT_THRESHOLD) {
        return {
          ...base,
          verdict:   'require_approval',
          reason:    `Token budget at ${Math.round(ratio * 100)}% — approval required to continue`,
          riskLevel: 'medium',
          approvalContext: {
            operationLabel: `Continue AI usage (${ctx.tokenUsed}/${ctx.tokenBudget} tokens used)`,
            risk:           'medium',
            expiresInMs:    60 * 60 * 1000,
            metadata:       { tokenUsed: ctx.tokenUsed, tokenBudget: ctx.tokenBudget, providerId: ctx.providerId ?? null },
          },
        }
      }
    }

    return { ...base, verdict: 'allow', reason: 'Provider access permitted', riskLevel: 'low' }
  },
}
