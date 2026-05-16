/**
 * autonomous-orchestrator.ts — Persistent autonomous run state machine.
 *
 * State: queued → running → (paused | blocked | failed | complete | cancelled)
 * Phases: scan → audit → plan → patch → verify → done
 *
 * All state is persisted to Postgres. BullMQ drives async job execution.
 * The BullMQ Worker is registered once at server startup.
 *
 * TRUTH ENFORCEMENT:
 * - "complete" / "verified" status requires evidence in verification_evidence
 * - No job is marked "verified" without real command evidence (exitCode 0)
 */
import { Worker }       from 'bullmq'
import { eq, desc }     from 'drizzle-orm'
import { db }           from '../db/client.js'
import {
  autonomousRuns, autonomousJobs, verificationEvidence,
  events,
}                       from '../db/schema.js'
import { queues }       from '../queues/index.js'
import { redisClient }  from '../redis/client.js'
import { v7 as uuidv7 } from 'uuid'
import { scanRepo }     from './repo-scanner.js'
import { repoSnapshots } from '../db/schema.js'
import { runFullVerification } from './verification-engine.js'
import { isTaskBlocked } from './approval-gate.js'

export type RunStatus = 'queued' | 'running' | 'paused' | 'blocked' | 'failed' | 'complete' | 'cancelled'
export type RunPhase  = 'scan' | 'audit' | 'plan' | 'patch' | 'verify' | 'done'
export type JobStatus = 'queued' | 'running' | 'paused' | 'blocked' | 'failed' | 'complete' | 'unverified'

