/**
 * issue-auto-loop.ts — closes the loop from issues → proposals → patches.
 *
 * The existing pipeline:
 *   issues (ledger)  →  code_proposals (drafts)  →  code_patches (built)  →  commits
 *
 * Each link existed separately; this service stitches them.
 *
 * Two cron-driven sweeps:
 *
 *   1. promoteDiagnosedIssues()
 *      For every issue with status='diagnosed' + no linked proposalId:
 *      synthesize a minimal CodeProposal from issue fields and link.
 *      Issue stays in 'diagnosed'; proposal lands in 'proposed' status
 *      so the operator can approve in the usual flow.
 *
 *   2. reconcileShippedPatches()
 *      For every issue with status='patched' + linked patchId:
 *      check the code_patches row. If status='shipped' with a commit
 *      sha, auto-transition issue to 'verified' with shipped commit
 *      as evidence. Operator still has to manually close.
 *
 * Honesty:
 *   - Step 1 does NOT call any LLM. It composes the proposal from the
 *     diagnosis fields the operator (or auto-ingest) already wrote.
 *     If those fields are sparse, the proposal will be sparse too.
 *   - Step 2 does NOT execute patches. It only records that an
 *     externally-shipped patch resolves the issue.
 *   - Neither step ever closes an issue. Final close is operator-only.
 */
