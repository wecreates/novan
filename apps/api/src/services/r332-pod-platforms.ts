/**
 * R146.332 — POD platform registry.
 *
 * Three buckets:
 *   A. PRINTFUL_INTEGRATIONS — platforms that auto-sync with Printful
 *      (no separate fulfillment; Printful handles print + ship for orders
 *      placed there).
 *   B. PUBLISH_TARGETS       — social platforms Novan posts CONTENT to
 *      that drive traffic back to wherever the operator sells.
 *   C. POD_STANDALONE        — POD marketplaces operator can list to
 *      independently (Printful doesn't integrate; operator uploads designs
 *      directly; the marketplace handles fulfillment).
 *
 * Each entry: signupUrl (for the operator) + devConsoleUrl (for OAuth /
 * API setup) + integrationKind + current Novan wiring status.
 */

export interface Platform {
  id:           string
  name:         string
  signupUrl:    string
  devConsoleUrl?: string
  storefrontUrl?: string
  integrationKind: 'direct-printful' | 'social' | 'standalone-pod' | 'payment'
  oauthSupported?: boolean
  novanStatus:  'wired' | 'scaffolded' | 'not-wired'
  notes?:       string
  // R332 — cost + margin constraints
  monthlyFeeUsd?: number              // recurring; 0 = free tier exists
  perTransactionFeePct?: number       // marketplace take rate
  perTransactionFeeFlatUsd?: number   // listing fee / payment processing
  typicalOperatorMarginPct?: number   // what's left for operator after Printful base cost + marketplace fee
  competitiveEndPriceTier?: 'cheap' | 'mid' | 'premium'
  unlockAtMrr?: number                // gate "open this when MRR crosses $X"
}

