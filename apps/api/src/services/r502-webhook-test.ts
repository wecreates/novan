/**
 * R502 — Webhook receipt self-test.
 *
 * Operator clicks a dashboard button. Server simulates the Gumroad ping
 * locally (hits its own /api/v1/webhooks/gumroad/sale endpoint with a fake
 * sale that has a __synthetic__ flag in the metadata so R374 doesn't fire
 * variant generation). Returns whether the round-trip worked.
 *
 * This lets operator confirm the URL + token + form-parser + DB INSERT
 * path all work BEFORE waiting on a real sale.
 */
import { v7 as uuidv7 } from 'uuid'

export interface WebhookTestResult {
  ok:           boolean
  httpStatus:   number
  body:         string
  syntheticId:  string
}

export async function selfTestGumroadWebhook(): Promise<WebhookTestResult> {
  const token = process.env['GUMROAD_WEBHOOK_TOKEN']
  if (!token) return { ok: false, httpStatus: 0, body: 'GUMROAD_WEBHOOK_TOKEN not configured', syntheticId: '' }
  const port = process.env['PORT'] ?? '3001'
  const syntheticId = `__synthetic_test__${uuidv7().slice(0, 12)}`
  const params = new URLSearchParams({
    sale_id:           syntheticId,
    product_permalink: 'https://example.invalid/__synthetic_test__',
    product_name:      'R502 self-test (do not ship)',
    price:             '0',
    test:              'true',       // R389 honors test=true and returns 202 without persisting
  })
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/webhooks/gumroad/sale?token=${encodeURIComponent(token)}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    })
    const body = await res.text()
    return { ok: res.status === 202 || res.status === 200, httpStatus: res.status, body: body.slice(0, 400), syntheticId }
  } catch (e) {
    return { ok: false, httpStatus: 0, body: (e as Error).message, syntheticId }
  }
}