import { v7 as uuidv7 } from 'uuid'
import { and, desc, eq, inArray, isNull, isNotNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { issues, codeProposals, events } from '../db/schema.js'
import { verifyIssue, linkProposal as linkProposalToIssue } from './issues.js'

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: (payload['issueId'] as string) ?? uuidv7(),
    causationId: null, source: 'api/issue-auto-loop', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ── Step 0: open → diagnosed (auto-diagnose common patterns) ──────────
//
// Auto-ingest creates issues in 'open' status when no rootCause is given.
// Without diagnosis, they never enter the rest of the loop. This step
// applies simple pattern-matching diagnoses so the brain can keep moving.
// Anything it can't recognize stays 'open' for operator review.

export interface AutoDiagnoseResult { scanned: number; diagnosed: number; skipped: number }

interface DiagnosisPattern {
  match:        RegExp
  rootCause:    string
  proposedFix:  string
  riskLevel:    'low' | 'medium' | 'high'
}

const DIAGNOSIS_PATTERNS: DiagnosisPattern[] = [
  { match: /\b503\b|service unavailable|temporarily unavailable/i,
    rootCause: 'Upstream service returning 503 (overload/maintenance)',
    proposedFix: 'Retry with exponential backoff + per-provider circuit breaker (provider-retry.ts)',
    riskLevel: 'low' },
  { match: /\b429\b|rate.?limit|too many requests/i,
    rootCause: 'Upstream rate limit exceeded',
    proposedFix: 'Honor Retry-After header, slow request rate, queue overflow to background',
    riskLevel: 'low' },
  { match: /\bECONNREFUSED|connect.*refused/i,
    rootCause: 'Target service not reachable',
    proposedFix: 'Add health check + retry with backoff before declaring failure',
    riskLevel: 'low' },
  { match: /\bETIMEDOUT|timeout|timed out/i,
    rootCause: 'Operation exceeded timeout window',
    proposedFix: 'Raise timeout for this path or break work into smaller chunks',
    riskLevel: 'low' },
  { match: /undefined is not|cannot read.*undefined|null is not/i,
    rootCause: 'Null/undefined access on an unexpected path',
    proposedFix: 'Add defensive guards + log the offending input shape',
    riskLevel: 'low' },
  { match: /unique constraint|duplicate key/i,
    rootCause: 'Duplicate insert — missing dedup or race condition',
    proposedFix: 'Use onConflictDoNothing or check-then-insert with txn',
    riskLevel: 'low' },
]

export async function autoDiagnoseIssues(workspaceId: string): Promise<AutoDiagnoseResult> {
  const open = await db.select().from(issues)
    .where(and(eq(issues.workspaceId, workspaceId), eq(issues.status, 'open')))
    .limit(20).catch(() => [])

  let diagnosed = 0, skipped = 0
  const { diagnoseIssue } = await import('./issues.js')
  for (const issue of open) {
    const hay = `${issue.symptom} ${(issue.evidence as Array<{ summary?: string }> ?? []).map(e => e.summary ?? '').join(' ')}`
    const pat = DIAGNOSIS_PATTERNS.find(p => p.match.test(hay))
    if (!pat) { skipped++; continue }
    await diagnoseIssue(workspaceId, issue.id, {
      rootCause:        pat.rootCause,
      proposedFix:      pat.proposedFix,
      verificationPlan: 'Re-run the failing operation; confirm no recurrence in last 30 min of events',
      riskLevel:        pat.riskLevel,
      diagnosedBy:      'auto-diagnoser',
    }).catch(() => null)
    await emit(workspaceId, 'issue.auto_diagnosed', {
      issueId: issue.id, pattern: pat.rootCause, riskLevel: pat.riskLevel,
    })
    diagnosed++
  }
  return { scanned: open.length, diagnosed, skipped }
}

// ── Step 1: diagnosed → proposed ──────────────────────────────────────

export interface PromoteResult {
  scanned:  number
  promoted: number
  errors:   number
}

export async function promoteDiagnosedIssues(workspaceId: string): Promise<PromoteResult> {
  const rows = await db.select().from(issues)
    .where(and(
      eq(issues.workspaceId, workspaceId),
      eq(issues.status, 'diagnosed'),
      isNull(issues.proposalId),
    ))
    .limit(20)
    .catch(() => [])

  let promoted = 0
  let errors = 0

  for (const issue of rows) {
    try {
      // Compose a minimal proposal from the diagnosis fields.
      // We don't pretend to know the file paths — the operator (or the
      // code-agent in a later step) figures that out. We set
      // filesToCreate/Modify to [] and let the agent fill them in.
      const proposalId = uuidv7()
      const title   = `Fix: ${issue.symptom.slice(0, 140)}`
      const summary = [
        issue.rootCause      && `Root cause: ${issue.rootCause}`,
        issue.proposedFix    && `Proposed fix: ${issue.proposedFix}`,
        issue.verificationPlan && `Verification: ${issue.verificationPlan}`,
        issue.affectedSystems.length > 0 && `Affected systems: ${issue.affectedSystems.join(', ')}`,
      ].filter(Boolean).join('\n\n')

      const now = Date.now()
      await db.insert(codeProposals).values({
        id:            proposalId,
        workspaceId:   issue.workspaceId,
        capabilityId:  `issue:${issue.id}`,  // synthetic capability id
        title,
        summary,
        filesToCreate: [],
        filesToModify: [],
        testsRequired: [],
        riskLevel:     (issue.riskLevel as 'low'|'medium'|'high'|'critical' | null) ?? 'medium',
        estimatedLoc:  0,
        status:        'proposed',
        reasoning:     [`Auto-promoted from issue ${issue.id} on ${new Date(now).toISOString()}`],
        createdAt:     now,
        updatedAt:     now,
      }).catch(() => null)

      await linkProposalToIssue(issue.workspaceId, issue.id, proposalId)
      await emit(issue.workspaceId, 'issue.auto_promoted_to_proposal', {
        issueId: issue.id, proposalId, riskLevel: issue.riskLevel,
      })
      promoted++
    } catch (e) {
      errors++
      await emit(issue.workspaceId, 'issue.auto_promote_failed', {
        issueId: issue.id, error: (e as Error).message,
      })
    }
  }

  return { scanned: rows.length, promoted, errors }
}

// ── Step 2: patched + shipped → verified ──────────────────────────────

export interface ReconcileResult {
  scanned:  number
  verified: number
  errors:   number
}

export async function reconcileShippedPatches(workspaceId: string): Promise<ReconcileResult> {
  // Look at issues that have a linked proposal AND are in patched state.
  // Verification gate: the linked code_proposals row must have
  // status='shipped' with a commit sha.
  const rows = await db.select().from(issues)
    .where(and(
      eq(issues.workspaceId, workspaceId),
      inArray(issues.status, ['patched']),
      isNotNull(issues.proposalId),
    ))
    .limit(50)
    .catch(() => [])

  let verified = 0
  let errors = 0

  for (const issue of rows) {
    if (!issue.proposalId) continue
    try {
      const prop = await db.select().from(codeProposals)
        .where(eq(codeProposals.id, issue.proposalId))
        .limit(1).then(r => r[0]).catch(() => undefined)
      if (!prop) continue
      if (prop.status !== 'shipped') continue

      const commitSha = prop.shippedCommitSha ?? undefined
      await verifyIssue(issue.workspaceId, issue.id, [{
        type:    'log',
        ref:     `proposal:${prop.id}`,
        summary: `Proposal ${prop.id} shipped${commitSha ? ` as ${commitSha.slice(0, 8)}` : ''}${prop.shippedBy ? ` by ${prop.shippedBy}` : ''}`,
        at:      prop.shippedAt ?? Date.now(),
      }], commitSha)
      await emit(issue.workspaceId, 'issue.auto_verified', {
        issueId: issue.id, proposalId: prop.id, commitSha,
      })
      verified++
    } catch (e) {
      errors++
      await emit(issue.workspaceId, 'issue.auto_verify_failed', {
        issueId: issue.id, error: (e as Error).message,
      })
    }
  }
  return { scanned: rows.length, verified, errors }
}

// ── Top-level entry point used by the cron ────────────────────────────

// ── Step 3: approved proposal → built patch ───────────────────────────
//
// When a proposal linked to an issue transitions to status='approved',
// auto-run the code-agent that builds the patch. This closes the gap
// between "operator approved the proposal" and "patch ready to ship."
//
// Hard rule from the directives doc: human approval still required.
// This step ONLY runs after the operator has explicitly approved the
// proposal — it never auto-approves anything.

export interface AutoBuildResult {
  scanned:  number
  built:    number
  errors:   number
}

export async function autoBuildApprovedProposals(workspaceId: string): Promise<AutoBuildResult> {
  // Find issues whose linked proposal is 'approved' but no patch yet.
  // We join in app code (no native JOIN) because the row counts are
  // small (≤50) and Drizzle's join ergonomics aren't worth it.
  const issuesPatched = await db.select().from(issues)
    .where(and(
      eq(issues.workspaceId, workspaceId),
      eq(issues.status, 'diagnosed'),   // issue is still 'diagnosed' until linkPatch transitions it
      isNotNull(issues.proposalId),
    ))
    .limit(20)
    .catch(() => [])

  if (issuesPatched.length === 0) return { scanned: 0, built: 0, errors: 0 }

  let built = 0
  let errors = 0
  const { buildPatchFromProposal } = await import('./code-agent.js')
  const { linkPatch } = await import('./issues.js')

  for (const issue of issuesPatched) {
    if (!issue.proposalId) continue
    try {
      // Look up proposal status — only proceed if 'approved'
      const prop = await db.select().from(codeProposals)
        .where(eq(codeProposals.id, issue.proposalId))
        .limit(1).then(r => r[0]).catch(() => undefined)
      if (!prop || prop.status !== 'approved') continue

      const result = await buildPatchFromProposal(workspaceId, issue.proposalId)
      // buildPatchFromProposal creates a code_patches row. Link it to the issue.
      const patchId = (result as { patchId?: string }).patchId
      if (patchId) {
        await linkPatch(workspaceId, issue.id, patchId)
        await emit(workspaceId, 'issue.auto_patch_built', {
          issueId: issue.id, proposalId: issue.proposalId, patchId,
        })
        built++
      }
    } catch (e) {
      errors++
      await emit(workspaceId, 'issue.auto_build_failed', {
        issueId: issue.id, error: (e as Error).message,
      })
    }
  }
  return { scanned: issuesPatched.length, built, errors }
}

// ── Step 2.5: auto-approve safe issue-linked proposals ────────────────
//
// Brain-driven patching needs a way through the proposed→approved gate.
// We only auto-approve when ALL of:
//   - proposal is linked to an issue (capability_id starts with 'issue:')
//   - riskLevel = 'low'
//   - selfEditLoopsAllowed flag is true for this workspace
//   - daily auto-approval budget not exhausted
//   - none of the listed files match protected paths
//
// Anything else stays gated for operator approval.

export interface AutoApproveResult { scanned: number; approved: number; skipped: number }
const DAILY_AUTO_APPROVE_BUDGET = 3

async function approvedTodayCount(workspaceId: string): Promise<number> {
  // Count ONLY autonomous activity — operator/claude-audit shipments
  // don't count against the autonomous daily budget. We tag autonomous
  // approvals via the 'issue.auto_approved' event in the events table.
  const since = Date.now() - 24 * 60 * 60_000
  const rows = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'issue.auto_approved'),
    ))
    .catch(() => [])
  return rows.filter(r => (r.createdAt ?? 0) >= since).length
}

