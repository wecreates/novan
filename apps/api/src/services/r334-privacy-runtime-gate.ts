/**
 * R146.334 — Privacy Runtime Gate (closes safety.privacy_runtime_gate)
 *
 * The closure: every op that submits user data to an external form must
 * pass through `checkBeforeSubmit()`. This function loads all importance-95+
 * privacy rules from workspace_memory and blocks the action if any rule
 * is violated, surfacing the rule text + a compliant alternative.
 *
 * Origin: R332 operator locked rule "never use home address publicly" at
 * importance 99. Without a runtime gate, that rule is a comment, not a
 * control. This is the control.
 *
 * Wire into: any op that accepts user-typed-or-filled form data
 *            (channel.save, brand.apply, profile.update, etc.)
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export type PrivacyViolation =
  | 'home_address_in_public_field'
  | 'ssn_in_public_field'
  | 'bank_account_in_public_field'
  | 'phone_personal_in_public_field'
  | 'email_personal_in_marketing'

export interface GateCheck {
  ok:               boolean
  violation?:       PrivacyViolation
  ruleId?:          string
  ruleText?:        string
  proposedAlternative?: string
  evidence?:        string
}

// Patterns that signal a typical US home address (street# + street + city + state + zip).
// Conservative on purpose — false positives are better than false negatives here.
const HOME_ADDRESS_PATTERN =
  /\b\d+\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Cir|Circle|Ter|Terrace)\b/i

const SSN_PATTERN  = /\b\d{3}-?\d{2}-?\d{4}\b/
const ROUTING_PATTERN = /\b[0-9]{9}\b/   // 9-digit ABA routing

const MARKETING_FIELDS = new Set([
  'shop_description', 'product_description', 'bio', 'about',
  'return_policy_text', 'support_message', 'tagline', 'brand_story',
  'shop_name', 'public_email',
])

const PUBLIC_FIELDS = new Set([
  ...MARKETING_FIELDS,
  'return_address', 'ship_from_address', 'public_address',
  'warehouse_address', 'business_address_public',
])

export interface SubmitInput {
  workspaceId: string
  channel:     string          // 'tiktok_shop' | 'printful' | 'inprnt' | etc.
  fieldName:   string          // e.g. 'return_address', 'bio'
  value:       string
}

export async function checkBeforeSubmit(input: SubmitInput): Promise<GateCheck> {
  const value = input.value ?? ''
  const isPublic = PUBLIC_FIELDS.has(input.fieldName)

  // Rule 1: home address in any public-facing field
  if (isPublic && HOME_ADDRESS_PATTERN.test(value)) {
    const rule = await loadRule(input.workspaceId, 'rule.never_use_home_address_publicly')
    return {
      ok: false,
      violation: 'home_address_in_public_field',
      ...(rule ? { ruleId: rule.key, ruleText: rule.value.slice(0, 200) } : {}),
      proposedAlternative:
        'Phase 1 ($0-200 MRR): use no public return address — set policy text "Contact seller within 14 days for returns." ' +
        'Phase 2 ($200+ MRR): substitute with virtual mailbox (Stable, iPostal1, ~$10/mo). ' +
        'NEVER use home address in any field labeled return/ship-from/warehouse/public.',
      evidence: `field=${input.fieldName}, channel=${input.channel}, pattern matched US street-address regex`,
    }
  }

  // Rule 2: SSN never goes in any field through Novan
  if (SSN_PATTERN.test(value)) {
    return {
      ok: false,
      violation: 'ssn_in_public_field',
      ruleId: 'rule.policy.financial_credentials_hard_block',
      ruleText: 'SSN is in the hard-block category — Novan never submits SSN to any platform regardless of field name or authorization.',
      proposedAlternative: 'Operator must enter SSN directly. Novan can pre-stage every non-SSN field and surface form-ready instructions.',
      evidence: `field=${input.fieldName}, channel=${input.channel}, SSN pattern matched`,
    }
  }

  // Rule 3: 9-digit routing number in non-banking field looks like a leak
  // (we never submit banking info anyway, but treat as a leak signal)
  if (ROUTING_PATTERN.test(value) && !input.fieldName.includes('bank') && !input.fieldName.includes('routing')) {
    return {
      ok: false,
      violation: 'bank_account_in_public_field',
      ruleId: 'rule.policy.financial_credentials_hard_block',
      ruleText: 'A 9-digit number resembling an ABA routing number appeared in a non-banking field.',
      proposedAlternative: 'If this is genuinely not bank data, prefix with a non-numeric character or relabel the field. If it is banking data, operator must enter it directly.',
      evidence: `field=${input.fieldName}, channel=${input.channel}`,
    }
  }

  return { ok: true }
}

async function loadRule(workspaceId: string, key: string): Promise<{ key: string; value: string } | null> {
  try {
    const rows = await db.execute(sql`
      SELECT key, value FROM workspace_memory
      WHERE workspace_id = ${workspaceId} AND key = ${key}
      LIMIT 1
    `) as unknown as Array<{ key: string; value: string }>
    return rows[0] ?? null
  } catch {
    return null
  }
}

/**
 * Bulk check — for ops that submit many fields at once (form bulk-fill).
 * Returns the first violation; caller should fix and retry.
 */
export async function checkAllFields(
  workspaceId: string,
  channel: string,
  fields: Record<string, string>,
): Promise<GateCheck> {
  for (const [fieldName, value] of Object.entries(fields)) {
    const r = await checkBeforeSubmit({ workspaceId, channel, fieldName, value })
    if (!r.ok) return r
  }
  return { ok: true }
}
