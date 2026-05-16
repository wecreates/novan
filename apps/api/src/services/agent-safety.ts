/**
 * Agent Safety Controls
 *
 * Central safety policy for all engineering agents.
 * Single source of truth for limits and high-risk patterns.
 */

import type { AgentType }                              from './agent-registry.js'
import { MAX_PATCH_SIZE_LINES, MAX_FILES_CHANGED, PATCH_RETRY_LIMIT } from './agent-patch-pipeline.js'

export { SAFETY_LOCK_THRESHOLD } from './agent-registry.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SafetyCheckResult {
  approved:         boolean
  violations:       string[]
  requiresApproval: boolean
}

export interface SafetyLimits {
  maxPatchSizeLines:        number
  maxFilesChanged:          number
  patchRetryLimit:          number
  safetyLockThreshold:      number
  highRiskPatterns:         string[]
  agentsRequiringApproval:  AgentType[]
}

// ─── High-risk patterns ───────────────────────────────────────────────────────

const HIGH_RISK: { pattern: RegExp; reason: string }[] = [
  { pattern: /auth/i,              reason: 'auth system — manual review required' },
  { pattern: /payment|billing/i,   reason: 'payment system — manual review required' },
  { pattern: /password|secret/i,   reason: 'credentials — blocked' },
  { pattern: /schema|migration/i,  reason: 'DB schema — manual review required' },
  { pattern: /\.env/i,             reason: 'env file — blocked' },
  { pattern: /deploy/i,            reason: 'deployment config — manual review required' },
]

const APPROVAL_AGENTS: AgentType[] = ['coder', 'security']

// ─── Safety check ─────────────────────────────────────────────────────────────

export function checkPatchSafety(
  agentType:      AgentType,
  targetFiles:    string[],
  estimatedLines: number,
  retryCount:     number,
): SafetyCheckResult {
  const violations: string[] = []
  let requiresApproval = APPROVAL_AGENTS.includes(agentType) && targetFiles.length > 0

  if (estimatedLines > MAX_PATCH_SIZE_LINES) {
    violations.push(`Patch size ${estimatedLines} exceeds limit ${MAX_PATCH_SIZE_LINES}`)
  }
  if (targetFiles.length > MAX_FILES_CHANGED) {
    violations.push(`File count ${targetFiles.length} exceeds limit ${MAX_FILES_CHANGED}`)
  }
  if (retryCount >= PATCH_RETRY_LIMIT) {
    violations.push(`Retry count ${retryCount} reached limit ${PATCH_RETRY_LIMIT}`)
  }

  for (const file of targetFiles) {
    for (const { pattern, reason } of HIGH_RISK) {
      if (pattern.test(file)) {
        requiresApproval = true
        violations.push(`High-risk file "${file}": ${reason}`)
      }
    }
  }

  // Hard violations are size/retry breaches (not approval gates)
  const hardViolations = violations.filter(
    v => !v.startsWith('High-risk'),
  )

  return {
    approved: hardViolations.length === 0,
    violations,
    requiresApproval,
  }
}

export function getSafetyLimits(): SafetyLimits {
  return {
    maxPatchSizeLines:       MAX_PATCH_SIZE_LINES,
    maxFilesChanged:         MAX_FILES_CHANGED,
    patchRetryLimit:         PATCH_RETRY_LIMIT,
    safetyLockThreshold:     3,
    highRiskPatterns:        HIGH_RISK.map(h => h.pattern.source),
    agentsRequiringApproval: APPROVAL_AGENTS,
  }
}
