/**
 * Billing Routes — /api/v1/billing
 *
 * Plans       : GET /plans
 * Subscription: GET /subscription  POST /subscription  POST /subscription/cancel  POST /plan/change
 * Usage       : GET /usage  POST /usage/record  POST /usage/check-limit
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  listPlans, ensureDefaultPlans, getSubscription, createSubscription,
  updateSubscriptionStatus, changePlan, getUsage, recordUsage, assertWithinLimit,
}                          from '../services/billing.js'
import type { MeterKey }   from '../services/billing.js'

const billingRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get('/plans', async () => {
    await ensureDefaultPlans()
    const data = await listPlans()
    return { success: true, data }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/subscription', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await getSubscription(ws)
    return { success: true, data }
  })

  fastify.post<{
    Body: { workspace_id?: string; plan_id?: string; trial_days?: number; stripe_customer_id?: string }
  }>('/subscription', async (req, reply) => {
    const { workspace_id, plan_id, trial_days, stripe_customer_id } = req.body
    if (!workspace_id || !plan_id) {
      return reply.code(400).send({ success: false, error: 'workspace_id, plan_id required' })
    }
    await ensureDefaultPlans()
    const input: Parameters<typeof createSubscription>[0] = {
      workspaceId: workspace_id, planId: plan_id,
    }
    if (trial_days !== undefined) input.trialDays = trial_days
    if (stripe_customer_id) input.stripeCustomerId = stripe_customer_id
    const id = await createSubscription(input)
    return { success: true, data: { subscriptionId: id } }
  })

  fastify.post<{
    Body: { subscription_id?: string; note?: string }
  }>('/subscription/cancel', async (req, reply) => {
    const id = req.body.subscription_id
    if (!id) return reply.code(400).send({ success: false, error: 'subscription_id required' })
    await updateSubscriptionStatus(id, 'canceled', req.body.note)
    return { success: true, data: { canceled: true } }
  })

  fastify.post<{
    Body: { workspace_id?: string; plan_id?: string }
  }>('/plan/change', async (req, reply) => {
    const { workspace_id, plan_id } = req.body
    if (!workspace_id || !plan_id) {
      return reply.code(400).send({ success: false, error: 'workspace_id, plan_id required' })
    }
    try {
      await changePlan(workspace_id, plan_id)
      return { success: true, data: { changed: true } }
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/usage', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await getUsage(ws)
    return { success: true, data }
  })

  fastify.post<{
    Body: { workspace_id?: string; meter_key?: MeterKey; amount?: number }
  }>('/usage/record', async (req, reply) => {
    const { workspace_id, meter_key, amount } = req.body
    if (!workspace_id || !meter_key || amount === undefined) {
      return reply.code(400).send({ success: false, error: 'workspace_id, meter_key, amount required' })
    }
    await recordUsage(workspace_id, meter_key, amount)
    return { success: true, data: { recorded: true } }
  })

  fastify.post<{
    Body: { workspace_id?: string; meter_key?: MeterKey; attempting?: number }
  }>('/usage/check-limit', async (req, reply) => {
    const { workspace_id, meter_key, attempting } = req.body
    if (!workspace_id || !meter_key) {
      return reply.code(400).send({ success: false, error: 'workspace_id, meter_key required' })
    }
    const result = await assertWithinLimit(workspace_id, meter_key, attempting ?? 0)
    return { success: true, data: result }
  })
}

export default billingRoutes
