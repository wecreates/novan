/**
 * verification-engine.ts — Real command execution for patch validation.
 * Spawns tsc, eslint, vitest, vite build and captures real exit codes.
 * ALL results persisted to verification_evidence table.
 * A "verified" status is only valid if evidence.passed === true.
 */
import { spawn }    from 'node:child_process'
import { db }                    from '../db/client.js'
import { verificationEvidence } from '../db/schema.js'
import { v7 as uuidv7 }         from 'uuid'
import { redactSecrets, buildSandboxEnv } from './secret-redactor.js'
import {
  recordFailure, recordSuccessfulFix, buildSignature,
}                                from './failure-memory.js'
import type { RootCauseClass }   from './failure-memory.js'
import { db as failureDb }       from '../db/client.js'
import { failureMemory }         from '../db/schema.js'
import { eq, and }               from 'drizzle-orm'

export interface VerifyResult {
  evidenceId: string
  command:    string
  args:       string[]
  exitCode:   number
  stdout:     string
  stderr:     string
  passed:     boolean
  durationMs: number
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  return new Promise((resolve) => {
    const start  = Date.now()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    // Use sandbox env — strips all secret env vars from child process
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === 'win32',
      env: buildSandboxEnv(process.env as Record<string, string | undefined>),
    })

    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d))
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d))

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode:  code ?? 1,
        stdout:    Buffer.concat(stdoutChunks).toString('utf8').slice(0, 50_000),
        stderr:    Buffer.concat(stderrChunks).toString('utf8').slice(0, 50_000),
        durationMs: Date.now() - start,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ exitCode: 1, stdout: '', stderr: err.message, durationMs: Date.now() - start })
    })
  })
}

async function persistEvidence(
  jobId: string, runId: string, workspaceId: string,
  cmd: string, args: string[], result: Awaited<ReturnType<typeof runCommand>>,
  filesChanged: string[],
): Promise<string> {
  // Redact secrets before persisting — raw credentials never touch the DB
  const stdoutSafe = redactSecrets(result.stdout).redacted
  const stderrSafe = redactSecrets(result.stderr).redacted

  const id = uuidv7()
  const passed = result.exitCode === 0
  await db.insert(verificationEvidence).values({
    id,
    jobId,
    runId,
    workspaceId,
    command:      cmd,
    args,
    exitCode:     result.exitCode,
    stdout:       stdoutSafe,
    stderr:       stderrSafe,
    passed,
    durationMs:   result.durationMs,
    filesChanged,
    createdAt:    Date.now(),
  })

  // ── Closed-loop learning ────────────────────────────────────────────────────
  // Map command → root cause class for failure classification
  const rootCauseClass: RootCauseClass = cmd === 'tsc' ? 'syntax'
    : cmd === 'eslint'                  ? 'syntax'
    : cmd === 'vitest' || cmd === 'jest' ? 'runtime'
    : cmd === 'vite' || cmd === 'npm' || cmd === 'turbo' ? 'build'
    : 'unknown'

  const targetRef = filesChanged[0] ?? `${cmd}:workspace`
  const errorMessage = (stderrSafe || stdoutSafe).slice(0, 500) || `Exit ${result.exitCode}`

  if (!passed) {
    // Record this failure into memory — non-blocking
    recordFailure({
      workspaceId,
      failureType:    'command',
      rootCauseClass,
      targetRef,
      targetKind:     filesChanged.length > 0 ? 'file' : 'command',
      errorMessage,
      evidenceIds:    [id],
    }).catch((e: Error) => { console.error('[verification-engine]', e.message); return null })
  } else {
    // Pass — if a recent matching failure exists, record this as a successful fix
    const { signature } = buildSignature({
      failureType: 'command', targetRef, rootCauseClass, errorMessage: errorMessage,
    })
    failureDb.select().from(failureMemory)
      .where(and(
        eq(failureMemory.workspaceId, workspaceId),
        eq(failureMemory.targetRef, targetRef),
      ))
      .limit(1)
      .then((rows) => {
        const f = rows[0]
        if (!f) return
        // Record a successful fix for this signature
        return recordSuccessfulFix({
          workspaceId,
          failureSignature:        f.signature,
          fixDescription:          `${cmd} now passing on ${targetRef}`,
          targetRef,
          verificationEvidenceIds: [id],
          patchRecordIds:          [],
        })
      })
      .catch((e: Error) => { console.error('[verification-engine]', e.message); return null })
    // Silence unused-warning for buildSignature when no recent failure
    void signature
  }

  return id
}

