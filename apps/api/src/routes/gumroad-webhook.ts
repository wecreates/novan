/**
 * R389 — Gumroad sale webhook receiver.
 *
 * Configure once in Gumroad: Settings → Advanced → Ping URL:
 *   https://137-184-198-2.sslip.io/api/v1/webhooks/gumroad/sale?token=<GUMROAD_WEBHOOK_TOKEN>
 *
 * Gumroad POSTs form-encoded fields on every sale. We persist via the same
 * path as R367 (business_revenue upsert by external_sale_id), then fire
 * R374.reactToNewSales for instant variant generation.
 *
 * Real-time replaces R367's hourly poll for any operator who configures it.
 * Polling stays as backup for missed webhooks.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

interface GumroadPingBody {
  sale_id?:           string
  product_permalink?: string
  product_name?:      string
  price?:             string                    // cents
  email?:             string
  refunded?:          string
  test?:              string
  seller_id?:         string                    // R420 — verified against GUMROAD_SELLER_ID
  workspace_id?:      string                    // optional override; defaults to 'default'
}

export async function registerGumroadWebhook(app: FastifyInstance): Promise<void> {
  // Gumroad sends application/x-www-form-urlencoded; register a parser locally
  // since this is the only public route in the app that needs it.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      try {
        const params = new URLSearchParams(String(body))
        const obj: Record<string, string> = {}
        for (const [k, v] of params.entries()) obj[k] = v
        done(null, obj)
      } catch (e) { done(e as Error, undefined) }
    })
  }

  app.post('/api/v1/webhooks/gumroad/sale', async (req: FastifyRequest<{ Body: GumroadPingBody; Querystring: { token?: string } }>, reply) => {
    // Token check
    const expected = process.env['GUMROAD_WEBHOOK_TOKEN']
    if (!expected) return reply.code(503).send({ error: 'GUMROAD_WEBHOOK_TOKEN not configured' })
    if ((req.query.token ?? '') !== expected) return reply.code(401).send({ error: 'invalid token' })

    // R420 — if GUMROAD_SELLER_ID is configured, also verify the seller_id
    // field. Protects against token leak being used by anyone with the URL.
    const expectedSeller = process.env['GUMROAD_SELLER_ID']
    if (expectedSeller && String((req.body ?? {}).seller_id ?? '') !== expectedSeller) {
      return reply.code(403).send({ error: 'seller_id mismatch' })
    }
    // R430 — optional IP allowlist. GUMROAD_ALLOWED_IPS comma-separated.
    // Honors X-Forwarded-For trustProxy behavior. Skip if not configured.
    const allowedIps = process.env['GUMROAD_ALLOWED_IPS']
    if (allowedIps) {
      const allowed = allowedIps.split(',').map(s => s.trim()).filter(Boolean)
      const reqIp = req.ip
      if (!allowed.includes(reqIp)) {
        return reply.code(403).send({ error: `ip ${reqIp} not allowlisted` })
      }
    }

    const body = req.body ?? {}
    const saleId   = String(body.sale_id ?? '').trim()
    // R431 — normalize permalink so R367 polling + R389 webhook don't
    // double-count by trailing-slash/protocol mismatch.
    const permalink = String(body.product_permalink ?? '').trim()
      .replace(/^http:\/\//i, 'https://')
      .replace(/\/$/, '')
      .toLowerCase()
    const priceCents = Math.max(0, Math.round(Number(body.price ?? 0)))
    const productName = String(body.product_name ?? '').slice(0, 200)
    if (!saleId || !permalink) {
      return reply.code(400).send({ error: 'missing sale_id or product_permalink' })
    }
    if (body.refunded === 'true' || body.test === 'true') {
      return reply.code(202).send({ ok: true, ignored: body.refunded === 'true' ? 'refund' : 'test' })
    }

    const workspaceId = String(body.workspace_id ?? 'default').slice(0, 64)
    const netUsd = priceCents / 100

    // Persist (idempotent on external_sale_id)
    try {
      await db.execute(sql`
        INSERT INTO business_revenue
          (id, workspace_id, external_sale_id, source, net_usd, currency, metadata, recorded_at)
        VALUES
          (${uuidv7()}, ${workspaceId}, ${saleId}, 'gumroad', ${netUsd}, 'USD',
           ${JSON.stringify({ permalink, productName, via: 'webhook' })}::jsonb, ${Date.now()})
        ON CONFLICT (workspace_id, external_sale_id) WHERE external_sale_id IS NOT NULL DO NOTHING
      `)
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }

    // R521 — feed price-experiment bandit. productKey = permalink for now.
    try {
      const { markSale } = await import('../services/r521-price-thompson.js')
      await markSale(workspaceId, permalink, priceCents)
    } catch { /* tolerated */ }

    // R518 — R517 buyer-email opt-in capture. Gumroad sends `email` +
    // `can_contact` ('true' string when buyer ticked the marketing-OK box).
    // Strict consent gate: no consent → no store.
    try {
      const email = String((body as Record<string, unknown>)['email'] ?? '').trim()
      const canContact = String((body as Record<string, unknown>)['can_contact'] ?? '').toLowerCase() === 'true'
      if (email && canContact) {
        const { captureOptIn } = await import('../services/r517-buyer-email-optin.js')
        await captureOptIn(workspaceId, email, 'gumroad', true)
      }
    } catch { /* tolerated */ }

    // Fire variant generation for the winner — but only if autonomy isn't
    // killed for this workspace. R458 — webhook respects R443 gate too.
    try {
      const { isAutonomyAllowed } = await import('../services/r443-autonomy-gate.js')
      if (await isAutonomyAllowed(workspaceId)) {
        const { reactToNewSales } = await import('../services/r374-winner-variant-generator.js')
        void reactToNewSales(workspaceId, [saleId])    // fire-and-forget
      }
    } catch { /* tolerated */ }

    // Tier-transition check
    try {
      const { classifyTier, nextMilestone } = await import('../services/r350-goal-ladder.js')
      const sumRows = await db.execute(sql`
        SELECT COALESCE(SUM(net_usd), 0) AS total FROM business_revenue
        WHERE workspace_id = ${workspaceId} AND recorded_at >= ${Date.now() - 30 * 24 * 60 * 60_000}
      `)
      const mrr = Number((sumRows as Array<{ total: number }>)[0]?.total ?? 0)
      const tier = classifyTier(mrr)
      const ms = nextMilestone(mrr)
      void tier; void ms     // values published as events from R367; webhook just persists
    } catch { /* tolerated */ }

    // Emit event for dashboard
    try {
      await db.execute(sql`
        INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
        VALUES (${uuidv7()}, 'gumroad.sale_webhook', ${workspaceId},
          ${JSON.stringify({ saleId, permalink, priceCents, productName })}::jsonb,
          ${uuidv7()}, ${uuidv7()}, ${'r389-gumroad-webhook'}, 1, ${Date.now()})
      `)
    } catch { /* tolerated */ }

    return reply.code(200).send({ ok: true, saleId, persisted: true, variantTriggered: true })
  })
}
