/**
 * R146.347 — Publish Mechanism Registry
 *
 * Operator rule (R347, importance 98):
 *   For every POD / digital-product platform Novan touches:
 *     - If the platform has a public API  →  Novan publishes via API. Always.
 *     - If no API exists                 →  Operator publishes manually. Always.
 *
 * Reasoning:
 *   - API publishing is fast, idempotent, observable, scalable, ban-safe.
 *   - Browser automation against seller UIs trips fraud detection (R332
 *     Etsy ban lesson) and is slow + brittle.
 *
 * This file encodes the API availability + connector status for every
 * platform we care about. Driven by:
 *   - r346-gumroad-api.ts (live)
 *   - r328-connectors.ts (Printful OAuth wired, products API available)
 *   - future r347-*-api.ts files (one per API-capable platform)
 *
 * Every platform action surfaces via planPublishRoute() — returns the
 * required publish mechanism + ready/blocked status so callers route
 * correctly.
 */

export type PublishMechanism =
  | 'api'                     // platform has an API, Novan handles end-to-end
  | 'manual'                  // no API, operator handles in browser
  | 'hybrid'                  // API exists but limited (e.g. listing yes, fulfillment no)

export type ApiAvailability =
  | 'public_api'              // open API anyone can use after token generation
  | 'partner_api'             // requires partner application + review
  | 'limited_api'             // exists but functionality reduced (read-only, affiliates-only, etc.)
  | 'no_api'                  // platform offers no programmatic interface

export type ConnectorStatus =
  | 'live'                    // wired + tested in Novan
  | 'planned'                 // file slot allocated, code skeleton ready
  | 'blocked'                 // requires operator action (app review, billing, etc.)
  | 'not_started'             // no work yet

export interface PlatformPublishProfile {
  id:               string
  name:             string
  mechanism:        PublishMechanism
  apiAvailability:  ApiAvailability
  connectorStatus:  ConnectorStatus
  apiDocsUrl?:      string
  novanModule?:     string                          // file in apps/api/src/services
  operatorActions?: string[]                        // what operator must do to unblock
  notes:            string
}

