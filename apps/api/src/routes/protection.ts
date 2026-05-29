/**
 * Runtime Protection Routes
 *
 * Budget caps, kill switches, provider quarantine,
 * queue pauses, preflight checks, cancellation.
 *
 * Prefix: /api/v1/protection
 */

import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 }           from 'uuid'
import { and, eq, isNull }        from 'drizzle-orm'
import { db }                      from '../db/client.js'
import {
  killSwitches, providerQuarantine, queuePauses, events,
} from '../db/schema.js'
import {
  upsertBudgetCap, runPreflight,
} from '../services/budget-guard.js'
import {
  cancelWorkflowRun, cancelExecutionLease,
} from '../services/cancellation.js'
import {
  evaluateKillSwitches,
} from '@ops/ai-router'
import type { KillSwitchRecord } from '@ops/ai-router'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emitEvent(
  workspaceId: string, type: string, payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/protection', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[protection]', e.message); return null })
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const protectionRoutes: FastifyPluginAsync = async (app) => {

  // ── Budget caps ────────────────────────────────────────────────────────────

  /** List budget caps for a workspace */
  app.get<{ Querystring: { workspaceId: string } }>('/budget-caps', {
    schema: {
      tags: ['protection'],
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const { workspaceId } = req.query
    const caps = await db.select().from(/* budgetCaps */ (await import('../db/schema.js')).budgetCaps)
      .where(eq((await import('../db/schema.js')).budgetCaps.workspaceId, workspaceId))
    return { caps }
  })

  /** Create or update a budget cap */
  app.post<{
    Body: {
      workspaceId:         string
      scopeType:           string
      scopeId:             string
      maxDailyUsd?:        number
      maxMonthlyUsd?:      number
      maxPerExecutionUsd?: number
      maxWorkflowUsd?:     number
    }
  }>('/budget-caps', {
    schema: {
      tags: ['protection'],
      body: {
        type: 'object',
        required: ['workspaceId', 'scopeType', 'scopeId'],
        properties: {
          workspaceId:         { type: 'string' },
          scopeType:           { type: 'string' },
          scopeId:             { type: 'string' },
          maxDailyUsd:         { type: 'number' },
          maxMonthlyUsd:       { type: 'number' },
          maxPerExecutionUsd:  { type: 'number' },
          maxWorkflowUsd:      { type: 'number' },
        },
      },
    },
  }, async (req) => {
    const { workspaceId, scopeType, scopeId, ...limits } = req.body
    const cap = await upsertBudgetCap(workspaceId, scopeType, scopeId, limits)
    return { cap }
  })

  /** Run budget preflight check */
  app.post<{
    Body: {
      workspaceId:      string
      executionId:      string
      providerId:       string
      scopeType:        string
      scopeId:          string
      estimatedCostUsd: number
      isWorkflow?:      boolean
    }
  }>('/preflight', {
    schema: {
      tags: ['protection'],
      body: {
        type: 'object',
        required: ['workspaceId', 'executionId', 'providerId', 'scopeType', 'scopeId', 'estimatedCostUsd'],
        properties: {
          workspaceId:      { type: 'string' },
          executionId:      { type: 'string' },
          providerId:       { type: 'string' },
          scopeType:        { type: 'string' },
          scopeId:          { type: 'string' },
          estimatedCostUsd: { type: 'number' },
          isWorkflow:       { type: 'boolean' },
        },
      },
    },
  }, async (req) => {
    const decision = await runPreflight(req.body)
    return { decision }
  })

  // ── Kill switches ──────────────────────────────────────────────────────────

  /** List kill switches for a workspace */
  app.get<{ Querystring: { workspaceId: string } }>('/kill-switches', {
    schema: {
      tags: ['protection'],
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const switches = await db.select().from(killSwitches)
      .where(eq(killSwitches.workspaceId, req.query.workspaceId))
    return { switches }
  })

  /** Create or upsert a kill switch */
  app.post<{
    Body: {
      workspaceId: string
      switchType:  string
      enabled:     boolean
      reason?:     string
      enabledBy?:  string
    }
  }>('/kill-switches', {
    schema: {
      tags: ['protection'],
      body: {
        type: 'object',
        required: ['workspaceId', 'switchType', 'enabled'],
        properties: {
          workspaceId: { type: 'string' },
          switchType:  { type: 'string' },
          enabled:     { type: 'boolean' },
          reason:      { type: 'string' },
          enabledBy:   { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const { workspaceId, switchType, enabled, reason, enabledBy } = req.body
    const now = Date.now()

    const [sw] = await db.insert(killSwitches).values({
      id: uuidv7(), workspaceId, switchType, enabled,
      ...(reason    !== undefined ? { reason }    : {}),
      ...(enabledBy !== undefined ? { enabledBy } : {}),
      enabledAt:  enabled ? now : null,
      disabledAt: enabled ? null : now,
      createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [killSwitches.workspaceId, killSwitches.switchType],
      set: {
        enabled,
        ...(reason    !== undefined ? { reason }    : {}),
        ...(enabledBy !== undefined ? { enabledBy } : {}),
        enabledAt:  enabled ? now : null,
        disabledAt: enabled ? null : now,
        updatedAt: now,
      },
    }).returning()

    await emitEvent(workspaceId, enabled ? 'kill_switch.enabled' : 'kill_switch.disabled', {
      switchType, reason, enabledBy,
    })

    return { switch: sw }
  })

  /** Emergency stop — enable global kill switch */
  app.post<{ Body: { workspaceId: string; reason: string; enabledBy?: string } }>(
    '/emergency-stop',
    {
      schema: {
        tags: ['protection'],
        body: {
          type: 'object',
          required: ['workspaceId', 'reason'],
          properties: {
            workspaceId: { type: 'string' },
            reason:      { type: 'string' },
            enabledBy:   { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { workspaceId, reason, enabledBy } = req.body
      const now = Date.now()

      const [sw] = await db.insert(killSwitches).values({
        id: uuidv7(), workspaceId, switchType: 'global', enabled: true,
        reason,
        ...(enabledBy !== undefined ? { enabledBy } : {}),
        enabledAt: now, disabledAt: null,
        createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: [killSwitches.workspaceId, killSwitches.switchType],
        set: { enabled: true, reason, enabledAt: now, disabledAt: null, updatedAt: now },
      }).returning()

      await emitEvent(workspaceId, 'kill_switch.emergency_stop', { reason, enabledBy })
      return reply.code(201).send({ switch: sw, message: 'Emergency stop activated' })
    },
  )

  /** Clear emergency stop */
  app.delete<{ Querystring: { workspaceId: string } }>('/emergency-stop', {
    schema: {
      tags: ['protection'],
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const { workspaceId } = req.query
    const now = Date.now()

    await db.update(killSwitches)
      .set({ enabled: false, disabledAt: now, updatedAt: now })
      .where(and(
        eq(killSwitches.workspaceId, workspaceId),
        eq(killSwitches.switchType, 'global'),
      ))

    await emitEvent(workspaceId, 'kill_switch.emergency_stop_cleared', {})
    return { cleared: true }
  })

  /** Check if any kill switch blocks the current context */
  app.post<{
    Body: {
      workspaceId: string
      jobType?:    string
      providerId?: string
      projectId?:  string
      userId?:     string
      workflowId?: string
      queueName?:  string
    }
  }>('/kill-switches/check', {
    schema: {
      tags: ['protection'],
      body: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' },
          jobType:     { type: 'string' },
          providerId:  { type: 'string' },
          projectId:   { type: 'string' },
          userId:      { type: 'string' },
          workflowId:  { type: 'string' },
          queueName:   { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const { workspaceId, ...context } = req.body
    const rows = await db.select().from(killSwitches)
      .where(and(eq(killSwitches.workspaceId, workspaceId), eq(killSwitches.enabled, true)))
    const records: KillSwitchRecord[] = rows.map((r) => ({
      switchType: r.switchType,
      enabled:    r.enabled,
    }))
    const result = evaluateKillSwitches(records, context)
    return { result }
  })

  // ── Provider quarantine ────────────────────────────────────────────────────

  /** List active quarantines */
  app.get<{ Querystring: { workspaceId: string } }>('/quarantine', {
    schema: {
      tags: ['protection'],
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const rows = await db.select().from(providerQuarantine)
      .where(and(
        eq(providerQuarantine.workspaceId, req.query.workspaceId),
        isNull(providerQuarantine.releasedAt),
      ))
    return { quarantined: rows }
  })

  /** Quarantine a provider */
  app.post<{
    Params: { providerId: string }
    Body: {
      workspaceId:  string
      reason:       string
      releaseAfterMs?: number
    }
  }>('/quarantine/:providerId', {
    schema: {
      tags: ['protection'],
      params: {
        type: 'object',
        required: ['providerId'],
        properties: { providerId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['workspaceId', 'reason'],
        properties: {
          workspaceId:    { type: 'string' },
          reason:         { type: 'string' },
          releaseAfterMs: { type: 'number' },
        },
      },
    },
  }, async (req, reply) => {
    const { providerId } = req.params
    const { workspaceId, reason, releaseAfterMs } = req.body
    const now = Date.now()
    const releaseAt = releaseAfterMs !== undefined ? now + releaseAfterMs : null

    const [row] = await db.insert(providerQuarantine).values({
      id: uuidv7(), workspaceId, providerId, reason,
      quarantinedAt: now,
      ...(releaseAt !== null ? { releaseAt, autoRelease: true } : {}),
      createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [providerQuarantine.workspaceId, providerQuarantine.providerId],
      set: {
        reason, quarantinedAt: now, releasedAt: null, releasedBy: null,
        ...(releaseAt !== null ? { releaseAt, autoRelease: true } : { releaseAt: null, autoRelease: false }),
        updatedAt: now,
      },
    }).returning()

    await emitEvent(workspaceId, 'provider.quarantined', { providerId, reason, releaseAt })
    return reply.code(201).send({ quarantine: row })
  })

  /** Release a provider from quarantine */
  app.delete<{
    Params: { providerId: string }
    Querystring: { workspaceId: string; releasedBy?: string }
  }>('/quarantine/:providerId', {
    schema: {
      tags: ['protection'],
      params: {
        type: 'object',
        required: ['providerId'],
        properties: { providerId: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' },
          releasedBy:  { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { providerId } = req.params
    const { workspaceId, releasedBy } = req.query
    const now = Date.now()

    const rows = await db.update(providerQuarantine)
      .set({
        releasedAt: now,
        ...(releasedBy !== undefined ? { releasedBy } : {}),
        updatedAt: now,
      })
      .where(and(
        eq(providerQuarantine.workspaceId, workspaceId),
        eq(providerQuarantine.providerId, providerId),
        isNull(providerQuarantine.releasedAt),
      ))
      .returning({ id: providerQuarantine.id })

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Provider not quarantined' })
    }

    await emitEvent(workspaceId, 'provider.quarantine_released', { providerId, releasedBy })
    return { released: true }
  })

  // ── Queue pauses ───────────────────────────────────────────────────────────

  /** List queue pause states */
  app.get<{ Querystring: { workspaceId: string } }>('/queue-pauses', {
    schema: {
      tags: ['protection'],
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const rows = await db.select().from(queuePauses)
      .where(eq(queuePauses.workspaceId, req.query.workspaceId))
    return { pauses: rows }
  })

  /** Pause a queue */
  app.post<{
    Params: { queueName: string }
    Body: { workspaceId: string; reason?: string; pausedBy?: string }
  }>('/queue-pauses/:queueName/pause', {
    schema: {
      tags: ['protection'],
      params: {
        type: 'object',
        required: ['queueName'],
        properties: { queueName: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' },
          reason:      { type: 'string' },
          pausedBy:    { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const { queueName } = req.params
    const { workspaceId, reason, pausedBy } = req.body
    const now = Date.now()

    const [row] = await db.insert(queuePauses).values({
      id: uuidv7(), workspaceId, queueName, paused: true,
      ...(reason   !== undefined ? { reason }   : {}),
      ...(pausedBy !== undefined ? { pausedBy } : {}),
      pausedAt: now, resumedAt: null,
      createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [queuePauses.workspaceId, queuePauses.queueName],
      set: {
        paused: true,
        ...(reason   !== undefined ? { reason }   : {}),
        ...(pausedBy !== undefined ? { pausedBy } : {}),
        pausedAt: now, resumedAt: null, updatedAt: now,
      },
    }).returning()

    await emitEvent(workspaceId, 'queue.paused', { queueName, reason, pausedBy })
    return { pause: row }
  })

  /** Resume a queue */
  app.post<{
    Params: { queueName: string }
    Body: { workspaceId: string }
  }>('/queue-pauses/:queueName/resume', {
    schema: {
      tags: ['protection'],
      params: {
        type: 'object',
        required: ['queueName'],
        properties: { queueName: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { queueName } = req.params
    const { workspaceId } = req.body
    const now = Date.now()

    const rows = await db.update(queuePauses)
      .set({ paused: false, resumedAt: now, updatedAt: now })
      .where(and(
        eq(queuePauses.workspaceId, workspaceId),
        eq(queuePauses.queueName, queueName),
        eq(queuePauses.paused, true),
      ))
      .returning({ id: queuePauses.id })

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Queue not paused or not found' })
    }

    await emitEvent(workspaceId, 'queue.resumed', { queueName })
    return { resumed: true }
  })

  // ── Cancellation ───────────────────────────────────────────────────────────

  /** Cancel a workflow run */
  app.post<{
    Params: { runId: string }
    Body: { workspaceId: string; reason: string; cancelledBy?: string }
  }>('/cancel/run/:runId', {
    schema: {
      tags: ['protection'],
      params: {
        type: 'object',
        required: ['runId'],
        properties: { runId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['workspaceId', 'reason'],
        properties: {
          workspaceId:  { type: 'string' },
          reason:       { type: 'string' },
          cancelledBy:  { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { runId } = req.params
    const { workspaceId, reason, cancelledBy = 'api' } = req.body
    const result = await cancelWorkflowRun(runId, workspaceId, reason, cancelledBy)
    if (!result.cancelled) {
      return reply.code(404).send({ error: result.reason })
    }
    return { result }
  })

  /** Cancel an execution lease */
  app.post<{
    Params: { leaseId: string }
    Body: { workspaceId: string; reason: string }
  }>('/cancel/lease/:leaseId', {
    schema: {
      tags: ['protection'],
      params: {
        type: 'object',
        required: ['leaseId'],
        properties: { leaseId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['workspaceId', 'reason'],
        properties: {
          workspaceId: { type: 'string' },
          reason:      { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { leaseId } = req.params
    const { workspaceId, reason } = req.body
    const result = await cancelExecutionLease(leaseId, workspaceId, reason)
    if (!result.cancelled) {
      return reply.code(404).send({ error: result.reason })
    }
    return { result }
  })
}

export default protectionRoutes