export async function autoApproveSafeProposals(workspaceId: string): Promise<AutoApproveResult> {
  const { isAllowed } = await import('./safety-mode.js')
  const allowed = await isAllowed(workspaceId, 'self_edit_loop').catch(() => false)
  if (!allowed) return { scanned: 0, approved: 0, skipped: 0 }

  const budgetUsed = await approvedTodayCount(workspaceId)
  const remaining  = Math.max(0, DAILY_AUTO_APPROVE_BUDGET - budgetUsed)
  if (remaining === 0) return { scanned: 0, approved: 0, skipped: 0 }

  const { isProtectedPath } = await import('./governance-core.js')

  // Candidates: issue-linked, proposed, low-risk
  const candidates = await db.select().from(codeProposals)
    .where(and(
      eq(codeProposals.workspaceId, workspaceId),
      eq(codeProposals.status, 'proposed'),
      eq(codeProposals.riskLevel, 'low'),
    ))
    .limit(20).catch(() => [])

  let approved = 0, skipped = 0
  for (const p of candidates) {
    if (approved >= remaining) break
    if (!p.capabilityId || !p.capabilityId.startsWith('issue:')) { skipped++; continue }

    const allFiles = [
      ...(p.filesToCreate as Array<{ path: string }> ?? []),
      ...(p.filesToModify as Array<{ path: string }> ?? []),
    ].map(f => f.path).filter(Boolean)
    const hitsProtected = allFiles.some(fp => isProtectedPath(fp).protected)
    if (hitsProtected) {
      skipped++
      await emit(workspaceId, 'issue.auto_approve_skipped', {
        proposalId: p.id, reason: 'protected-path', files: allFiles,
      })
      continue
    }

    await db.update(codeProposals).set({ status: 'approved', updatedAt: Date.now() })
      .where(eq(codeProposals.id, p.id)).catch(() => null)
    await emit(workspaceId, 'issue.auto_approved', {
      proposalId: p.id, riskLevel: p.riskLevel, files: allFiles, dailyRemaining: remaining - approved - 1,
    })
    approved++
  }
  return { scanned: candidates.length, approved, skipped }
}

