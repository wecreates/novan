/**
 * R146.340 — Adversarial Self-Check (closes reasoning.adversarial_self_check 3→8)
 *
 * Before any non-trivial finding/decision/output is treated as fact, run it
 * through multiple lenses: correctness, security, cost, privacy, regression.
 * Majority vote required. Cheap when claims are obvious; depth scales with
 * impact tier.
 *
 * No LLM calls in v1 — rule-based verifiers per lens. Easy to add LLM
 * verifiers later as a separate file.
 */

export type VerifierLens = 'correctness' | 'security' | 'cost' | 'privacy' | 'regression' | 'evidence'

export interface VerifierVerdict {
  lens:       VerifierLens
  pass:       boolean
  confidence: number               // 0-1
  concern?:   string
  suggestion?: string
}

export interface Claim {
  statement:  string               // "Provider X is healthy"
  evidence:   string               // "probe returned 200 at <ts>"
  impactTier: 'low' | 'medium' | 'high'  // higher tier triggers more lenses + higher threshold
  metadata?:  Record<string, unknown>
}

export interface VerificationResult {
  claim:      Claim
  verdicts:   VerifierVerdict[]
  passCount:  number
  failCount:  number
  passed:     boolean              // majority pass + meets impact threshold
  rationale:  string
}

// ─── Per-lens verifiers ──────────────────────────────────────────────────────

function verifyCorrectness(claim: Claim): VerifierVerdict {
  const e = claim.evidence.toLowerCase()
  // Strong evidence keywords
  const strong = ['returned 200', 'verified', 'tested', 'matches', 'asserted', 'observed']
  const weak   = ['probably', 'maybe', 'likely', 'assume', 'should', 'expected']
  const strongHits = strong.filter(s => e.includes(s)).length
  const weakHits   = weak.filter(s => e.includes(s)).length
  const conf = Math.max(0, Math.min(1, 0.5 + (strongHits * 0.15) - (weakHits * 0.2)))
  return {
    lens:       'correctness',
    pass:       conf >= 0.5,
    confidence: conf,
    ...(conf < 0.5 ? { concern: 'Evidence contains hedging language without verification' } : {}),
    ...(conf < 0.5 ? { suggestion: 'Add concrete test result, status code, or measurement' } : {}),
  }
}

function verifySecurity(claim: Claim): VerifierVerdict {
  const s = claim.statement.toLowerCase()
  const e = claim.evidence.toLowerCase()
  // Look for dangerous patterns
  const risky = ['bypass', 'skip auth', 'disable check', 'override policy', 'force', 'expose secret']
  const hits = risky.filter(r => s.includes(r) || e.includes(r))
  if (hits.length > 0) {
    return {
      lens:       'security',
      pass:       false,
      confidence: 0.9,
      concern:    `Statement contains security-sensitive language: ${hits.join(', ')}`,
      suggestion: 'Re-evaluate whether the bypass is necessary; surface to operator for explicit approval',
    }
  }
  return { lens: 'security', pass: true, confidence: 0.7 }
}

function verifyCost(claim: Claim): VerifierVerdict {
  const s = claim.statement.toLowerCase()
  // Catch unbounded operations
  const unbounded = /(all|every|forever|unlimited)/i.test(s)
  const hasBudget = /\$\d+|budget|cap|limit/i.test(s) || /\$\d+|budget|cap|limit/i.test(claim.evidence)
  if (unbounded && !hasBudget) {
    return {
      lens:       'cost',
      pass:       false,
      confidence: 0.8,
      concern:    'Unbounded scope without explicit cost cap',
      suggestion: 'Add explicit budget cap or count limit',
    }
  }
  return { lens: 'cost', pass: true, confidence: 0.6 }
}

function verifyPrivacy(claim: Claim): VerifierVerdict {
  const s = claim.statement
  const e = claim.evidence
  // Quick scan for PII patterns
  if (/\b\d{3}-?\d{2}-?\d{4}\b/.test(s) || /\b\d{3}-?\d{2}-?\d{4}\b/.test(e)) {
    return {
      lens:       'privacy',
      pass:       false,
      confidence: 0.95,
      concern:    'SSN pattern detected in statement or evidence',
      suggestion: 'Redact before logging; hard-block submission',
    }
  }
  if (/\b\d+\s+[A-Z][a-z]+\s+(Street|Ave|Rd|Blvd|Lane|Drive)\b/.test(s)) {
    return {
      lens:       'privacy',
      pass:       false,
      confidence: 0.85,
      concern:    'Home address pattern detected',
      suggestion: 'Substitute with virtual mailbox or generic shop address',
    }
  }
  return { lens: 'privacy', pass: true, confidence: 0.7 }
}

function verifyRegression(claim: Claim): VerifierVerdict {
  // Without test-suite integration, this is shallow: warn if statement
  // describes behavior change without evidence of test coverage.
  const s = claim.statement.toLowerCase()
  const e = claim.evidence.toLowerCase()
  const isChange = /change|update|modify|replace|refactor/.test(s)
  const hasTest = /test|verified|passing|green/.test(e)
  if (isChange && !hasTest) {
    return {
      lens:       'regression',
      pass:       false,
      confidence: 0.7,
      concern:    'Behavior change claimed without test-verification evidence',
      suggestion: 'Run relevant test suite + include result in evidence',
    }
  }
  return { lens: 'regression', pass: true, confidence: 0.6 }
}

function verifyEvidence(claim: Claim): VerifierVerdict {
  if (claim.evidence.trim().length < 20) {
    return {
      lens:       'evidence',
      pass:       false,
      confidence: 0.9,
      concern:    'Evidence string is suspiciously short (<20 chars)',
      suggestion: 'Include concrete data: timestamps, IDs, status codes, measurements',
    }
  }
  return { lens: 'evidence', pass: true, confidence: 0.8 }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function verify(claim: Claim): VerificationResult {
  const allVerifiers = [verifyCorrectness, verifySecurity, verifyCost, verifyPrivacy, verifyRegression, verifyEvidence]
  // Tier scales lens count: low=3, medium=5, high=all 6
  const tierLensCount = { low: 3, medium: 5, high: 6 }
  const lensCount = tierLensCount[claim.impactTier]
  const verdicts = allVerifiers.slice(0, lensCount).map(fn => fn(claim))
  const passCount = verdicts.filter(v => v.pass).length
  const failCount = verdicts.length - passCount

  // Threshold: low=majority, medium=2/3, high=all-pass-except-1
  const threshold = { low: 0.5, medium: 0.66, high: (verdicts.length - 1) / verdicts.length }[claim.impactTier]
  const passRatio = passCount / verdicts.length
  const passed = passRatio >= threshold

  const concerns = verdicts.filter(v => !v.pass).map(v => `${v.lens}: ${v.concern ?? 'failed'}`).join('; ')
  const rationale = passed
    ? `${passCount}/${verdicts.length} lenses passed (threshold ${(threshold * 100).toFixed(0)}%)`
    : `${failCount} lens(es) failed: ${concerns}`

  return { claim, verdicts, passCount, failCount, passed, rationale }
}