/** Run `tsc --noEmit` in the given project directory */
export async function runTypecheck(
  opts: { jobId: string; runId: string; workspaceId: string; cwd: string }
): Promise<VerifyResult> {
  const args   = ['--noEmit', '--pretty', 'false']
  const result = await runCommand('tsc', args, opts.cwd)
  const id     = await persistEvidence(opts.jobId, opts.runId, opts.workspaceId, 'tsc', args, result, [])
  return { evidenceId: id, command: 'tsc', args, ...result, passed: result.exitCode === 0 }
}

/** Run `eslint` on changed files */
export async function runLint(
  opts: { jobId: string; runId: string; workspaceId: string; cwd: string; files: string[] }
): Promise<VerifyResult> {
  // R146.46 — argument-injection guard. opts.files originates from the
  // BullMQ job payload (autonomous-orchestrator data.changedFiles).
  // The producer is internal code today, but a future producer bug OR a
  // hostile Redis writer could inject `--config /tmp/evil.eslintrc.js`
  // or `--rulesdir /path/to/rce` — eslint would happily load those and
  // a malicious .eslintrc.js can require() arbitrary code at lint time
  // → RCE. Filter to plain path-like strings before spawning.
  const safeFiles = opts.files
    .filter((f): f is string => typeof f === 'string' && f.length > 0 && f.length < 500)
    .filter(f => !f.startsWith('-'))                // reject option-shaped entries
    .filter(f => !f.includes('\0'))                 // reject NUL injection
    .filter(f => !/[\r\n]/.test(f))                 // reject newlines
  const args = safeFiles.length > 0
    ? [...safeFiles, '--max-warnings', '0']
    : ['.', '--ext', '.ts,.tsx', '--max-warnings', '0']
  const result = await runCommand('eslint', args, opts.cwd)
  const id     = await persistEvidence(opts.jobId, opts.runId, opts.workspaceId, 'eslint', args, result, safeFiles)
  return { evidenceId: id, command: 'eslint', args, ...result, passed: result.exitCode === 0 }
}

/** Run `vitest run` (all tests) */
export async function runTests(
  opts: { jobId: string; runId: string; workspaceId: string; cwd: string }
): Promise<VerifyResult> {
  const args   = ['run', '--reporter=verbose']
  const result = await runCommand('vitest', args, opts.cwd, 300_000)
  const id     = await persistEvidence(opts.jobId, opts.runId, opts.workspaceId, 'vitest', args, result, [])
  return { evidenceId: id, command: 'vitest', args, ...result, passed: result.exitCode === 0 }
}

/** Run `vite build` or turbo build */
export async function runBuild(
  opts: { jobId: string; runId: string; workspaceId: string; cwd: string }
): Promise<VerifyResult> {
  const args   = ['run', 'build', '--if-present']
  const result = await runCommand('npm', args, opts.cwd, 300_000)
  const id     = await persistEvidence(opts.jobId, opts.runId, opts.workspaceId, 'npm', args, result, [])
  return { evidenceId: id, command: 'npm', args, ...result, passed: result.exitCode === 0 }
}

/** Run the full verification suite: typecheck → lint → tests */
export async function runFullVerification(opts: {
  jobId: string; runId: string; workspaceId: string; cwd: string; changedFiles: string[]
}): Promise<{ results: VerifyResult[]; allPassed: boolean }> {
  const results: VerifyResult[] = []

  const tsc = await runTypecheck(opts)
  results.push(tsc)
  if (!tsc.passed) return { results, allPassed: false }

  const lint = await runLint({ ...opts, files: opts.changedFiles })
  results.push(lint)
  if (!lint.passed) return { results, allPassed: false }

  const tests = await runTests(opts)
  results.push(tests)

  return { results, allPassed: results.every((r) => r.passed) }
}
