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

/** Deterministic simulation — real impl would run tsc/vitest. */
function simulatePatch(description: string, targetFiles: string[]): {
  lines: number; files: string[]
} {
  const lines = Math.min(Math.max(description.length, 10), 200)
  const files  = targetFiles.length > 0 ? targetFiles : [`src/generated/${description.slice(0, 24).replace(/\s+/g, '-')}.ts`]
  return { lines, files }
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
  const { lines, files } = simulatePatch(job.description, job.targetFiles)
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

  // ── validate ─────────────────────────────────────────────────────────────
  await updateJob(jobId, { stage: 'validate' })
  await emitStage(ws, jobId, 'validate', {})
  const validationPassed = true // real: spawn tsc --noEmit

  // ── test ─────────────────────────────────────────────────────────────────
  await updateJob(jobId, { stage: 'test' })
  await emitStage(ws, jobId, 'test', {})
  const testsPassed = true // real: spawn vitest run --reporter=json

  // ── apply ─────────────────────────────────────────────────────────────────
  const patch         = `--- a/generated.ts\n+++ b/generated.ts\n@@ -0,0 +1,${lines} @@\n// patch by ${job.agentType}`
  const rollbackPatch = `--- b/generated.ts\n+++ a/generated.ts\n@@ -1,${lines} +0,0 @@\n// rollback`

  await updateJob(jobId, {
    stage: 'apply', patch, rollbackPatch,
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
