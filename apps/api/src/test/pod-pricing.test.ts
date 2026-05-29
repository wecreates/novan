/**
 * pod-pricing.test.ts — verifies the COGS / pricing math the Pricing
 * Analyst persona depends on. Concrete number checks because operators
 * make $ decisions from these values.
 */
import { describe, it, expect } from 'vitest'
import {
  recommendPricing,
  compareProviders,
  bundleMath,
  promoMath,
  marketplaceFees,
} from '../services/pod-pricing.js'

describe('pod-pricing.recommendPricing', () => {
  it('recommends charm-priced retail for a Printful tee on Etsy with 30% margin', () => {
    const r = recommendPricing({
      provider: 'printful', productType: 'tee', channel: 'etsy',
      targetMarginPct: 0.30,
    })
    if ('error' in r) throw new Error(r.error)
    expect(r.recommendedRetailUsd).toBeGreaterThan(20)
    expect(r.recommendedRetailUsd).toBeLessThan(35)
    // Charm price → .99 ending
    expect((r.recommendedRetailUsd * 100) % 100).toBeCloseTo(99, 0)
    // Margin should hit at least the target (rounding may add a hair)
    expect(r.estimatedMarginPct).toBeGreaterThanOrEqual(0.29)
  })

  it('warns when target margin is impossible on a low-net channel', () => {
    const r = recommendPricing({
      provider: 'printful', productType: 'tee', channel: 'redbubble',
      targetMarginPct: 0.50,
    })
    if ('error' in r) throw new Error(r.error)
    // Redbubble takes ~80% — 50% additional margin on top is impossible.
    // Either retail explodes or warnings fire.
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('refuses out-of-range margin', () => {
    const r = recommendPricing({
      provider: 'printful', productType: 'tee', channel: 'etsy',
      targetMarginPct: 0.95,
    })
    expect('error' in r).toBe(true)
  })

  it('warns when recommended retail falls below consumer floor', () => {
    // Pick a provider/product/channel combo where 5% margin produces a
    // below-floor price. SPOD tee at 5% margin on own_store → ~$13ish,
    // below the $17.99 consumer floor.
    const r = recommendPricing({
      provider: 'spod', productType: 'tee', channel: 'own_store',
      targetMarginPct: 0.05,
    })
    if ('error' in r) throw new Error(r.error)
    if (r.recommendedRetailUsd < 17.99) {
      expect(r.warnings.some(w => /below typical consumer floor/.test(w))).toBe(true)
    }
  })

  it('reports unit volume needed to hit $10k/month net', () => {
    const r = recommendPricing({
      provider: 'printful', productType: 'hoodie', channel: 'shopify',
      targetMarginPct: 0.40,
    })
    if ('error' in r) throw new Error(r.error)
    const notes = r.notes.join(' ')
    expect(notes).toMatch(/units\/month/)
  })

  it('errors when provider does not carry the product type', () => {
    const r = recommendPricing({
      provider: 'spod', productType: 'canvas_16x20', channel: 'etsy',
      targetMarginPct: 0.30,
    })
    expect('error' in r).toBe(true)
  })
})

describe('pod-pricing.compareProviders', () => {
  it('ranks providers by total COGS ascending', () => {
    const rows = compareProviders({ productType: 'tee' })
    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.totalCogsUsd).toBeGreaterThanOrEqual(rows[i - 1]!.totalCogsUsd)
    }
  })

  it('omits providers that do not carry the product', () => {
    const rows = compareProviders({ productType: 'canvas_16x20' })
    const providers = rows.map(r => r.provider)
    // SPOD and Gooten don't carry canvas_16x20 in our matrix
    expect(providers).not.toContain('spod')
    expect(providers).not.toContain('gooten')
  })
})

describe('pod-pricing.bundleMath', () => {
  it('charges max shipping once for a multi-item bundle', () => {
    const r = bundleMath({
      provider: 'printful',
      items: [
        { productType: 'tee',  quantity: 2 },
        { productType: 'mug_11oz', quantity: 1 },
      ],
      bundleRetailUsd: 49.99,
      channel: 'own_store',
    })
    if ('error' in r) throw new Error(r.error)
    // 2× tee base ($8.95) + 1× mug base ($7.95) = $25.85 + max ship ($4.99) = $30.84
    expect(r.cogsUsd).toBeCloseTo(30.84, 1)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('rejects bad quantity', () => {
    const r = bundleMath({
      provider: 'printful', items: [{ productType: 'tee', quantity: 0 }],
      bundleRetailUsd: 19.99, channel: 'etsy',
    })
    expect('error' in r).toBe(true)
  })

  it('rejects unsupported product', () => {
    const r = bundleMath({
      provider: 'spod', items: [{ productType: 'canvas_16x20', quantity: 1 }],
      bundleRetailUsd: 49.99, channel: 'etsy',
    })
    expect('error' in r).toBe(true)
  })
})

describe('pod-pricing.promoMath', () => {
  it('computes break-even units given ad spend + discount', () => {
    const r = promoMath({
      baseNetUsd: 8, discountPct: 0.20, adSpendUsd: 500, retailUsd: 25,
    })
    // discount = $5, effective net = $8 - $5 = $3 → break-even = 500/3 ≈ 167
    expect(r.effectiveNetUsd).toBeCloseTo(3, 1)
    expect(r.breakEvenUnits).toBe(167)
    expect(r.warning).toBeUndefined()
  })

  it('warns when discount eliminates margin', () => {
    const r = promoMath({
      baseNetUsd: 3, discountPct: 0.50, adSpendUsd: 200, retailUsd: 20,
    })
    // discount = $10, effective net = $3 - $10 = -$7 → wipes out margin
    expect(r.effectiveNetUsd).toBeLessThan(0)
    expect(r.breakEvenUnits).toBe(Infinity)
    expect(r.warning).toBeDefined()
  })
})

describe('pod-pricing.marketplaceFees', () => {
  it('returns distinct rates per channel', () => {
    expect(marketplaceFees('etsy').pctFee).toBeCloseTo(0.095, 3)
    expect(marketplaceFees('shopify').pctFee).toBeCloseTo(0.029, 3)
    expect(marketplaceFees('amazon_merch').pctFee).toBeGreaterThan(0.5)
    expect(marketplaceFees('redbubble').pctFee).toBeGreaterThan(0.7)
    expect(marketplaceFees('own_store').pctFee).toBeCloseTo(0.029, 3)
  })
})
