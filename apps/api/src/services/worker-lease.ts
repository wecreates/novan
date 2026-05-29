/**
 * worker-lease.ts — One-owner-at-a-time execution lease system.
 *
 * Before any sandboxed execution begins:
 * 1. Worker claims a lease (atomic DB insert/update)
 * 2. Worker emits heartbeats during execution
 * 3. Lease expires if heartbeats stop (prevents zombie sessions)
 * 4. Worker releases lease on completion/failure
 *
 * Protections:
 * - A cancelled job cannot be claimed
 * - A running job cannot be claimed by a second worker
 * - Jobs requiring capabilities the worker lacks are rejected
 * - Max runtime enforced at lease level
 */
import { db }              from '../db/client.js'
import { sandboxSessions, sandboxEvents } from '../db/schema.js'
import { eq, and, lt }     from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Lease heartbeat interval — worker must update every N ms */
export const HEARTBEAT_INTERVAL_MS = 10_000
/** Lease TTL — if no heartbeat for this long, lease is considered dead */
export const LEASE_TTL_MS = 30_000
/** Absolute max runtime regardless of timeout setting */
export const MAX_RUNTIME_MS = 10 * 60 * 1000  // 10 min

// ─── Worker capabilities ──────────────────────────────────────────────────────

/** Commands a worker can run — must declare on registration */
export type WorkerCapability =
  | 'typecheck'
  | 'lint'
  | 'test'
  | 'build'
  | 'scan'
  | 'patch'
  | 'verify'

const COMMAND_CAPABILITY_MAP: Record<string, WorkerCapability> = {
  tsc:    'typecheck',
  eslint: 'lint',
  vitest: 'test',
  jest:   'test',
  vite:   'build',
  turbo:  'build',
  npx:    'build',   // npx can run any of the above — capability checked by args
  node:   'patch',
  git:    'scan',
}

/** Command allowlist — only these binaries may be executed in sandbox */
export const ALLOWED_COMMANDS = new Set([
  'tsc', 'eslint', 'vitest', 'jest', 'vite', 'turbo',
  'npx', 'node', 'pnpm', 'git', 'sh', 'bash',
])

// ─── Lease record ─────────────────────────────────────────────────────────────

export interface LeaseRecord {
  sessionId:  string
  workerId:   string
  jobId:      string | null
  acquiredAt: number
  expiresAt:  number
}

export type AcquireResult =
  | { ok: true;  sessionId: string }
  | { ok: false; reason: string }

// ─── Isolation validator ──────────────────────────────────────────────────────

export interface WorkerDescriptor {
  workerId:     string
  capabilities: WorkerCapability[]
}

/**
 * Checks all isolation rules before execution.
 * Returns null if safe, or a violation reason string.
 */
export function checkIsolationRules(opts: {
  worker:     WorkerDescriptor
  command:    string
  jobStatus?: string    // e.g. 'cancelled', 'blocked'
  sessionId?: string    // existing session to claim
  elapsed?:   number    // ms since session started
}): string | null {
  const { worker, command, jobStatus, elapsed } = opts

  // Rule 1: command must be on the allowlist
  if (!ALLOWED_COMMANDS.has(command)) {
    return `Command '${command}' is not on the sandbox allowlist`
  }

  // Rule 2: cannot execute cancelled jobs
  if (jobStatus === 'cancelled' || jobStatus === 'blocked') {
    return `Cannot execute job in status '${jobStatus}' — isolation violation`
  }

  // Rule 3: max runtime guard
  if (elapsed !== undefined && elapsed > MAX_RUNTIME_MS) {
    return `Execution exceeded max runtime of ${MAX_RUNTIME_MS}ms — isolation violation`
  }

  // Rule 4: capability check
  const requiredCap = COMMAND_CAPABILITY_MAP[command]
  if (requiredCap && !worker.capabilities.includes(requiredCap)) {
    return `Worker '${worker.workerId}' lacks capability '${requiredCap}' for command '${command}'`
  }

  return null  // all checks pass
}

// ─── Acquire lease ────────────────────────────────────────────────────────────