// ─── A. Platforms that auto-sync with Printful ──────────────────────────
// monthlyFeeUsd: 0 means "free tier available" — open NOW.
// >0 means paid only — gated behind unlockAtMrr.
export const PRINTFUL_INTEGRATIONS: Platform[] = [
  // ━━━ FREE NOW ━━━
  { id: 'etsy',        name: 'Etsy',           signupUrl: 'https://www.etsy.com/sell',                    devConsoleUrl: 'https://www.etsy.com/developers/your-apps', integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'scaffolded', monthlyFeeUsd: 0, perTransactionFeePct: 6.5, perTransactionFeeFlatUsd: 0.20, typicalOperatorMarginPct: 30, competitiveEndPriceTier: 'mid', notes: 'R112+R332 OAuth wired. $0.20/listing for 4mo + 6.5% transaction. No monthly fee.' },
  { id: 'tiktokshop',  name: 'TikTok Shop',    signupUrl: 'https://seller-us.tiktok.com/',                devConsoleUrl: 'https://partner.tiktokshop.com/docv2/',      integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired',  monthlyFeeUsd: 0, perTransactionFeePct: 6,   typicalOperatorMarginPct: 25, competitiveEndPriceTier: 'cheap', notes: 'Free to sell. 5-6% transaction + payment fee. Highest growth-of-buyer surface 2024-2025.' },
  { id: 'gumroad',     name: 'Gumroad',        signupUrl: 'https://app.gumroad.com/signup',               devConsoleUrl: 'https://gumroad.com/api',                    integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'scaffolded', monthlyFeeUsd: 0, perTransactionFeePct: 10,  typicalOperatorMarginPct: 25, competitiveEndPriceTier: 'mid', notes: 'Free. 10% flat. Easy for digital + POD mix.' },
  { id: 'storenvy',    name: 'Storenvy',       signupUrl: 'https://www.storenvy.com/stores/new',          integrationKind: 'direct-printful', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, perTransactionFeePct: 10, typicalOperatorMarginPct: 25, competitiveEndPriceTier: 'cheap', notes: 'Free indie storefront. Built-in marketplace browsers.' },
  { id: 'bigcartel',   name: 'Big Cartel',     signupUrl: 'https://www.bigcartel.com/signup',             devConsoleUrl: 'https://developers.bigcartel.com/',          integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 0, perTransactionFeePct: 0, typicalOperatorMarginPct: 40, competitiveEndPriceTier: 'mid', notes: 'Free tier = 5 products. No transaction fee.' },
  { id: 'ecwid',       name: 'Ecwid',          signupUrl: 'https://www.ecwid.com/signup',                 devConsoleUrl: 'https://developers.ecwid.com/',              integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 0, perTransactionFeePct: 0, typicalOperatorMarginPct: 40, competitiveEndPriceTier: 'mid', notes: 'Free tier = 5 products. Embeds into existing site.' },
  { id: 'square',      name: 'Square Online',  signupUrl: 'https://squareup.com/signup',                  devConsoleUrl: 'https://developer.squareup.com/apps',        integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 0, perTransactionFeePct: 2.9, typicalOperatorMarginPct: 35, competitiveEndPriceTier: 'mid', notes: 'Free tier. 2.9%+$0.30 transaction.' },
  { id: 'weebly',      name: 'Weebly',         signupUrl: 'https://www.weebly.com/signup',                integrationKind: 'direct-printful', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, perTransactionFeePct: 3, typicalOperatorMarginPct: 35, competitiveEndPriceTier: 'mid', notes: 'Free tier; Square-owned.' },
  { id: 'ebay',        name: 'eBay',           signupUrl: 'https://reg.ebay.com/reg/PartialReg',          devConsoleUrl: 'https://developer.ebay.com/my/keys',         integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 0, perTransactionFeePct: 13, typicalOperatorMarginPct: 20, competitiveEndPriceTier: 'cheap', notes: '250 free listings/mo. 13% take rate. Massive search traffic.' },

  // ━━━ PAID — gated until MRR ≥ $1,000 ━━━
  { id: 'shopify',     name: 'Shopify',        signupUrl: 'https://www.shopify.com/signup',                devConsoleUrl: 'https://partners.shopify.com/',           integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'scaffolded', monthlyFeeUsd: 39, typicalOperatorMarginPct: 40, competitiveEndPriceTier: 'mid', unlockAtMrr: 1000, notes: '$39/mo Basic. Worth it once volume justifies — full control over brand.' },
  { id: 'wix',         name: 'Wix',            signupUrl: 'https://www.wix.com/start',                    devConsoleUrl: 'https://dev.wix.com/',                       integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 17, typicalOperatorMarginPct: 38, competitiveEndPriceTier: 'mid', unlockAtMrr: 1000 },
  { id: 'squarespace', name: 'Squarespace',    signupUrl: 'https://www.squarespace.com/get-started',      devConsoleUrl: 'https://developers.squarespace.com/',        integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 16, typicalOperatorMarginPct: 38, competitiveEndPriceTier: 'mid', unlockAtMrr: 1000 },
  { id: 'bigcommerce', name: 'BigCommerce',    signupUrl: 'https://www.bigcommerce.com/start-your-trial/', devConsoleUrl: 'https://developer.bigcommerce.com/',         integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 39, typicalOperatorMarginPct: 40, competitiveEndPriceTier: 'mid', unlockAtMrr: 1000 },
  { id: 'webflow',     name: 'Webflow',        signupUrl: 'https://webflow.com/signup',                   devConsoleUrl: 'https://developers.webflow.com/',            integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 14, typicalOperatorMarginPct: 40, competitiveEndPriceTier: 'mid', unlockAtMrr: 1000 },
  { id: 'woocommerce', name: 'WooCommerce',    signupUrl: 'https://woocommerce.com/start/',               devConsoleUrl: 'https://woocommerce.com/document/woocommerce-rest-api/', integrationKind: 'direct-printful', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 10, typicalOperatorMarginPct: 42, competitiveEndPriceTier: 'mid', unlockAtMrr: 1000, notes: 'WordPress plugin; needs hosting (~$5-10/mo).' },
  { id: 'amazon',      name: 'Amazon',         signupUrl: 'https://sell.amazon.com/',                     devConsoleUrl: 'https://sellercentral.amazon.com/sw/AccountManager/DeveloperCentral', integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 39.99, perTransactionFeePct: 15, typicalOperatorMarginPct: 18, competitiveEndPriceTier: 'cheap', unlockAtMrr: 1000, notes: '$39.99/mo Pro Seller + 15% referral fee. Worth it at scale.' },
  { id: 'prestashop',  name: 'PrestaShop',     signupUrl: 'https://www.prestashop.com/',                  integrationKind: 'direct-printful', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 10, typicalOperatorMarginPct: 40, unlockAtMrr: 1000 },
  { id: 'magento',     name: 'Magento',        signupUrl: 'https://magento.com/',                         integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 100, typicalOperatorMarginPct: 40, unlockAtMrr: 5000, notes: 'Enterprise-scale only.' },
]

// ─── B. Social platforms Novan posts CONTENT to ────────────────────────
export const PUBLISH_TARGETS: Platform[] = [
  { id: 'tiktok',      name: 'TikTok',         signupUrl: 'https://www.tiktok.com/signup',                devConsoleUrl: 'https://developers.tiktok.com/',             integrationKind: 'social', oauthSupported: true, novanStatus: 'scaffolded', notes: 'R331 #11 upload op queue ready; needs TikTok dev app + OAuth.' },
  { id: 'youtube',     name: 'YouTube',        signupUrl: 'https://accounts.google.com/signup',           devConsoleUrl: 'https://console.cloud.google.com/apis/credentials', integrationKind: 'social', oauthSupported: true, novanStatus: 'scaffolded', notes: 'R331 #12 upload op queue ready; uses Google OAuth.' },
  { id: 'instagram',   name: 'Instagram',      signupUrl: 'https://www.instagram.com/accounts/emailsignup/', devConsoleUrl: 'https://developers.facebook.com/apps/',      integrationKind: 'social', oauthSupported: true, novanStatus: 'scaffolded', notes: 'R331 #13. Reels API via Meta Graph API; complex.' },
  { id: 'x',           name: 'X (Twitter)',    signupUrl: 'https://twitter.com/i/flow/signup',            devConsoleUrl: 'https://developer.twitter.com/en/portal/dashboard', integrationKind: 'social', oauthSupported: true, novanStatus: 'scaffolded', notes: 'R331 #14. Free tier limited; Basic $100/mo for posting at volume.' },
  { id: 'reddit',      name: 'Reddit',         signupUrl: 'https://www.reddit.com/register/',             devConsoleUrl: 'https://www.reddit.com/prefs/apps',          integrationKind: 'social', oauthSupported: true, novanStatus: 'scaffolded', notes: 'R331 #15. Cheapest first-traction surface for POD niches.' },
  { id: 'pinterest',   name: 'Pinterest',      signupUrl: 'https://www.pinterest.com/business/create/',   devConsoleUrl: 'https://developers.pinterest.com/apps/',     integrationKind: 'social', oauthSupported: true, novanStatus: 'scaffolded', notes: 'R331 #16. Slept-on for POD — high intent.' },
  { id: 'facebook',    name: 'Facebook',       signupUrl: 'https://www.facebook.com/r.php',               devConsoleUrl: 'https://developers.facebook.com/apps/',      integrationKind: 'social', oauthSupported: true, novanStatus: 'not-wired' },
  { id: 'threads',     name: 'Threads',        signupUrl: 'https://www.threads.net/',                     devConsoleUrl: 'https://developers.facebook.com/docs/threads', integrationKind: 'social', oauthSupported: true, novanStatus: 'not-wired' },
  { id: 'linkedin',    name: 'LinkedIn',       signupUrl: 'https://www.linkedin.com/signup',              devConsoleUrl: 'https://www.linkedin.com/developers/apps',   integrationKind: 'social', oauthSupported: true, novanStatus: 'not-wired' },
]

// ─── C. POD marketplaces NOT integrated with Printful ──────────────────
// Sorted descending by typicalOperatorMarginPct.
// Operator keeps the most $ on INPRNT and Society6 art prints,
// but those have higher base prices — customer-price-friendly tier shown
// per row so we balance margin vs. price-competitiveness.
export const POD_STANDALONE: Platform[] = [
  { id: 'inprnt',      name: 'INPRNT',         signupUrl: 'https://www.inprnt.com/info/sell/',            integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 50, competitiveEndPriceTier: 'premium', notes: 'HIGHEST MARGIN. 50% on art prints. Curated — application + portfolio required. Buyers expect quality, accept premium pricing.' },
  { id: 'displate',    name: 'Displate',       signupUrl: 'https://displate.com/sell-art',                integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 38, competitiveEndPriceTier: 'premium', notes: 'Metal posters only. 25-50% margin tier. Premium product, customers accept higher price for the medium.' },
  { id: 'society6',    name: 'Society6',       signupUrl: 'https://society6.com/signup',                  integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 30, competitiveEndPriceTier: 'premium', notes: 'Art-focused buyer pool. 10% on apparel, ~30% on art prints. Premium-friendly customer base.' },
  { id: 'zazzle',      name: 'Zazzle',         signupUrl: 'https://www.zazzle.com/my/account/create',     integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 25, competitiveEndPriceTier: 'mid', notes: 'You set markup up to 99% — but high markups kill sales. Realistic 15-30%. Has frequent buyer discounts that compress margin.' },
  { id: 'spreadshirt', name: 'Spreadshirt',    signupUrl: 'https://www.spreadshirt.com/shop/signup',      devConsoleUrl: 'https://developer.spreadshirt.com/',        integrationKind: 'standalone-pod', oauthSupported: true,  novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 25, competitiveEndPriceTier: 'mid', notes: 'EU-dominant. Public API exists. Decent margin on a mid-priced platform.' },
  { id: 'merchamazon', name: 'Merch by Amazon', signupUrl: 'https://merch.amazon.com/landing',            integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 22, competitiveEndPriceTier: 'cheap', notes: '13-37% royalty. Invite-only. Amazon traffic = volume. Mid-margin offset by free audience.' },
  { id: 'threadless',  name: 'Threadless',     signupUrl: 'https://www.threadless.com/login',             integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 20, competitiveEndPriceTier: 'mid', notes: '~33% on art-print products, lower on apparel. Buyers expect indie/quirky designs.' },
  { id: 'redbubble',   name: 'Redbubble',      signupUrl: 'https://www.redbubble.com/auth/register',      integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 20, competitiveEndPriceTier: 'cheap', notes: 'Massive built-in audience. ~20% margin standard. Cheap-customer profile — race-to-the-bottom warning.' },
  { id: 'spring',      name: 'Spring (TeeSpring)', signupUrl: 'https://spri.ng/start',                    integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 15, competitiveEndPriceTier: 'cheap', notes: 'You set markup but realistic margin lower. Best when you already have YouTube/TikTok audience.' },
  { id: 'teepublic',   name: 'TeePublic',      signupUrl: 'https://www.teepublic.com/registrations/new',  integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', monthlyFeeUsd: 0, typicalOperatorMarginPct: 8, competitiveEndPriceTier: 'cheap', notes: 'LOWEST MARGIN here. Redbubble-owned. ~6-10% take. Use only as 4th-tier surface.' },
]

// ─── D. Payment processors (orthogonal to POD) ─────────────────────────
export const PAYMENT_PROCESSORS: Platform[] = [
  { id: 'stripe',  name: 'Stripe',  signupUrl: 'https://dashboard.stripe.com/register',  devConsoleUrl: 'https://dashboard.stripe.com/apikeys',    integrationKind: 'payment', oauthSupported: true,  novanStatus: 'scaffolded' },
  { id: 'paypal',  name: 'PayPal',  signupUrl: 'https://www.paypal.com/us/business',     devConsoleUrl: 'https://developer.paypal.com/dashboard/applications', integrationKind: 'payment', oauthSupported: true, novanStatus: 'not-wired' },
]

// ─── Aggregator ─────────────────────────────────────────────────────────
export interface PlatformsRegistry {
  printful_integrations: Platform[]
  publish_targets:       Platform[]
  pod_standalone:        Platform[]
  payment_processors:    Platform[]
  recommended_starting_lineup: { platform: string; reason: string }[]
}

export function podPlatforms(): PlatformsRegistry {
  return {
    printful_integrations: PRINTFUL_INTEGRATIONS,
    publish_targets:       PUBLISH_TARGETS,
    pod_standalone:        POD_STANDALONE,
    payment_processors:    PAYMENT_PROCESSORS,
    recommended_starting_lineup: [
      { platform: 'etsy',       reason: 'PRIMARY STOREFRONT — $0 monthly. Direct Printful auto-sync. First sale 7-14d.' },
      { platform: 'tiktokshop', reason: 'SECONDARY STOREFRONT — $0 monthly. Direct Printful auto-sync. Highest 2025 growth surface.' },
      { platform: 'inprnt',     reason: 'HIGHEST-MARGIN STANDALONE (50%). Requires approval — apply early, premium-tier buyers.' },
      { platform: 'society6',   reason: 'MID-PREMIUM STANDALONE (30%). Art-focused buyers accept higher prices.' },
      { platform: 'pinterest',  reason: 'TRAFFIC ENGINE — pin designs → Etsy/TikTok Shop listings. Slept-on for POD.' },
      { platform: 'reddit',     reason: 'FREE FIRST TRACTION — niche subreddits. Participate, don\'t spam.' },
      { platform: 'tiktok',     reason: 'TREND-HIJACK once audience grows — drives traffic to storefronts.' },
    ],
  }
}

// ─── Constraint helpers ─────────────────────────────────────────────────
export function freeStorefrontsOnly(): Platform[] {
  return PRINTFUL_INTEGRATIONS.filter(p => (p.monthlyFeeUsd ?? 0) === 0)
}

export function unlockedAtMrr(monthlyRevenueUsd: number): Platform[] {
  return PRINTFUL_INTEGRATIONS.filter(p => {
    const fee = p.monthlyFeeUsd ?? 0
    if (fee === 0) return true
    const gate = p.unlockAtMrr ?? 0
    return monthlyRevenueUsd >= gate
  })
}

export function highestMarginStandalone(maxPriceTier: 'cheap' | 'mid' | 'premium' = 'mid'): Platform[] {
  const tierRank: Record<string, number> = { cheap: 0, mid: 1, premium: 2 }
  const cap = tierRank[maxPriceTier] ?? 1
  return POD_STANDALONE
    .filter(p => tierRank[p.competitiveEndPriceTier ?? 'mid']! <= cap)
    .sort((a, b) => (b.typicalOperatorMarginPct ?? 0) - (a.typicalOperatorMarginPct ?? 0))
}

