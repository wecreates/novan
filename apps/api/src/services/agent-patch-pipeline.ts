/**
 * Agent Patch Pipeline
 *
 * Stages: diagnose → plan → generate → validate → test → apply | rollback
 *
 * Safety limits enforced before patch is applied:
 *   MAX_PATCH_SIZE_LINES = 500
 *   MAX_FILES_CHANGED    = 10
 *   PATCH_RETRY_LIMIT    = 3
 */

import { v7 as uuidv7 }        from 'uuid'
import { db }                  from '../db/client.js'
import { events }              from '../db/schema.js'
import { getJob, updateJob }   from './agent-job-store.js'
import { recordAgentSuccess, recordAgentFailure } from './agent-registry.js'
import type { AgentType }      from './agent-registry.js'
import { runTypecheck, runTests } from './verification-engine.js'

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_PATCH_SIZE_LINES = 500
export const MAX_FILES_CHANGED    = 10
export const PATCH_RETRY_LIMIT    = 3

// Agent types that always require approval for any code change
const APPROVAL_REQUIRED_AGENTS: AgentType[] = ['coder', 'security']

// File patterns that force approval regardless of agent type
const HIGH_RISK_PATTERNS: RegExp[] = [
  /auth/i, /payment|billing/i, /password|secret|\.env/i,
  /schema|migration/i, /deploy/i,
]

// ─── Types ────────────────────────────────────────────────────────────────────

export type PipelineStage =
  | 'queued' | 'diagnose' | 'plan' | 'generate'
  | 'validate' | 'test' | 'apply' | 'rollback' | 'done' | 'failed'

