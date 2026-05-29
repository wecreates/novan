/**
 * remote-dispatch.ts — actually submit a job to a remote worker over
 * its endpointUrl. This is the wire-through that closes the loop from
 * routing decision → real HTTP call → tracked lease.
 *
 * Wire protocol (workers must implement this — keep it boring and small):
 *
 *   POST  <endpointUrl>/jobs           body: { jobId, kind, payload, callbackBase }
 *     → 200 { accepted: true }         worker queues the job, runs async
 *     → any non-2xx                    dispatch fails, lease is cancelled
 *
 *   The worker reports progress back by hitting these endpoints on us:
 *     POST <callbackBase>/logs   { lines: [{ at, level, msg }] }
 *     POST <callbackBase>/done   { ok, costUsd, tokensUsed, output? }
 *
 *   callbackBase encodes the leaseId, so the worker never needs to know
 *   the lease primary key — it just echoes the URL we hand it.
 *
 * Authentication: workers expecting auth should put a token in their
 * endpointUrl as a header proxy or query-string secret. We send the
 * NOVAN_REMOTE_AUTH_TOKEN env var as `Authorization: Bearer …` when set.
 */
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import { workerRegistry, events } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { createLease, cancelLease } from './lease-manager.js'
import { routeJob, type RouteDecision, type JobKind } from './execution-fabric.js'

export interface DispatchRequest {
  workspaceId: string
  kind:        JobKind
  jobId?:      string
  payload?:    Record<string, unknown>
  capability?: string
  timeoutMs?:  number
  /** Base URL the worker will use for callbacks (logs/done). Required
   *  in production; in dev we infer from the request, but accepting it
   *  explicitly keeps tests deterministic and reverse-proxy setups sane. */
  callbackBase?: string
}

export interface DispatchResult {
  ok:        boolean
  decision:  RouteDecision
  jobId:     string
  leaseId?:  string
  workerId?: string
  error?:    string
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/remote-dispatch', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

export async function dispatchJob(req: DispatchRequest): Promise<DispatchResult> {
  const jobId = req.jobId ?? uuidv7()
  const decision = await routeJob({
    workspaceId: req.workspaceId,
    kind:        req.kind,
    ...(req.capability ? { capability: req.capability } : {}),
  })

  if (decision.decision === 'block') {
    await emit(req.workspaceId, 'remote.dispatch.blocked', { jobId, kind: req.kind, reason: decision.reason })
    return { ok: false, decision, jobId, error: decision.reason }
  }

  if (decision.decision === 'local') {
    // Caller handles locally; we return the decision but don't create a
    // lease (local execution doesn't lease through this path).
    return { ok: true, decision, jobId }
  }

  // Remote dispatch
  if (!decision.workerId || !decision.endpointUrl) {
    return { ok: false, decision, jobId, error: 'route returned remote without workerId/endpointUrl' }
  }

  // Create lease BEFORE the HTTP call so a slow worker can't double-bill.
  const lease = await createLease({
    workspaceId: req.workspaceId,
    workerId:    decision.workerId,
    jobId,
    jobType:     'remote',
    ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
    metadata:    { kind: req.kind, endpointUrl: decision.endpointUrl },
  }).catch(e => { return { error: (e as Error).message } as const })

  if ('error' in lease) {
    return { ok: false, decision, jobId, error: `lease creation failed: ${lease.error}` }
  }

  // Build callback base — uses the leaseId so worker echoes it back
  const cbBase = `${req.callbackBase ?? ''}/api/v1/runtime/leases/${lease.id}`

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const token = process.env['NOVAN_REMOTE_AUTH_TOKEN']
    if (token) headers['authorization'] = `Bearer ${token}`

    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 10_000)   // 10s to ACK
    const resp = await fetch(`${decision.endpointUrl}/jobs`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ jobId, kind: req.kind, payload: req.payload ?? {}, callbackBase: cbBase }),
      signal:  controller.signal,
    })
    clearTimeout(t)

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      await cancelLease(lease.id, req.workspaceId).catch(() => null)
      await emit(req.workspaceId, 'remote.dispatch.failed', { jobId, leaseId: lease.id, status: resp.status, body: body.slice(0, 500) })
      return { ok: false, decision, jobId, leaseId: lease.id, workerId: decision.workerId,
        error: `worker returned ${resp.status}: ${body.slice(0, 200)}` }
    }

    await emit(req.workspaceId, 'remote.dispatch.accepted', {
      jobId, leaseId: lease.id, workerId: decision.workerId, workerName: decision.workerName,
      kind: req.kind, endpointUrl: decision.endpointUrl,
    })
    return { ok: true, decision, jobId, leaseId: lease.id, workerId: decision.workerId }
  } catch (e) {
    await cancelLease(lease.id, req.workspaceId).catch(() => null)
    const msg = (e as Error).message
    await emit(req.workspaceId, 'remote.dispatch.error', { jobId, leaseId: lease.id, error: msg })
    return { ok: false, decision, jobId, leaseId: lease.id, workerId: decision.workerId,
      error: `dispatch threw: ${msg}` }
  }
}

/**
 * List a worker's lifetime cost + per-status counts. Used by the UI to
 * show "this remote worker has cost $X across N jobs."
 */
export async function workerCostSummary(workspaceId: string) {
  const rows = await db.select().from(workerRegistry).where(eq(workerRegistry.workspaceId, workspaceId)).catch(() => [])
  // We aggregate from executionLeases — done as a single query to avoid N+1.
  const { executionLeases } = await import('../db/schema.js')
  const { sql } = await import('drizzle-orm')
  const agg = await db.select({
    workerId:  executionLeases.workerId,
    totalCost: sql<number>`COALESCE(SUM(${executionLeases.costUsd}), 0)`,
    leases:    sql<number>`COUNT(*)`,
    completed: sql<number>`SUM(CASE WHEN ${executionLeases.status} = 'completed' THEN 1 ELSE 0 END)`,
    failed:    sql<number>`SUM(CASE WHEN ${executionLeases.status} IN ('expired','cancelled','reclaimed') THEN 1 ELSE 0 END)`,
  })
    .from(executionLeases)
    .where(eq(executionLeases.workspaceId, workspaceId))
    .groupBy(executionLeases.workerId)
    .catch(() => [])

  const byId = new Map(agg.map(a => [a.workerId, a]))
  return rows.map(w => {
    const a = byId.get(w.id)
    return {
      workerId:    w.id,
      workerName:  w.workerName,
      workerType:  w.workerType,
      endpointUrl: w.endpointUrl,
      alive:       (w.lastHeartbeatAt ?? 0) > Date.now() - 90_000,
      totalCostUsd: Number(a?.totalCost ?? 0),
      leases:       Number(a?.leases ?? 0),
      completed:    Number(a?.completed ?? 0),
      failed:       Number(a?.failed ?? 0),
    }
  })
}
