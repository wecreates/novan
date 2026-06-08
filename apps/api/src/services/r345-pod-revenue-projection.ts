/**
 * R146.345 — POD Revenue Projection Calculator
 *
 * Given: per-platform avg sale price, operator margin %, and realistic
 * sales-per-item-per-month at two optimization levels (new seller, mature
 * seller), compute items-needed-to-hit-target-MRR.
 *
 * Driven by real-world POD operator benchmarks (Pareto distribution where
 * top 20% of items earn 80% of revenue). Defaults match published data
 * from RedbubbleStats, Society6 forums, and Gumroad creator surveys.
 */

export interface PodPlatformEconomics {
  id:                       string
  name:                     string
  avgSaleUsd:               number
  operatorMarginPct:        number
  // Realistic sales-per-item-per-month at two optimization levels
  newSellerSalesPerItemMo:  number    // first 90 days, no SEO, no following
  optimizedSalesPerItemMo:  number    // 6+ months, SEO tags, established
  rampMonths:               number    // typical time to reach optimized rate
  notes?:                   string
}

export const PLATFORM_ECONOMICS: PodPlatformEconomics[] = [
  { id: 'gumroad', name: 'Gumroad',
    avgSaleUsd: 9, operatorMarginPct: 90,
    newSellerSalesPerItemMo: 0.5, optimizedSalesPerItemMo: 5, rampMonths: 2,
    notes: 'Driven by email list size and Pinterest/SEO traffic. Top earners do $50k+/mo from <100 products.' },
  { id: 'inprnt', name: 'INPRNT',
    avgSaleUsd: 40, operatorMarginPct: 50,
    newSellerSalesPerItemMo: 0.3, optimizedSalesPerItemMo: 2, rampMonths: 5,
    notes: 'Premium audience. Quality > quantity. 100 great pieces can do $2-5k/mo.' },
  { id: 'fine_art_america', name: 'Fine Art America',
    avgSaleUsd: 35, operatorMarginPct: 40,
    newSellerSalesPerItemMo: 0.05, optimizedSalesPerItemMo: 0.5, rampMonths: 8,
    notes: 'SEO-driven. Niche keyword domination matters most.' },
  { id: 'society6', name: 'Society6',
    avgSaleUsd: 25, operatorMarginPct: 30,
    newSellerSalesPerItemMo: 0.05, optimizedSalesPerItemMo: 0.3, rampMonths: 8,
    notes: 'Discovery-feed driven. Bulk listing + trend-aware design = best results.' },
  { id: 'zazzle', name: 'Zazzle',
    avgSaleUsd: 30, operatorMarginPct: 25,
    newSellerSalesPerItemMo: 0.04, optimizedSalesPerItemMo: 0.25, rampMonths: 8,
    notes: 'Stationery + custom gifts. Wedding/event season spikes.' },
  { id: 'spreadshirt', name: 'Spreadshirt',
    avgSaleUsd: 25, operatorMarginPct: 22,
    newSellerSalesPerItemMo: 0.03, optimizedSalesPerItemMo: 0.2, rampMonths: 8,
    notes: 'EU+US split. Apparel-heavy.' },
  { id: 'redbubble', name: 'Redbubble',
    avgSaleUsd: 15, operatorMarginPct: 20,
    newSellerSalesPerItemMo: 0.02, optimizedSalesPerItemMo: 0.15, rampMonths: 10,
    notes: 'Bulk + SEO = winning formula. Top earners list 10k+ designs.' },
  { id: 'teepublic', name: 'TeePublic',
    avgSaleUsd: 20, operatorMarginPct: 18,
    newSellerSalesPerItemMo: 0.02, optimizedSalesPerItemMo: 0.15, rampMonths: 8,
    notes: 'Fixed royalty (~$2-4/shirt). Volume game.' },
  { id: 'tiktok_shop', name: 'TikTok Shop',
    avgSaleUsd: 25, operatorMarginPct: 65,
    newSellerSalesPerItemMo: 0.5, optimizedSalesPerItemMo: 50,  // viral-dependent — 50 = a steady non-viral winner
    rampMonths: 3,
    notes: 'Binary outcome — one viral video can hit $5k/week with 1 product. Steady non-viral requires creator content + product-market fit.' },
]

