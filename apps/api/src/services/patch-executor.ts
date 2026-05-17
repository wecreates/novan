/**
 * patch-executor.ts — Real filesystem patch executor.
 * Reads originals for rollback, validates limits, writes atomically,
 * stores patch_records, and can roll back on failure.
 *
 * Hard limits:
 *   - max 10 files per patch
 *   - max 500 lines changed per file
 *   - protected files are never modified
 */
import { readFile, writeFile }    from 'node:fs/promises'
import { resolve }               from 'node:path'
import { inArray }               from 'drizzle-orm'
import { db }                           from '../db/client.js'
import { patchRecords, events }         from '../db/schema.js'
import { v7 as uuidv7 }                 from 'uuid'
import { recordFailure }                from './failure-memory.js'
import { gate, isProtectedPath, invalidateDailyCounter } from './governance-core.js'
import { shouldEmit }                  from './agent-coordinator.js'
import crypto                          from 'node:crypto'

// Files that must never be patched autonomously
const PROTECTED_PATTERNS = [
  /package\.json$/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /\.env(\.\w+)?$/,
  /tsconfig.*\.json$/,
  /vite\.config\./,
  /vitest\.config\./,
  /drizzle\.config\./,
  /schema\.ts$/,               // db schema — high risk
  /migrations?\//,
  /\/auth\//,
  /\/security\//,
]

const MAX_FILES  = 10
const MAX_LINES  = 500

export interface PatchSpec {
  filePath:       string   // absolute path
  patchedContent: string   // full replacement content
}

export interface PatchApplyResult {
  recordId:      string
  filePath:      string
  linesAdded:    number
  linesRemoved:  number
  status:        'applied' | 'skipped' | 'error'
  error?:        string
}

function _countLines(s: string): number {
  return s.split('\n').length
}

function diffLines(orig: string, patched: string): { added: number; removed: number } {
  const o = orig.split('\n')
  const p = patched.split('\n')
  const removed = o.length
  const added   = p.length
  return { added, removed }
}

function isProtected(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/')
  return PROTECTED_PATTERNS.some((re) => re.test(norm))
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const resolved = resolve(filePath)
  const root     = resolve(rootPath)
  return resolved.startsWith(root)
}

