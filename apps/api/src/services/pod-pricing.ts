/**
 * pod-pricing.ts — Print-on-Demand cost + margin engine.
 *
 * Concrete COGS lookup tables for the major fulfilment providers
 * (Printful, Printify, Gelato, SPOD, Gooten) across the highest-volume
 * product types: tees, hoodies, posters, mugs, stickers, tote bags,
 * canvas, phone cases. Numbers are 2024-2025 published base prices and
 * are intentionally conservative (operator should re-verify on the
 * provider dashboard before pricing live products — printer pricing
 * shifts seasonally and by region).
 *
 * What this gives the brain:
 *   - `pod.pricing.recommend` op: given product type + provider + target
 *     margin, return suggested retail with floor warnings
 *   - `pod.pricing.compare` op: same product across all providers
 *     side-by-side, ranked by COGS
 *   - `pod.pricing.bundle` op: bundle math — N items with combined
 *     shipping + bundle discount → effective margin
 *   - `pod.pricing.promo` op: promo planning — discount %, break-even
 *     volume given fixed marketing spend
 *
 * Honest scope:
 *   - Shipping is approximate; real shipping depends on destination
 *     zone + provider warehouse and is a per-order calculation. Numbers
 *     here are "US domestic standard, 1 unit" averages.
 *   - Provider pricing changes; this file is the canonical source the
 *     operator updates manually when they spot drift. Brain reads it
 *     fresh on every op call (no DB layer between).
 *   - Etsy / Shopify / Amazon Merch platform fees are layered on top
 *     via `marketplaceFees()` — they aren't part of COGS but the
 *     operator's $10k floor calc has to net them out.
 */

export type PodProvider = 'printful' | 'printify' | 'gelato' | 'spod' | 'gooten'
export type PodProductType =
  | 'tee'              // unisex short-sleeve cotton tee, ~5oz
  | 'tee_premium'      // bella+canvas 3001 or equivalent
  | 'hoodie'           // unisex pullover hoodie, ~8oz
  | 'sweatshirt'       // unisex crewneck
  | 'tank'             // unisex tank
  | 'longsleeve'       // unisex long-sleeve tee
  | 'poster_12x18'     // standard wall poster
  | 'poster_18x24'
  | 'canvas_12x12'
  | 'canvas_16x20'
  | 'mug_11oz'         // ceramic
  | 'mug_15oz'
  | 'sticker_3x3'      // die-cut vinyl
  | 'sticker_4x4'
  | 'tote'             // canvas tote bag
  | 'phonecase'        // iPhone case (current gen)
  | 'hat_dad'          // unstructured dad hat
  | 'hat_snapback'     // structured 6-panel snapback

export interface PodPriceRow {
  baseCostUsd:    number   // raw fulfilment cost (print + blank + handling)
  shipUsDomUsd:   number   // approx US-domestic standard shipping, 1 unit
  productionDays: number   // P50 days to ship from order placement
}

/** Provider × product price matrix. Last calibrated against published
 *  rate sheets 2024-Q4. Where a provider doesn't carry a product type,
 *  the row is omitted — `lookup()` returns null and the brain reports
 *  "provider does not carry this product type". */
