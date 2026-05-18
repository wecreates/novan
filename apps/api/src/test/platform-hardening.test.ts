/**
 * Tests for platform-hardening.ts — webhook signature verification.
 *
 * Pure crypto + env-var paths. No DB needed for the verification path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'

vi.mock('../db/client.js', () => {
  const chain = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (resolve: (v: unknown) => unknown) => resolve([])
      if (prop === 'catch') return () => chain
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
})
vi.mock('../services/notifications.js', () => ({ notify: async () => ({ sent: [], skipped: [], failed: [], rateLimited: false }) }))

import { verifyWebhookSignature } from '../services/platform-hardening.js'

describe('platform-hardening: verifyWebhookSignature', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => { delete process.env['SLACK_WEBHOOK_SECRET']; delete process.env['WEBHOOK_SECRET']; delete process.env['WEBHOOK_VERIFY_OPTIONAL'] })
  afterEach(() => { Object.assign(process.env, originalEnv) })

  it('rejects missing signature', async () => {
    process.env['WEBHOOK_SECRET'] = 'test-secret-32-chars-min-length'
    const r = await verifyWebhookSignature('ws', 'slack', '{"hello":"world"}', '')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/signature missing/i)
  })

  it('rejects when no secret configured', async () => {
    const r = await verifyWebhookSignature('ws', 'slack', '{"x":1}', 'a'.repeat(64))
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no secret configured/i)
  })

  it('allows verification opt-out via env when no secret', async () => {
    process.env['WEBHOOK_VERIFY_OPTIONAL'] = '1'
    const r = await verifyWebhookSignature('ws', 'slack', '{"x":1}', 'a'.repeat(64))
    expect(r.ok).toBe(true)
  })

  it('accepts a valid HMAC signature (per-channel env)', async () => {
    process.env['SLACK_WEBHOOK_SECRET'] = 'test-secret-32-chars-min-length'
    const body = '{"text":"hello"}'
    const sig = createHmac('sha256', process.env['SLACK_WEBHOOK_SECRET']!).update(body).digest('hex')
    const r = await verifyWebhookSignature('ws', 'slack', body, sig)
    expect(r.ok).toBe(true)
  })

  it('accepts sha256= prefix on signature', async () => {
    process.env['WEBHOOK_SECRET'] = 'test-secret-32-chars-min-length'
    const body = '{"y":2}'
    const sig = createHmac('sha256', process.env['WEBHOOK_SECRET']!).update(body).digest('hex')
    const r = await verifyWebhookSignature('ws', 'github', body, `sha256=${sig}`)
    expect(r.ok).toBe(true)
  })

  it('rejects tampered body with valid-shape signature', async () => {
    process.env['WEBHOOK_SECRET'] = 'test-secret-32-chars-min-length'
    const sig = createHmac('sha256', process.env['WEBHOOK_SECRET']!).update('original').digest('hex')
    const r = await verifyWebhookSignature('ws', 'slack', 'tampered', sig)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/mismatch/i)
  })

  it('rejects wrong-length signature', async () => {
    process.env['WEBHOOK_SECRET'] = 'test-secret-32-chars-min-length'
    const r = await verifyWebhookSignature('ws', 'slack', '{"x":1}', 'a'.repeat(20))
    expect(r.ok).toBe(false)
  })

  it('per-channel env overrides global WEBHOOK_SECRET', async () => {
    process.env['WEBHOOK_SECRET'] = 'global-secret-32-chars-min-len-x'
    process.env['SLACK_WEBHOOK_SECRET'] = 'slack-specific-32-chars-min-len-y'
    const body = '{"x":1}'
    const sigGlobal = createHmac('sha256', process.env['WEBHOOK_SECRET']!).update(body).digest('hex')
    const sigSlack = createHmac('sha256', process.env['SLACK_WEBHOOK_SECRET']!).update(body).digest('hex')
    // Slack channel should use SLACK_* env, NOT global
    expect((await verifyWebhookSignature('ws', 'slack', body, sigSlack)).ok).toBe(true)
    expect((await verifyWebhookSignature('ws', 'slack', body, sigGlobal)).ok).toBe(false)
  })
})
