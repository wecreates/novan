/**
 * R536 — TikTok Shop sale webhook.
 *
 * Symmetric to gumroad-webhook.ts: receives order events from TikTok
 * Shop Partner Center webhooks, persists into business_revenue,
 * advances R350 tier classification, feeds R521 bandit, captures
 * buyer opt-ins for R517 (only when buyer explicitly consented).
 *
 * URL:
 *   https://137-184-198-2.sslip.io/api/v1/webhooks/tiktok/order?token=<TIKTOK_WEBHOOK_TOKEN>
 *
 * Env:
 *   TIKTOK_WEBHOOK_TOKEN           required — shared secret in query
 *   TIKTOK_WEBHOOK_HMAC_SECRET     optional — verify x-tiktok-signature
 *
 * Body shape (TikTok Shop OPEN_API_ORDER_PAID, simplified):
 *   {
 *     order_id, shop_id, seller_id,
 *     order_status, total_amount, currency, refund_amount,
 *     buyer_email?, marketing_opt_in?
 *   }
 */
import { sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import { createHmac, timingSafeEqual } from 'node:crypto'

interface TikTokPing {
  order_id?:         string
  shop_id?:          string
  seller_id?:        string
  order_status?:     string         // 'PAID' | 'REFUNDED' | 'CANCELLED' | etc.
  total_amount?:     string | number    // major units (USD)
  currency?:         string
  refund_amount?:    string | number
  buyer_email?:      string
  marketing_opt_in?: boolean | string
  workspace_id?:     string
  test?:             boolean | string
  product_name?:     string
  product_id?:       string
}

export async function registerTikTokWebhook(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/webhooks/tiktok/order', async (req: FastifyRequest<{ Body: TikTokPing; Querystring: { token?: string } }>, reply) => {
    const expected = process.env['TIKTOK_WEBHOOK_TOKEN']
    if (!expected) return reply.code(503).send({ error: 'TIKTOK_WEBHOOK_TOKEN not configured' })
    if ((req.query.token ?? '') !== expected) return reply.code(401).send({ error: 'invalid token' })

    // Optional HMAC verification via x-tiktok-signature header
    const hmacSecret = process.env['TIKTOK_WEBHOOK_HMAC_SECRET']
    if (hmacSecret) {
      const sig = String(req.headers['x-tiktok-signature'] ?? '')
      const raw = JSON.stringify(req.body ?? {})
      const expectedSig = createHmac('sha256', hmacSecret).update(raw).digest('hex')
      if (sig.length !== expectedSig.length ||
          !timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expectedSig, 'utf8'))) {
        return reply.code(403).send({ error: 'hmac mismatch' })
      }
    }

    const body = req.body ?? {}
    if (body.test === 'true' || body.test === true) {
      return reply.code(202).send({ ok: true, ignored: 'test' })
    }
    const orderId = String(body.order_id ?? '').trim()
    if (!orderId) return reply.code(400).send({ error: 'missing order_id' })

    const workspaceId = String(body.workspace_id ?? 'default').slice(0, 64)
    const productKey = `tiktok_shop:${String(body.shop_id ?? '')}:${String(body.product_id ?? body.product_name ?? 'unknown')}`
    const status = String(body.order_status ?? 'PAID').toUpperCase()

    // Refund branch — symmetric to R522 Gumroad refund.
    if (status === 'REFUNDED' || status === 'CANCELLED') {
      const refundAmount = Number(body.refund_amount ?? body.total_amount ?? 0) || 0
      try {
        await db.execute(sql`
          UPDATE business_revenue
          SET metadata = jsonb_set(metadata, '{refunded_at}', to_jsonb(${Date.now()}::bigint), true)
          WHERE workspace_id = ${workspaceId} AND external_sale_id = ${orderId}
        `).catch(() => {/* tolerated */})
        await db.execute(sql`
          INSERT INTO business_revenue
            (id, workspace_id, external_sale_id, source, net_usd, currency, metadata, recorded_at)
          VALUES
            (${uuidv7()}, ${workspaceId}, ${'refund:' + orderId}, 'tiktok_shop',
             ${-refundAmount}, ${String(body.currency ?? 'USD').toUpperCase()},
             ${JSON.stringify({ productKey, refundOf: orderId, via: 'webhook_refund' })}::jsonb,
             ${Date.now()})
          ON CONFLICT (workspace_id, external_sale_id) WHERE external_sale_id IS NOT NULL DO NOTHING
        `).catch(() => {/* tolerated */})
      } catch { /* tolerated */ }
      try {
        const { unmarkSale } = await import('../services/r521-price-thompson.js')
        await unmarkSale(workspaceId, productKey, Math.round(refundAmount * 100))
      } catch { /* tolerated */ }
      return reply.code(200).send({ ok: true, refunded: orderId, correctedUsd: -refundAmount })
    }

    // PAID branch — persist sale.
    const netUsd = Number(body.total_amount ?? 0) || 0
    const priceCents = Math.max(0, Math.round(netUsd * 100))

    try {
      await db.execute(sql`
        INSERT INTO business_revenue
          (id, workspace_id, external_sale_id, source, net_usd, currency, metadata, recorded_at)
        VALUES
          (${uuidv7()}, ${workspaceId}, ${orderId}, 'tiktok_shop',
           ${netUsd}, ${String(body.currency ?? 'USD').toUpperCase()},
           ${JSON.stringify({ productKey, productName: body.product_name, via: 'webhook' })}::jsonb,
           ${Date.now()})
        ON CONFLICT (workspace_id, external_sale_id) WHERE external_sale_id IS NOT NULL DO NOTHING
      `)
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message })
    }

    // R443-gated variant generation
    try {
      const { isAutonomyAllowed } = await import('../services/r443-autonomy-gate.js')
      if (await isAutonomyAllowed(workspaceId)) {
        const { reactToNewSales } = await import('../services/r374-winner-variant-generator.js')
        void reactToNewSales(workspaceId, [orderId])
      }
    } catch { /* tolerated */ }

    // R521 bandit win
    try {
      const { markSale } = await import('../services/r521-price-thompson.js')
      await markSale(workspaceId, productKey, priceCents)
    } catch { /* tolerated */ }

    // R517 buyer-email opt-in (strict consent)
    try {
      const email = String(body.buyer_email ?? '').trim()
      const canContact = body.marketing_opt_in === true || body.marketing_opt_in === 'true'
      if (email && canContact) {
        const { captureOptIn } = await import('../services/r517-buyer-email-optin.js')
        await captureOptIn(workspaceId, email, 'tiktok_shop', true)
      }
    } catch { /* tolerated */ }

    try {
      await db.execute(sql`
        INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
        VALUES (${uuidv7()}, 'tiktok.sale_webhook', ${workspaceId},
          ${JSON.stringify({ orderId, netUsd, productKey })}::jsonb,
          ${uuidv7()}, ${uuidv7()}, 'r536-tiktok-webhook', 1, ${Date.now()})
      `).catch(() => {/* tolerated */})
    } catch { /* tolerated */ }

    return reply.code(200).send({ ok: true, orderId, persisted: true, variantTriggered: true })
  })
}