const PRICE_MATRIX: Record<PodProvider, Partial<Record<PodProductType, PodPriceRow>>> = {
  printful: {
    tee:           { baseCostUsd: 8.95,  shipUsDomUsd: 4.69, productionDays: 3 },
    tee_premium:   { baseCostUsd: 12.25, shipUsDomUsd: 4.69, productionDays: 3 },
    hoodie:        { baseCostUsd: 22.50, shipUsDomUsd: 6.39, productionDays: 4 },
    sweatshirt:    { baseCostUsd: 19.95, shipUsDomUsd: 6.39, productionDays: 4 },
    tank:          { baseCostUsd: 11.95, shipUsDomUsd: 4.69, productionDays: 3 },
    longsleeve:    { baseCostUsd: 14.50, shipUsDomUsd: 4.69, productionDays: 3 },
    poster_12x18:  { baseCostUsd: 9.95,  shipUsDomUsd: 4.99, productionDays: 3 },
    poster_18x24:  { baseCostUsd: 13.95, shipUsDomUsd: 4.99, productionDays: 3 },
    canvas_12x12:  { baseCostUsd: 18.50, shipUsDomUsd: 8.49, productionDays: 5 },
    canvas_16x20:  { baseCostUsd: 26.95, shipUsDomUsd: 8.49, productionDays: 5 },
    mug_11oz:      { baseCostUsd: 7.95,  shipUsDomUsd: 4.99, productionDays: 3 },
    mug_15oz:      { baseCostUsd: 9.50,  shipUsDomUsd: 4.99, productionDays: 3 },
    sticker_3x3:   { baseCostUsd: 1.95,  shipUsDomUsd: 3.99, productionDays: 2 },
    sticker_4x4:   { baseCostUsd: 2.95,  shipUsDomUsd: 3.99, productionDays: 2 },
    tote:          { baseCostUsd: 13.50, shipUsDomUsd: 4.99, productionDays: 3 },
    phonecase:     { baseCostUsd: 14.95, shipUsDomUsd: 4.49, productionDays: 3 },
    hat_dad:       { baseCostUsd: 14.95, shipUsDomUsd: 5.49, productionDays: 4 },
    hat_snapback:  { baseCostUsd: 17.50, shipUsDomUsd: 5.49, productionDays: 4 },
  },
  printify: {
    // Printify is a network of printers; cost varies by provider chosen
    // within Printify. These are mid-range Monster/SwiftPOD numbers.
    tee:           { baseCostUsd: 7.50,  shipUsDomUsd: 4.25, productionDays: 4 },
    tee_premium:   { baseCostUsd: 10.95, shipUsDomUsd: 4.25, productionDays: 4 },
    hoodie:        { baseCostUsd: 20.50, shipUsDomUsd: 5.95, productionDays: 5 },
    sweatshirt:    { baseCostUsd: 17.95, shipUsDomUsd: 5.95, productionDays: 5 },
    tank:          { baseCostUsd: 10.50, shipUsDomUsd: 4.25, productionDays: 4 },
    longsleeve:    { baseCostUsd: 13.25, shipUsDomUsd: 4.25, productionDays: 4 },
    poster_12x18:  { baseCostUsd: 8.50,  shipUsDomUsd: 4.79, productionDays: 4 },
    poster_18x24:  { baseCostUsd: 12.50, shipUsDomUsd: 4.79, productionDays: 4 },
    mug_11oz:      { baseCostUsd: 6.95,  shipUsDomUsd: 4.79, productionDays: 4 },
    mug_15oz:      { baseCostUsd: 8.50,  shipUsDomUsd: 4.79, productionDays: 4 },
    sticker_3x3:   { baseCostUsd: 1.65,  shipUsDomUsd: 3.79, productionDays: 3 },
    sticker_4x4:   { baseCostUsd: 2.50,  shipUsDomUsd: 3.79, productionDays: 3 },
    tote:          { baseCostUsd: 11.95, shipUsDomUsd: 4.79, productionDays: 4 },
    phonecase:     { baseCostUsd: 13.50, shipUsDomUsd: 4.29, productionDays: 4 },
    hat_dad:       { baseCostUsd: 13.50, shipUsDomUsd: 5.29, productionDays: 5 },
  },
  gelato: {
    // Gelato is global with local printing → US-domestic numbers below;
    // EU/UK orders route to local printers, often cheaper there.
    tee:           { baseCostUsd: 9.45,  shipUsDomUsd: 4.99, productionDays: 3 },
    tee_premium:   { baseCostUsd: 12.95, shipUsDomUsd: 4.99, productionDays: 3 },
    hoodie:        { baseCostUsd: 23.50, shipUsDomUsd: 6.49, productionDays: 4 },
    sweatshirt:    { baseCostUsd: 20.50, shipUsDomUsd: 6.49, productionDays: 4 },
    poster_12x18:  { baseCostUsd: 10.50, shipUsDomUsd: 5.49, productionDays: 2 },
    poster_18x24:  { baseCostUsd: 14.95, shipUsDomUsd: 5.49, productionDays: 2 },
    canvas_12x12:  { baseCostUsd: 19.50, shipUsDomUsd: 8.95, productionDays: 4 },
    canvas_16x20:  { baseCostUsd: 28.50, shipUsDomUsd: 8.95, productionDays: 4 },
    mug_11oz:      { baseCostUsd: 8.50,  shipUsDomUsd: 5.49, productionDays: 3 },
    mug_15oz:      { baseCostUsd: 10.25, shipUsDomUsd: 5.49, productionDays: 3 },
    tote:          { baseCostUsd: 13.95, shipUsDomUsd: 5.49, productionDays: 3 },
    phonecase:     { baseCostUsd: 15.50, shipUsDomUsd: 4.99, productionDays: 3 },
  },
  spod: {
    // SPOD specialises in fast US fulfilment, narrower catalog.
    tee:           { baseCostUsd: 8.49,  shipUsDomUsd: 3.99, productionDays: 2 },
    tee_premium:   { baseCostUsd: 11.49, shipUsDomUsd: 3.99, productionDays: 2 },
    hoodie:        { baseCostUsd: 21.99, shipUsDomUsd: 5.99, productionDays: 2 },
    sweatshirt:    { baseCostUsd: 18.99, shipUsDomUsd: 5.99, productionDays: 2 },
    tank:          { baseCostUsd: 10.99, shipUsDomUsd: 3.99, productionDays: 2 },
    longsleeve:    { baseCostUsd: 13.99, shipUsDomUsd: 3.99, productionDays: 2 },
    mug_11oz:      { baseCostUsd: 7.49,  shipUsDomUsd: 4.49, productionDays: 2 },
    tote:          { baseCostUsd: 12.99, shipUsDomUsd: 4.49, productionDays: 2 },
  },
  gooten: {
    tee:           { baseCostUsd: 8.25,  shipUsDomUsd: 4.50, productionDays: 4 },
    hoodie:        { baseCostUsd: 21.00, shipUsDomUsd: 6.25, productionDays: 5 },
    poster_12x18:  { baseCostUsd: 9.25,  shipUsDomUsd: 4.75, productionDays: 4 },
    poster_18x24:  { baseCostUsd: 12.95, shipUsDomUsd: 4.75, productionDays: 4 },
    mug_11oz:      { baseCostUsd: 7.50,  shipUsDomUsd: 4.75, productionDays: 4 },
    sticker_3x3:   { baseCostUsd: 1.75,  shipUsDomUsd: 3.50, productionDays: 3 },
    tote:          { baseCostUsd: 12.50, shipUsDomUsd: 4.75, productionDays: 4 },
    phonecase:     { baseCostUsd: 14.25, shipUsDomUsd: 4.25, productionDays: 4 },
  },
}

