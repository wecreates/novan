/**
 * connector-etsy.ts — Etsy Open API v3 endpoint wrappers.
 *
 * Mirrors the YouTube connector pattern (round 118): builds on
 * connector-base for OAuth + REST + rate-limit + retry.
 *
 * High-value endpoints for a POD / e-commerce operator:
 *   - getMe / getShops            — verify auth + identify shops the operator owns
 *   - listListings                — recent listings on a shop
 *   - createDraftListing          — operator-approved draft creation
 *   - updateListing               — title / description / tags / price / inventory
 *   - uploadListingImage          — image upload to a listing
 *   - listOrders                  — recent transactions for fulfillment
 *   - getOrderReceipt             — full order detail
 *   - createListingTranslation    — multi-language listings
 *   - listReviews                 — fetch reviews on a listing
 *
 * Honest scope:
 *   - All write operations gated by approval_token="OPERATOR_APPROVED"
 *     because Etsy listings affect a live storefront and customer trust.
 *   - Image upload requires multipart/form-data; we issue manually
 *     (connectorRequest is JSON-only).
 *   - Etsy uses page-based pagination; this module returns one page
 *     per call. Caller iterates by passing offset.
 *   - Rate limits: Etsy enforces 10 req/sec + 10,000 req/day per app;
 *     connector-base honours the 10 req/sec, daily quota tracked here.
 */
import { connectorRequest, getConnectorSpec } from './connector-base.js'
import { recordAiUsage } from './ai-cost-tracker.js'

const ETSY = getConnectorSpec('etsy')!

type AccessTokenInput = { workspaceId: string; accessToken: string }

/** Etsy daily-quota ledger via ai_usage rows. */
function quotaTick(units = 1): void {
  recordAiUsage({
    workspaceId:  'etsy-quota',
    provider:     'etsy',
    model:        'open-api-v3',
    promptTokens: 0,
    outputTokens: units,
    costUsd:      0,
    latencyMs:    0,
    taskType:     'other',
  })
}

// ── Auth + identity ────────────────────────────────────────────────
export async function getMe(input: AccessTokenInput): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        ETSY,
    accessToken: input.accessToken,
    path:        '/users/me',
  })
}

/** List shops the OAuth token controls. Operator typically has one
 *  shop per Etsy account; multi-shop sellers have more. */
export async function getShops(input: AccessTokenInput & { userId: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        ETSY,
    accessToken: input.accessToken,
    path:        `/users/${input.userId}/shops`,
  })
}

// ── Listings ───────────────────────────────────────────────────────
export interface EtsyListingFilters {
  state?:         'active' | 'inactive' | 'draft' | 'expired' | 'sold_out'
  limit?:         number     // max 100
  offset?:        number
  sortOn?:        'created' | 'price' | 'updated'
  sortOrder?:     'asc' | 'desc'
}

export async function listListings(input: AccessTokenInput & { shopId: string; filters?: EtsyListingFilters }): Promise<unknown> {
  quotaTick()
  const f = input.filters ?? {}
  return connectorRequest({
    spec:        ETSY,
    accessToken: input.accessToken,
    path:        `/shops/${input.shopId}/listings`,
    query: {
      state:      f.state     ?? 'active',
      limit:      Math.min(f.limit ?? 50, 100),
      offset:     f.offset    ?? 0,
      sort_on:    f.sortOn    ?? 'created',
      sort_order: f.sortOrder ?? 'desc',
    },
  })
}

export interface CreateDraftListingInput extends AccessTokenInput {
  shopId:           string
  title:            string
  description:      string
  priceUsd:         number
  /** Etsy WHO_MADE — 'i_did' | 'someone_else' | 'collective'. */
  whoMade:          'i_did' | 'someone_else' | 'collective'
  /** Etsy WHEN_MADE — see Etsy docs for full enum; '2020_2025' is common for POD. */
  whenMade:         string
  /** Etsy taxonomy id — required. Operator looks up via /taxonomy endpoint. */
  taxonomyId:       number
  tags?:            string[]   // max 13, lowercase, ≤ 20 chars each
  materials?:       string[]   // max 13
  shippingProfileId?: number   // operator's pre-created shipping profile
  quantity?:        number     // default 1
  isSupply?:        boolean
  isCustomizable?:  boolean
  isPersonalizable?: boolean
  approvalToken?:   string
}