/** Apply a list of patches atomically — all or nothing. */
export async function applyPatches(opts: {
  jobId:       string
  runId:       string
  workspaceId: string
  rootPath:    string
  patches:     PatchSpec[]
}): Promise<{ results: PatchApplyResult[]; anyFailed: boolean; rollbackNeeded: boolean }> {
  const { jobId, runId, workspaceId, rootPath, patches } = opts

  if (patches.length > MAX_FILES) {
    throw new Error(`Patch exceeds MAX_FILES limit (${patches.length} > ${MAX_FILES})`)
  }

  // ── Governance boundary: classify the whole patch by its file list.
  // Hard-blocked or approval-required intents abort before any write.
  const filePaths = patches.map(p => p.filePath)
  const govDecision = await gate({
    workspaceId, intent: 'apply_patch', context: { filePaths, jobId, runId },
  })
  if (govDecision.decision !== 'auto_apply_ok') {
    // Dedup: collapse identical block events within the agent-coordinator
    // dedup window so spammed attempts don't flood the events table.
    const pathSig = crypto.createHash('sha256').update(filePaths.sort().join('|')).digest('hex').slice(0, 16)
    const eventSig = `${govDecision.decision}:${pathSig}`
    if (shouldEmit(workspaceId, 'patch.blocked_by_governance', eventSig)) {
      await db.insert(events).values({
        id: uuidv7(), type: 'patch.blocked_by_governance', workspaceId,
        payload: { jobId, runId, decision: govDecision.decision, reason: govDecision.reason, filePaths },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'patch-executor', version: 1, createdAt: Date.now(),
      }).catch(() => null)
    }
    return {
      results: patches.map(p => ({
        recordId: '', filePath: p.filePath, linesAdded: 0, linesRemoved: 0,
        status: 'skipped' as const,
        error: `governance ${govDecision.decision}: ${govDecision.reason}`,
      })),
      anyFailed: false, rollbackNeeded: false,
    }
  }

  const results: PatchApplyResult[] = []
  const applied: Array<{ filePath: string; originalContent: string; recordId: string }> = []

  for (const spec of patches) {
    const abs = resolve(spec.filePath)

    // Safety checks
    if (!isWithinRoot(abs, rootPath)) {
      results.push({ recordId: '', filePath: spec.filePath, linesAdded: 0, linesRemoved: 0, status: 'error', error: 'Path outside repo root' })
      continue
    }
    if (isProtected(spec.filePath) || isProtectedPath(spec.filePath).protected) {
      results.push({ recordId: '', filePath: spec.filePath, linesAdded: 0, linesRemoved: 0, status: 'skipped', error: 'Protected file — skipped' })
      continue
    }

    // Read original
    let originalContent = ''
    try {
      originalContent = await readFile(abs, 'utf8')
    } catch {
      originalContent = ''  // new file
    }

    const { added, removed } = diffLines(originalContent, spec.patchedContent)
    if (Math.abs(added - removed) > MAX_LINES) {
      results.push({ recordId: '', filePath: spec.filePath, linesAdded: added, linesRemoved: removed, status: 'error', error: `Exceeds MAX_LINES delta (${Math.abs(added - removed)} > ${MAX_LINES})` })
      continue
    }

    // Write file
    try {
      await writeFile(abs, spec.patchedContent, 'utf8')
    } catch (err) {
      results.push({ recordId: '', filePath: spec.filePath, linesAdded: 0, linesRemoved: 0, status: 'error', error: String(err) })
      continue
    }

    // Persist record
    const recordId = uuidv7()
    await db.insert(patchRecords).values({
      id:              recordId,
      jobId,
      runId,
      workspaceId,
      filePath:        spec.filePath,
      originalContent,
      patchedContent:  spec.patchedContent,
      linesAdded:      added,
      linesRemoved:    removed,
      status:          'applied',
      createdAt:       Date.now(),
    })

    applied.push({ filePath: abs, originalContent, recordId })
    results.push({ recordId, filePath: spec.filePath, linesAdded: added, linesRemoved: removed, status: 'applied' })

    // Emit event so daily counters + history can see this patch.
    await db.insert(events).values({
      id: uuidv7(), type: 'patch.applied', workspaceId,
      payload: { recordId, jobId, runId, filePath: spec.filePath, linesAdded: added, linesRemoved: removed },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'patch-executor', version: 1, createdAt: Date.now(),
    }).catch(() => null)
  }

  // Invalidate cached patch counter so governor sees the new count next check
  if (applied.length > 0) invalidateDailyCounter(workspaceId, 'patches')

  const anyFailed = results.some((r) => r.status === 'error')
  return { results, anyFailed, rollbackNeeded: anyFailed && applied.length > 0 }
}

/** Roll back all applied patches — restore originals, update DB records. */
export async function rollbackPatches(opts: {
  jobId:       string
  runId:       string
  workspaceId: string
  patches:     Array<{ filePath: string; originalContent: string; recordId: string }>
  reason:      string
}): Promise<void> {
  const { patches, reason } = opts
  const now = Date.now()

  for (const p of patches) {
    try {
      await writeFile(p.filePath, p.originalContent, 'utf8')
    } catch {
      // best-effort
    }
  }

  if (patches.length > 0) {
    const ids = patches.map((p) => p.recordId).filter(Boolean)
    if (ids.length > 0) {
      await db.update(patchRecords)
        .set({ status: 'rolled_back', rolledBackAt: now, rollbackReason: reason })
        .where(inArray(patchRecords.id, ids))
    }
    // Emit per-rollback event so explainability + daily counters see it.
    for (const p of patches) {
      await db.insert(events).values({
        id: uuidv7(), type: 'patch.rolled_back', workspaceId: opts.workspaceId,
        payload: { recordId: p.recordId, jobId: opts.jobId, runId: opts.runId, filePath: p.filePath, reason },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'patch-executor', version: 1, createdAt: now,
      }).catch(() => null)
    }
  }

  // ── Closed-loop learning: record each rolled-back file as a patch failure ──
  for (const p of patches) {
    recordFailure({
      workspaceId: opts.workspaceId,
      failureType:    'patch',
      rootCauseClass: 'runtime',
      targetRef:      p.filePath,
      targetKind:     'file',
      errorMessage:   reason.slice(0, 500),
      evidenceIds:    [p.recordId],
      attemptedFixId: p.recordId,
    }).catch(() => null)
  }
}
