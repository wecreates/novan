/**
 * failure-memory.ts — Persisted failure history + repeat-prevention.
 *
 * Records every failure with a stable signature. Agents must call
 * `checkBeforePatch()` before attempting a fix; if the signature has
 * already been tried REPEAT_BLOCK_THRESHOLD times, the attempt is blocked.
 *
 * No fake learning — every record references real evidence row IDs.
 */
import { db }              from '../db/client.js'
import { failureMemory, successfulFixes, events } from '../db/schema.js'
import { eq, and, desc }   from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'
import * as crypto         from 'node:crypto'

export type FailureType = 'patch' | 'command' | 'provider_call' | 'worker_exec' | 'recovery'
export type RootCauseClass =
  | 'syntax' | 'build' | 'runtime' | 'data' | 'ui'
  | 'performance' | 'security' | 'infra' | 'unknown'

export const REPEAT_WARN_THRESHOLD  = 2
export const REPEAT_BLOCK_THRESHOLD = 3

// ─── Signature ────────────────────────────────────────────────────────────────

/**
 * Build a stable signature for grouping similar failures.
 * Pattern is the first 80 chars of error message, normalised.
 */
export function buildSignature(opts: {
  failureType:    FailureType
  targetRef:      string
  rootCauseClass: RootCauseClass
  errorMessage:   string
}): { signature: string; errorPattern: string } {
  const pattern = opts.errorMessage
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '0xHEX')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)

  const hash = crypto.createHash('sha256')
    .update(`${opts.failureType}::${opts.targetRef}::${opts.rootCauseClass}::${pattern.slice(0, 80)}`)
    .digest('hex')
    .slice(0, 16)

  return { signature: hash, errorPattern: pattern }
}

// ─── Event helper ─────────────────────────────────────────────────────────────

async function emitEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'failure-memory', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Record a failure ─────────────────────────────────────────────────────────

export interface RecordFailureInput {
  workspaceId:    string
  failureType:    FailureType
  rootCauseClass: RootCauseClass
  targetRef:      string
  targetKind:     string
  errorMessage:   string
  agentId?:       string
  evidenceIds:    string[]   // REAL row IDs from source tables
  attemptedFixId?: string    // patchRecord ID for the failed attempt
}

export interface RecordedFailure {
  id:              string
  signature:       string
  occurrenceCount: number
  blocked:         boolean
  isRepeat:        boolean
}

export async function recordFailure(input: RecordFailureInput): Promise<RecordedFailure> {
  if (input.evidenceIds.length === 0) {
    throw new Error('recordFailure: evidenceIds required — failure memory must link to real evidence')
  }

  const { signature, errorPattern } = buildSignature({
    failureType:    input.failureType,
    targetRef:      input.targetRef,
    rootCauseClass: input.rootCauseClass,
    errorMessage:   input.errorMessage,
  })

  const now = Date.now()

  // Look for existing memory with same signature
  const existing = await db.select().from(failureMemory)
    .where(and(
      eq(failureMemory.workspaceId, input.workspaceId),
      eq(failureMemory.signature, signature),
    )).limit(1)

  if (existing[0]) {
    const prev = existing[0]
    const newEvidence = [...new Set([...prev.evidenceIds, ...input.evidenceIds])]
    const newFixes    = input.attemptedFixId
      ? [...new Set([...prev.attemptedFixIds, input.attemptedFixId])]
      : prev.attemptedFixIds
    const newCount    = prev.occurrenceCount + 1
    const shouldBlock = newCount >= REPEAT_BLOCK_THRESHOLD

    await db.update(failureMemory).set({
      occurrenceCount: newCount,
      evidenceIds:     newEvidence,
      attemptedFixIds: newFixes,
      blocked:         shouldBlock,
      lastSeenAt:      now,
      updatedAt:       now,
    }).where(eq(failureMemory.id, prev.id))

    await emitEvent(input.workspaceId, 'failure_memory.similar_detected', {
      memoryId: prev.id, signature, occurrenceCount: newCount, targetRef: input.targetRef,
    })

    return {
      id: prev.id, signature, occurrenceCount: newCount, blocked: shouldBlock, isRepeat: true,
    }
  }

  // New failure
  const id = uuidv7()
  await db.insert(failureMemory).values({
    id,
    workspaceId:     input.workspaceId,
    failureType:     input.failureType,
    rootCauseClass:  input.rootCauseClass,
    targetRef:       input.targetRef,
    targetKind:      input.targetKind,
    signature,
    errorPattern,
    agentId:         input.agentId ?? null,
    evidenceIds:     input.evidenceIds,
    attemptedFixIds: input.attemptedFixId ? [input.attemptedFixId] : [],
    occurrenceCount: 1,
    blocked:         false,
    firstSeenAt:     now,
    lastSeenAt:      now,
    createdAt:       now,
    updatedAt:       now,
  })

  await emitEvent(input.workspaceId, 'failure_memory.recorded', {
    memoryId: id, signature, failureType: input.failureType, targetRef: input.targetRef,
    rootCauseClass: input.rootCauseClass,
  })

  return { id, signature, occurrenceCount: 1, blocked: false, isRepeat: false }
}

