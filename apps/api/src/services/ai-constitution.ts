/**
 * ai-constitution.ts — immutable operational principles (#52).
 *
 * The single highest-priority module in the platform. Every autonomous
 * action MUST pass `checkConstitution(action)` before it fires. The
 * principles below cannot be overridden by any other layer — not the
 * operator's hands-free pref, not a "trusted" pattern, not a budget
 * approval, not a workspace admin.
 *
 * Pure function. No DB, no I/O. Tested with fixtures. Calling code
 * MUST treat `verdict: 'block'` as final.
 *
 * Closely related modules and how they layer:
 *   - voice-safety.classifyCommand    : hard blocks at the prompt level
 *   - voice-handsfree-policy           : per-intent allow/approval policy
 *   - strategic-restraint.shouldAutoAct : "is this the right moment?"
 *   - ai-constitution.checkConstitution : "is this allowed at all?"  ← here
 *
 * The four together form defense in depth: a "yes" requires all four.
 */

export type ConstitutionVerdict = 'allow' | 'block'

export interface ProposedAction {
  /** Stable identifier for the intent, e.g. "voice.research.start". */
  kind:         string
  /** True if this would execute without explicit operator confirmation. */
  autonomous:   boolean
  /** True if this hides the action from the audit trail or operator UI. */
  hidesFromOperator: boolean
  /** True if this would remove or reduce operator control / kill switches. */
  reducesOperatorAuthority: boolean
  /** True if this proposes changing the platform's own governance rules. */
  modifiesGovernance: boolean
  /** True if this would write a deceptive or fabricated record. */
  fabricatesRecord:   boolean
  /** True if this proposes self-modification (code or prompts). */
  selfModifies:       boolean
  /** Optional risk hint surfaced by upstream classifiers. */
  risk?:        'low' | 'medium' | 'high'
}

export interface ConstitutionDecision {
  verdict:    ConstitutionVerdict
  violated:   string[]
  reason:     string
}

/** The immutable principles. Order matters — earlier rules dominate. */
const PRINCIPLES: Array<{ id: string; predicate: (a: ProposedAction) => boolean; reason: string }> = [
  { id: 'protect_operator_sovereignty',
    predicate: a => a.reducesOperatorAuthority,
    reason:    'reduces operator authority / kill-switch control' },
  { id: 'preserve_auditability',
    predicate: a => a.hidesFromOperator,
    reason:    'hides action from audit trail or operator UI' },
  { id: 'preserve_truth',
    predicate: a => a.fabricatesRecord,
    reason:    'fabricates or falsifies a recorded outcome' },
  { id: 'no_unsafe_self_modification',
    predicate: a => a.selfModifies && a.autonomous,
    reason:    'autonomous self-modification is forbidden' },
  { id: 'no_unauthorized_governance_change',
    predicate: a => a.modifiesGovernance && a.autonomous,
    reason:    'autonomous governance modification is forbidden' },
  { id: 'no_high_risk_autonomy',
    predicate: a => a.autonomous && a.risk === 'high',
    reason:    'high-risk actions require explicit operator approval' },
]

/**
 * Check a proposed action against the constitution. Returns `block` on
 * any violation; `allow` only when EVERY principle is satisfied.
 */
export function checkConstitution(action: ProposedAction): ConstitutionDecision {
  const violated: string[] = []
  const reasons: string[] = []
  for (const p of PRINCIPLES) {
    if (p.predicate(action)) {
      violated.push(p.id)
      reasons.push(p.reason)
    }
  }
  if (violated.length === 0) {
    return { verdict: 'allow', violated: [], reason: 'all principles satisfied' }
  }
  return { verdict: 'block', violated, reason: reasons.join('; ') }
}

/** Read-only enumeration of the principles — for the Strategic Console. */
export function listPrinciples(): Array<{ id: string; reason: string }> {
  return PRINCIPLES.map(p => ({ id: p.id, reason: p.reason }))
}
