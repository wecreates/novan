/**
 * push-quicklink-r9.test.ts — Tests for rounds 129+130:
 * Web Push VAPID + quick-link auth helpers.
 */
import { describe, it, expect } from 'vitest'

describe('web-push — VAPID', () => {
  it('publicVapidKey returns null when env not set', async () => {
    const prev = { pub: process.env['VAPID_PUBLIC_KEY'], priv: process.env['VAPID_PRIVATE_KEY'] }
    delete process.env['VAPID_PUBLIC_KEY']
    delete process.env['VAPID_PRIVATE_KEY']
    try {
      const { publicVapidKey, loadVapidKeys } = await import('../services/web-push.js')
      expect(publicVapidKey()).toBeNull()
      expect(loadVapidKeys()).toBeNull()
    } finally {
      if (prev.pub)  process.env['VAPID_PUBLIC_KEY']  = prev.pub
      if (prev.priv) process.env['VAPID_PRIVATE_KEY'] = prev.priv
    }
  })

  it('generateVapidKeys produces base64url-shaped pair of correct length', async () => {
    const { generateVapidKeys } = await import('../services/web-push.js')
    const { publicKey, privateKey } = generateVapidKeys()
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]+$/)
    // P-256 public key: 65 bytes raw → ~87 chars base64url
    expect(publicKey.length).toBeGreaterThan(80)
    expect(publicKey.length).toBeLessThan(95)
    // P-256 private scalar: 32 bytes → ~43 chars base64url
    expect(privateKey.length).toBeGreaterThan(40)
    expect(privateKey.length).toBeLessThan(48)
  })

  it('sendPushOne refuses when keys not configured', async () => {
    const prev = process.env['VAPID_PUBLIC_KEY']
    delete process.env['VAPID_PUBLIC_KEY']
    try {
      const { sendPushOne } = await import('../services/web-push.js')
      const out = await sendPushOne(
        { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } },
        { title: 'x', body: 'y' },
      )
      expect(out.ok).toBe(false)
      expect(out.error).toMatch(/VAPID/)
    } finally {
      if (prev) process.env['VAPID_PUBLIC_KEY'] = prev
    }
  })

  it('broadcastPush returns zeroes when no subscriptions + no DB', async () => {
    const { broadcastPush } = await import('../services/web-push.js')
    const out = await broadcastPush('no-such-ws', { title: 't', body: 'b' })
    expect(out.attempted).toBe(0)
    expect(out.succeeded).toBe(0)
  })
})

describe('quick-link-auth', () => {
  it('redeem rejects empty/short/long tokens upfront', async () => {
    const { redeemQuickLink } = await import('../services/quick-link-auth.js')
    expect((await redeemQuickLink('')).ok).toBe(false)
    expect((await redeemQuickLink('short')).ok).toBe(false)
    expect((await redeemQuickLink('x'.repeat(100))).ok).toBe(false)
  })

  it('redeem returns unknown for a never-issued token', async () => {
    const { redeemQuickLink } = await import('../services/quick-link-auth.js')
    const out = await redeemQuickLink('a'.repeat(32))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(['unknown', 'error']).toContain(out.reason)
  })

  it('issue returns a token + future expiresAt', async () => {
    const { issueQuickLink } = await import('../services/quick-link-auth.js')
    const out = await issueQuickLink('ws-test', 'op')
    expect(out.token.length).toBeGreaterThan(20)
    expect(out.expiresAt).toBeGreaterThan(Date.now())
    expect(out.expiresAt).toBeLessThan(Date.now() + 10 * 60_000)  // ≤ 10min
  })
})