// ─── Check before patch ───────────────────────────────────────────────────────

export interface PreFixCheckResult {
  decision:        'allow' | 'warn' | 'block'
  reason:          string
  signature:       string
  memoryId:        string | null
  occurrenceCount: number
  successfulFixId: string | null
  successfulFixDescription: string | null
}

export async function checkBeforePatch(opts: {
  workspaceId:    string
  failureType:    FailureType
  rootCauseClass: RootCauseClass
  targetRef:      string
  errorMessage:   string
}): Promise<PreFixCheckResult> {
  const { signature } = buildSignature({
    failureType:    opts.failureType,
    targetRef:      opts.targetRef,
    rootCauseClass: opts.rootCauseClass,
    errorMessage:   opts.errorMessage,
  })

  // Look up failure memory
  const memRows = await db.select().from(failureMemory)
    .where(and(
      eq(failureMemory.workspaceId, opts.workspaceId),
      eq(failureMemory.signature, signature),
    )).limit(1)
  const mem = memRows[0]

  // Look up successful fixes for this signature
  const fixRows = await db.select().from(successfulFixes)
    .where(and(
      eq(successfulFixes.workspaceId, opts.workspaceId),
      eq(successfulFixes.failureSignature, signature),
    ))
    .orderBy(desc(successfulFixes.successCount))
    .limit(1)
  const fix = fixRows[0]

  if (!mem) {
    return {
      decision: 'allow', reason: 'No prior failure recorded for this signature',
      signature, memoryId: null, occurrenceCount: 0,
      successfulFixId: fix?.id ?? null,
      successfulFixDescription: fix?.fixDescription ?? null,
    }
  }

  if (mem.blocked || mem.occurrenceCount >= REPEAT_BLOCK_THRESHOLD) {
    await emitEvent(opts.workspaceId, 'failure_memory.repeated_fix_blocked', {
      memoryId: mem.id, signature, occurrenceCount: mem.occurrenceCount, targetRef: opts.targetRef,
    })
    return {
      decision: 'block',
      reason: `Refusing repeat fix: this exact failure has been attempted ${mem.occurrenceCount} times — try a new strategy or escalate`,
      signature, memoryId: mem.id, occurrenceCount: mem.occurrenceCount,
      successfulFixId: fix?.id ?? null,
      successfulFixDescription: fix?.fixDescription ?? null,
    }
  }

  if (mem.occurrenceCount >= REPEAT_WARN_THRESHOLD) {
    return {
      decision: 'warn',
      reason: `Similar failure seen ${mem.occurrenceCount} time(s) — consider a different approach`,
      signature, memoryId: mem.id, occurrenceCount: mem.occurrenceCount,
      successfulFixId: fix?.id ?? null,
      successfulFixDescription: fix?.fixDescription ?? null,
    }
  }

  return {
    decision: 'allow', reason: 'Prior failure exists but below repeat threshold',
    signature, memoryId: mem.id, occurrenceCount: mem.occurrenceCount,
    successfulFixId: fix?.id ?? null,
    successfulFixDescription: fix?.fixDescription ?? null,
  }
}

// ─── Record a successful fix ──────────────────────────────────────────────────

export interface RecordSuccessInput {
  workspaceId:             string
  failureSignature:        string
  fixDescription:          string
  targetRef:               string
  agentId?:                string
  verificationEvidenceIds: string[]  // must be passed=true rows
  patchRecordIds:          string[]
}

