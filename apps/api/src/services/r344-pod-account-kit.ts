/**
 * R146.344 — POD Account Kit
 *
 * Comprehensive POD platform registry with pre-staged application content,
 * cost-gating, ban-risk scoring, and sequenced rollout plan.
 *
 * Key constraints (from operator workspace_memory):
 *   - Free storefronts only until MRR ≥ $1k (then paid tier unlocks)
 *   - Highest margin while customers happy (premium tier preferred)
 *   - All publications must be premium quality, no "AI tells"
 *   - Etsy ban lesson R332: simultaneous applications trigger fraud detection
 *
 * Staggering: every paid-storefront or seller-app registration AGES
 * the account ≥7 days before next platform in the same vertical. Pure
 * artist-marketplace signups (Redbubble/Zazzle/etc) can be parallel.
 */

export type PodCategory =
  | 'standalone_marketplace'     // INPRNT, Society6, etc — they handle storefront + payments + fulfillment
  | 'free_storefront_pf_sync'    // free storefronts that auto-sync with Printful (e.g. Storenvy, Big Cartel free)
  | 'paid_storefront_pf_sync'    // paid storefronts (Shopify, etc) — gated until $1k MRR
  | 'creator_platform'           // Gumroad, Patreon — physical + digital, low friction

export type AccountFriction =
  | 'instant_signup'             // email + password, no review
  | 'application_review'         // portfolio submission, 3-30 day approval
  | 'invite_only'                // referral or established portfolio required
  | 'tax_id_required'            // need EIN/SSN before listing

export interface PodPlatform {
  id:                string
  name:              string
  category:          PodCategory
  friction:          AccountFriction
  url:               string
  monthlyFeeUsd:     number               // 0 for free tier
  typicalMarginPct:  number               // operator margin on a $30 item
  unlockAtMrrUsd:    number               // gate: don't enroll until MRR crosses
  banRisk:           'low' | 'medium' | 'high'   // probability of fraud-system rejection
  parallelSafe:      boolean              // can register alongside other accounts same day?
  agingDaysBeforeNextSeller: number       // recommended gap after this signup
  prestagedKey?:     string               // workspace_memory key for application content
  notes:             string
}