export async function createDraftListing(input: CreateDraftListingInput): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'createDraftListing requires approval_token="OPERATOR_APPROVED" — Etsy listings affect live storefront' }
  }
  // Etsy enforces title ≤ 140 chars, tags ≤ 13 with each ≤ 20 chars,
  // materials ≤ 13 with each ≤ 45 chars. We sanitise here so the API
  // doesn't reject the whole call for a single bad field.
  if (input.title.length > 140) return { ok: false, error: `title too long (${input.title.length} > 140)` }
  if (input.priceUsd <= 0 || input.priceUsd > 50_000) return { ok: false, error: `price out of range $0.01-$50,000` }
  const tags = (input.tags ?? []).slice(0, 13).map(t => t.toLowerCase().slice(0, 20))
  const materials = (input.materials ?? []).slice(0, 13).map(m => m.slice(0, 45))

  quotaTick()
  return connectorRequest({
    spec:        ETSY,
    accessToken: input.accessToken,
    path:        `/shops/${input.shopId}/listings`,
    method:      'POST',
    body: {
      title:               input.title,
      description:         input.description.slice(0, 5_000),
      price:               input.priceUsd,
      quantity:            input.quantity ?? 1,
      who_made:            input.whoMade,
      when_made:           input.whenMade,
      taxonomy_id:         input.taxonomyId,
      tags,
      materials,
      ...(input.shippingProfileId !== undefined ? { shipping_profile_id: input.shippingProfileId } : {}),
      ...(input.isSupply         !== undefined ? { is_supply: input.isSupply } : {}),
      ...(input.isCustomizable   !== undefined ? { is_customizable: input.isCustomizable } : {}),
      ...(input.isPersonalizable !== undefined ? { is_personalizable: input.isPersonalizable } : {}),
    },
  }) as Promise<{ ok: true; data: unknown } | { ok: false; error: string }>
}

export interface UpdateListingInput extends AccessTokenInput {
  shopId:        string
  listingId:     string
  title?:        string
  description?:  string
  priceUsd?:     number
  quantity?:     number
  tags?:         string[]
  materials?:    string[]
  state?:        'active' | 'inactive' | 'draft'
  approvalToken?: string
}

export async function updateListing(input: UpdateListingInput): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'updateListing requires approval_token="OPERATOR_APPROVED"' }
  }
  const body: Record<string, unknown> = {}
  if (input.title       !== undefined) body['title']       = input.title.slice(0, 140)
  if (input.description !== undefined) body['description'] = input.description.slice(0, 5_000)
  if (input.priceUsd    !== undefined) body['price']       = input.priceUsd
  if (input.quantity    !== undefined) body['quantity']    = input.quantity
  if (input.tags        !== undefined) body['tags']        = input.tags.slice(0, 13).map(t => t.toLowerCase().slice(0, 20))
  if (input.materials   !== undefined) body['materials']   = input.materials.slice(0, 13).map(m => m.slice(0, 45))
  if (input.state       !== undefined) body['state']       = input.state
  if (Object.keys(body).length === 0) return { ok: false, error: 'no fields to update' }
  quotaTick()
  return connectorRequest({
    spec:        ETSY,
    accessToken: input.accessToken,
    path:        `/shops/${input.shopId}/listings/${input.listingId}`,
    method:      'PATCH',
    body,
  })
}

/** Multipart image upload. Etsy expects an `image` form field with the
 *  binary image data + an optional rank (display position). Caller
 *  provides a Buffer; we wrap into FormData. */