/** Marketplace fees (percentage of retail, paid by the operator).
 *  Etsy = listing fee + 6.5% transaction + 3%+$0.25 payment processing.
 *  Shopify storefront has no per-sale fee beyond payment processing.
 *  Amazon Merch is royalty-based — Amazon owns the customer + 100% of
 *  shipping/returns/CS; royalty is set by Amazon based on price tier. */
export interface MarketplaceFees {
  /** Percentage fee on retail (decimal — 0.065 = 6.5%). */
  pctFee:        number
  /** Flat fee per transaction (USD). */
  flatFee:       number
  /** Listing fee per item (USD, prorated to ~per-sale where applicable). */
  listingFee:    number
  notes:         string
}
export function marketplaceFees(channel: 'etsy' | 'shopify' | 'amazon_merch' | 'redbubble' | 'teepublic' | 'own_store'): MarketplaceFees {
  switch (channel) {
    case 'etsy':
      return { pctFee: 0.065 + 0.03, flatFee: 0.25, listingFee: 0.20 / 100,  // $0.20 every 4 months / ~100 sales
        notes: 'Etsy: 6.5% transaction + 3%+$0.25 payment + $0.20 listing every 4 months.' }
    case 'shopify':
      return { pctFee: 0.029, flatFee: 0.30, listingFee: 0,
        notes: 'Shopify storefront: payment processing 2.9% + $0.30 (US). No per-listing fee. Subscription cost separate.' }
    case 'amazon_merch':
      // Amazon Merch is royalty-based — operator sets retail, Amazon
      // takes the rest. Royalty rates per Amazon: ~$2.18 royalty on
      // $15.99 tee, ~$3.95 on $19.99, ~$5.71 on $22.99. This is closer
      // to a NET COGS model — the "fee" is what's left after Amazon's
      // cut. Set pctFee high to reflect that.
      return { pctFee: 0.62, flatFee: 0, listingFee: 0,
        notes: 'Amazon Merch: royalty-only — Amazon owns COGS+CS+returns. Effective "fee" ~60-65% of retail. Operator gets royalty, no COGS to subtract.' }
    case 'redbubble':
      return { pctFee: 0.80, flatFee: 0, listingFee: 0,
        notes: 'Redbubble: artist sets margin; platform takes ~80% of retail to cover COGS + their cut. Royalty-like model.' }
    case 'teepublic':
      return { pctFee: 0.85, flatFee: 0, listingFee: 0,
        notes: 'TeePublic: similar to Redbubble — artist sets markup over base; platform pays a per-sale royalty (~$4 on tees during sales, ~$5 full-price).' }
    case 'own_store':
      return { pctFee: 0.029, flatFee: 0.30, listingFee: 0,
        notes: 'Own store via Stripe/PayPal: payment processing only. No marketplace cut.' }
  }
}