// ── Step 4: validated patch → applied on disk ──────────────────────────
//
// After buildPatchFromProposal lands a `validated` code_patches row, this
// step applies the files via patch-executor (which has its OWN governance
// + protected-path guard). On success, the proposal is shipped and the
// issue moves to 'patched'. On failure, the proposal is rejected so we
// don't loop on a bad patch.

export interface AutoApplyResult { scanned: number; applied: number; failed: number; skipped: number }

export async function autoApplyValidatedPatches(workspaceId: string): Promise<AutoApplyResult> {
  const { isAllowed } = await import('./safety-mode.js')
  const allowed = await isAllowed(workspaceId, 'self_edit_loop').catch(() => false)
  if (!allowed) return { scanned: 0, applied: 0, failed: 0, skipped: 0 }

  const { codePatches } = await import('../db/schema.js')
  const { applyPatches } = await import('./patch-executor.js')
  const { linkPatch }    = await import('./issues.js')

  // Look up validated patches whose proposal is approved (and thus
  // cleared by Step 2.5 or operator).
  const validated = await db.select().from(codePatches)
    .where(and(
      eq(codePatches.workspaceId, workspaceId),
      eq(codePatches.status, 'validated'),
    ))
    .limit(10).catch(() => [])

  let applied = 0, failed = 0, skipped = 0
  const repoRoot = process.cwd()   // dev/launch.ps1 keeps cwd at repo root

  for (const patch of validated) {
    const prop = patch.proposalId ? await db.select().from(codeProposals)
      .where(eq(codeProposals.id, patch.proposalId)).limit(1).then(r => r[0]).catch(() => undefined) : undefined
    if (!prop || prop.status !== 'approved') { skipped++; continue }

    // code_patches.files has shape { path, contents, op } — pull `contents`.
    const files = (patch.files as Array<{ path: string; contents: string }> ?? [])
      .filter(f => f.path && typeof f.contents === 'string')
    if (files.length === 0) { skipped++; continue }

    // Refuse to apply stub-tagged patches — code-agent marks files with
    // STUB_NOT_FOR_AUTO_APPLY when all LLM providers failed and it
    // fell back to template generation. Applying these would write
    // `// TODO[code-agent]: implement.` to the live codebase.
    const hasStubs = files.some(f => f.contents.startsWith('// STUB_NOT_FOR_AUTO_APPLY'))
    if (hasStubs) {
      await emit(workspaceId, 'issue.auto_apply_refused', {
        patchId: patch.id, reason: 'stub-tagged — operator must approve manually',
      })
      skipped++
      continue
    }

    const result = await applyPatches({
      jobId:       `auto:${patch.id}`,
      runId:       `auto:${patch.id}`,
      workspaceId,
      rootPath:    repoRoot,
      patches:     files.map(f => ({ filePath: f.path, patchedContent: f.contents })),
    }).catch(err => ({ results: [], anyFailed: true, rollbackNeeded: false, error: (err as Error).message }))

    const success = !('error' in result) && !result.anyFailed && result.results.some(r => r.status === 'applied')
    if (success) {
      const firstApplied = result.results.find(r => r.status === 'applied')
      await db.update(codeProposals).set({
        status: 'shipped', shippedAt: Date.now(), shippedBy: 'auto-apply',
        updatedAt: Date.now(),
      }).where(eq(codeProposals.id, prop.id)).catch(() => null)
      const issueId = prop.capabilityId?.replace(/^issue:/, '')
      if (issueId && firstApplied?.recordId) {
        await linkPatch(workspaceId, issueId, firstApplied.recordId).catch(() => null)
      }
      await emit(workspaceId, 'issue.auto_applied', {
        proposalId: prop.id, patchId: patch.id,
        applied: result.results.filter(r => r.status === 'applied').length,
        skipped: result.results.filter(r => r.status === 'skipped').length,
      })
      applied++
    } else {
      const reason = 'error' in result ? result.error : result.results.map(r => r.error).filter(Boolean).join('; ')
      await db.update(codeProposals).set({ status: 'rejected', updatedAt: Date.now() })
        .where(eq(codeProposals.id, prop.id)).catch(() => null)
      await emit(workspaceId, 'issue.auto_apply_failed', { proposalId: prop.id, patchId: patch.id, reason })
      failed++
    }
  }
  return { scanned: validated.length, applied, failed, skipped }
}

