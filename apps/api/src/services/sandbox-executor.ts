/**
 * sandbox-executor.ts — Isolated command execution with full protection.
 *
 * Wraps every command execution in:
 * 1. Command allowlist validation
 * 2. Env var allowlist (strips all secrets from child process)
 * 3. Worker lease acquisition (one owner at a time)
 * 4. Execution timeout + max runtime enforcement
 * 5. Heartbeat emission during execution
 * 6. Secret redaction on all stdout/stderr before persisting
 * 7. Safe working directory validation
 * 8. Lease release on all exit paths
 *
 * ALL output returned is redacted. Raw secrets never leave this module.
 */
import { spawn }           from 'node:child_process'
import * as path           from 'node:path'
import * as fs             from 'node:fs'
import { redactSecrets, buildSandboxEnv } from './secret-redactor.js'
import {
  acquireLease, emitHeartbeat, releaseLease, persistSandboxEvent,
  checkIsolationRules, ALLOWED_COMMANDS, HEARTBEAT_INTERVAL_MS,
} from './worker-lease.js'
import type { WorkerDescriptor } from './worker-lease.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SandboxOptions {
  worker:      WorkerDescriptor
  command:     string
  args:        string[]
  workingDir:  string
  workspaceId: string
  jobId?:      string | null
  runId?:      string | null
  jobStatus?:  string   // for isolation rule check
  timeoutMs?:  number
}

export interface SandboxResult {
  sessionId:      string
  exitCode:       number
  stdout:         string   // REDACTED
  stderr:         string   // REDACTED
  durationMs:     number
  passed:         boolean
  secretsRedacted: number
  timedOut:       boolean
  isolationViolation: boolean
  violationReason?: string
}

// ─── Safe working dir validation ─────────────────────────────────────────────

const REPO_ROOT = process.env['REPO_ROOT'] ?? process.cwd()

/** Validates that workingDir is inside REPO_ROOT — blocks path traversal. */
function validateWorkingDir(dir: string): string {
  const resolved = path.resolve(dir)
  const root     = path.resolve(REPO_ROOT)
  if (!resolved.startsWith(root)) {
    throw new Error(`Working directory '${resolved}' is outside repo root '${root}' — isolation violation`)
  }
  if (!fs.existsSync(resolved)) {
    // Fall back to repo root — never fail, just isolate
    return root
  }
  return resolved
}

// ─── Core executor ────────────────────────────────────────────────────────────

