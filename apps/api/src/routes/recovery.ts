/**
 * Recovery Routes
 *
 * Workflow checkpoints, disaster recovery, and replay engine.
 *
 * Prefix: /api/v1/recovery
 */

import type { FastifyPluginAsync } from 'fastify'
import {
  createCheckpoint, listCheckpoints,
  restoreCheckpoint, deleteCheckpoint, pruneOldCheckpoints,
} from '../services/checkpoint-manager.js'
import { runDisasterRecovery }    from '../services/disaster-recovery.js'
import {
  startReplay, getReplayRun, listReplayRuns,
} from '../services/replay-engine.js'

// ─── Plugin ───────────────────────────────────────────────────────────────────

const recoveryRoutes: FastifyPluginAsync = async (app) => {

  // ── Checkpoints ────────────────────────────────────────────────────────────

  /** List checkpoints for a run */
  app.get<{
    Params:      { runId: string }
    Querystring: { workspaceId: string }
  }>('/checkpoints/:runId', {
    schema: {
      tags: ['recovery'],
      params: {
        type: 'object',
        required: ['runId'],
        properties: { runId: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const checkpoints = await listCheckpoints(req.params.runId, req.query.workspaceId)
    return { checkpoints }
  })

  /** Create a checkpoint */
  app.post<{
    Body: {
      workspaceId:    string
      runId:          string
      stepId:         string
      traceId:        string
      completedSteps: string[]
      state:          Record<string, unknown>
      snapshotId?:    string
    }
  }>('/checkpoints', {
    schema: {
      tags: ['recovery'],
      body: {
        type: 'object',
        required: ['workspaceId', 'runId', 'stepId', 'traceId', 'completedSteps', 'state'],
        properties: {
          workspaceId:    { type: 'string' },
          runId:          { type: 'string' },
          stepId:         { type: 'string' },
          traceId:        { type: 'string' },
          completedSteps: { type: 'array', items: { type: 'string' } },
          state:          { type: 'object' },
          snapshotId:     { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const checkpoint = await createCheckpoint(req.body)
    return reply.code(201).send({ checkpoint })
  })

  /** Restore a checkpoint */
  app.post<{
    Params: { id: string }
    Body:   { workspaceId: string; restoredBy?: string }
  }>('/checkpoints/:id/restore', {
    schema: {
      tags: ['recovery'],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' },
          restoredBy:  { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const checkpoint = await restoreCheckpoint(
      req.params.id,
      req.body.workspaceId,
      req.body.restoredBy ?? 'api',
    )
    if (!checkpoint) {
      return reply.code(404).send({ error: 'Checkpoint not found' })
    }
    return { checkpoint }
  })

  /** Delete a checkpoint */
  app.delete<{
    Params:      { id: string }
    Querystring: { workspaceId: string }
  }>('/checkpoints/:id', {
    schema: {
      tags: ['recovery'],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const deleted = await deleteCheckpoint(req.params.id, req.query.workspaceId)
    if (!deleted) {
      return reply.code(404).send({ error: 'Checkpoint not found' })
    }
    return { deleted: true }
  })

  /** Prune old checkpoints */
  app.post<{
    Body: { workspaceId: string; maxAgeMs?: number }
  }>('/checkpoints/prune', {
    schema: {
      tags: ['recovery'],
      body: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' },
          maxAgeMs:    { type: 'number' },
        },
      },
    },
  }, async (req) => {
    const count = await pruneOldCheckpoints(
      req.body.workspaceId,
      req.body.maxAgeMs ?? 7 * 24 * 60 * 60_000,  // default: 7 days
    )
    return { pruned: count }
  })

  // ── Disaster recovery ──────────────────────────────────────────────────────

  /** Run disaster recovery for a workspace */
  app.post<{ Body: { workspaceId: string } }>('/disaster-recovery/run', {
    schema: {
      tags: ['recovery'],
      body: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const report = await runDisasterRecovery(req.body.workspaceId)
    return { report }
  })

  // ── Replay engine ──────────────────────────────────────────────────────────

  /** List replay runs */
  app.get<{
    Querystring: { workspaceId: string; sourceRunId?: string }
  }>('/replay-runs', {
    schema: {
      tags: ['recovery'],
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' },
          sourceRunId: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const runs = await listReplayRuns(req.query.workspaceId, req.query.sourceRunId)
    return { runs }
  })

  /** Start a replay */
  app.post<{
    Body: {
      workspaceId:   string
      sourceRunId:   string
      checkpointId?: string
    }
  }>('/replay-runs', {
    schema: {
      tags: ['recovery'],
      body: {
        type: 'object',
        required: ['workspaceId', 'sourceRunId'],
        properties: {
          workspaceId:   { type: 'string' },
          sourceRunId:   { type: 'string' },
          checkpointId:  { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    try {
      const result = await startReplay(req.body)
      return reply.code(201).send({ result })
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  /** Get a replay run with its divergences */
  app.get<{
    Params:      { id: string }
    Querystring: { workspaceId: string }
  }>('/replay-runs/:id', {
    schema: {
      tags: ['recovery'],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { run, divergences } = await getReplayRun(req.params.id, req.query.workspaceId)
    if (!run) {
      return reply.code(404).send({ error: 'Replay run not found' })
    }
    return { run, divergences }
  })
}

export default recoveryRoutes
