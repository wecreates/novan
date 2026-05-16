/**
 * Launch Readiness Routes
 * Prefix: /api/v1/launch
 */

import type { FastifyPluginAsync } from 'fastify'
import { v7 as uuidv7 }           from 'uuid'
import { checkReadiness }          from '../services/launch-gate.js'
import {
  startDeployment,
  approveDeployment,
  completeDeployment,
  rollbackDeployment,
  getDeployment,
  listDeployments,
} from '../services/deploy-guard.js'

const launchRoutes: FastifyPluginAsync = async (app) => {

  // GET /readiness?workspaceId=
  app.get('/readiness', {
    schema: {
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const { workspaceId } = req.query as { workspaceId: string }
    const report = await checkReadiness(workspaceId)
    return { report }
  })

  // GET /checklist?workspaceId=
  app.get('/checklist', {
    schema: {
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const { workspaceId } = req.query as { workspaceId: string }
    const report = await checkReadiness(workspaceId)
    return {
      ready:        report.ready,
      score:        report.score,
      items:        report.checks.map(c => ({ name: c.name, status: c.status, message: c.message, blocking: c.blocking })),
      blockerCount: report.blockers.length,
      warningCount: report.warnings.length,
    }
  })

  // POST /deployments
  app.post('/deployments', {
    schema: {
      body: {
        type: 'object',
        required: ['workspaceId', 'description'],
        properties: {
          workspaceId:      { type: 'string' },
          description:      { type: 'string' },
          requiresApproval: { type: 'boolean' },
          triggeredBy:      { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const body = req.body as {
      workspaceId:      string
      description:      string
      requiresApproval?: boolean
      triggeredBy?:     string
    }
    const deployment = await startDeployment({
      id:               uuidv7(),
      workspaceId:      body.workspaceId,
      description:      body.description,
      requiresApproval: body.requiresApproval ?? false,
      triggeredBy:      body.triggeredBy ?? 'api',
    })

    const statusCode = deployment.status === 'failed' ? 422 : 201
    return reply.code(statusCode).send({ deployment })
  })

  // GET /deployments?workspaceId=
  app.get('/deployments', {
    schema: {
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
    },
  }, async (req) => {
    const { workspaceId } = req.query as { workspaceId: string }
    const deployments = listDeployments(workspaceId)
    return { deployments }
  })

  // GET /deployments/:id?workspaceId=
  app.get('/deployments/:id', {
    schema: {
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
    const { id } = req.params as { id: string }
    const deployment = getDeployment(id)
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })
    return { deployment }
  })

  // POST /deployments/:id/approve
  app.post('/deployments/:id/approve', {
    schema: {
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
          approvedBy:  { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { workspaceId: string; approvedBy?: string }

    const existing = getDeployment(id)
    if (!existing) return reply.code(404).send({ error: 'Deployment not found' })
    if (existing.status !== 'pending_approval') {
      return reply.code(409).send({ error: `Cannot approve deployment in status: ${existing.status}` })
    }

    const deployment = await approveDeployment(id, body.workspaceId, body.approvedBy ?? 'unknown')
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })
    return { deployment }
  })

  // POST /deployments/:id/complete
  app.post('/deployments/:id/complete', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['workspaceId', 'success'],
        properties: {
          workspaceId: { type: 'string' },
          success:     { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { workspaceId: string; success: boolean }
    const deployment = await completeDeployment(id, body.workspaceId, body.success)
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })
    return { deployment }
  })

  // POST /deployments/:id/rollback
  app.post('/deployments/:id/rollback', {
    schema: {
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
          reason:      { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as { workspaceId: string; reason?: string }
    const deployment = await rollbackDeployment(id, body.workspaceId, body.reason ?? 'Manual rollback')
    if (!deployment) return reply.code(404).send({ error: 'Deployment not found' })
    return { deployment }
  })
}

export default launchRoutes