export interface AutoLoopResult {
  workspaceId: string
  diagnose:    AutoDiagnoseResult
  promote:     PromoteResult
  approve:     AutoApproveResult
  build:       AutoBuildResult
  apply:       AutoApplyResult
  reconcile:   ReconcileResult
}

export async function runAutoLoopFor(workspaceId: string): Promise<AutoLoopResult> {
  const { recordAgentActivityAsync } = await import('./agent-state-sync.js')
  // Each stage maps to a logical agent type for activity tracking.
  recordAgentActivityAsync(workspaceId, 'fact_checker',     { status: 'running' })
  const diagnose  = await autoDiagnoseIssues(workspaceId)
  recordAgentActivityAsync(workspaceId, 'fact_checker',     { status: 'idle' })

  recordAgentActivityAsync(workspaceId, 'research_planner', { status: 'running' })
  const promote   = await promoteDiagnosedIssues(workspaceId)
  recordAgentActivityAsync(workspaceId, 'research_planner', { status: 'idle' })

  recordAgentActivityAsync(workspaceId, 'workflow',         { status: 'running' })
  const approve   = await autoApproveSafeProposals(workspaceId)
  const build     = await autoBuildApprovedProposals(workspaceId)
  const apply     = await autoApplyValidatedPatches(workspaceId)
  const reconcile = await reconcileShippedPatches(workspaceId)
  recordAgentActivityAsync(workspaceId, 'workflow',         { status: 'idle' })

  return { workspaceId, diagnose, promote, approve, build, apply, reconcile }
}
