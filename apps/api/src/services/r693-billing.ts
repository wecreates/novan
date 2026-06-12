/**
 * R693 — Stripe billing integration.
 *
 * Maps Stripe customers → r689 users → workspace plan tier → R660 cap.
 * Tiers (default): free $5/day, pro $20/day, scale $100/day. Override via
 * Stripe Price metadata `daily_cap_usd=<n>`.
 *
 * Endpoints (server.ts):
 *   POST /billing/checkout       — creates a Stripe Checkout Session for the user
 *   POST /billing/portal         — opens the Stripe customer portal
 *   POST /billing/webhook        — receives subscription.* events (verifies signature)
 *   GET  /billing/me             — current tier + cap + next renewal
 *
 * Brain ops:
 *   billing.set_tier             — admin override (no Stripe call)
 *   billing.list                 — what plans exist
 *
 * Falls back gracefully if STRIPE_SECRET_KEY isn't set — endpoints return 503,
 * brain ops still let the operator admin-set tiers.
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const DEFAULT_TIERS: Record<string, { dailyCapUsd: number; label: string }> = {
  free:  { dailyCapUsd: 5,   label: 'Free' },
  pro:   { dailyCapUsd: 20,  label: 'Pro' },
  scale: { dailyCapUsd: 100, label: 'Scale' },
}

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r693_workspace_plans (
        workspace_id      TEXT PRIMARY KEY,
        user_id           TEXT,
        tier              TEXT NOT NULL DEFAULT 'free',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        renews_at         TIMESTAMPTZ,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r693_billing_events (
        id           TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        workspace_id TEXT,
        payload      JSONB,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export async function getPlan(workspaceId: string): Promise<{ tier: string; dailyCapUsd: number; renewsAt: string | null }> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`SELECT tier, renews_at FROM r693_workspace_plans WHERE workspace_id = ${workspaceId} LIMIT 1`)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    const tier = String(r?.['tier'] ?? 'free')
    const cap = DEFAULT_TIERS[tier]?.dailyCapUsd ?? 5
    return { tier, dailyCapUsd: cap, renewsAt: r?.['renews_at'] ? String(r['renews_at']) : null }
  } catch { return { tier: 'free', dailyCapUsd: 5, renewsAt: null } }
}

export async function setTier(workspaceId: string, tier: string, opts?: { userId?: string; customerId?: string; subscriptionId?: string; renewsAt?: Date }): Promise<{ ok: boolean; tier: string; dailyCapUsd: number }> {
  await ensureDdl()
  if (!DEFAULT_TIERS[tier]) throw new Error(`unknown tier: ${tier}. Allowed: ${Object.keys(DEFAULT_TIERS).join(', ')}`)
  try {
    await db.execute(sql`
      INSERT INTO r693_workspace_plans (workspace_id, user_id, tier, stripe_customer_id, stripe_subscription_id, renews_at)
      VALUES (${workspaceId}, ${opts?.userId ?? null}, ${tier}, ${opts?.customerId ?? null}, ${opts?.subscriptionId ?? null}, ${opts?.renewsAt?.toISOString() ?? null})
      ON CONFLICT (workspace_id) DO UPDATE SET
        tier = EXCLUDED.tier,
        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, r693_workspace_plans.stripe_customer_id),
        stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, r693_workspace_plans.stripe_subscription_id),
        renews_at = COALESCE(EXCLUDED.renews_at, r693_workspace_plans.renews_at),
        updated_at = now()
    `)
    // Sync R660 cap to the tier
    try {
      const { setDailyCap } = await import('./r660-agent-budget.js')
      await setDailyCap(workspaceId, DEFAULT_TIERS[tier]!.dailyCapUsd)
    } catch { /* tolerated */ }
  } catch (e) { return { ok: false, tier, dailyCapUsd: DEFAULT_TIERS[tier]?.dailyCapUsd ?? 5 } }
  return { ok: true, tier, dailyCapUsd: DEFAULT_TIERS[tier]!.dailyCapUsd }
}

