/**
 * Webhook routes — inbound webhook trigger management.
 *
 * POST /api/v1/webhooks              — create webhook endpoint
 * GET  /api/v1/webhooks              — list webhooks
 * GET  /api/v1/webhooks/:id          — get webhook + recent deliveries
 * PUT  /api/v1/webhooks/:id          — update
 * DELETE /api/v1/webhooks/:id        — delete
 * POST /api/v1/webhooks/:id/trigger  — inbound trigger (no auth required, uses HMAC)
 * POST /api/v1/webhooks/:id/rotate-secret — rotate HMAC secret
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                       from 'zod'
import { v7 as uuidv7 }            from 'uuid'
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { eq, and, desc }           from 'drizzle-orm'
import { db }                      from '../db/client.js'
import { webhooks, webhookDeliveries, workflowDefinitions, workflowRuns, events } from '../db/schema.js'
import { queues }                  from '../queues/index.js'

const createSchema = z.object({
  name:       z.string().min(1).max(200),
  events:     z.array(z.string()).default([]),
  workflowId: z.string().optional(),
})

function generateSecret(): string {
  return 'whsec_' + randomBytes(32).toString('hex')
}

function verifySignature(payload: string, secret: string, signature: string): boolean {
  try {
    const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex')
    // R146.33 — constant-time compare. The previous `expected === signature`
    // short-circuited at the first byte mismatch, leaking the HMAC byte-by-byte
    // via response timing. Length pre-check is required because timingSafeEqual
    // throws on length mismatch (and a length mismatch is itself a clear reject).
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(signature, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export const webhooksRoutes: FastifyPluginAsync = async (app) => {
  const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

  // Create webhook
  app.post('/', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message })
    const d = parsed.data
    const workspaceId = ws(req)
    const id = uuidv7()
    const now = Date.now()
    const secret = generateSecret()
    await db.insert(webhooks).values({
      id, workspaceId, name: d.name, secret, events: d.events,
      ...(d.workflowId ? { workflowId: d.workflowId } : {}),
      createdAt: now, updatedAt: now,
    })
    const [created] = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1)
    return reply.status(201).send({ success: true, data: { ...created, secret } })  // Return secret once on create
  })

  // List
  app.get('/', async (req, reply) => {
    const workspaceId = ws(req)
    const rows = await db.select().from(webhooks)
      .where(eq(webhooks.workspaceId, workspaceId))
      .orderBy(desc(webhooks.createdAt))
      .limit(50)
    return reply.send({ success: true, data: rows.map((r) => ({ ...r, secret: undefined })), meta: { count: rows.length } })
  })

  // Detail + deliveries
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [wh] = await db.select().from(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.workspaceId, workspaceId))).limit(1)
    if (!wh) return reply.status(404).send({ error: 'Webhook not found' })
    const deliveries = await db.select().from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, id)).orderBy(desc(webhookDeliveries.createdAt)).limit(20)
    return reply.send({ success: true, data: { ...wh, secret: undefined, deliveries } })
  })

  // Update
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const parsed = createSchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message })
    const d = parsed.data
    const now = Date.now()
    const updateFields: Record<string, unknown> = { updatedAt: now }
    if (d.name    !== undefined) updateFields['name']       = d.name
    if (d.events  !== undefined) updateFields['events']     = d.events
    if (d.workflowId !== undefined) updateFields['workflowId'] = d.workflowId
    await db.update(webhooks).set(updateFields).where(and(eq(webhooks.id, id), eq(webhooks.workspaceId, workspaceId)))
    const [updated] = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1)
    return reply.send({ success: true, data: { ...updated, secret: undefined } })
  })

  // Delete
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await db.delete(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.workspaceId, ws(req))))
    return reply.send({ success: true })
  })

  // Rotate secret
  app.post('/:id/rotate-secret', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const newSecret = generateSecret()
    await db.update(webhooks).set({ secret: newSecret, updatedAt: Date.now() }).where(and(eq(webhooks.id, id), eq(webhooks.workspaceId, workspaceId)))
    return reply.send({ success: true, data: { secret: newSecret } })
  })

  // Inbound trigger — no auth, uses HMAC
  app.post('/:id/trigger', { config: { skipAuth: true } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const [wh] = await db.select().from(webhooks).where(and(eq(webhooks.id, id), eq(webhooks.active, true))).limit(1)
    if (!wh) return reply.status(404).send({ error: 'Webhook not found' })

    // SECURITY: HMAC verification is now REQUIRED. Previously it was
    // "verify if signature header present" — attacker could just omit
    // the header and bypass verification entirely.
    // Operators can opt out per-webhook by setting wh.secret to an empty
    // string (e.g. for testing webhooks from a trusted internal source).
    if (wh.secret) {
      const sig = (req.headers['x-webhook-signature'] ?? req.headers['x-hub-signature-256']) as string | undefined
      if (!sig) {
        return reply.status(401).send({ error: 'signature required: send x-webhook-signature or x-hub-signature-256' })
      }
      const rawBody = JSON.stringify(req.body)
      if (!verifySignature(rawBody, wh.secret, sig)) {
        return reply.status(401).send({ error: 'Invalid signature' })
      }
    }

    const payload = (req.body ?? {}) as Record<string, unknown>
    const eventType = (payload['type'] as string | undefined) ?? 'webhook.received'
    const deliveryId = uuidv7()
    const now = Date.now()

    // Record delivery
    await db.insert(webhookDeliveries).values({
      id: deliveryId, webhookId: id, workspaceId: wh.workspaceId,
      eventType, payload, createdAt: now,
    })

    // Update call count
    await db.update(webhooks).set({ callCount: wh.callCount + 1, lastCalledAt: now, updatedAt: now }).where(eq(webhooks.id, id))

    // If workflow configured, trigger it
    let runId: string | undefined
    if (wh.workflowId) {
      // Find workflow
      const [wfDef] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, wh.workflowId)).limit(1)
      if (wfDef) {
        runId = uuidv7()
        const traceId = uuidv7()
        await db.insert(workflowRuns).values({
          id: runId, workflowId: wh.workflowId, workspaceId: wh.workspaceId,
          triggeredBy: `webhook:${id}`, triggeredAt: now, traceId,
          context: { webhookDeliveryId: deliveryId, payload },
        })
        await queues['workflow'].add('execute-workflow', { runId, workflowId: wh.workflowId, workspaceId: wh.workspaceId, traceId }, { jobId: runId })
        // Update delivery status
        await db.update(webhookDeliveries).set({ status: 'triggered', runId }).where(eq(webhookDeliveries.id, deliveryId))
      }
    } else {
      // Emit as event
      await db.insert(events).values({
        id: uuidv7(), type: eventType, workspaceId: wh.workspaceId, payload,
        traceId: uuidv7(), correlationId: deliveryId, causationId: null,
        source: `webhook:${id}`, version: 1, createdAt: now,
      }).catch((e: Error) => { console.error('[webhooks]', e.message); return null })
      await db.update(webhookDeliveries).set({ status: 'processed' }).where(eq(webhookDeliveries.id, deliveryId))
    }

    return reply.send({ success: true, data: { deliveryId, ...(runId ? { runId } : {}) } })
  })
}
