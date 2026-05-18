/**
 * Tests for commerce-policy.ts — purchase block, security block, IP block,
 * spam detector, slop scorer, originality scoring, composite quality.
 *
 * These are the safety-critical functions for the commerce/creative/trust/
 * governance layers. Pure functions, no mocks.
 */
import { describe, it, expect } from 'vitest'
import {
  checkPurchaseIntent, checkSecurityIntent, checkIpRisk, checkSpam,
  checkPublishContent, checkBrowserAction,
  scoreSlop, scoreOriginality, compositeQuality,
} from '../services/commerce-policy.js'

describe('commerce-policy: purchase block (HARD)', () => {
  it('blocks buying', () => {
    expect(checkPurchaseIntent('Buy a domain for the new site').ok).toBe(false)
    expect(checkPurchaseIntent('Purchase 100 stamps').ok).toBe(false)
    expect(checkPurchaseIntent('Click checkout').ok).toBe(false)
  })
  it('blocks payment entry', () => {
    expect(checkPurchaseIntent('Enter credit card number').ok).toBe(false)
    expect(checkPurchaseIntent('CVV is 123').ok).toBe(false)
    expect(checkPurchaseIntent('Routing number 1234').ok).toBe(false)
  })
  it('blocks subscriptions', () => {
    expect(checkPurchaseIntent('Subscribe to the pro plan').ok).toBe(false)
    expect(checkPurchaseIntent('Renew subscription').ok).toBe(false)
  })
  it('blocks ad spend', () => {
    expect(checkPurchaseIntent('Run ads for the new listing').ok).toBe(false)
    expect(checkPurchaseIntent('Boost post with $50').ok).toBe(false)
  })
  it('blocks money movement', () => {
    expect(checkPurchaseIntent('Wire transfer to vendor').ok).toBe(false)
    expect(checkPurchaseIntent('PayPal send $100').ok).toBe(false)
    expect(checkPurchaseIntent('Process payment via stripe').ok).toBe(false)
    expect(checkPurchaseIntent('Crypto transfer 0.5 BTC').ok).toBe(false)
  })

  it('ALLOWS legitimate non-purchase content', () => {
    expect(checkPurchaseIntent('Schedule the post for tomorrow').ok).toBe(true)
    expect(checkPurchaseIntent('Generate 5 design variations').ok).toBe(true)
    expect(checkPurchaseIntent('Upload to Printify').ok).toBe(true)
    expect(checkPurchaseIntent('Research trending niches').ok).toBe(true)
  })
})

describe('commerce-policy: security intent', () => {
  it('blocks captcha bypass', () => {
    expect(checkSecurityIntent('Bypass the recaptcha').ok).toBe(false)
    expect(checkSecurityIntent('Solve the hcaptcha automatically').ok).toBe(false)
  })
  it('blocks deceptive accounts', () => {
    expect(checkSecurityIntent('Create a fake account').ok).toBe(false)
    expect(checkSecurityIntent('Burner email signup').ok).toBe(false)
  })
  it('blocks impersonation', () => {
    expect(checkSecurityIntent('Impersonate Nike brand on Twitter').ok).toBe(false)
  })
  it('blocks aggressive scraping', () => {
    expect(checkSecurityIntent('Scrape every listing on Etsy').ok).toBe(false)
  })
  it('blocks 2FA disable', () => {
    expect(checkSecurityIntent('Disable 2fa on the account').ok).toBe(false)
  })
})

describe('commerce-policy: IP risk', () => {
  it('blocks design copying', () => {
    expect(checkIpRisk('Copy competitor design from Etsy top seller').ok).toBe(false)
    expect(checkIpRisk('Clone the brand logo').ok).toBe(false)
  })
  it('flags protected brand references', () => {
    expect(checkIpRisk('Make a Disney parody design').ok).toBe(false)
    expect(checkIpRisk('Pokemon-style shirt').ok).toBe(false)
    expect(checkIpRisk('Marvel-inspired graphic').ok).toBe(false)
    expect(checkIpRisk('Nike-style sneaker design').ok).toBe(false)
  })
  it('allows generic concepts', () => {
    expect(checkIpRisk('Minimalist mountain landscape with sunrise').ok).toBe(true)
    expect(checkIpRisk('Inspirational quote about resilience').ok).toBe(true)
  })
})

