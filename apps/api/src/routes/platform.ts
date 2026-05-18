/**
 * Platform hardening routes — /api/v1/platform/*
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  runRetention, recentRetentionRuns, cronHealthCheck,
  registerWebhookSecret, getSetupSnapshot, markSetupStep,
} from '../services/platform-hardening.js'

const platformRoutes: FastifyPluginAsync = async (fastify) => {

  // Data retention
  fastify.post<{ Body: { workspace_id?: string } }>('/retention/run', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await runRetention(ws) }
  })
  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/retention/log', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentRetentionRuns(ws, req.query.limit ? Number(req.query.limit) : 30) }
  })

  // Cron health
  fastify.get<{ Querystring: { hours?: string } }>('/cron-health', async (req) => {
    return { success: true, data: await cronHealthCheck(req.query.hours ? Number(req.query.hours) : 24) }
  })

  // Webhook secrets
  fastify.post<{ Body: { workspace_id?: string; channel?: string; secret?: string } }>('/webhook-secrets', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.channel || !b.secret) return reply.code(400).send({ success: false, error: 'workspace_id, channel, secret required' })
    if (b.secret.length < 16) return reply.code(400).send({ success: false, error: 'secret must be ≥16 chars' })
    const id = await registerWebhookSecret(b.workspace_id, b.channel, b.secret)
    return reply.code(201).send({ success: true, data: { id, note: 'Store the secret in env as {CHANNEL}_WEBHOOK_SECRET to enable verification.' } })
  })

  // Setup state / onboarding
  fastify.get<{ Querystring: { workspace_id?: string } }>('/setup', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await getSetupSnapshot(ws) }
  })
  fastify.post<{ Body: { workspace_id?: string; step?: string } }>('/setup/mark', async (req, reply) => {
    const { workspace_id, step } = req.body
    if (!workspace_id || !step) return reply.code(400).send({ success: false, error: 'workspace_id, step required' })
    const allowed = ['firstProviderAt', 'firstChatAt', 'firstActionAt', 'firstHorizonAt', 'firstProposalAt', 'firstRevenueAt'] as const
    if (!allowed.includes(step as typeof allowed[number])) return reply.code(400).send({ success: false, error: `step must be one of ${allowed.join(', ')}` })
    await markSetupStep(workspace_id, step as typeof allowed[number])
    return { success: true }
  })
}

export default platformRoutes
