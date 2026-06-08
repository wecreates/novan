/**
 * R146.337 — Hard Policy Registry (closes safety.hard_policy_blocks 6→9)
 *
 * Single source of truth for every Anthropic-policy-derived hard block.
 * Any op that submits user data passes through enforceHardPolicy() before
 * action. Violations are NEVER overridable by operator authorization, by
 * approval tokens, or by API keys.
 *
 * Adoption pattern: every op that touches operator-form-submit or
 * external-API-write calls enforceHardPolicy(action) at the top. Returns
 * structured violation; op converts to BlockerReport for UI.
 */

export type HardPolicyCategory =
  | 'financial_credentials'      // bank routing, account #, card #
  | 'government_id'              // SSN, passport, driver's license
  | 'authentication'             // passwords, MFA codes, recovery questions
  | 'tax_signature'              // W-9, 1099, K-1 signatures
  | 'irreversible_financial'     // trade execution, money transfer, crypto swap
  | 'unauthorized_purchase'      // buying without explicit per-action approval
  | 'access_control_change'      // sharing perms, role grants
  | 'permanent_deletion'         // hard-delete data

export interface PolicyViolation {
  category:    HardPolicyCategory
  rule:        string
  evidence:    string
  alternative: string         // what operator/Novan should do instead
}

export interface PolicyAction {
  type:        'submit_form_field' | 'click_button' | 'api_write' | 'browser_action'
  channel:     string                  // e.g. 'tiktok_shop', 'printful', 'stripe'
  fieldOrLabel: string                  // e.g. 'SSN', 'Sign and submit W-9'
  value?:      string
  context?:    Record<string, unknown>
}

// ─── Pattern matchers ────────────────────────────────────────────────────────

const SSN_RE         = /\b\d{3}-?\d{2}-?\d{4}\b/
const BANK_ROUTING_RE= /\brouting\s*(number|#)?\s*[:\s]\s*\d{9}\b/i
const BANK_ACCT_RE   = /\baccount\s*(number|#)?\s*[:\s]\s*\d{6,17}\b/i
const CARD_RE        = /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/
const CVV_RE         = /\b(cvv|cvc)\s*[:\s]\s*\d{3,4}\b/i

const FIELD_FLAGS: Array<{ re: RegExp; category: HardPolicyCategory; rule: string }> = [
  { re: /ssn|social.security/i, category: 'government_id',
    rule: 'Novan never types SSN into any field; operator handles directly.' },
  { re: /bank.routing|aba.routing|routing.number/i, category: 'financial_credentials',
    rule: 'Novan never enters bank routing numbers.' },
  { re: /account.number|bank.account/i, category: 'financial_credentials',
    rule: 'Novan never enters bank account numbers.' },
  { re: /driver.license|passport|govt.id/i, category: 'government_id',
    rule: 'Novan never uploads government ID. Operator uploads through platform UI.' },
  { re: /selfie|liveness.check/i, category: 'government_id',
    rule: 'Novan cannot perform liveness checks. Operator does this on their device.' },
  { re: /w-?9|w-?4|1099/i, category: 'tax_signature',
    rule: 'Novan does not sign or submit tax forms on operator behalf.' },
  { re: /password|recovery.code|mfa/i, category: 'authentication',
    rule: 'Novan does not enter passwords or MFA codes.' },
]

const BUTTON_FLAGS: Array<{ re: RegExp; category: HardPolicyCategory; rule: string }> = [
  { re: /sign.+(submit|certify|agree)|i.certify/i, category: 'tax_signature',
    rule: 'Novan does not click sign-and-certify buttons on tax/financial forms.' },
  { re: /place.order|buy.now|complete.purchase|charge.card/i, category: 'unauthorized_purchase',
    rule: 'Novan does not click purchase buttons without per-action operator approval.' },
  { re: /transfer|withdraw|send.money|swap/i, category: 'irreversible_financial',
    rule: 'Novan does not click money-movement buttons.' },
  { re: /delete.permanently|empty.trash|hard.delete/i, category: 'permanent_deletion',
    rule: 'Novan does not click permanent-delete buttons; operator does this directly.' },
  { re: /grant.access|change.role|share.with/i, category: 'access_control_change',
    rule: 'Novan does not modify access controls without explicit operator approval per-action.' },
]

// ─── Enforcement ─────────────────────────────────────────────────────────────

export function enforceHardPolicy(action: PolicyAction): PolicyViolation | null {
  const v = action.value ?? ''
  const f = (action.fieldOrLabel ?? '').toLowerCase()

  // Check value patterns (any action type)
  if (SSN_RE.test(v)) {
    return {
      category:    'government_id',
      rule:        'SSN pattern in submitted value',
      evidence:    `value matched SSN regex in field=${action.fieldOrLabel}, channel=${action.channel}`,
      alternative: 'Operator enters SSN directly via platform UI; Novan resumes after.',
    }
  }
  if (BANK_ROUTING_RE.test(v) || BANK_ACCT_RE.test(v)) {
    return {
      category:    'financial_credentials',
      rule:        'Banking-info pattern in submitted value',
      evidence:    `value matched bank routing/account regex`,
      alternative: 'Operator enters banking info directly.',
    }
  }
  if (CARD_RE.test(v) || CVV_RE.test(v)) {
    return {
      category:    'financial_credentials',
      rule:        'Card-number / CVV pattern in submitted value',
      evidence:    `value matched card/CVV regex`,
      alternative: 'Operator enters card details directly.',
    }
  }

  // Check field-name flags
  if (action.type === 'submit_form_field') {
    for (const flag of FIELD_FLAGS) {
      if (flag.re.test(f)) {
        return {
          category:    flag.category,
          rule:        flag.rule,
          evidence:    `field "${action.fieldOrLabel}" matched hard-policy pattern`,
          alternative: 'Operator handles this field directly; Novan can pre-stage non-blocked fields.',
        }
      }
    }
  }

  // Check button-label flags
  if (action.type === 'click_button') {
    for (const flag of BUTTON_FLAGS) {
      if (flag.re.test(f)) {
        return {
          category:    flag.category,
          rule:        flag.rule,
          evidence:    `button "${action.fieldOrLabel}" matched hard-policy pattern`,
          alternative: 'Operator clicks this button directly.',
        }
      }
    }
  }

  return null
}

/** Convenience: check + return outcome for the brain-task layer. */
export function checkAction(action: PolicyAction): { ok: boolean; violation?: PolicyViolation } {
  const v = enforceHardPolicy(action)
  return v ? { ok: false, violation: v } : { ok: true }
}