export interface AutonomousRun {
  id:          string
  workspaceId: string
  status:      RunStatus
  phase:       RunPhase | null
  masterPrompt: string
  currentAgent: string | null
  activeJobId: string | null
  lastEvent:   string | null
  failureReason: string | null
  verificationResults: unknown
  completedAt: number | null
  createdAt:   number
  updatedAt:   number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REPO_ROOT = process.env['REPO_ROOT'] ?? process.cwd()

async function emitEvent(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'autonomous-orchestrator', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

async function updateRun(id: string, updates: Partial<typeof autonomousRuns.$inferInsert>): Promise<void> {
  await db.update(autonomousRuns)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(autonomousRuns.id, id))
}

async function createJob(opts: {
  runId: string; workspaceId: string; agentName: string; phase: string; input: Record<string, unknown>
}): Promise<string> {
  const id = uuidv7()
  await db.insert(autonomousJobs).values({
    id,
    runId:       opts.runId,
    workspaceId: opts.workspaceId,
    agentName:   opts.agentName,
    phase:       opts.phase,
    status:      'queued',
    input:       opts.input,
    attempt:     1,
    createdAt:   Date.now(),
    updatedAt:   Date.now(),
  })
  return id
}

async function updateJob(jobId: string, updates: Partial<typeof autonomousJobs.$inferInsert>): Promise<void> {
  await db.update(autonomousJobs)
    .set({ ...updates, updatedAt: Date.now() })
    .where(eq(autonomousJobs.id, jobId))
}

// ─── Truth enforcement ────────────────────────────────────────────────────────

/** Returns true only if there is passing verification evidence for this job */
async function hasVerificationEvidence(jobId: string): Promise<boolean> {
  const rows = await db
    .select({ passed: verificationEvidence.passed })
    .from(verificationEvidence)
    .where(eq(verificationEvidence.jobId, jobId))
    .limit(20)
  return rows.length > 0 && rows.every((r) => r.passed)
}

// ─── Phase handlers ───────────────────────────────────────────────────────────

async function runScanPhase(run: { id: string; workspaceId: string }): Promise<void> {
  const jobId = await createJob({
    runId: run.id, workspaceId: run.workspaceId,
    agentName: 'repo-scanner', phase: 'scan', input: { rootPath: REPO_ROOT },
  })

  await updateRun(run.id, { phase: 'scan', currentAgent: 'repo-scanner', activeJobId: jobId, status: 'running' })
  await updateJob(jobId, { status: 'running', startedAt: Date.now() })
  await emitEvent(run.workspaceId, 'autonomous.scan.started', { runId: run.id, jobId })

  let snapshot: Awaited<ReturnType<typeof scanRepo>>
  try {
    snapshot = await scanRepo(REPO_ROOT)
  } catch (err) {
    await updateJob(jobId, { status: 'failed', errorMessage: String(err), completedAt: Date.now() })
    await updateRun(run.id, { status: 'failed', failureReason: `Scan failed: ${err}` })
    return
  }

  await db.insert(repoSnapshots).values({
    id:        uuidv7(),
    runId:     run.id,
    workspaceId: run.workspaceId,
    rootPath:  REPO_ROOT,
    fileCount: snapshot.fileCount,
    totalLines: snapshot.totalLines,
    fileTree:  snapshot.fileTree,
    summary:   snapshot.summary,
    createdAt: Date.now(),
  })

  await updateJob(jobId, {
    status: 'complete', completedAt: Date.now(),
    output: { fileCount: snapshot.fileCount, totalLines: snapshot.totalLines },
  })
  await emitEvent(run.workspaceId, 'autonomous.scan.complete', { runId: run.id, jobId, fileCount: snapshot.fileCount })
}

async function runVerifyPhase(run: { id: string; workspaceId: string }, changedFiles: string[]): Promise<boolean> {
  const jobId = await createJob({
    runId: run.id, workspaceId: run.workspaceId,
    agentName: 'verifier', phase: 'verify', input: { changedFiles },
  })

  await updateRun(run.id, { phase: 'verify', currentAgent: 'verifier', activeJobId: jobId })
  await updateJob(jobId, { status: 'running', startedAt: Date.now() })
  await emitEvent(run.workspaceId, 'autonomous.verify.started', { runId: run.id, jobId })

  const { results, allPassed } = await runFullVerification({
    jobId, runId: run.id, workspaceId: run.workspaceId,
    cwd: REPO_ROOT, changedFiles,
  })

  const hasEvidence = await hasVerificationEvidence(jobId)

  // Truth enforcement: only mark verified if evidence exists AND all passed
  const finalStatus: JobStatus = (!hasEvidence) ? 'unverified' : allPassed ? 'complete' : 'failed'

  await updateJob(jobId, {
    status: finalStatus,
    completedAt: Date.now(),
    output: {
      allPassed,
      evidenceCount: results.length,
      commands: results.map((r) => ({ cmd: r.command, passed: r.passed, exitCode: r.exitCode })),
    },
    errorMessage: allPassed ? null : results.find((r) => !r.passed)?.stderr?.slice(0, 500) ?? 'Verification failed',
  })

  await updateRun(run.id, {
    verificationResults: results.map((r) => ({ cmd: r.command, passed: r.passed, exitCode: r.exitCode })),
    lastEvent: allPassed ? 'verify.passed' : 'verify.failed',
  })

  await emitEvent(run.workspaceId, allPassed ? 'autonomous.verify.passed' : 'autonomous.verify.failed', {
    runId: run.id, jobId, allPassed, hasEvidence,
  })

  return allPassed && hasEvidence
}

// ─── BullMQ job handler ───────────────────────────────────────────────────────

interface AutoJobData {
  runId:       string
  workspaceId: string
  phase:       RunPhase
  changedFiles?: string[]
  taskId?:      string  // set when dispatched from audit dispatch endpoint
}

async function processJob(data: AutoJobData): Promise<void> {
  const run = await db.select().from(autonomousRuns).where(eq(autonomousRuns.id, data.runId)).limit(1)
  if (!run[0]) throw new Error(`Run not found: ${data.runId}`)
  if (run[0].status === 'cancelled' || run[0].status === 'paused') return

  // ── Approval gate: block patch execution if task has pending/rejected approval ──
  if (data.phase === 'patch' && data.taskId) {
    const blocked = await isTaskBlocked(data.taskId)
    if (blocked) {
      await emitEvent(data.workspaceId, 'autonomous.patch.blocked', {
        runId:  data.runId,
        taskId: data.taskId,
        reason: 'Pending human approval — task blocked until approved in the Approvals queue',
      })
      // Do NOT throw — don't fail the BullMQ job, just skip silently.
      // The task status is already 'approval_required' in Postgres.
      return
    }
  }

  switch (data.phase) {
    case 'scan':
      await runScanPhase({ id: data.runId, workspaceId: data.workspaceId })
      break
    case 'verify':
      await runVerifyPhase({ id: data.runId, workspaceId: data.workspaceId }, data.changedFiles ?? [])
      break
    default:
      // audit/plan/patch phases are stubs — they dispatch to BullMQ but don't have AI yet
      await emitEvent(data.workspaceId, `autonomous.${data.phase}.noop`, { runId: data.runId, phase: data.phase })
  }
}

// ─── Worker registration ──────────────────────────────────────────────────────

let worker: Worker | null = null

export function registerAutonomousWorker(): void {
  if (worker) return
  worker = new Worker(
    'autonomous',
    async (job) => { await processJob(job.data as AutoJobData) },
    {
      connection: redisClient,
      concurrency: 2,
      limiter: { max: 10, duration: 60_000 },
    },
  )
  worker.on('failed', (job, err) => {
    console.error(`[autonomous-worker] Job ${job?.id} failed:`, err.message)
  })
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function startRun(opts: {
  workspaceId: string
  masterPrompt: string
}): Promise<AutonomousRun> {
  const id  = uuidv7()
  const now = Date.now()

  await db.insert(autonomousRuns).values({
    id,
    workspaceId:  opts.workspaceId,
    status:       'queued',
    masterPrompt: opts.masterPrompt,
    createdAt:    now,
    updatedAt:    now,
  })

  await emitEvent(opts.workspaceId, 'autonomous.run.created', { runId: id })

  // Dispatch first job (scan phase) to BullMQ
  const bullJob = await queues.autonomous.add('scan', {
    runId: id, workspaceId: opts.workspaceId, phase: 'scan',
  } satisfies AutoJobData, { priority: 2 })

  await updateRun(id, { status: 'running', activeJobId: bullJob.id ?? null })

  const rows = await db.select().from(autonomousRuns).where(eq(autonomousRuns.id, id)).limit(1)
  return rows[0] as AutonomousRun
}

export async function pauseRun(id: string): Promise<void> {
  await updateRun(id, { status: 'paused', lastEvent: 'paused-by-user' })
}

export async function resumeRun(id: string, workspaceId: string): Promise<void> {
  await updateRun(id, { status: 'running', lastEvent: 'resumed-by-user' })
  await queues.autonomous.add('resume', {
    runId: id, workspaceId, phase: 'scan',
  } satisfies AutoJobData)
}

export async function cancelRun(id: string, workspaceId: string): Promise<void> {
  await updateRun(id, { status: 'cancelled', completedAt: Date.now(), lastEvent: 'cancelled-by-user' })
  await emitEvent(workspaceId, 'autonomous.run.cancelled', { runId: id })
}

export async function getRun(id: string): Promise<AutonomousRun | null> {
  const rows = await db.select().from(autonomousRuns).where(eq(autonomousRuns.id, id)).limit(1)
  return (rows[0] as AutonomousRun | undefined) ?? null
}

export async function listRuns(workspaceId: string, limit = 50): Promise<AutonomousRun[]> {
  const rows = await db.select().from(autonomousRuns)
    .where(eq(autonomousRuns.workspaceId, workspaceId))
    .orderBy(desc(autonomousRuns.createdAt))
    .limit(limit)
  return rows as AutonomousRun[]
}

export async function getRunJobs(runId: string): Promise<typeof autonomousJobs.$inferSelect[]> {
  return db.select().from(autonomousJobs)
    .where(eq(autonomousJobs.runId, runId))
    .orderBy(desc(autonomousJobs.createdAt))
}

export async function getJobEvidence(jobId: string): Promise<typeof verificationEvidence.$inferSelect[]> {
  return db.select().from(verificationEvidence)
    .where(eq(verificationEvidence.jobId, jobId))
    .orderBy(desc(verificationEvidence.createdAt))
}
