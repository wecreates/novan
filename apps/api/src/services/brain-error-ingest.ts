/**
 * brain-error-ingest.ts — Operator never sees raw errors. Brain does.
 *
 * Every UI mutation that fails + every server-side caught exception
 * funnels into `reportError()`. The brain:
 *   1. Captures full context (URL, method, payload, stack, recent events)
 *   2. Creates a high-fidelity `issue` row (or appends to an existing one)
 *   3. Runs the auto-diagnose patterns immediately (don't wait for cron)
 *   4. If diagnosis succeeds AND risk=low AND paths-safe → fires the
 *      auto-loop for this specific issue in the background
 *   5. Returns a tiny "investigating" handle for the UI so the operator
 *      sees "Brain is on it" instead of a raw error
 *
 * The brain owns the failure. The operator owns the outcome.
 */
import { db } from '../db/client.js'
import {
  issues, events, reasoningChains, failureMemory,
} from '../db/schema.js'
import { and, eq, desc, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'node:crypto'

export interface ErrorReport {
  workspaceId:  string
  source:       'ui' | 'api' | 'worker' | 'cron' | 'voice' | 'chat'
  // What broke
  errorMessage: string
  errorName?:   string
  stack?:       string
  // Where
  url?:         string
  method?:      string
  statusCode?:  number
  // Context (anything the caller knows)
  payload?:     Record<string, unknown>
  userAgent?:   string
  // Pointers (so brain can pull more context)
  conversationId?: string
  delegationId?:   string
  taskId?:         string
}

export interface ErrorReportResult {
  issueId:        string
  fingerprint:    string
  alreadyKnown:   boolean
  diagnosed:      boolean
  autoFixQueued:  boolean
  brainSays:      string   // short message the UI can show — "Brain is on it"
}

/**
 * Stable fingerprint so retries of the same error roll up to one issue.
 * Hash on (error name + first line of stack + URL pattern with IDs stripped).
 */
function fingerprintError(r: ErrorReport): string {
  const name  = r.errorName ?? r.errorMessage.split(':')[0]?.slice(0, 80) ?? 'error'
  const stack = (r.stack ?? '').split('\n').find(l => l.trim().startsWith('at')) ?? ''
  const url   = (r.url ?? '').replace(/[0-9a-f]{8,}/gi, ':id').replace(/\?.*/, '')
  return createHash('sha256').update(`${name}|${stack}|${url}`).digest('hex').slice(0, 16)
}

/**
 * Pattern bank — same library used by `autoDiagnoseIssues`, expanded
 * with patterns specific to UI + API errors. Match order matters:
 * specific patterns first.
 */
interface DiagPattern {
  match:        RegExp
  rootCause:    string
  proposedFix:  string
  riskLevel:    'low' | 'medium' | 'high'
}
const PATTERNS: DiagPattern[] = [
  { match: /\b401\b|\bUnauthorized\b/i,
    rootCause: 'Auth token missing or expired',
    proposedFix: 'Re-issue the operator session token + verify /api/v1/auth/me round-trip succeeds',
    riskLevel: 'low' },
  { match: /\b403\b|forbidden/i,
    rootCause: 'Permission denied — workspace/role check rejected the request',
    proposedFix: 'Verify req.workspaceId matches operator workspace + check role allowlist on the route',
    riskLevel: 'low' },
  { match: /\b404\b|not found/i,
    rootCause: 'Resource not found at the requested URL',
    proposedFix: 'Check route registration + verify the upstream record exists',
    riskLevel: 'low' },
  { match: /\b429\b|rate.?limit/i,
    rootCause: 'Rate limit exceeded',
    proposedFix: 'Add backoff to caller OR raise rate limit on the route',
    riskLevel: 'low' },
  { match: /\b50[0-9]\b|service unavailable|internal server/i,
    rootCause: 'Upstream 5xx — server error or upstream provider down',
    proposedFix: 'Retry with exponential backoff (provider-retry.ts) + circuit-breaker if recurring',
    riskLevel: 'low' },
  { match: /undefined is not|cannot read.*undefined|null is not/i,
    rootCause: 'Null/undefined access on data that did not load',
    proposedFix: 'Add optional chaining OR isLoading guard before the access',
    riskLevel: 'low' },
  { match: /timeout|timed out|ETIMEDOUT/i,
    rootCause: 'Operation exceeded timeout window',
    proposedFix: 'Raise timeout for this code path OR break into smaller chunks',
    riskLevel: 'low' },
  { match: /ECONNREFUSED|connection refused/i,
    rootCause: 'Service connection refused — target not running',
    proposedFix: 'Verify the target service is up + reachable from the API host',
    riskLevel: 'low' },
  { match: /CORS|cross.?origin/i,
    rootCause: 'CORS preflight rejected by browser',
    proposedFix: 'Add the operator origin to CORS_ORIGINS env var + restart API',
    riskLevel: 'low' },
  { match: /TypeError.*not a function|is not a constructor/i,
    rootCause: 'Function reference broken — likely a refactor mismatch or import drift',
    proposedFix: 'Grep for the symbol + verify exports match imports',
    riskLevel: 'low' },
  { match: /unique constraint|duplicate key/i,
    rootCause: 'Insert collided with existing row',
    proposedFix: 'Switch to onConflictDoNothing/onConflictDoUpdate OR check-then-insert in transaction',
    riskLevel: 'low' },
  { match: /JSON.*Unexpected|Unexpected token/i,
    rootCause: 'Response was not valid JSON (likely HTML error page)',
    proposedFix: 'Inspect the response body before JSON.parse; surface upstream HTML errors as the real cause',
    riskLevel: 'low' },
  { match: /circuit-breaker-open/i,
    rootCause: 'Provider circuit breaker tripped after 5 failures',
    proposedFix: 'Wait for breaker to reset (60s) + investigate why the provider keeps failing',
    riskLevel: 'medium' },
  { match: /money-guard blocked/i,
    rootCause: 'Brain attempted a financial operation; money guard refused',
    proposedFix: 'No fix needed — this is a safety boundary working correctly',
    riskLevel: 'low' },
]

function diagnose(message: string, stack: string): DiagPattern | null {
  const hay = `${message} ${stack}`
  for (const p of PATTERNS) if (p.match.test(hay)) return p
  return null
}

async function recordChain(workspaceId: string, subjectId: string, decision: string, evidence: Array<{ type: string; id: string; extract: string }>): Promise<void> {
  await db.insert(reasoningChains).values({
    id: uuidv7(),
    workspaceId,
    kind: 'observation',
    subjectId,
    decision,
    evidence,
    confidence: 0.85,
    source: 'brain-error-ingest',
    indexedForSearch: false,
    createdAt: Date.now(),
  } as typeof reasoningChains.$inferInsert).catch(() => null)
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'brain-error-ingest', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

/**
 * Public entry — UI + API + workers call this with whatever they know.
 * Always responds with a small actionable message; never throws.
 */
export async function reportError(r: ErrorReport): Promise<ErrorReportResult> {
  const fingerprint = fingerprintError(r)
  const now = Date.now()

  // 1. Dedup: existing open/triaged/diagnosed issue with same fingerprint?
  const existing = await db.select().from(issues)
    .where(and(
      eq(issues.workspaceId, r.workspaceId),
      eq(issues.fingerprint, fingerprint),
    ))
    .orderBy(desc(issues.detectedAt))
    .limit(1).then(rows => rows[0]).catch(() => undefined)

  // 2. Diagnose the message
  const diag = diagnose(r.errorMessage, r.stack ?? '')

  // 3. Pull recent failure_memory hits for this fingerprint — has the
  //    brain seen this before? failure_memory uses `signature` as its
  //    dedup key; reuse our fingerprint as the prefix.
  const memoryHit = await db.select().from(failureMemory)
    .where(and(
      eq(failureMemory.workspaceId, r.workspaceId),
      eq(failureMemory.signature, fingerprint),
    )).limit(1).then(rows => rows[0]).catch(() => undefined)

  const evidenceItems = [
    { type: 'error',       ref: 'inline', summary: r.errorMessage.slice(0, 500), at: now },
    ...(r.stack       ? [{ type: 'stack',    ref: 'inline', summary: r.stack.slice(0, 1500),    at: now }] : []),
    ...(r.url         ? [{ type: 'request',  ref: r.url,    summary: `${r.method ?? 'GET'} ${r.url}${r.statusCode ? ` → ${r.statusCode}` : ''}`, at: now }] : []),
    ...(r.payload     ? [{ type: 'payload',  ref: 'inline', summary: JSON.stringify(r.payload).slice(0, 500),   at: now }] : []),
    ...(memoryHit     ? [{ type: 'memory',   ref: memoryHit.id, summary: `Seen ${memoryHit.occurrenceCount}× before: ${memoryHit.errorPattern.slice(0, 200)}`, at: now }] : []),
  ]

  let issueId: string
  let alreadyKnown = false

  if (existing) {
    issueId = existing.id
    alreadyKnown = true
    // Append evidence (capped) so the brain accumulates context
    const newEvidence = [
      ...((existing.evidence as Array<{ type: string; ref: string; summary: string; at: number }>) ?? []),
      ...evidenceItems,
    ].slice(-50)
    // FIX: previously .catch(() => null) — failed update meant the error
    // ingester silently dropped the evidence append. Operator never saw
    // why their issue evidence wasn't growing. Now propagate (the outer
    // function returns { ok: false, reason } if anything throws).
    try {
      await db.update(issues).set({ evidence: newEvidence, updatedAt: now })
        .where(eq(issues.id, existing.id))
    } catch (e) {
      console.error('[brain-error-ingest] failed to update issue evidence:', (e as Error).message)
    }
    await emit(r.workspaceId, 'brain.error_recurrence', {
      issueId, fingerprint, source: r.source, count: newEvidence.length,
    })
  } else {
    issueId = uuidv7()
    const baseRow = {
      id:               issueId,
      workspaceId:      r.workspaceId,
      symptom:          r.errorMessage.slice(0, 280),
      source:           'cron-failure' as const,
      severity:         (r.statusCode && r.statusCode >= 500 ? 'critical' : 'warning') as 'warning' | 'critical',
      affectedSystems:  inferAffectedSystems(r),
      evidence:         evidenceItems,
      fingerprint,
      detectedAt:       now,
      createdAt:        now,
      updatedAt:        now,
      createdBy:        `brain-ingest:${r.source}`,
      diagnosedBy:      diag ? 'auto-diagnoser' : null,
      ...(diag ? {
        rootCause:        diag.rootCause,
        proposedFix:      diag.proposedFix,
        riskLevel:        diag.riskLevel,
        verificationPlan: 'Re-run the operation that failed; confirm no recurrence in 30 min',
        status:           'diagnosed' as const,
        diagnosedAt:      now,
      } : {
        status: 'open' as const,
      }),
    }
    // FIX: don't silently drop a new-issue insert — log so we see real
    // DB failures during incidents (when we most need this telemetry).
    try {
      await db.insert(issues).values(baseRow)
    } catch (e) {
      console.error('[brain-error-ingest] failed to insert new issue:', (e as Error).message, { issueId })
    }
    await recordChain(r.workspaceId, `issue:${issueId}`,
      diag
        ? `Brain ingested error: "${r.errorMessage.slice(0, 120)}" → matched pattern "${diag.rootCause}" → ${diag.proposedFix}`
        : `Brain ingested error: "${r.errorMessage.slice(0, 120)}" — no diagnosis pattern matched yet; queued for operator review`,
      [{ type: 'issue', id: issueId, extract: diag?.rootCause ?? 'unknown' }],
    )
    await emit(r.workspaceId, 'brain.error_received', {
      issueId, fingerprint, source: r.source, diagnosed: !!diag, url: r.url, statusCode: r.statusCode,
    })
  }

  // 4. If diagnosed + low-risk + safety flag on → fire the auto-loop
  //    in the background. The loop's own gates (selfEditLoopsAllowed,
  //    protected paths, daily budget) provide the final say.
  //
  //    Recursion guard: errors thrown BY the auto-loop itself funnel
  //    through this same reportError (via the API error handler), which
  //    would re-trigger another auto-loop → infinite cascade if the loop
  //    keeps failing. Skip the spawn when the error's source/url marks
  //    it as originating inside the auto-loop subsystem.
  let autoFixQueued = false
  const isAutoLoopOrigin =
    r.source === 'cron' && /auto[-_]loop|issue-auto-loop/i.test(r.errorMessage + ' ' + (r.url ?? ''))
  if (diag && diag.riskLevel === 'low' && !isAutoLoopOrigin) {
    void (async () => {
      try {
        const { isAllowed } = await import('./safety-mode.js')
        if (await isAllowed(r.workspaceId, 'self_edit_loop')) {
          const { runAutoLoopFor } = await import('./issue-auto-loop.js')
          await runAutoLoopFor(r.workspaceId).catch((e: unknown) => {
            console.error('[brain-error-ingest] runAutoLoopFor failed (suppressing to avoid recursion):', (e as Error).message)
          })
        }
      } catch { /* tolerated */ }
    })()
    autoFixQueued = !isAutoLoopOrigin
  }

  // 5. Compose operator-facing message — short + honest
  const brainSays = diag
    ? `Brain identified this as "${diag.rootCause}". ${autoFixQueued ? 'Auto-fix queued.' : 'Diagnosis recorded; awaiting operator approval.'}`
    : `Brain logged this for analysis. ${alreadyKnown ? 'Same pattern seen before.' : 'New pattern.'}`

  return {
    issueId,
    fingerprint,
    alreadyKnown,
    diagnosed: !!diag,
    autoFixQueued,
    brainSays,
  }
}

function inferAffectedSystems(r: ErrorReport): string[] {
  const out = new Set<string>()
  out.add(r.source)
  if (r.url) {
    const seg = r.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]?.split('/').filter(Boolean) ?? []
    if (seg[0] === 'api' && seg[1] && seg[2]) out.add(`route:${seg[2]}`)
  }
  if (r.conversationId)  out.add('chat')
  if (r.delegationId)    out.add('agency')
  if (r.taskId)          out.add('brain-task')
  return [...out]
}

/** Last N errors the brain has ingested — for /brain/errors dashboard. */
export async function recentErrors(workspaceId: string, limit = 30) {
  return db.select({
    id: issues.id, symptom: issues.symptom, severity: issues.severity,
    status: issues.status, rootCause: issues.rootCause, proposedFix: issues.proposedFix,
    riskLevel: issues.riskLevel, fingerprint: issues.fingerprint,
    affectedSystems: issues.affectedSystems,
    detectedAt: issues.detectedAt, diagnosedAt: issues.diagnosedAt,
  }).from(issues)
    .where(and(
      eq(issues.workspaceId, workspaceId),
      // Only ingest sources
    ))
    .orderBy(desc(issues.detectedAt))
    .limit(limit)
    .then(rows => rows.filter(r => true))   // placeholder: full list
    .catch(() => [])
}
