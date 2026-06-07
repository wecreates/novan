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
}

// ─── A. Platforms that auto-sync with Printful ──────────────────────────
export const PRINTFUL_INTEGRATIONS: Platform[] = [
  { id: 'shopify',     name: 'Shopify',        signupUrl: 'https://www.shopify.com/signup',                devConsoleUrl: 'https://partners.shopify.com/',           integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'scaffolded', notes: 'R117 wired the connector module; needs Shopify Partners app + OAuth.' },
  { id: 'etsy',        name: 'Etsy',           signupUrl: 'https://www.etsy.com/sell',                    devConsoleUrl: 'https://www.etsy.com/developers/your-apps', integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'scaffolded', notes: 'R112 + R332 OAuth wired. Operator must register dev app + paste creds.' },
  { id: 'ebay',        name: 'eBay',           signupUrl: 'https://reg.ebay.com/reg/PartialReg',          devConsoleUrl: 'https://developer.ebay.com/my/keys',         integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired',  notes: 'Printful direct sync; Novan can add to OAUTH_PROVIDERS in one commit.' },
  { id: 'amazon',      name: 'Amazon',         signupUrl: 'https://sell.amazon.com/',                     devConsoleUrl: 'https://sellercentral.amazon.com/sw/AccountManager/DeveloperCentral', integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired',  notes: 'Pro Seller required ($39.99/mo); high barrier — start elsewhere first.' },
  { id: 'woocommerce', name: 'WooCommerce',    signupUrl: 'https://woocommerce.com/start/',               devConsoleUrl: 'https://woocommerce.com/document/woocommerce-rest-api/', integrationKind: 'direct-printful', oauthSupported: false, novanStatus: 'not-wired',  notes: 'API key auth (not OAuth). Plugin install + REST keys.' },
  { id: 'squarespace', name: 'Squarespace',    signupUrl: 'https://www.squarespace.com/get-started',      devConsoleUrl: 'https://developers.squarespace.com/',        integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired' },
  { id: 'wix',         name: 'Wix',            signupUrl: 'https://www.wix.com/start',                    devConsoleUrl: 'https://dev.wix.com/',                       integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired' },
  { id: 'bigcommerce', name: 'BigCommerce',    signupUrl: 'https://www.bigcommerce.com/start-your-trial/', devConsoleUrl: 'https://developer.bigcommerce.com/',         integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired' },
  { id: 'webflow',     name: 'Webflow',        signupUrl: 'https://webflow.com/signup',                   devConsoleUrl: 'https://developers.webflow.com/',            integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired' },
  { id: 'prestashop',  name: 'PrestaShop',     signupUrl: 'https://www.prestashop.com/',                  integrationKind: 'direct-printful', oauthSupported: false, novanStatus: 'not-wired' },
  { id: 'magento',     name: 'Magento',        signupUrl: 'https://magento.com/',                         integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired' },
  { id: 'storenvy',    name: 'Storenvy',       signupUrl: 'https://www.storenvy.com/stores/new',          integrationKind: 'direct-printful', oauthSupported: false, novanStatus: 'not-wired' },
  { id: 'ecwid',       name: 'Ecwid',          signupUrl: 'https://www.ecwid.com/signup',                 devConsoleUrl: 'https://developers.ecwid.com/',              integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired' },
  { id: 'gumroad',     name: 'Gumroad',        signupUrl: 'https://app.gumroad.com/signup',               devConsoleUrl: 'https://gumroad.com/api',                    integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'scaffolded', notes: 'R331 #37 — queue gumroad upload op; OAuth not yet in providers.' },
  { id: 'tiktokshop',  name: 'TikTok Shop',    signupUrl: 'https://seller-us.tiktok.com/',                devConsoleUrl: 'https://partner.tiktokshop.com/docv2/',      integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired',  notes: 'Fastest-growing POD funnel; integrate after Etsy works.' },
  { id: 'weebly',      name: 'Weebly',         signupUrl: 'https://www.weebly.com/signup',                integrationKind: 'direct-printful', oauthSupported: false, novanStatus: 'not-wired' },
  { id: 'bigcartel',   name: 'Big Cartel',     signupUrl: 'https://www.bigcartel.com/signup',             devConsoleUrl: 'https://developers.bigcartel.com/',          integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired' },
  { id: 'square',      name: 'Square',         signupUrl: 'https://squareup.com/signup',                  devConsoleUrl: 'https://developer.squareup.com/apps',        integrationKind: 'direct-printful', oauthSupported: true,  novanStatus: 'not-wired' },
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
// (operator uploads designs directly; marketplace handles print + ship)
export const POD_STANDALONE: Platform[] = [
  { id: 'redbubble',   name: 'Redbubble',      signupUrl: 'https://www.redbubble.com/auth/register',      integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', notes: 'Massive built-in audience; lower margins. Manual upload OR scraped automation.' },
  { id: 'teepublic',   name: 'TeePublic',      signupUrl: 'https://www.teepublic.com/registrations/new',  integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', notes: 'Owned by Redbubble. Similar profile.' },
  { id: 'society6',    name: 'Society6',       signupUrl: 'https://society6.com/signup',                  integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', notes: 'Art-focused. Higher-quality buyer.' },
  { id: 'zazzle',      name: 'Zazzle',         signupUrl: 'https://www.zazzle.com/my/account/create',     integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired' },
  { id: 'spreadshirt', name: 'Spreadshirt',    signupUrl: 'https://www.spreadshirt.com/shop/signup',      devConsoleUrl: 'https://developer.spreadshirt.com/',        integrationKind: 'standalone-pod', oauthSupported: true,  novanStatus: 'not-wired', notes: 'EU-strong. Spreadshop has a public API.' },
  { id: 'threadless',  name: 'Threadless',     signupUrl: 'https://www.threadless.com/login',             integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired' },
  { id: 'merchamazon', name: 'Merch by Amazon', signupUrl: 'https://merch.amazon.com/landing',            integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', notes: 'Invite-only. Apply + wait.' },
  { id: 'spring',      name: 'Spring (TeeSpring)', signupUrl: 'https://spri.ng/start',                    integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', notes: 'Creator-focused. Mostly for influencers with existing audience.' },
  { id: 'displate',    name: 'Displate',       signupUrl: 'https://displate.com/sell-art',                integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', notes: 'Metal posters only. Premium pricing.' },
  { id: 'inprnt',      name: 'INPRNT',         signupUrl: 'https://www.inprnt.com/info/sell/',            integrationKind: 'standalone-pod', oauthSupported: false, novanStatus: 'not-wired', notes: 'Curated; art prints only.' },
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
      { platform: 'etsy',      reason: 'Lowest friction storefront with Printful auto-sync. First sale possible in 7-14 days.' },
      { platform: 'pinterest', reason: 'Slept-on traffic source for POD. Operator pins designs → clicks land at Etsy listing.' },
      { platform: 'tiktok',    reason: 'Trend-hijack content drives spikes — only useful once you have audience.' },
      { platform: 'reddit',    reason: 'Free first traction in niche subreddits. Avoid spam; participate in community.' },
      { platform: 'redbubble', reason: 'Secondary surface — list same designs there for built-in marketplace traffic. Lower margin but free audience.' },
    ],
  }
}