export async function runSandboxed(opts: SandboxOptions): Promise<SandboxResult> {
  const timeoutMs = Math.min(opts.timeoutMs ?? 120_000, 10 * 60 * 1000)

  // ── Cloud-API-only mode guard ─────────────────────────────────────────────
  // When RUNTIME_MODE=cloud-api-only, all local FS/command execution is refused.
  // Operator must dispatch to a remote worker for any execution.
  if (process.env['RUNTIME_MODE'] === 'cloud-api-only') {
    const reason = 'RUNTIME_MODE=cloud-api-only — local sandbox execution disabled. Dispatch to remote worker via /api/v1/cloud-runtime.'
    await persistSandboxEvent('none', opts.workspaceId, opts.worker.workerId, 'isolation_violation', {
      command: opts.command, reason, mode: 'cloud-api-only',
    })
    return {
      sessionId: 'none', exitCode: 1, stdout: '', stderr: reason,
      durationMs: 0, passed: false, secretsRedacted: 0,
      timedOut: false, isolationViolation: true, violationReason: reason,
    }
  }

  // ── Isolation pre-check ───────────────────────────────────────────────────
  const isolationOpts: { worker: WorkerDescriptor; command: string; jobStatus?: string } = {
    worker:  opts.worker,
    command: opts.command,
  }
  if (opts.jobStatus !== undefined) isolationOpts.jobStatus = opts.jobStatus
  const violation = checkIsolationRules(isolationOpts)

  if (violation) {
    // Persist a denial event without acquiring a lease (no session created)
    await persistSandboxEvent('none', opts.workspaceId, opts.worker.workerId, 'isolation_violation', {
      command: opts.command, reason: violation, jobId: opts.jobId,
    })
    return {
      sessionId: 'none', exitCode: 1, stdout: '', stderr: violation,
      durationMs: 0, passed: false, secretsRedacted: 0,
      timedOut: false, isolationViolation: true, violationReason: violation,
    }
  }

  // ── Validate working directory ────────────────────────────────────────────
  let safeDir: string
  try {
    safeDir = validateWorkingDir(opts.workingDir)
  } catch (e) {
    const reason = (e as Error).message
    return {
      sessionId: 'none', exitCode: 1, stdout: '', stderr: reason,
      durationMs: 0, passed: false, secretsRedacted: 0,
      timedOut: false, isolationViolation: true, violationReason: reason,
    }
  }

  // ── Acquire lease ─────────────────────────────────────────────────────────
  const leaseInput: {
    workerId: string; workspaceId: string; command: string
    args: string[]; workingDir: string; timeoutMs: number
    jobId?: string | null; runId?: string | null
  } = {
    workerId:    opts.worker.workerId,
    workspaceId: opts.workspaceId,
    command:     opts.command,
    args:        opts.args,
    workingDir:  safeDir,
    timeoutMs,
  }
  if (opts.jobId !== undefined) leaseInput.jobId = opts.jobId
  if (opts.runId !== undefined) leaseInput.runId = opts.runId

  const leaseResult = await acquireLease(leaseInput)

  if (!leaseResult.ok) {
    return {
      sessionId: 'none', exitCode: 1, stdout: '', stderr: leaseResult.reason,
      durationMs: 0, passed: false, secretsRedacted: 0,
      timedOut: false, isolationViolation: true, violationReason: leaseResult.reason,
    }
  }

  const { sessionId } = leaseResult
  const start = Date.now()
  let timedOut = false

  // ── Build sanitized env (no secrets) ─────────────────────────────────────
  const safeEnv = buildSandboxEnv(process.env as Record<string, string | undefined>)

  // ── Heartbeat interval ────────────────────────────────────────────────────
  // Log emit failures rather than swallowing them — without this the
  // operator can't tell a hanging exec from a heartbeat outage, and
  // dead-worker detection silently fails.
  const heartbeatTimer = setInterval(() => {
    emitHeartbeat(sessionId, opts.worker.workerId).catch((e: unknown) => {
      console.error('[sandbox-executor] heartbeat emit failed:', (e as Error).message)
    })
  }, HEARTBEAT_INTERVAL_MS)

  // ── Execute ───────────────────────────────────────────────────────────────
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []

  const rawResult = await new Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>(
    (resolve) => {
      const child = spawn(opts.command, opts.args, {
        cwd:   safeDir,
        shell: process.platform === 'win32',
        env:   safeEnv,
      })

      child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d))
      child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d))

      const killTimer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2000)
      }, timeoutMs)

      child.on('close', (code) => {
        clearTimeout(killTimer)
        resolve({
          exitCode:   code ?? 1,
          stdout:     Buffer.concat(stdoutChunks).toString('utf8').slice(0, 100_000),
          stderr:     Buffer.concat(stderrChunks).toString('utf8').slice(0, 100_000),
          durationMs: Date.now() - start,
        })
      })

      child.on('error', (err) => {
        clearTimeout(killTimer)
        resolve({ exitCode: 1, stdout: '', stderr: err.message, durationMs: Date.now() - start })
      })
    },
  )

  clearInterval(heartbeatTimer)

  // ── Secret redaction ──────────────────────────────────────────────────────
  const stdoutRedact = redactSecrets(rawResult.stdout)
  const stderrRedact = redactSecrets(rawResult.stderr)
  const totalRedacted = stdoutRedact.count + stderrRedact.count

  // Emit secret_redacted event if any tokens were scrubbed
  if (totalRedacted > 0) {
    await persistSandboxEvent(sessionId, opts.workspaceId, opts.worker.workerId, 'secret_redacted', {
      count:    totalRedacted,
      patterns: [...new Set([...stdoutRedact.patternNames, ...stderrRedact.patternNames])],
    })
  }

  // Emit command_executed event (with redacted output only)
  await persistSandboxEvent(sessionId, opts.workspaceId, opts.worker.workerId, 'command_executed', {
    exitCode:   rawResult.exitCode,
    durationMs: rawResult.durationMs,
    timedOut,
    stdoutPreview: stdoutRedact.redacted.slice(0, 500),
    secretsRedacted: totalRedacted,
  })

  // ── Release lease ─────────────────────────────────────────────────────────
  const finalStatus = timedOut ? 'timeout'
    : rawResult.exitCode === 0 ? 'complete'
    : 'failed'

  await releaseLease({
    sessionId,
    workerId:        opts.worker.workerId,
    workspaceId:     opts.workspaceId,
    status:          finalStatus,
    exitCode:        rawResult.exitCode,
    durationMs:      rawResult.durationMs,
    stdoutRedacted:  stdoutRedact.redacted,
    stderrRedacted:  stderrRedact.redacted,
    secretsRedacted: totalRedacted,
  })

  return {
    sessionId,
    exitCode:        rawResult.exitCode,
    stdout:          stdoutRedact.redacted,
    stderr:          stderrRedact.redacted,
    durationMs:      rawResult.durationMs,
    passed:          rawResult.exitCode === 0 && !timedOut,
    secretsRedacted: totalRedacted,
    timedOut,
    isolationViolation: false,
  }
}

/**
 * Build a default worker descriptor for the API server's internal worker.
 * The server worker has all capabilities.
 */
export function getServerWorker(): WorkerDescriptor {
  return {
    workerId:     `server-${process.pid}`,
    capabilities: ['typecheck', 'lint', 'test', 'build', 'scan', 'patch', 'verify'],
  }
}

export { ALLOWED_COMMANDS }
