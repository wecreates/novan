/**
 * R146.334 — Honest Blocker Reporter (closes reasoning.honest_blocker_naming)
 *
 * Every op should produce structured outcomes that name the real blocker,
 * not vague failures. The pattern Claude uses in chat:
 *   "I cannot do X because Y. The unblock is Z. Suggested next action: W."
 *
 * Codified here as a single helper any op can return. The brain-task layer
 * + UI render this consistently. No more "failed: unknown error" — every
 * non-OK outcome is one of these BlockerClass enums with evidence.
 */

export type BlockerClass =
  | 'provider_auth_revoked'         // FAL 403, key needs regen
  | 'provider_billing_exhausted'    // Replicate 402, top up
  | 'provider_rate_limited'         // 429, retry later
  | 'provider_spend_cap_hit'        // Gemini 429 RESOURCE_EXHAUSTED
  | 'platform_policy_block'         // Etsy banned the app
  | 'platform_requires_human'       // SSN/banking/ID/W9 — anthropic-policy or platform-policy
  | 'platform_requires_approval'    // TikTok seller review pending
  | 'privacy_rule_violation'        // home address would be exposed
  | 'cost_budget_exceeded'          // op cost exceeds workspace budget cap
  | 'capability_not_implemented'    // Novan doesn't have this skill yet
  | 'dependency_missing'            // upstream op hasn't completed
  | 'evidence_insufficient'         // would need data Novan can't access
  | 'unknown'

export interface BlockerReport {
  blocked:                    true
  blockerClass:               BlockerClass
  reason:                     string                  // 1-sentence human-readable
  evidence:                   string                  // what Novan observed
  suggestedUnblockAction:     string                  // what operator should do
  suggestedNovanAction?:      string                  // what Novan will do if/when unblocked
  estimatedUnblockCostUsd?:   number                  // if money is involved
  estimatedUnblockTimeMin?:   number                  // if waiting is involved
  relatedCapabilityId?:       string                  // link to parity registry
}

export interface OkReport<T = unknown> {
  blocked: false
  ok:      true
  data:    T
  evidence?: string
}

export interface PartialReport<T = unknown> {
  blocked: false
  ok:      false
  partial: true
  data:    T
  remaining: string                  // what's still to do
  evidence?: string
}

export type StructuredOutcome<T = unknown> = OkReport<T> | PartialReport<T> | BlockerReport

// ─── Constructor helpers ─────────────────────────────────────────────────────

export function ok<T>(data: T, evidence?: string): OkReport<T> {
  const r: OkReport<T> = { blocked: false, ok: true, data }
  if (evidence) r.evidence = evidence
  return r
}

export function partial<T>(data: T, remaining: string, evidence?: string): PartialReport<T> {
  const r: PartialReport<T> = { blocked: false, ok: false, partial: true, data, remaining }
  if (evidence) r.evidence = evidence
  return r
}

export function blocked(input: Omit<BlockerReport, 'blocked'>): BlockerReport {
  return { blocked: true, ...input }
}

// ─── Common blocker constructors ─────────────────────────────────────────────

export function blockedByProviderBilling(provider: string): BlockerReport {
  return blocked({
    blockerClass:           'provider_billing_exhausted',
    reason:                 `${provider} returned 402 Payment Required`,
    evidence:               `provider=${provider}, last probe failure_class=billing_exhausted`,
    suggestedUnblockAction: provider === 'replicate'
      ? 'Top up Replicate $5 at replicate.com/account/billing (~500 Flux Schnell generations)'
      : `Top up ${provider} balance`,
    estimatedUnblockCostUsd: 5,
    estimatedUnblockTimeMin: 2,
  })
}

export function blockedByProviderAuth(provider: string): BlockerReport {
  return blocked({
    blockerClass:           'provider_auth_revoked',
    reason:                 `${provider} returned 401/403 — key revoked or expired`,
    evidence:               `provider=${provider}, last probe failure_class=auth_revoked`,
    suggestedUnblockAction: `Regenerate ${provider} API key + replace in droplet .env, restart api container`,
    estimatedUnblockTimeMin: 3,
  })
}

export function blockedByPrivacyRule(violation: string, alternative: string): BlockerReport {
  return blocked({
    blockerClass:           'privacy_rule_violation',
    reason:                 `Action blocked by importance-99 privacy rule: ${violation}`,
    evidence:               violation,
    suggestedUnblockAction: alternative,
  })
}

export function blockedByHumanRequired(field: string, platform: string): BlockerReport {
  return blocked({
    blockerClass:           'platform_requires_human',
    reason:                 `${platform} requires operator to enter ${field} directly — Novan hard-blocked from submitting`,
    evidence:               `field=${field}, hard_blocked_categories=[SSN, bank, govID, W9_signature]`,
    suggestedUnblockAction: `Operator enters ${field} via platform UI; Novan resumes with next non-personal step`,
  })
}

export function blockedByCapability(capabilityId: string, partialProgress?: string): BlockerReport {
  return blocked({
    blockerClass:           'capability_not_implemented',
    reason:                 `Capability ${capabilityId} not yet implemented at Novan-autonomous level`,
    evidence:               partialProgress ?? 'See r334-claude-parity-registry for current score',
    suggestedUnblockAction: 'capability.next_target may have scheduled this for closure; check capability.parity_report',
    relatedCapabilityId:    capabilityId,
  })
}

/**
 * Render a BlockerReport into a single human-readable sentence for chat.
 * Format: "Blocked: <reason>. To unblock: <action>. (<cost>)"
 */
export function renderBlockerSentence(r: BlockerReport): string {
  const parts = [`Blocked: ${r.reason}.`, `To unblock: ${r.suggestedUnblockAction}.`]
  if (r.estimatedUnblockCostUsd) parts.push(`(~$${r.estimatedUnblockCostUsd})`)
  if (r.estimatedUnblockTimeMin) parts.push(`(~${r.estimatedUnblockTimeMin} min)`)
  return parts.join(' ')
}