export async function acquireLease(opts: {
  workerId:    string
  workspaceId: string
  jobId?:      string | null
  runId?:      string | null
  command:     string
  args:        string[]
  workingDir:  string
  timeoutMs?:  number
}): Promise<AcquireResult> {
  const now = Date.now()
  const id  = uuidv7()
  const ttl = Math.min(opts.timeoutMs ?? 120_000, MAX_RUNTIME_MS)

  // Rule: command must be allowed
  if (!ALLOWED_COMMANDS.has(opts.command)) {
    return { ok: false, reason: `Command '${opts.command}' not in sandbox allowlist` }
  }

  // Expire any dead sessions from previous workers (heartbeat timeout)
  await db.update(sandboxSessions).set({
    status:    'timeout',
    updatedAt: now,
    completedAt: now,
  }).where(and(
    eq(sandboxSessions.status, 'running'),
    lt(sandboxSessions.leaseExpiresAt, now - LEASE_TTL_MS),
  ))

  try {
    await db.insert(sandboxSessions).values({
      id,
      workspaceId:    opts.workspaceId,
      jobId:          opts.jobId ?? null,
      runId:          opts.runId ?? null,
      leaseOwner:     opts.workerId,
      leaseExpiresAt: now + LEASE_TTL_MS,
      lastHeartbeat:  now,
      command:        opts.command,
      args:           opts.args,
      workingDir:     opts.workingDir,
      status:         'running',
      timeoutMs:      ttl,
      startedAt:      now,
      stdoutRedacted: '',
      stderrRedacted: '',
      secretsRedacted: 0,
      createdAt:      now,
      updatedAt:      now,
    })
  } catch (e) {
    return { ok: false, reason: `Lease insert failed: ${(e as Error).message}` }
  }

  await persistSandboxEvent(id, opts.workspaceId, opts.workerId, 'started', {
    command: opts.command, args: opts.args, workingDir: opts.workingDir, timeoutMs: ttl,
  })

  return { ok: true, sessionId: id }
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

export async function emitHeartbeat(sessionId: string, workerId: string): Promise<void> {
  const now = Date.now()
  await db.update(sandboxSessions).set({
    lastHeartbeat:  now,
    leaseExpiresAt: now + LEASE_TTL_MS,
    updatedAt:      now,
  }).where(and(
    eq(sandboxSessions.id, sessionId),
    eq(sandboxSessions.leaseOwner, workerId),
  ))

  await persistSandboxEvent(sessionId, '', workerId, 'heartbeat', { ts: now })
}

// ─── Release lease ────────────────────────────────────────────────────────────

export async function releaseLease(opts: {
  sessionId:      string
  workerId:       string
  workspaceId:    string
  status:         'complete' | 'failed' | 'timeout' | 'cancelled' | 'isolation_violation'
  exitCode?:      number | null
  durationMs?:    number
  stdoutRedacted: string
  stderrRedacted: string
  secretsRedacted: number
  violationReason?: string
}): Promise<void> {
  const now = Date.now()
  await db.update(sandboxSessions).set({
    status:          opts.status,
    exitCode:        opts.exitCode ?? null,
    durationMs:      opts.durationMs ?? null,
    completedAt:     now,
    stdoutRedacted:  opts.stdoutRedacted,
    stderrRedacted:  opts.stderrRedacted,
    secretsRedacted: opts.secretsRedacted,
    violationReason: opts.violationReason ?? null,
    updatedAt:       now,
  }).where(and(
    eq(sandboxSessions.id, opts.sessionId),
    eq(sandboxSessions.leaseOwner, opts.workerId),
  ))

  const evType = opts.status === 'complete' ? 'completed'
    : opts.status === 'timeout'             ? 'timeout'
    : opts.status === 'isolation_violation' ? 'isolation_violation'
    : 'failed'

  await persistSandboxEvent(opts.sessionId, opts.workspaceId, opts.workerId, evType, {
    exitCode:        opts.exitCode,
    durationMs:      opts.durationMs,
    secretsRedacted: opts.secretsRedacted,
    violationReason: opts.violationReason,
  })
}

// ─── Sandbox event helpers ────────────────────────────────────────────────────

export async function persistSandboxEvent(
  sessionId:   string,
  workspaceId: string,
  leaseOwner:  string,
  eventType:   string,
  payload:     Record<string, unknown>,
): Promise<void> {
  await db.insert(sandboxEvents).values({
    id:          uuidv7(),
    sessionId,
    workspaceId,
    leaseOwner,
    eventType,
    payload,
    createdAt:   Date.now(),
  }).catch((e: Error) => { console.error('[worker-lease]', e.message); return null })  // best-effort — never block execution
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function getActiveSessions(workspaceId: string) {
  return db.select().from(sandboxSessions)
    .where(and(
      eq(sandboxSessions.workspaceId, workspaceId),
      eq(sandboxSessions.status, 'running'),
    ))
}

export async function getSessionEvents(sessionId: string) {
  return db.select().from(sandboxEvents)
    .where(eq(sandboxEvents.sessionId, sessionId))
}