export async function recordSuccessfulFix(input: RecordSuccessInput): Promise<{ id: string; isNew: boolean }> {
  if (input.verificationEvidenceIds.length === 0) {
    throw new Error('recordSuccessfulFix: requires verificationEvidenceIds (passed=true rows)')
  }
  const now = Date.now()

  // Dedup by signature + targetRef
  const existing = await db.select().from(successfulFixes)
    .where(and(
      eq(successfulFixes.workspaceId, input.workspaceId),
      eq(successfulFixes.failureSignature, input.failureSignature),
      eq(successfulFixes.targetRef, input.targetRef),
    )).limit(1)

  if (existing[0]) {
    const prev = existing[0]
    await db.update(successfulFixes).set({
      successCount:           prev.successCount + 1,
      verificationEvidenceIds: [...new Set([...prev.verificationEvidenceIds, ...input.verificationEvidenceIds])],
      patchRecordIds:         [...new Set([...prev.patchRecordIds, ...input.patchRecordIds])],
      lastAppliedAt:          now,
      updatedAt:              now,
    }).where(eq(successfulFixes.id, prev.id))

    await emitEvent(input.workspaceId, 'failure_memory.successful_fix_learned', {
      fixId: prev.id, signature: input.failureSignature, successCount: prev.successCount + 1,
    })
    return { id: prev.id, isNew: false }
  }

  const id = uuidv7()
  await db.insert(successfulFixes).values({
    id,
    workspaceId:             input.workspaceId,
    failureSignature:        input.failureSignature,
    fixDescription:          input.fixDescription,
    targetRef:               input.targetRef,
    agentId:                 input.agentId ?? null,
    verificationEvidenceIds: input.verificationEvidenceIds,
    patchRecordIds:          input.patchRecordIds,
    successCount:            1,
    firstAppliedAt:          now,
    lastAppliedAt:           now,
    createdAt:               now,
    updatedAt:               now,
  })

  // Clear blocked flag on the matching failure memory (we have a working fix now)
  await db.update(failureMemory).set({
    blocked:   false,
    updatedAt: now,
  }).where(and(
    eq(failureMemory.workspaceId, input.workspaceId),
    eq(failureMemory.signature,   input.failureSignature),
  ))

  await emitEvent(input.workspaceId, 'failure_memory.successful_fix_learned', {
    fixId: id, signature: input.failureSignature, successCount: 1,
  })
  return { id, isNew: true }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function listFailures(workspaceId: string, opts: { type?: string; blocked?: boolean; limit?: number } = {}) {
  if (opts.blocked) {
    return db.select().from(failureMemory)
      .where(and(eq(failureMemory.workspaceId, workspaceId), eq(failureMemory.blocked, true)))
      .orderBy(desc(failureMemory.occurrenceCount))
      .limit(opts.limit ?? 50)
  }
  if (opts.type) {
    return db.select().from(failureMemory)
      .where(and(eq(failureMemory.workspaceId, workspaceId), eq(failureMemory.failureType, opts.type)))
      .orderBy(desc(failureMemory.occurrenceCount))
      .limit(opts.limit ?? 50)
  }
  return db.select().from(failureMemory)
    .where(eq(failureMemory.workspaceId, workspaceId))
    .orderBy(desc(failureMemory.occurrenceCount))
    .limit(opts.limit ?? 50)
}

export async function listSuccessfulFixes(workspaceId: string, limit = 50) {
  return db.select().from(successfulFixes)
    .where(eq(successfulFixes.workspaceId, workspaceId))
    .orderBy(desc(successfulFixes.successCount))
    .limit(limit)
}

/** Aggregate stats for the War Room view */
export async function getLearningStats(workspaceId: string) {
  const failures = await db.select().from(failureMemory)
    .where(eq(failureMemory.workspaceId, workspaceId))
  const fixes = await db.select().from(successfulFixes)
    .where(eq(successfulFixes.workspaceId, workspaceId))

  // Risky files: targetKind=file with highest occurrence
  const fileFailures = failures.filter((f) => f.targetKind === 'file')
  const riskyFiles = [...new Set(fileFailures.map((f) => f.targetRef))]
    .map((file) => {
      const recs = fileFailures.filter((f) => f.targetRef === file)
      return {
        file,
        failures: recs.length,
        totalOccurrences: recs.reduce((n, r) => n + r.occurrenceCount, 0),
        blocked: recs.some((r) => r.blocked),
      }
    })
    .sort((a, b) => b.totalOccurrences - a.totalOccurrences)
    .slice(0, 10)

  // Agent rollback rates
  const agentMap = new Map<string, { failures: number; successes: number; blocked: number }>()
  for (const f of failures) {
    if (!f.agentId) continue
    const a = agentMap.get(f.agentId) ?? { failures: 0, successes: 0, blocked: 0 }
    a.failures += f.occurrenceCount
    if (f.blocked) a.blocked += 1
    agentMap.set(f.agentId, a)
  }
  for (const fix of fixes) {
    if (!fix.agentId) continue
    const a = agentMap.get(fix.agentId) ?? { failures: 0, successes: 0, blocked: 0 }
    a.successes += fix.successCount
    agentMap.set(fix.agentId, a)
  }
  const agentStats = [...agentMap.entries()].map(([agentId, m]) => ({
    agentId,
    failures: m.failures,
    successes: m.successes,
    blocked: m.blocked,
    rollbackRate: m.failures + m.successes > 0 ? m.failures / (m.failures + m.successes) : 0,
  })).sort((a, b) => b.rollbackRate - a.rollbackRate)

  return {
    totalFailures:        failures.length,
    totalOccurrences:     failures.reduce((n, f) => n + f.occurrenceCount, 0),
    blockedSignatures:    failures.filter((f) => f.blocked).length,
    totalSuccessfulFixes: fixes.length,
    riskyFiles,
    agentStats,
  }
}