export interface PricingRecommendation {
  provider:        PodProvider
  productType:     PodProductType
  baseCostUsd:     number
  shipUsDomUsd:    number
  productionDays:  number
  recommendedRetailUsd:  number
  estimatedNetUsd:       number   // after COGS + marketplace fees
  estimatedMarginPct:    number   // estimatedNet / retail
  channel:          string
  notes:            string[]
  warnings:         string[]
}

/** Recommend a retail price for a given product/provider/channel given
 *  a target margin. Math:
 *    let R = retail
 *    let net = R*(1-pctFee) - flatFee - listingFee - cogs
 *    solve for R such that net / R >= target
 *    R = (cogs + flatFee + listingFee) / (1 - pctFee - target)
 *  Sanity rails: retail rounded up to nearest $0.99; warns if retail
 *  falls below a reasonable consumer threshold ($14.99 tee, $29.99
 *  hoodie, etc.). */
export function recommendPricing(input: {
  provider:     PodProvider
  productType:  PodProductType
  channel:      'etsy' | 'shopify' | 'amazon_merch' | 'redbubble' | 'teepublic' | 'own_store'
  targetMarginPct: number   // 0.30 = 30%
}): PricingRecommendation | { error: string } {
  const row = PRICE_MATRIX[input.provider]?.[input.productType]
  if (!row) return { error: `provider ${input.provider} does not carry ${input.productType} in our price matrix — verify on their dashboard` }
  if (input.targetMarginPct < 0 || input.targetMarginPct > 0.85) {
    return { error: `targetMarginPct ${input.targetMarginPct} out of sane range [0, 0.85]` }
  }
  const fees = marketplaceFees(input.channel)
  const cogs = row.baseCostUsd + row.shipUsDomUsd
  const fixedCost = cogs + fees.flatFee + fees.listingFee
  const denom = 1 - fees.pctFee - input.targetMarginPct
  const warnings: string[] = []
  const notes: string[]    = [fees.notes]

  if (denom <= 0.05) {
    warnings.push(`fee+margin (${(fees.pctFee + input.targetMarginPct).toFixed(2)}) leaves <5% headroom — retail would explode. Reduce target margin or switch channel.`)
  }

  // Solve for retail, then bump to a charm price (.99 ending).
  const rawRetail = fixedCost / Math.max(0.05, denom)
  const charmRetail = Math.ceil(rawRetail) - 0.01
  const retail = charmRetail < rawRetail ? charmRetail + 1 : charmRetail

  const net      = retail * (1 - fees.pctFee) - fees.flatFee - fees.listingFee - cogs
  const marginPct = net / retail

  // Consumer-acceptability sanity check — too-cheap signals low quality
  // (especially on Etsy/Shopify); too-expensive without brand kills CTR.
  const consumerFloors: Partial<Record<PodProductType, number>> = {
    tee: 17.99, tee_premium: 22.99, hoodie: 34.99, sweatshirt: 32.99, tank: 19.99,
    longsleeve: 24.99, mug_11oz: 14.99, mug_15oz: 17.99, sticker_3x3: 3.99,
    sticker_4x4: 4.99, tote: 19.99, phonecase: 21.99, hat_dad: 22.99, hat_snapback: 26.99,
    poster_12x18: 16.99, poster_18x24: 22.99, canvas_12x12: 39.99, canvas_16x20: 54.99,
  }
  const floor = consumerFloors[input.productType]
  if (floor && retail < floor) {
    warnings.push(`retail $${retail.toFixed(2)} below typical consumer floor $${floor} — risks being read as low-quality. Consider higher target margin or premium positioning.`)
  }

  // $10k/month back-of-envelope: how many units/day at this margin?
  const unitsPerMonthFor10k = net > 0 ? Math.ceil(10_000 / net) : Infinity
  notes.push(`To hit $10k/mo net at this margin, need ${unitsPerMonthFor10k} units/month (~${Math.ceil(unitsPerMonthFor10k / 30)} units/day).`)

  return {
    provider:       input.provider,
    productType:    input.productType,
    baseCostUsd:    row.baseCostUsd,
    shipUsDomUsd:   row.shipUsDomUsd,
    productionDays: row.productionDays,
    recommendedRetailUsd: Number(retail.toFixed(2)),
    estimatedNetUsd:      Number(net.toFixed(2)),
    estimatedMarginPct:   Number(marginPct.toFixed(3)),
    channel:        input.channel,
    notes,
    warnings,
  }
}