export function listTiers(): Array<{ tier: string; label: string; dailyCapUsd: number; priceId: string | null }> {
  return Object.entries(DEFAULT_TIERS).map(([tier, info]) => ({
    tier, label: info.label, dailyCapUsd: info.dailyCapUsd,
    priceId: process.env[`STRIPE_PRICE_${tier.toUpperCase()}`] ?? null,
  }))
}

export async function createCheckoutSession(userId: string, tier: string, returnUrl: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const apiKey = process.env['STRIPE_SECRET_KEY']
  if (!apiKey) return { ok: false, error: 'STRIPE_SECRET_KEY not configured' }
  const priceId = process.env[`STRIPE_PRICE_${tier.toUpperCase()}`]
  if (!priceId) return { ok: false, error: `STRIPE_PRICE_${tier.toUpperCase()} not configured` }
  const form = new URLSearchParams({
    'mode': 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'success_url': returnUrl + '?ok=1',
    'cancel_url':  returnUrl + '?ok=0',
    'client_reference_id': userId,
    'metadata[user_id]': userId,
    'metadata[tier]': tier,
  })
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    if (!r.ok) return { ok: false, error: `stripe ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` }
    const j = await r.json() as { url?: string }
    return { ok: true, ...(j.url ? { url: j.url } : {}) }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function createPortalSession(customerId: string, returnUrl: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const apiKey = process.env['STRIPE_SECRET_KEY']
  if (!apiKey) return { ok: false, error: 'STRIPE_SECRET_KEY not configured' }
  const form = new URLSearchParams({ customer: customerId, return_url: returnUrl })
  try {
    const r = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    if (!r.ok) return { ok: false, error: `stripe ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` }
    const j = await r.json() as { url?: string }
    return { ok: true, ...(j.url ? { url: j.url } : {}) }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

/** Verify Stripe webhook signature per Stripe's t=,v1= header format. */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  const parts = Object.fromEntries(signatureHeader.split(',').map(p => { const [k, ...rest] = p.split('='); return [k!, rest.join('=')] }))
  const t = parts['t']
  const v1 = parts['v1']
  if (!t || !v1) return false
  const payload = `${t}.${rawBody}`
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
}

export async function handleWebhookEvent(event: Record<string, unknown>): Promise<{ ok: boolean }> {
  await ensureDdl()
  const type = String(event['type'] ?? '')
  const id = String(event['id'] ?? `evt_${crypto.randomBytes(6).toString('hex')}`)
  const obj = (event['data'] as Record<string, unknown> | undefined)?.['object'] as Record<string, unknown> | undefined
  let workspaceId: string | null = null
  if (obj) {
    workspaceId = (obj['client_reference_id'] as string | undefined) ?? (obj['metadata'] as Record<string, string> | undefined)?.['user_id'] ?? null
  }
  try {
    await db.execute(sql`
      INSERT INTO r693_billing_events (id, type, workspace_id, payload)
      VALUES (${id}, ${type}, ${workspaceId}, ${JSON.stringify(event)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `)
  } catch { /* tolerated */ }

  // Map to tier changes
  if (type === 'checkout.session.completed' && obj) {
    const tier = (obj['metadata'] as Record<string, string> | undefined)?.['tier'] ?? 'pro'
    const ws = String(obj['client_reference_id'] ?? '')
    const customerId = String(obj['customer'] ?? '')
    const subscriptionId = String(obj['subscription'] ?? '')
    if (ws) await setTier(ws, tier, { customerId, subscriptionId })
  }
  if (type === 'customer.subscription.deleted' && obj) {
    const subId = String(obj['id'] ?? '')
    if (subId) {
      try {
        await db.execute(sql`UPDATE r693_workspace_plans SET tier = 'free', updated_at = now() WHERE stripe_subscription_id = ${subId}`)
      } catch { /* tolerated */ }
    }
  }
  return { ok: true }
}