export interface PipelineResult {
  jobId:             string
  stage:             PipelineStage
  success:           boolean
  patchLinesChanged: number
  filesChanged:      number
  validationPassed:  boolean
  testsPassed:       boolean
  applied:           boolean
  rolledBack:        boolean
  errorMessage:      string | null
  retryCount:        number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requiresApproval(agentType: AgentType, targetFiles: string[]): boolean {
  if (APPROVAL_REQUIRED_AGENTS.includes(agentType)) return true
  return targetFiles.some(f => HIGH_RISK_PATTERNS.some(p => p.test(f)))
}

/**
 * Plan the shape of a patch from the job description + declared targets.
 * Returns the planned scope (file list + estimated line count from the patch
 * content the job provides). Does NOT fabricate patch contents.
 *
 * If `job.patch` is empty, returns null — the caller MUST fail honestly
 * rather than apply a made-up patch.
 */
function planPatch(
  patchContent: string | null | undefined,
  targetFiles: string[],
): { lines: number; files: string[] } | null {
  if (!patchContent || patchContent.trim().length === 0) return null
  if (targetFiles.length === 0) return null

  // Count real changed lines from the unified-diff content the job provides.
  // Lines beginning with '+' or '-' (excluding diff headers) are counted.
  const lines = patchContent.split('\n').filter(
    (l) => (l.startsWith('+') && !l.startsWith('+++')) ||
           (l.startsWith('-') && !l.startsWith('---')),
  ).length

  return { lines, files: targetFiles }
}

async function emitStage(
  workspaceId: string, jobId: string,
  stage: string, payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type: `eng_pipeline.${stage}`, workspaceId,
    payload: { jobId, stage, ...payload },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/eng-agents/pipeline', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

function fail(
  jobId: string, stage: PipelineStage, msg: string,
  lines = 0, files = 0, retry = 0,
): PipelineResult {
  return {
    jobId, stage, success: false,
    patchLinesChanged: lines, filesChanged: files,
    validationPassed: false, testsPassed: false,
    applied: false, rolledBack: false,
    errorMessage: msg, retryCount: retry,
  }
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export async function runPipeline(jobId: string): Promise<PipelineResult> {
  const job = getJob(jobId)
  if (!job) return fail(jobId, 'failed', 'Job not found')

  const retryCount = job._retryCount
  const ws = job.workspaceId

  // Retry limit gate
  if (retryCount >= PATCH_RETRY_LIMIT) {
    await updateJob(jobId, {
      status: 'failed', errorMessage: 'Retry limit reached',
      completedAt: Date.now(), stage: 'failed',
    })
    recordAgentFailure(ws, job.agentType)
    return fail(jobId, 'failed', 'Retry limit reached', 0, 0, retryCount)
  }

  // Approval gate
  if (job.requiresApproval && !job.approvedAt) {
    await updateJob(jobId, { status: 'awaiting_approval', stage: 'plan' })
    await emitStage(ws, jobId, 'awaiting_approval', { agentType: job.agentType })
    return fail(jobId, 'plan', 'Awaiting approval', 0, 0, retryCount)
  }

  // ── diagnose ──────────────────────────────────────────────────────────────
  await updateJob(jobId, { status: 'running', startedAt: Date.now(), stage: 'diagnose' })
  await emitStage(ws, jobId, 'diagnose', { agentType: job.agentType })

  // ── plan ─────────────────────────────────────────────────────────────────
  await updateJob(jobId, { stage: 'plan' })
  await emitStage(ws, jobId, 'plan', {})

  // ── generate ─────────────────────────────────────────────────────────────
  await updateJob(jobId, { stage: 'generate' })

  // Honest gate: this pipeline does NOT fabricate patches. The job must
  // arrive with `patch` content provided by the agent (LLM or operator).
  // If no patch content is present, fail explicitly rather than apply a stub.
  const plan = planPatch(job.patch, job.targetFiles)
  if (!plan) {
    const msg = 'No patch content provided — autonomous LLM-driven patch generation is not wired. ' +
                'Job must arrive with `patch` (unified diff) and non-empty `targetFiles`.'
    await updateJob(jobId, { status: 'failed', errorMessage: msg, completedAt: Date.now(), stage: 'failed' })
    recordAgentFailure(ws, job.agentType)
    await emitStage(ws, jobId, 'generate.no_patch', { reason: msg })
    return fail(jobId, 'generate', msg, 0, 0, retryCount)
  }
  const { lines, files } = plan
  await emitStage(ws, jobId, 'generate', { linesChanged: lines, filesChanged: files.length })

  // Safety: patch size
  if (lines > MAX_PATCH_SIZE_LINES) {
    const msg = `Patch too large: ${lines} lines (max ${MAX_PATCH_SIZE_LINES})`
    await updateJob(jobId, { status: 'failed', errorMessage: msg, completedAt: Date.now(), stage: 'failed' })
    recordAgentFailure(ws, job.agentType)
    return fail(jobId, 'generate', msg, lines, files.length, retryCount)
  }

  // Safety: file count
  if (files.length > MAX_FILES_CHANGED) {
    const msg = `Too many files: ${files.length} (max ${MAX_FILES_CHANGED})`
    await updateJob(jobId, { status: 'failed', errorMessage: msg, completedAt: Date.now(), stage: 'failed' })
    recordAgentFailure(ws, job.agentType)
    return fail(jobId, 'generate', msg, lines, files.length, retryCount)
  }

  // ── validate (real tsc --noEmit) ─────────────────────────────────────────
  // In tests, skip real spawning (would recurse). Production runs real tsc.
  const skipRealVerification = process.env['NODE_ENV'] === 'test'
  await updateJob(jobId, { stage: 'validate' })
  await emitStage(ws, jobId, 'validate', { skipped: skipRealVerification })
  const cwd = process.env['REPO_ROOT'] ?? process.cwd()
  const tscResult = skipRealVerification
    ? { evidenceId: 'test-skip', command: 'tsc', args: [], exitCode: 0,
        stdout: '', stderr: '', passed: true, durationMs: 0 }
    : await runTypecheck({
        jobId, runId: jobId, workspaceId: ws, cwd,
      }).catch((e) => ({
        evidenceId: '', command: 'tsc', args: [], exitCode: 1,
        stdout: '', stderr: (e as Error).message, passed: false, durationMs: 0,
      }))
  const validationPassed = tscResult.passed
  await emitStage(ws, jobId, 'validate.result', {
    passed: validationPassed, evidenceId: tscResult.evidenceId,
  })
  if (!validationPassed) {
    const msg = `Typecheck failed (real tsc run): ${tscResult.stderr.slice(0, 200)}`
    await updateJob(jobId, { status: 'failed', errorMessage: msg, completedAt: Date.now(), stage: 'failed' })
    recordAgentFailure(ws, job.agentType)
    return fail(jobId, 'validate', msg, lines, files.length, retryCount)
  }

  // ── test (real vitest run) ───────────────────────────────────────────────
  await updateJob(jobId, { stage: 'test' })
  await emitStage(ws, jobId, 'test', { skipped: skipRealVerification })
  const testResult = skipRealVerification
    ? { evidenceId: 'test-skip', command: 'vitest', args: [], exitCode: 0,
        stdout: '', stderr: '', passed: true, durationMs: 0 }
    : await runTests({
        jobId, runId: jobId, workspaceId: ws, cwd,
      }).catch((e) => ({
        evidenceId: '', command: 'vitest', args: [], exitCode: 1,
        stdout: '', stderr: (e as Error).message, passed: false, durationMs: 0,
      }))
  const testsPassed = testResult.passed
  await emitStage(ws, jobId, 'test.result', {
    passed: testsPassed, evidenceId: testResult.evidenceId,
  })
  if (!testsPassed) {
    const msg = `Tests failed (real vitest run): ${testResult.stderr.slice(0, 200)}`
    await updateJob(jobId, { status: 'failed', errorMessage: msg, completedAt: Date.now(), stage: 'failed' })
    recordAgentFailure(ws, job.agentType)
    return fail(jobId, 'test', msg, lines, files.length, retryCount)
  }

  // ── apply (uses real job-provided patch content) ─────────────────────────
  // Note: actual filesystem writes are handled by patch-executor.ts when the
  // dispatching route calls applyPatches(). This pipeline records the planned
  // patch and lets the executor own the apply step — single source of truth.
  await updateJob(jobId, {
    stage: 'apply',
    patch: job.patch,
    rollbackPatch: job.rollbackPatch ?? null,
    status: 'completed', completedAt: Date.now(),
  })
  await emitStage(ws, jobId, 'apply', { linesChanged: lines, filesChanged: files.length })

  recordAgentSuccess(ws, job.agentType, jobId, true)

  return {
    jobId, stage: 'done', success: true,
    patchLinesChanged: lines, filesChanged: files.length,
    validationPassed, testsPassed,
    applied: true, rolledBack: false,
    errorMessage: null, retryCount,
  }
}

export { requiresApproval }