export async function uploadListingImage(input: AccessTokenInput & {
  shopId:        string
  listingId:     string
  imageData:     Uint8Array
  filename:      string
  mimeType:      string
  rank?:         number    // 1-based; lower = earlier in carousel
  approvalToken?: string
}): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'uploadListingImage requires approval_token="OPERATOR_APPROVED"' }
  }
  if (input.imageData.byteLength > 20 * 1024 * 1024) {
    return { ok: false, error: `image too large: ${input.imageData.byteLength} bytes > Etsy 20MB cap` }
  }
  const form = new FormData()
  form.append('image', new Blob([input.imageData], { type: input.mimeType }), input.filename)
  if (input.rank !== undefined) form.append('rank', String(input.rank))

  const url = `${ETSY.baseUrl}/shops/${input.shopId}/listings/${input.listingId}/images`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${input.accessToken}` },
    body: form,
  }).catch(e => ({ ok: false, status: 0, text: () => Promise.resolve(`network: ${(e as Error).message}`) }))
  if (!('ok' in r) || !r.ok) return { ok: false, error: `image upload failed: status ${(r as Response).status ?? 'network'}` }
  quotaTick(2)   // image uploads cost more
  return { ok: true, data: await (r as Response).json().catch(() => ({})) }
}

// ── Orders / receipts ──────────────────────────────────────────────
export async function listOrders(input: AccessTokenInput & {
  shopId:    string
  /** 'open' = needs fulfillment; 'completed' = shipped; 'paid' = both. */
  state?:    'open' | 'unshipped' | 'completed' | 'paid' | 'canceled'
  limit?:    number
  offset?:   number
}): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        ETSY,
    accessToken: input.accessToken,
    path:        `/shops/${input.shopId}/receipts`,
    query: {
      limit:  Math.min(input.limit ?? 50, 100),
      offset: input.offset ?? 0,
      ...(input.state === 'unshipped' ? { was_shipped: false, was_paid: true } : {}),
      ...(input.state === 'completed' ? { was_shipped: true } : {}),
      ...(input.state === 'canceled'  ? { was_canceled: true } : {}),
    },
  })
}

export async function getOrderReceipt(input: AccessTokenInput & { shopId: string; receiptId: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        ETSY,
    accessToken: input.accessToken,
    path:        `/shops/${input.shopId}/receipts/${input.receiptId}`,
  })
}

// ── Reviews ────────────────────────────────────────────────────────
export async function listReviews(input: AccessTokenInput & {
  shopId:     string
  /** Optional listingId — when set, returns reviews for one listing. */
  listingId?: string
  limit?:     number
  offset?:    number
  minCreated?: number   // Unix seconds
}): Promise<unknown> {
  quotaTick()
  const path = input.listingId
    ? `/shops/${input.shopId}/listings/${input.listingId}/reviews`
    : `/shops/${input.shopId}/reviews`
  return connectorRequest({
    spec:        ETSY,
    accessToken: input.accessToken,
    path,
    query: {
      limit:  Math.min(input.limit ?? 50, 100),
      offset: input.offset ?? 0,
      ...(input.minCreated !== undefined ? { min_created: input.minCreated } : {}),
    },
  })
}

// ── Translations (multi-language listings) ─────────────────────────
export async function createListingTranslation(input: AccessTokenInput & {
  shopId:     string
  listingId:  string
  language:   string     // 'es' | 'fr' | 'de' | 'it' | 'ja' | 'pt' | 'nl' | 'pl' | 'ru' | etc.
  title:      string
  description: string
  tags?:      string[]
  approvalToken?: string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'createListingTranslation requires approval_token="OPERATOR_APPROVED"' }
  }
  quotaTick()
  return connectorRequest({
    spec:        ETSY,
    accessToken: input.accessToken,
    path:        `/shops/${input.shopId}/listings/${input.listingId}/translations/${input.language}`,
    method:      'POST',
    body: {
      title:       input.title.slice(0, 140),
      description: input.description.slice(0, 5_000),
      ...(input.tags ? { tags: input.tags.slice(0, 13).map(t => t.toLowerCase().slice(0, 20)) } : {}),
    },
  })
}