export const PUBLISH_PROFILES: PlatformPublishProfile[] = [
  // ── API-publishable (Novan autonomous) ──────────────────────────────────
  {
    id: 'gumroad', name: 'Gumroad',
    mechanism: 'api', apiAvailability: 'public_api', connectorStatus: 'live',
    apiDocsUrl: 'https://app.gumroad.com/api',
    novanModule: 'r346-gumroad-api.ts',
    notes: 'R346 LIVE. POST /v2/products + PUT /v2/products/:id/enable. Operator generates token at gumroad.com/settings/advanced. Used for digital downloads and physical via Stripe.',
  },
  {
    id: 'printful', name: 'Printful',
    mechanism: 'api', apiAvailability: 'public_api', connectorStatus: 'live',
    apiDocsUrl: 'https://developers.printful.com/',
    novanModule: 'r328-connectors.ts + printful endpoints',
    notes: 'OAuth wired R332. POST /v2/sync/products creates listings, /v2/orders/estimate-costs, etc. Sync stores (TikTok Shop, Shopify, Etsy) auto-publish products created here.',
  },
  {
    id: 'tiktok_shop', name: 'TikTok Shop',
    mechanism: 'api', apiAvailability: 'partner_api', connectorStatus: 'blocked',
    apiDocsUrl: 'https://partner.tiktokshop.com/docv2',
    novanModule: '(future) r347-tiktok-shop-api.ts',
    operatorActions: [
      'Apply for TikTok Shop Open Platform at partner.tiktokshop.com',
      'Wait for app review (typically 1-2 weeks)',
      'On approval: copy AppKey + AppSecret to .env',
    ],
    notes: 'Direct API path blocked on app review. WORKAROUND TODAY: publish via Printful (R332 wired), which auto-syncs to TikTok Shop because they have their own integration. No Novan code needed.',
  },
  {
    id: 'ebay', name: 'eBay',
    mechanism: 'api', apiAvailability: 'public_api', connectorStatus: 'planned',
    apiDocsUrl: 'https://developer.ebay.com/api-docs/sell/inventory/overview.html',
    novanModule: '(future) r347-ebay-api.ts',
    operatorActions: ['Apply for eBay developer account; takes 24-48h; cap on listings until rep built'],
    notes: 'Sell Inventory API + Sell Account API. POST /inventory/v1/inventory_item then publishOffer. Production cap: 10 listings/mo for new sellers, scales with feedback score.',
  },
  {
    id: 'shopify', name: 'Shopify',
    mechanism: 'api', apiAvailability: 'public_api', connectorStatus: 'not_started',
    apiDocsUrl: 'https://shopify.dev/docs/api/admin',
    novanModule: '(future) r347-shopify-api.ts',
    notes: 'GraphQL Admin API. Blocked at $39/mo gate per operator constraint (unlock at $1k MRR). Once unlocked: mutation productCreate creates listings end-to-end.',
  },
  {
    id: 'square_online', name: 'Square Online',
    mechanism: 'api', apiAvailability: 'public_api', connectorStatus: 'planned',
    apiDocsUrl: 'https://developer.squareup.com/reference/square/catalog-api',
    novanModule: '(future) r347-square-api.ts',
    notes: 'Catalog + Inventory API. POST /v2/catalog/object creates catalog items.',
  },
  {
    id: 'ecwid', name: 'Ecwid',
    mechanism: 'api', apiAvailability: 'public_api', connectorStatus: 'not_started',
    apiDocsUrl: 'https://api-docs.ecwid.com/',
    novanModule: '(future) r347-ecwid-api.ts',
    notes: 'POST /api/v3/{storeId}/products. Free tier has 5-product cap; API still works.',
  },
  {
    id: 'wix_ecommerce', name: 'Wix eCommerce',
    mechanism: 'api', apiAvailability: 'public_api', connectorStatus: 'not_started',
    apiDocsUrl: 'https://dev.wix.com/api/rest/stores',
    novanModule: '(future) r347-wix-api.ts',
    notes: 'POST /stores/v1/products. Blocked at $27/mo gate per operator constraint.',
  },

  // ── Manual publish (operator territory — no usable artist API) ──────────
  {
    id: 'inprnt', name: 'INPRNT',
    mechanism: 'manual', apiAvailability: 'no_api', connectorStatus: 'not_started',
    operatorActions: ['Apply at inprnt.com/application/', 'Wait 3-7 days for approval', 'Upload images via web UI'],
    notes: 'No public artist API. Operator uploads via web UI. Premium audience compensates for the manual workflow.',
  },
  {
    id: 'society6', name: 'Society6',
    mechanism: 'manual', apiAvailability: 'no_api', connectorStatus: 'not_started',
    operatorActions: ['Sign up at society6.com/become-an-artist', 'Upload images via web UI'],
    notes: 'No public artist API. Operator uploads via web UI.',
  },
  {
    id: 'redbubble', name: 'Redbubble',
    mechanism: 'manual', apiAvailability: 'no_api', connectorStatus: 'not_started',
    operatorActions: ['Sign up at redbubble.com/account/sell', 'Upload images via web UI'],
    notes: 'No public artist API. Operator uploads via web UI. Bulk-upload via CSV available in dashboard for paid plans.',
  },
  {
    id: 'zazzle', name: 'Zazzle',
    mechanism: 'manual', apiAvailability: 'limited_api', connectorStatus: 'not_started',
    apiDocsUrl: 'https://asp.zazzle.com/dev',
    operatorActions: ['Sign up at zazzle.com/sell', 'Upload images via web UI'],
    notes: 'Zazzle Affiliate API exists for promotion but no creator-side API for posting designs. Operator uploads via web UI.',
  },
  {
    id: 'fine_art_america', name: 'Fine Art America',
    mechanism: 'manual', apiAvailability: 'no_api', connectorStatus: 'not_started',
    operatorActions: ['Already signed up as Chris Spangler', 'Upload images via web UI at fineartamerica.com/profiles/2-chris-spangler'],
    notes: 'No public artist API. Operator uploads via web UI. R343 set premium markup defaults, AI keywords on, etc.',
  },
  {
    id: 'spreadshirt', name: 'Spreadshirt',
    mechanism: 'manual', apiAvailability: 'limited_api', connectorStatus: 'not_started',
    apiDocsUrl: 'https://developer.spreadshirt.net/',
    operatorActions: ['Sign up at spreadshirt.com/sell-online', 'Upload via web UI'],
    notes: 'Partner Marketplace API exists but limited to enterprise/agency tier. Standard creators use web UI.',
  },
  {
    id: 'teepublic', name: 'TeePublic',
    mechanism: 'manual', apiAvailability: 'no_api', connectorStatus: 'not_started',
    notes: 'No public artist API. Operator uploads via web UI.',
  },
  {
    id: 'displate', name: 'Displate',
    mechanism: 'manual', apiAvailability: 'no_api', connectorStatus: 'not_started',
    operatorActions: ['Submit portfolio at displate.com/sell', 'Wait for invite'],
    notes: 'Invite-only. No API. Operator uploads via web UI post-invite.',
  },

  // ── Digital products beyond POD ─────────────────────────────────────────
  {
    id: 'patreon', name: 'Patreon',
    mechanism: 'api', apiAvailability: 'public_api', connectorStatus: 'planned',
    apiDocsUrl: 'https://docs.patreon.com/',
    novanModule: '(future) r347-patreon-api.ts',
    notes: 'OAuth + REST API. POST /v2/posts can publish posts to tiers. Useful for subscription-based digital art delivery.',
  },
  {
    id: 'youtube_partner', name: 'YouTube (Partner)',
    mechanism: 'api', apiAvailability: 'public_api', connectorStatus: 'not_started',
    apiDocsUrl: 'https://developers.google.com/youtube/v3',
    novanModule: '(future) r347-youtube-api.ts',
    notes: 'OAuth + Data API v3. videos.insert for uploads. Monetization requires YPP eligibility (1k subs + 4k watch hours).',
  },
  {
    id: 'substack', name: 'Substack',
    mechanism: 'manual', apiAvailability: 'limited_api', connectorStatus: 'not_started',
    notes: 'Public API minimal (read-only feeds). Posts created via web UI or email-to-publish. Operator publishes.',
  },
  {
    id: 'bandcamp', name: 'Bandcamp',
    mechanism: 'manual', apiAvailability: 'no_api', connectorStatus: 'not_started',
    notes: 'No public artist API for uploads. Operator uploads via web UI.',
  },
]