export const POD_PLATFORMS: PodPlatform[] = [
  // ── Standalone marketplaces — highest margins, you supply art only ──
  {
    id: 'inprnt', name: 'INPRNT',
    category: 'standalone_marketplace', friction: 'application_review',
    url: 'https://www.inprnt.com/application/',
    monthlyFeeUsd: 0, typicalMarginPct: 50, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: true, agingDaysBeforeNextSeller: 0,
    prestagedKey: 'prestaged.inprnt_application',
    notes: 'Application required. Highest margin in the standalone marketplace tier. Premium customer base. 3-7 day review.',
  },
  {
    id: 'displate', name: 'Displate',
    category: 'standalone_marketplace', friction: 'invite_only',
    url: 'https://displate.com/sell',
    monthlyFeeUsd: 0, typicalMarginPct: 38, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: true, agingDaysBeforeNextSeller: 0,
    notes: 'Metal posters only. Invite-only — submit Instagram/Behance/INPRNT portfolio for review. Premium aesthetic match.',
  },
  {
    id: 'society6', name: 'Society6',
    category: 'standalone_marketplace', friction: 'instant_signup',
    url: 'https://society6.com/become-an-artist',
    monthlyFeeUsd: 0, typicalMarginPct: 30, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: true, agingDaysBeforeNextSeller: 0,
    prestagedKey: 'prestaged.society6_application',
    notes: 'Instant artist signup. Set markup per product. Wide product catalog (art prints + home goods).',
  },
  {
    id: 'redbubble', name: 'Redbubble',
    category: 'standalone_marketplace', friction: 'instant_signup',
    url: 'https://www.redbubble.com/account/sell',
    monthlyFeeUsd: 0, typicalMarginPct: 20, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: true, agingDaysBeforeNextSeller: 0,
    prestagedKey: 'prestaged.redbubble_application',
    notes: 'Instant signup. Lower margin but enormous traffic + SEO. Worth it for volume.',
  },
  {
    id: 'zazzle', name: 'Zazzle',
    category: 'standalone_marketplace', friction: 'instant_signup',
    url: 'https://www.zazzle.com/sell',
    monthlyFeeUsd: 0, typicalMarginPct: 25, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: true, agingDaysBeforeNextSeller: 0,
    prestagedKey: 'prestaged.zazzle_application',
    notes: 'Customizable product catalog. Operator sets royalty %. Good for invitations, stationery, custom gifts.',
  },
  {
    id: 'spreadshirt', name: 'Spreadshirt',
    category: 'standalone_marketplace', friction: 'instant_signup',
    url: 'https://www.spreadshirt.com/sell-online',
    monthlyFeeUsd: 0, typicalMarginPct: 22, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: true, agingDaysBeforeNextSeller: 0,
    notes: 'Apparel-focused. EU + US markets. Add later — overlaps Redbubble.',
  },
  {
    id: 'teepublic', name: 'TeePublic',
    category: 'standalone_marketplace', friction: 'instant_signup',
    url: 'https://www.teepublic.com/sell',
    monthlyFeeUsd: 0, typicalMarginPct: 18, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: true, agingDaysBeforeNextSeller: 0,
    notes: 'Apparel + accessories. Fixed-royalty model (~$2-4/shirt). Add only if Redbubble does well.',
  },
  {
    id: 'fine_art_america', name: 'Fine Art America',
    category: 'standalone_marketplace', friction: 'instant_signup',
    url: 'https://fineartamerica.com/sellprints.html',
    monthlyFeeUsd: 0, typicalMarginPct: 40, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: true, agingDaysBeforeNextSeller: 0,
    notes: 'Free tier limited to 25 images. Premium tier $30/mo unlimited. Wait for $200 MRR before paid tier.',
  },

  // ── Creator platforms — physical + digital, no review needed ──
  {
    id: 'gumroad', name: 'Gumroad',
    category: 'creator_platform', friction: 'instant_signup',
    url: 'https://gumroad.com/signup',
    monthlyFeeUsd: 0, typicalMarginPct: 90, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: true, agingDaysBeforeNextSeller: 0,
    prestagedKey: 'prestaged.gumroad_application',
    notes: 'Sell digital downloads of the same art as printable PDFs. 90% margin (10% Gumroad fee). Adds digital revenue stream alongside POD.',
  },

  // ── Free Printful-sync storefronts — slower to monetize but operator-owned ──
  {
    id: 'tiktok_shop', name: 'TikTok Shop',
    category: 'free_storefront_pf_sync', friction: 'tax_id_required',
    url: 'https://seller-us.tiktok.com/setup',
    monthlyFeeUsd: 0, typicalMarginPct: 60, unlockAtMrrUsd: 0, banRisk: 'medium',
    parallelSafe: false, agingDaysBeforeNextSeller: 7,
    notes: 'ALREADY LIVE as CYZOR CREATIONS (R332). First-sale priority channel — feeds TikTok ads + organic reach.',
  },
  {
    id: 'storenvy', name: 'Storenvy',
    category: 'free_storefront_pf_sync', friction: 'instant_signup',
    url: 'https://www.storenvy.com/start-selling',
    monthlyFeeUsd: 0, typicalMarginPct: 65, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: false, agingDaysBeforeNextSeller: 5,
    notes: 'Free storefront with marketplace traffic. Lower volume than TikTok but no ad cost.',
  },
  {
    id: 'big_cartel_free', name: 'Big Cartel (free tier)',
    category: 'free_storefront_pf_sync', friction: 'instant_signup',
    url: 'https://www.bigcartel.com/signup',
    monthlyFeeUsd: 0, typicalMarginPct: 70, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: false, agingDaysBeforeNextSeller: 5,
    notes: '5-product limit on free tier. Good for highest-margin SKUs only.',
  },
  {
    id: 'ecwid_free', name: 'Ecwid (free tier)',
    category: 'free_storefront_pf_sync', friction: 'instant_signup',
    url: 'https://www.ecwid.com/signup',
    monthlyFeeUsd: 0, typicalMarginPct: 65, unlockAtMrrUsd: 0, banRisk: 'low',
    parallelSafe: false, agingDaysBeforeNextSeller: 5,
    notes: '5-product limit on free tier. Embeddable widget for own site later.',
  },
  {
    id: 'square_online', name: 'Square Online',
    category: 'free_storefront_pf_sync', friction: 'tax_id_required',
    url: 'https://squareup.com/us/en/online-store',
    monthlyFeeUsd: 0, typicalMarginPct: 65, unlockAtMrrUsd: 0, banRisk: 'medium',
    parallelSafe: false, agingDaysBeforeNextSeller: 14,
    notes: 'Free storefront tier. Transaction-fee-only. Square account = bank-level KYC, similar friction to TikTok Shop.',
  },
  {
    id: 'ebay', name: 'eBay',
    category: 'free_storefront_pf_sync', friction: 'tax_id_required',
    url: 'https://www.ebay.com/sl/sell',
    monthlyFeeUsd: 0, typicalMarginPct: 50, unlockAtMrrUsd: 0, banRisk: 'medium',
    parallelSafe: false, agingDaysBeforeNextSeller: 14,
    notes: 'First-time sellers limited to ~10 listings/mo. Volume grows as seller score builds.',
  },

  // ── Paid storefronts — GATED until $1k MRR per operator constraint ──
  {
    id: 'shopify', name: 'Shopify',
    category: 'paid_storefront_pf_sync', friction: 'instant_signup',
    url: 'https://www.shopify.com/free-trial',
    monthlyFeeUsd: 39, typicalMarginPct: 75, unlockAtMrrUsd: 1000, banRisk: 'low',
    parallelSafe: false, agingDaysBeforeNextSeller: 0,
    notes: 'BLOCKED until MRR ≥ $1k. Owns customer data, custom domain, premium brand surface. Best long-term home.',
  },
  {
    id: 'wix_ecommerce', name: 'Wix eCommerce',
    category: 'paid_storefront_pf_sync', friction: 'instant_signup',
    url: 'https://www.wix.com/ecommerce/website',
    monthlyFeeUsd: 27, typicalMarginPct: 73, unlockAtMrrUsd: 1000, banRisk: 'low',
    parallelSafe: false, agingDaysBeforeNextSeller: 0,
    notes: 'BLOCKED until MRR ≥ $1k. Lower brand-control ceiling than Shopify but cheaper.',
  },
  {
    id: 'squarespace', name: 'Squarespace Commerce',
    category: 'paid_storefront_pf_sync', friction: 'instant_signup',
    url: 'https://www.squarespace.com/templates/commerce',
    monthlyFeeUsd: 23, typicalMarginPct: 73, unlockAtMrrUsd: 1000, banRisk: 'low',
    parallelSafe: false, agingDaysBeforeNextSeller: 0,
    notes: 'BLOCKED until MRR ≥ $1k. Best portfolio + commerce combo for artists.',
  },
]

