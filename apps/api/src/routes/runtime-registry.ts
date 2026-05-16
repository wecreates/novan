/**
 * Runtime Registry Routes
 *
 * Worker registration, heartbeat, and listing.
 * Execution lease lifecycle (create / renew / release / reclaim).
 * Provider composite scores + circuit breaker state.
 *
 * Prefix: /api/v1/runtime
 */

import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 }           from 'uuid'
import { and, desc, eq, lt }      from 'drizzle-orm'
import { db }                      from '../db/client.js'
import {
  workerRegistry, executionLeases, providerScores, events,
} from '../db/schema.js'
import {
  computeCompositeScore, computeLatencyScore, computeSuccessRateScore,
  computeCostScore, evaluateCircuit, nextCircuitState,
  DEFAULT_SCORE_WEIGHTS,
} from '@ops/ai-router'
import type { CircuitState } from '@ops/ai-router'
import {
  createLease, renewLease, releaseLease, cancelLease,
  getActiveLease, reclaimStaleLeases,
} from '../services/lease-manager.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/runtime-registry', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

const STALE_THRESHOLD_MS = 90_000   // worker is stale if no heartbeat for 90s

// ─── Plugin ───────────────────────────────────────────────────────────────────

const runtimeRegistryRoutes: FastifyPluginAsync = async (app) => {

  // ── Workers ────────────────────────────────────────────────────────────────

  /** Register a new remote worker */
  app.post<{
    Body: {
      workspaceId:      string
      workerName:       string
      workerType?:      string
      capabilities?:    string[]
      endpointUrl?:     string
      maxConcurrent?:   number
      staleThresholdMs?: number
      metadata?:        Record<string, unknown>
    }
  }>('/workers', async (req, reply) => {
    const {
      workspaceId, workerName, workerType = 'cpu', capabilities = [],
      endpointUrl, maxConcurrent = 1, staleThresholdMs = 60_000, metadata = {},
    } = req.body

    if (!workspaceId || !workerName) {
      return reply.code(400).send({ success: false, error: 'workspaceId and workerName required' })
    }

    const now    = Date.now()
    const worker = {
      id:               uuidv7(),
      workspaceId,
      workerName,
      workerType,
      capabilities,
      endpointUrl:      endpointUrl ?? null,
      metadata,
      status:           'idle' as const,
      maxConcurrent,
      activeLeases:     0,
      lastHeartbeatAt:  now,
      registeredAt:     now,
      staleThresholdMs,
      createdAt:        now,
      updatedAt:        now,
    }

    await db.insert(workerRegistry).values(worker)

    await emit(workspaceId, 'worker.registered', {
      workerId: worker.id, workerName, workerType, capabilities,
    })

    return reply.code(201).send({ success: true, data: worker })
  })

  /** List workers for a workspace */
  app.get<{ Params: { workspaceId: string }; Querystring: { status?: string; type?: string } }>(
    '/workers/:workspaceId',
    async (req, reply) => {
      const { workspaceId } = req.params
      const { status, type } = req.query

      const now = Date.now()

      let query = db.select().from(workerRegistry)
        .where(eq(workerRegistry.workspaceId, workspaceId))
        .$dynamic()

      if (status) {
        query = query.where(eq(workerRegistry.status, status))
      }
      if (type) {
        query = query.where(eq(workerRegistry.workerType, type))
      }

      const workers = await query.orderBy(desc(workerRegistry.lastHeartbeatAt))

      // Annotate stale status in response (don't mutate DB on read)
      const annotated = workers.map((w) => ({
        ...w,
        isStale: w.lastHeartbeatAt !== null && now - w.lastHeartbeatAt > (w.staleThresholdMs ?? STALE_THRESHOLD_MS),
      }))

      return reply.send({ success: true, data: annotated })
    },
  )

  /** Worker heartbeat */
  app.post<{ Params: { workerId: string }; Body: { workspaceId: string; status?: string; metadata?: Record<string, unknown> } }>(
    '/workers/:workerId/heartbeat',
    async (req, reply) => {
      const { workerId } = req.params
      const { workspaceId, status, metadata } = req.body

      const now = Date.now()

      const rows = await db.update(workerRegistry)
        .set({
          lastHeartbeatAt: now,
          updatedAt:       now,
          ...(status ? { status } : {}),
          ...(metadata ? { metadata } : {}),
        })
        .where(and(
          eq(workerRegistry.id, workerId),
          eq(workerRegistry.workspaceId, workspaceId),
        ))
        .returning({ id: workerRegistry.id, status: workerRegistry.status })

      if (rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'Worker not found' })
      }

      await emit(workspaceId, 'worker.heartbeat', { workerId, status: rows[0]!.status })

      return reply.send({ success: true, data: { workerId, heartbeatAt: now } })
    },
  )

  /** Deregister a worker */
  app.delete<{ Params: { workerId: string }; Body: { workspaceId: string } }>(
    '/workers/:workerId',
    async (req, reply) => {
      const { workerId }    = req.params
      const { workspaceId } = req.body

      const now = Date.now()
      await db.update(workerRegistry)
        .set({ status: 'offline', updatedAt: now })
        .where(and(
          eq(workerRegistry.id, workerId),
          eq(workerRegistry.workspaceId, workspaceId),
        ))

      await emit(workspaceId, 'worker.offline', { workerId })
      return reply.send({ success: true })
    },
  )

  /** Detect and mark stale workers as offline */
  app.post<{ Params: { workspaceId: string } }>(
    '/workers/:workspaceId/detect-stale',
    async (req, reply) => {
      const { workspaceId } = req.params
      const now = Date.now()

      // Workers with heartbeat older than their stale threshold
      const stale = await db.select({ id: workerRegistry.id, workerName: workerRegistry.workerName })
        .from(workerRegistry)
        .where(and(
          eq(workerRegistry.workspaceId, workspaceId),
          eq(workerRegistry.status, 'idle'),
          lt(workerRegistry.lastHeartbeatAt, now - STALE_THRESHOLD_MS),
        ))

      if (stale.length > 0) {
        await db.update(workerRegistry)
          .set({ status: 'offline', updatedAt: now })
          .where(and(
            eq(workerRegistry.workspaceId, workspaceId),
            eq(workerRegistry.status, 'idle'),
            lt(workerRegistry.lastHeartbeatAt, now - STALE_THRESHOLD_MS),
          ))

        for (const w of stale) {
          await emit(workspaceId, 'worker.stale', { workerId: w.id, workerName: w.workerName })
        }
      }

      return reply.send({ success: true, data: { markedOffline: stale.length } })
    },
  )

  // ── Leases ─────────────────────────────────────────────────────────────────

  /** Create a new execution lease */
  app.post<{
    Body: {
      workspaceId: string
      workerId:    string
      jobId:       string
      jobType:     string
      timeoutMs?:  number
      metadata?:   Record<string, unknown>
    }
  }>('/leases', async (req, reply) => {
    const { workspaceId, workerId, jobId, jobType, timeoutMs, metadata } = req.body

    if (!workspaceId || !workerId || !jobId || !jobType) {
      return reply.code(400).send({ success: false, error: 'workspaceId, workerId, jobId, jobType required' })
    }

    // Check worker exists
    const workers = await db.select().from(workerRegistry)
      .where(and(
        eq(workerRegistry.id, workerId),
        eq(workerRegistry.workspaceId, workspaceId),
      )).limit(1)

    if (workers.length === 0) {
      return reply.code(404).send({ success: false, error: 'Worker not found' })
    }

    const lease = await createLease({
      workspaceId,
      workerId,
      jobId,
      jobType: jobType as 'ai' | 'browser' | 'remote' | 'workflow',
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(metadata  !== undefined ? { metadata  } : {}),
    })

    return reply.code(201).send({ success: true, data: lease })
  })

  /** Renew an active lease */
  app.post<{ Params: { leaseId: string }; Body: { workspaceId: string } }>(
    '/leases/:leaseId/renew',
    async (req, reply) => {
      const { leaseId }     = req.params
      const { workspaceId } = req.body

      const updated = await renewLease(leaseId, workspaceId)
      if (!updated) {
        return reply.code(404).send({ success: false, error: 'Active lease not found' })
      }
      return reply.send({ success: true, data: updated })
    },
  )

  /** Release (complete) a lease */
  app.post<{ Params: { leaseId: string }; Body: { workspaceId: string; costUsd?: number } }>(
    '/leases/:leaseId/release',
    async (req, reply) => {
      const { leaseId }            = req.params
      const { workspaceId, costUsd } = req.body

      const ok = await releaseLease(leaseId, workspaceId, costUsd ?? 0)
      if (!ok) {
        return reply.code(404).send({ success: false, error: 'Active lease not found' })
      }
      return reply.send({ success: true })
    },
  )

  /** Cancel a lease */
  app.post<{ Params: { leaseId: string }; Body: { workspaceId: string } }>(
    '/leases/:leaseId/cancel',
    async (req, reply) => {
      const { leaseId }     = req.params
      const { workspaceId } = req.body

      const ok = await cancelLease(leaseId, workspaceId)
      if (!ok) {
        return reply.code(404).send({ success: false, error: 'Lease not found' })
      }
      return reply.send({ success: true })
    },
  )

  /** Get active lease for a job */
  app.get<{ Params: { workspaceId: string }; Querystring: { jobId: string } }>(
    '/leases/:workspaceId/active',
    async (req, reply) => {
      const { workspaceId } = req.params
      const { jobId }       = req.query

      if (!jobId) {
        return reply.code(400).send({ success: false, error: 'jobId query param required' })
      }

      const lease = await getActiveLease(jobId, workspaceId)
      return reply.send({ success: true, data: lease })
    },
  )

  /** List leases for a workspace */
  app.get<{
    Params:      { workspaceId: string }
    Querystring: { status?: string; workerId?: string; limit?: string }
  }>('/leases/:workspaceId', async (req, reply) => {
    const { workspaceId }                  = req.params
    const { status, workerId, limit = '50' } = req.query

    let query = db.select().from(executionLeases)
      .where(eq(executionLeases.workspaceId, workspaceId))
      .$dynamic()

    if (status)   query = query.where(eq(executionLeases.status, status))
    if (workerId) query = query.where(eq(executionLeases.workerId, workerId))

    const leases = await query
      .orderBy(desc(executionLeases.createdAt))
      .limit(Math.min(parseInt(limit, 10), 200))

    return reply.send({ success: true, data: leases })
  })

  /** Reclaim expired leases */
  app.post<{ Params: { workspaceId: string } }>(
    '/leases/:workspaceId/reclaim-stale',
    async (req, reply) => {
      const { workspaceId } = req.params
      const count = await reclaimStaleLeases(workspaceId)
      return reply.send({ success: true, data: { reclaimed: count } })
    },
  )

  // ── Provider Scores ────────────────────────────────────────────────────────

  /** Get all provider scores for a workspace */
  app.get<{ Params: { workspaceId: string } }>(
    '/scores/:workspaceId',
    async (req, reply) => {
      const scores = await db.select().from(providerScores)
        .where(eq(providerScores.workspaceId, req.params.workspaceId))
        .orderBy(desc(providerScores.compositeScore))

      return reply.send({ success: true, data: scores })
    },
  )

  /** Record a provider request outcome and recompute scores */
  app.post<{
    Body: {
      workspaceId:         string
      providerId:          string
      latencyMs:           number
      success:             boolean
      costUsdPerRequest?:  number
      capabilities?:       string[]
      requiredCapabilities?: string[]
    }
  }>('/scores/record', async (req, reply) => {
    const {
      workspaceId, providerId, latencyMs, success,
      costUsdPerRequest = 0,
      capabilities      = [],
      requiredCapabilities = [],
    } = req.body

    if (!workspaceId || !providerId) {
      return reply.code(400).send({ success: false, error: 'workspaceId and providerId required' })
    }

    const now  = Date.now()

    // Load existing score row
    const rows = await db.select().from(providerScores)
      .where(and(
        eq(providerScores.workspaceId, workspaceId),
        eq(providerScores.providerId,  providerId),
      )).limit(1)

    const existing = rows[0]

    // Compute new error rate (rolling approximation)
    const samples      = (existing?.sampleCount ?? 0) + 1
    const prevErrRate  = existing?.lastErrorRate ?? 0
    const errorRate    = (prevErrRate * (samples - 1) + (success ? 0 : 1)) / samples

    // Compute sub-scores
    const latencyScore    = computeLatencyScore(latencyMs)
    const successScore    = computeSuccessRateScore(errorRate)
    const costScore       = computeCostScore(costUsdPerRequest)
    const capabilityScore = existing?.capabilityScore ?? 1.0  // capability doesn't change per-request

    const compositeScore = computeCompositeScore(
      { latencyMs, errorRate, costUsdPerRequest, capabilities, requiredCapabilities },
      DEFAULT_SCORE_WEIGHTS,
    )

    // Circuit breaker update
    const curState    = (existing?.circuitState ?? 'closed') as CircuitState
    const curFailures = existing?.circuitFailures ?? 0
    const { state: newState, failures: newFailures } = nextCircuitState(curState, success, curFailures)
    const circuitOpenedAt =
      newState === 'open' && curState !== 'open' ? now : (existing?.circuitOpenedAt ?? null)

    await db.insert(providerScores).values({
      id:               uuidv7(),
      workspaceId,
      providerId,
      latencyScore,
      successScore,
      costScore,
      capabilityScore,
      compositeScore,
      sampleCount:      1,
      lastLatencyMs:    latencyMs,
      lastErrorRate:    errorRate,
      circuitState:     newState,
      circuitOpenedAt,
      circuitFailures:  newFailures,
      createdAt:        now,
      updatedAt:        now,
    }).onConflictDoUpdate({
      target: [providerScores.workspaceId, providerScores.providerId],
      set: {
        latencyScore, successScore, costScore, compositeScore,
        sampleCount:     samples,
        lastLatencyMs:   latencyMs,
        lastErrorRate:   errorRate,
        circuitState:    newState,
        circuitOpenedAt,
        circuitFailures: newFailures,
        updatedAt:       now,
      },
    })

    // Emit events
    await emit(workspaceId, 'provider.score.updated', {
      providerId, compositeScore, circuitState: newState, latencyMs, success,
    })

    if (newState === 'open' && curState !== 'open') {
      await emit(workspaceId, 'provider.circuit.opened', {
        providerId, failures: newFailures,
      })
    }
    if (newState === 'closed' && curState !== 'closed') {
      await emit(workspaceId, 'provider.circuit.closed', { providerId })
    }

    // Return circuit decision
    const circuitStatus = evaluateCircuit(newState, newFailures, circuitOpenedAt, now)

    return reply.send({
      success: true,
      data: {
        providerId, latencyScore, successScore, costScore, compositeScore,
        circuitState: newState, shouldAllow: circuitStatus.shouldAllow,
        sampleCount: samples,
      },
    })
  })

  /** Evaluate circuit state for a provider (read-only) */
  app.get<{ Params: { workspaceId: string; providerId: string } }>(
    '/scores/:workspaceId/:providerId/circuit',
    async (req, reply) => {
      const { workspaceId, providerId } = req.params

      const rows = await db.select().from(providerScores)
        .where(and(
          eq(providerScores.workspaceId, workspaceId),
          eq(providerScores.providerId,  providerId),
        )).limit(1)

      const row = rows[0]
      if (!row) {
        return reply.send({
          success: true,
          data: { providerId, circuitState: 'closed', shouldAllow: true, compositeScore: 1.0 },
        })
      }

      const circuitStatus = evaluateCircuit(
        row.circuitState as CircuitState,
        row.circuitFailures,
        row.circuitOpenedAt,
        Date.now(),
      )

      return reply.send({ success: true, data: { ...row, ...circuitStatus } })
    },
  )
}

export default runtimeRegistryRoutes