// ─── Routing logic ──────────────────────────────────────────────────────────

export interface PublishRoute {
  platformId:           string
  platformName:         string
  mechanism:            PublishMechanism
  ready:                boolean                  // true = can execute now
  blockReason?:         string
  novanAction?:         string                   // brain-task op to run if ready=true
  operatorAction?:      string                   // what operator does if ready=false
}

export function planPublishRoute(platformId: string): PublishRoute | null {
  const p = PUBLISH_PROFILES.find(x => x.id === platformId)
  if (!p) return null
  if (p.mechanism === 'manual') {
    return {
      platformId,
      platformName:   p.name,
      mechanism:      'manual',
      ready:          false,
      blockReason:    p.apiAvailability === 'no_api'
                       ? 'platform has no public API for creators — manual web-UI publish required'
                       : 'API exists but does not support creator-side publish on free tier',
      operatorAction: (p.operatorActions ?? []).join(' → '),
    }
  }
  // mechanism === 'api' or 'hybrid'
  if (p.connectorStatus === 'live') {
    return {
      platformId,
      platformName: p.name,
      mechanism:    p.mechanism,
      ready:        true,
      ...(p.id === 'gumroad'  ? { novanAction: 'gumroad.publish_first_three' } : {}),
      ...(p.id === 'printful' ? { novanAction: 'printful.create_product' }     : {}),
    }
  }
  return {
    platformId,
    platformName:   p.name,
    mechanism:      p.mechanism,
    ready:          false,
    blockReason:    `connector_status=${p.connectorStatus}`,
    ...(p.operatorActions ? { operatorAction: p.operatorActions.join(' → ') } : {}),
  }
}

export function listByMechanism(mechanism: PublishMechanism): PlatformPublishProfile[] {
  return PUBLISH_PROFILES.filter(p => p.mechanism === mechanism)
}

export function listReady(): PublishRoute[] {
  return PUBLISH_PROFILES
    .map(p => planPublishRoute(p.id))
    .filter((r): r is PublishRoute => r !== null && r.ready)
}

export function listBlockedNeedingOperator(): PublishRoute[] {
  return PUBLISH_PROFILES
    .map(p => planPublishRoute(p.id))
    .filter((r): r is PublishRoute => r !== null && !r.ready && !!r.operatorAction)
}

export interface PublishMechanismReport {
  totalPlatforms:        number
  apiCapable:            number
  manualOnly:            number
  liveConnectors:        number
  plannedConnectors:     number
  blockedConnectors:     number
  apiReadyToday:         string[]                     // platform names usable now
  apiBlockedOnOperator:  Array<{ platform: string; action: string }>
}

export function publishMechanismReport(): PublishMechanismReport {
  const apiCapable = PUBLISH_PROFILES.filter(p => p.mechanism === 'api').length
  const manualOnly = PUBLISH_PROFILES.filter(p => p.mechanism === 'manual').length
  const live      = PUBLISH_PROFILES.filter(p => p.connectorStatus === 'live').length
  const planned   = PUBLISH_PROFILES.filter(p => p.connectorStatus === 'planned').length
  const blocked   = PUBLISH_PROFILES.filter(p => p.connectorStatus === 'blocked').length
  return {
    totalPlatforms:        PUBLISH_PROFILES.length,
    apiCapable, manualOnly,
    liveConnectors:        live,
    plannedConnectors:     planned,
    blockedConnectors:     blocked,
    apiReadyToday:         PUBLISH_PROFILES.filter(p => p.mechanism === 'api' && p.connectorStatus === 'live').map(p => p.name),
    apiBlockedOnOperator:  PUBLISH_PROFILES
      .filter(p => p.mechanism === 'api' && (p.connectorStatus === 'blocked' || p.connectorStatus === 'planned') && p.operatorActions)
      .map(p => ({ platform: p.name, action: (p.operatorActions ?? []).join(' → ') })),
  }
}