/** Compare a product across every provider that carries it, ranked by
 *  COGS + shipping. Used by `pod.pricing.compare` op so the operator
 *  sees which fulfilment partner is cheapest for a given SKU. */
export function compareProviders(input: { productType: PodProductType }): Array<{
  provider:     PodProvider
  baseCostUsd:  number
  shipUsDomUsd: number
  totalCogsUsd: number
  productionDays: number
}> {
  const out: Array<{ provider: PodProvider; baseCostUsd: number; shipUsDomUsd: number; totalCogsUsd: number; productionDays: number }> = []
  for (const provider of Object.keys(PRICE_MATRIX) as PodProvider[]) {
    const row = PRICE_MATRIX[provider][input.productType]
    if (!row) continue
    out.push({
      provider,
      baseCostUsd: row.baseCostUsd,
      shipUsDomUsd: row.shipUsDomUsd,
      totalCogsUsd: Number((row.baseCostUsd + row.shipUsDomUsd).toFixed(2)),
      productionDays: row.productionDays,
    })
  }
  return out.sort((a, b) => a.totalCogsUsd - b.totalCogsUsd)
}

/** Bundle math — N items shipped as one order. Most providers charge
 *  the full per-item base cost but only ONE shipping fee. */
export function bundleMath(input: {
  provider: PodProvider
  items: Array<{ productType: PodProductType; quantity: number }>
  bundleRetailUsd: number
  channel: 'etsy' | 'shopify' | 'amazon_merch' | 'redbubble' | 'teepublic' | 'own_store'
}): { ok: true; cogsUsd: number; feesUsd: number; netUsd: number; marginPct: number; warnings: string[] } | { error: string } {
  let baseTotal = 0
  let maxShip = 0
  const warnings: string[] = []
  for (const it of input.items) {
    const row = PRICE_MATRIX[input.provider]?.[it.productType]
    if (!row) return { error: `provider ${input.provider} does not carry ${it.productType}` }
    if (it.quantity < 1 || !Number.isInteger(it.quantity)) return { error: `quantity must be positive integer, got ${it.quantity}` }
    baseTotal += row.baseCostUsd * it.quantity
    maxShip = Math.max(maxShip, row.shipUsDomUsd)
  }
  // Realistic: providers don't always bundle — only items shipped from
  // the same printer get one shipping. Warn the operator.
  warnings.push('Bundle shipping assumes all items ship together. If your provider routes items to different printers (Printify common case), expect multiple shipping charges.')
  const cogs = Number((baseTotal + maxShip).toFixed(2))
  const fees = marketplaceFees(input.channel)
  const feesUsd = input.bundleRetailUsd * fees.pctFee + fees.flatFee + fees.listingFee
  const net = input.bundleRetailUsd - cogs - feesUsd
  return {
    ok: true,
    cogsUsd:   cogs,
    feesUsd:   Number(feesUsd.toFixed(2)),
    netUsd:    Number(net.toFixed(2)),
    marginPct: Number((net / input.bundleRetailUsd).toFixed(3)),
    warnings,
  }
}

/** Promo math — given a discount % and a fixed ad spend, how many
 *  promo-period units to break even on the marketing spend? */
export function promoMath(input: {
  baseNetUsd:      number     // current net margin per unit at full retail
  discountPct:     number     // 0.20 = 20% off
  adSpendUsd:      number     // ad budget for the promo window
  retailUsd:       number     // current retail
}): { breakEvenUnits: number; effectiveNetUsd: number; warning?: string } {
  const discountedRetail = input.retailUsd * (1 - input.discountPct)
  const lostMargin = input.retailUsd - discountedRetail
  const effectiveNet = input.baseNetUsd - lostMargin
  const out: { breakEvenUnits: number; effectiveNetUsd: number; warning?: string } = {
    breakEvenUnits: effectiveNet > 0 ? Math.ceil(input.adSpendUsd / effectiveNet) : Infinity,
    effectiveNetUsd: Number(effectiveNet.toFixed(2)),
  }
  if (effectiveNet <= 0) {
    out.warning = `discount ${(input.discountPct * 100).toFixed(0)}% wipes out per-unit margin (effective net $${effectiveNet.toFixed(2)}). Promo runs at a loss unless ad spend = 0 + units carry brand value.`
  }
  return out
}