describe('commerce-policy: spam detection', () => {
  it('blocks engagement manipulation', () => {
    expect(checkSpam('Follow for follow! F4F').ok).toBe(false)
    expect(checkSpam('Like 4 like spam pod').ok).toBe(false)
  })
  it('blocks scam', () => {
    expect(checkSpam('Click here to win cash').ok).toBe(false)
    expect(checkSpam('Click link in bio to earn $5000').ok).toBe(false)
  })
  it('blocks fake-growth', () => {
    expect(checkSpam('Buy followers cheap').ok).toBe(false)
    expect(checkSpam('Fake likes for sale').ok).toBe(false)
  })
  it('blocks excessive hashtag spam', () => {
    expect(checkSpam('#a #b #c #d #e #f #g #h #i #j #k #l #m #n #o #p #q').ok).toBe(false)
  })
  it('blocks character repetition', () => {
    expect(checkSpam('OMGGGGGGGGGGG amazing').ok).toBe(false)
  })
  it('allows normal posts', () => {
    expect(checkSpam('New minimalist mountain print just dropped — link in bio!').ok).toBe(true)
    expect(checkSpam('Excited to share our new winter collection #pod #design #etsy').ok).toBe(true)
  })
})

describe('commerce-policy: composite checkPublishContent', () => {
  it('blocks IP-violating content', () => {
    const r = checkPublishContent('New Disney Mickey Mouse design for shirts')
    expect(r.ok).toBe(false)
    expect(r.category).toBe('ip')
  })
  it('blocks spam content', () => {
    const r = checkPublishContent('Follow for follow! Buy followers cheap!')
    expect(r.ok).toBe(false)
    expect(r.category).toBe('spam')
  })
  it('allows clean content', () => {
    const r = checkPublishContent('Calming sunset over the desert — new art print available now')
    expect(r.ok).toBe(true)
    expect(r.category).toBe('ok')
  })
})

describe('commerce-policy: checkBrowserAction', () => {
  it('blocks purchase URL', () => {
    const r = checkBrowserAction('click button', 'https://etsy.com/cart/checkout')
    expect(r.ok).toBe(false)
    expect(r.category).toBe('purchase')
  })
  it('blocks captcha solve action', () => {
    const r = checkBrowserAction('bypass the captcha widget', 'https://example.com')
    expect(r.ok).toBe(false)
  })
  it('allows normal navigation', () => {
    const r = checkBrowserAction('navigate to dashboard', 'https://etsy.com/your/shops/me/listings')
    expect(r.ok).toBe(true)
  })
})

describe('commerce-policy: slop scoring', () => {
  it('penalizes AI-cliché prompts', () => {
    const s = scoreSlop('highly detailed ultra realistic 8k masterpiece trending on artstation')
    expect(s.score).toBeGreaterThan(0)
  })
  it('penalizes overused phrases', () => {
    const s = scoreSlop('live laugh love wine o\'clock')
    expect(s.score).toBeGreaterThanOrEqual(0.2)
  })
  it('penalizes too-short copy', () => {
    const s = scoreSlop('cool design')
    expect(s.score).toBeGreaterThan(0)
  })
  it('original copy scores low', () => {
    const s = scoreSlop('A desert sunrise over Joshua Tree, hand-drawn in muted earth tones, available as poster and tee.')
    expect(s.score).toBeLessThan(0.2)
  })
})

describe('commerce-policy: originality scoring', () => {
  it('returns 1 when cohort is empty', () => {
    const v = new Array(256).fill(0); v[10] = 1
    const r = scoreOriginality(v, [])
    expect(r.score).toBe(1)
  })
  it('returns 0 when target equals a cohort member', () => {
    const v = new Array(256).fill(0); v[10] = 1
    const r = scoreOriginality(v, [v])
    expect(r.score).toBeLessThan(0.1)
  })
  it('returns ~1 when target is orthogonal to cohort', () => {
    const a = new Array(256).fill(0); a[10] = 1
    const b = new Array(256).fill(0); b[20] = 1
    const r = scoreOriginality(a, [b])
    expect(r.score).toBeGreaterThan(0.9)
  })
})

describe('commerce-policy: compositeQuality', () => {
  it('high originality + low slop + low ipRisk → high quality', () => {
    const q = compositeQuality({ originality: 0.9, slop: 0.1, ipRisk: 0 })
    expect(q).toBeGreaterThan(0.85)
  })
  it('high ipRisk drags quality down', () => {
    const q = compositeQuality({ originality: 0.9, slop: 0.1, ipRisk: 1 })
    expect(q).toBeLessThan(0.75)
  })
  it('high slop drags quality down', () => {
    const q = compositeQuality({ originality: 0.9, slop: 1, ipRisk: 0 })
    expect(q).toBeLessThan(0.7)
  })
  it('low originality drags quality down', () => {
    const q = compositeQuality({ originality: 0.1, slop: 0.1, ipRisk: 0 })
    expect(q).toBeLessThan(0.55)
  })
  it('clamps to [0, 1]', () => {
    expect(compositeQuality({ originality: 1, slop: 0, ipRisk: 0 })).toBeLessThanOrEqual(1)
    expect(compositeQuality({ originality: 0, slop: 1, ipRisk: 1 })).toBeGreaterThanOrEqual(0)
  })
})