// ─── Sequencing logic ──────────────────────────────────────────────────────

export interface SequencedPlan {
  todayParallel:    PodPlatform[]      // safe to register today, in parallel
  thisWeek:         PodPlatform[]      // stagger across this week, 1-2/day
  nextWeek:         PodPlatform[]      // after this week's accounts age
  blockedByMrr:     PodPlatform[]      // need MRR threshold first
  inviteOnly:       PodPlatform[]      // need portfolio established first
  total:            number
  notes:            string[]
}

export function planSequencedRollout(currentMrrUsd: number = 0): SequencedPlan {
  const todayParallel: PodPlatform[] = []
  const thisWeek: PodPlatform[] = []
  const nextWeek: PodPlatform[] = []
  const blockedByMrr: PodPlatform[] = []
  const inviteOnly: PodPlatform[] = []

  // Already-live or in-progress platforms — exclude
  const exclude = new Set(['tiktok_shop', 'inprnt'])

  for (const p of POD_PLATFORMS) {
    if (exclude.has(p.id)) continue
    if (p.unlockAtMrrUsd > currentMrrUsd) {
      blockedByMrr.push(p)
      continue
    }
    if (p.friction === 'invite_only') {
      inviteOnly.push(p)
      continue
    }
    if (p.parallelSafe && p.friction === 'instant_signup') {
      todayParallel.push(p)
    } else if (p.friction === 'instant_signup') {
      thisWeek.push(p)
    } else {
      nextWeek.push(p)
    }
  }

  const notes: string[] = [
    `Currently live: TikTok Shop (CYZOR CREATIONS). In progress: INPRNT application.`,
    `Etsy lesson R332: simultaneous registrations trigger fraud systems. Stagger free-storefront + tax-ID accounts by ${5}–${14} days.`,
    `Standalone marketplaces (Society6/Redbubble/Zazzle/Gumroad) are parallel-safe — they don't share fraud signals.`,
    `Paid storefronts ($23–$39/mo) unlock once MRR ≥ $1k per operator constraint.`,
    `Displate requires existing portfolio. Apply AFTER INPRNT is live + a few months of activity.`,
  ]

  return {
    todayParallel, thisWeek, nextWeek, blockedByMrr, inviteOnly,
    total: POD_PLATFORMS.length - exclude.size,
    notes,
  }
}

export function findPlatform(id: string): PodPlatform | undefined {
  return POD_PLATFORMS.find(p => p.id === id)
}

export function platformsByCategory(category: PodCategory): PodPlatform[] {
  return POD_PLATFORMS.filter(p => p.category === category)
}