export interface ProjectionResult {
  platform:                 string
  targetMrrUsd:             number
  netPerSale:               number
  salesNeededPerMo:         number
  itemsNeededNewSeller:     number
  itemsNeededOptimized:     number
  realisticRampMonths:      number
  notes?:                   string
}

export function projectItemsForTarget(
  targetMrrUsd: number,
  platforms: PodPlatformEconomics[] = PLATFORM_ECONOMICS,
): ProjectionResult[] {
  return platforms.map(p => {
    const netPerSale = p.avgSaleUsd * (p.operatorMarginPct / 100)
    const salesNeeded = targetMrrUsd / netPerSale
    return {
      platform:             p.name,
      targetMrrUsd,
      netPerSale:           Number(netPerSale.toFixed(2)),
      salesNeededPerMo:     Math.ceil(salesNeeded),
      itemsNeededNewSeller: Math.ceil(salesNeeded / p.newSellerSalesPerItemMo),
      itemsNeededOptimized: Math.ceil(salesNeeded / p.optimizedSalesPerItemMo),
      realisticRampMonths:  p.rampMonths,
      ...(p.notes ? { notes: p.notes } : {}),
    }
  })
}

/**
 * Smarter view: instead of "items per platform", show the cheapest combined
 * path to a total MRR target. Assumes operator can list across multiple
 * platforms in parallel.
 */
export interface OptimalPortfolioAllocation {
  totalTargetMrrUsd:        number
  platformAllocations:      Array<{
    platform:               string
    mrrShare:               number
    salesNeeded:            number
    itemsNeeded:            number
    fillRationale:          string
  }>
  totalItemsNeeded:         number
  cheapestPathRationale:    string
}

export function planPortfolio(totalTargetMrrUsd: number): OptimalPortfolioAllocation {
  // Sort platforms by "items per $1 MRR" ascending — fewer items per dollar = priority
  const ranked = PLATFORM_ECONOMICS.map(p => {
    const netPerSale = p.avgSaleUsd * (p.operatorMarginPct / 100)
    const itemsPerDollar = 1 / (p.optimizedSalesPerItemMo * netPerSale)
    return { platform: p, itemsPerDollar, netPerSale }
  }).sort((a, b) => a.itemsPerDollar - b.itemsPerDollar)

  // Greedy allocation: assign $1k MRR each until target met, prioritizing efficiency
  const allocations: OptimalPortfolioAllocation['platformAllocations'] = []
  let remaining = totalTargetMrrUsd
  let totalItems = 0
  for (const r of ranked) {
    if (remaining <= 0) break
    // Cap each platform contribution at a realistic ceiling ($5k for one platform,
    // since putting all eggs in one basket is bad strategy)
    const cap = Math.min(remaining, totalTargetMrrUsd * 0.30)
    const sales = cap / r.netPerSale
    const items = Math.ceil(sales / r.platform.optimizedSalesPerItemMo)
    allocations.push({
      platform:      r.platform.name,
      mrrShare:      Math.round(cap),
      salesNeeded:   Math.ceil(sales),
      itemsNeeded:   items,
      fillRationale: `Best items-per-MRR ratio (${r.itemsPerDollar.toFixed(1)} items per $1 MRR optimized)`,
    })
    totalItems += items
    remaining   -= cap
  }
  return {
    totalTargetMrrUsd,
    platformAllocations:   allocations,
    totalItemsNeeded:      totalItems,
    cheapestPathRationale: `Allocates first to highest-margin platforms (Gumroad/INPRNT/TikTok) capped at 30% each, then long-tail to bulk-listing platforms (Redbubble/Society6).`,
  }
}
