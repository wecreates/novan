/**
 * connector-printful.ts — Printful API v1 wrappers.
 *
 * Closes the 3rd POD platform after Etsy + Shopify. Mirrors the
 * connector pattern from YouTube/Etsy/TikTok/Instagram/Shopify
 * (rounds 118/129/117/119/120). Per SPEC §18.11.
 *
 * Printful's role in a POD operation: the fulfilment partner that
 * actually prints + ships. Etsy / Shopify hold the storefront +
 * customer; Printful holds the print files + production. Operator
 * connects Printful to their store(s) via Printful's native sync,
 * then Novan reads + writes via this connector.
 *
 * High-value endpoints:
 *   - getStore                  — verify auth + identify connected stores
 *   - listSyncProducts          — products synced to operator's store(s)
 *   - getSyncProduct            — full sync product detail w/ variants
 *   - createSyncProduct         — create new sync product (requires approval)
 *   - listOrders                — orders in Printful (mirrored from store)
 *   - getOrder                  — full order detail w/ items + shipping
 *   - confirmOrder              — move order from draft → fulfillment (REQUIRES APPROVAL)
 *   - cancelOrder               — cancel a pending order (REQUIRES APPROVAL)
 *   - listProductCatalog        — base products available for printing
 *   - getProductVariants        — variants (size/color) for a base product
 *   - getProductPrices          — wholesale prices per variant (feeds pod-pricing)
 *   - getShippingRates          — calc shipping for an address + items
 *
 * Honest scope:
 *   - All write operations gated by `approval_token="OPERATOR_APPROVED"`
 *     per SPEC §11.6. Printful confirmOrder triggers actual charge to
 *     the operator's billing method — three-layer money-guard applies.
 *   - File / mockup uploads not exposed here — operator uploads via
 *     Printful's UI or a dedicated upload service.
 *   - Printful's rate limit: 120 requests / 60s. Honored via
 *     connector-base rate-limit-per-second.
 */
import { connectorRequest, getConnectorSpec } from './connector-base.js'
import { recordAiUsage } from './ai-cost-tracker.js'

const PRINTFUL = getConnectorSpec('printful')!

type PrintfulAuth = { workspaceId: string; accessToken: string }

function quotaTick(units = 1): void {
  recordAiUsage({
    workspaceId:  'printful-quota',
    provider:     'printful',
    model:        'api-v1',
    promptTokens: 0,
    outputTokens: units,
    costUsd:      0,
    latencyMs:    0,
    taskType:     'other',
  })
}

// ── Store ──────────────────────────────────────────────────────────
export async function getStore(input: PrintfulAuth): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        '/store',
  })
}

// ── Sync products (products on the operator's connected store) ─────
export async function listSyncProducts(input: PrintfulAuth & { limit?: number; offset?: number }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        '/sync/products',
    query: {
      limit:  Math.min(input.limit ?? 50, 100),
      offset: input.offset ?? 0,
    },
  })
}

export async function getSyncProduct(input: PrintfulAuth & { productId: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        `/sync/products/${input.productId}`,
  })
}

export interface CreateSyncProductInput extends PrintfulAuth {
  name:              string
  /** Thumbnail URL on operator's CDN. */
  thumbnailUrl?:     string
  /** Variants — at least one. Each maps a Printful catalog variant to
   *  operator-side pricing + print files. */
  variants: Array<{
    /** Printful catalog variant id — e.g. 4012 for unisex tee S black. */
    variantId:       number
    /** Operator's retail price (what their storefront charges). */
    retailPriceUsd:  number
    /** Print file URL(s) — operator hosts publicly accessible. */
    printFiles: Array<{
      type:          'default' | 'front' | 'back' | 'left' | 'right' | 'sleeve_left' | 'sleeve_right' | 'inside_label'
      url:           string
    }>
    /** Optional external SKU mapping. */
    externalId?:     string
  }>
  approvalToken?:    string
}

export async function createSyncProduct(input: CreateSyncProductInput): Promise<{ ok: true; productId: string } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'createSyncProduct requires approval_token="OPERATOR_APPROVED" — affects connected storefront' }
  }
  if (!input.variants || input.variants.length === 0) {
    return { ok: false, error: 'at least one variant required' }
  }
  if (input.variants.some(v => v.retailPriceUsd <= 0)) {
    return { ok: false, error: 'all variant retail prices must be > 0' }
  }
  if (input.variants.some(v => v.printFiles.length === 0)) {
    return { ok: false, error: 'each variant needs at least one print file' }
  }
  quotaTick(2)
  const result = await connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        '/sync/products',
    method:      'POST',
    body: {
      sync_product: {
        name:      input.name.slice(0, 255),
        ...(input.thumbnailUrl ? { thumbnail: input.thumbnailUrl } : {}),
      },
      sync_variants: input.variants.map(v => ({
        variant_id:    v.variantId,
        retail_price:  v.retailPriceUsd.toFixed(2),
        ...(v.externalId ? { external_id: v.externalId } : {}),
        files: v.printFiles.map(f => ({ type: f.type, url: f.url })),
      })),
    },
  })
  if (!result.ok) return { ok: false, error: 'create sync product failed' }
  const productId = ((result.data as { result?: { id?: number } }).result?.id)
  if (!productId) return { ok: false, error: 'Printful did not return product id' }
  return { ok: true, productId: String(productId) }
}

// ── Orders ─────────────────────────────────────────────────────────
export async function listOrders(input: PrintfulAuth & {
  status?:  'draft' | 'failed' | 'pending' | 'canceled' | 'onhold' | 'inprocess' | 'partial' | 'fulfilled' | 'archived'
  limit?:   number
  offset?:  number
}): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        '/orders',
    query: {
      ...(input.status ? { status: input.status } : {}),
      limit:  Math.min(input.limit ?? 50, 100),
      offset: input.offset ?? 0,
    },
  })
}

export async function getOrder(input: PrintfulAuth & { orderId: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        `/orders/${input.orderId}`,
  })
}

/** Confirm an order — moves status from `draft` to `pending` and
 *  triggers Printful production + charge to operator's billing method.
 *  THIS IS A MONEY-FLOW operation. Three-layer money-guard applies:
 *   1. Caller must be `operator` (not agent / cron / mcp)
 *   2. approval_token must be OPERATOR_APPROVED
 *   3. policy-engine.money_pattern_hard_block evaluates ahead of this
 *  We additionally check the approval token here as defense-in-depth. */
export async function confirmOrder(input: PrintfulAuth & {
  orderId:        string
  approvalToken?: string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'confirmOrder requires approval_token="OPERATOR_APPROVED" — this is a money-flow operation; charges operator billing method on confirm' }
  }
  quotaTick(3)
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        `/orders/${input.orderId}/confirm`,
    method:      'POST',
  })
}

export async function cancelOrder(input: PrintfulAuth & {
  orderId:        string
  approvalToken?: string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'cancelOrder requires approval_token="OPERATOR_APPROVED"' }
  }
  quotaTick(2)
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        `/orders/${input.orderId}`,
    method:      'DELETE',
  })
}

// ── Catalog (base products available for printing) ────────────────
export async function listProductCatalog(input: PrintfulAuth & { category?: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        '/products',
    ...(input.category ? { query: { category_id: input.category } } : {}),
  })
}

export async function getProductVariants(input: PrintfulAuth & { catalogProductId: number }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        `/products/${input.catalogProductId}`,
  })
}

/** Pull wholesale prices for catalog variants. Feeds `pod-pricing.ts`
 *  COGS table updates — operator can call this periodically to refresh
 *  the static cost matrix in pod-pricing. */
export async function getProductPrices(input: PrintfulAuth & {
  catalogProductId: number
  currency?:        string    // default 'USD'
  region?:          string    // 'US' / 'EU' / etc.
}): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        `/products/${input.catalogProductId}/prices`,
    query: {
      currency: input.currency ?? 'USD',
      ...(input.region ? { selling_region_name: input.region } : {}),
    },
  })
}

// ── Shipping rates ────────────────────────────────────────────────
export interface ShippingRateInput extends PrintfulAuth {
  recipient: {
    countryCode:  string
    stateCode?:   string
    zip?:         string
  }
  items: Array<{
    /** Printful catalog variant id. */
    variantId:    number
    quantity:     number
  }>
  currency?:     string
}

export async function getShippingRates(input: ShippingRateInput): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        '/shipping/rates',
    method:      'POST',
    body: {
      recipient: {
        country_code: input.recipient.countryCode,
        ...(input.recipient.stateCode ? { state_code: input.recipient.stateCode } : {}),
        ...(input.recipient.zip       ? { zip:        input.recipient.zip       } : {}),
      },
      items: input.items.map(it => ({
        variant_id: it.variantId,
        quantity:   it.quantity,
      })),
      currency: input.currency ?? 'USD',
    },
  })
}

// ── Analytics summary ────────────────────────────────────────────
/** Aggregate Printful order activity for the operator dashboard.
 *  Pairs with `connector-shopify.getAnalyticsSummary` so the operator
 *  can compare storefront orders vs Printful production status. */
export async function getAnalyticsSummary(input: PrintfulAuth & { days?: number }): Promise<{
  ok:                  true
  totalOrders:         number
  pendingOrders:       number
  inProcessOrders:     number
  fulfilledOrders:     number
  failedOrders:        number
  estimatedCostUsd:    number   // sum of order totals (operator's wholesale cost)
} | { ok: false; error: string }> {
  const days = input.days ?? 30
  // Printful list-orders doesn't accept date filter; we fetch recent
  // and filter client-side. Limit to last 100 orders.
  const result = await connectorRequest({
    spec:        PRINTFUL,
    accessToken: input.accessToken,
    path:        '/orders',
    query:       { limit: 100, offset: 0 },
  })
  quotaTick()
  if (!result.ok) return { ok: false, error: 'failed to fetch orders' }
  const items = ((result.data as { result?: Array<{ status?: string; created?: number; costs?: { total?: string } }> }).result ?? [])
  const since = (Date.now() / 1000) - days * 86_400
  const recent = items.filter(o => (o.created ?? 0) >= since)

  const pending     = recent.filter(o => o.status === 'pending').length
  const inProcess   = recent.filter(o => o.status === 'inprocess' || o.status === 'partial').length
  const fulfilled   = recent.filter(o => o.status === 'fulfilled').length
  const failed      = recent.filter(o => o.status === 'failed').length
  const estimatedCost = recent.reduce((s, o) => s + Number(o.costs?.total ?? 0), 0)

  return {
    ok: true,
    totalOrders:      recent.length,
    pendingOrders:    pending,
    inProcessOrders:  inProcess,
    fulfilledOrders:  fulfilled,
    failedOrders:     failed,
    estimatedCostUsd: Number(estimatedCost.toFixed(2)),
  }
}
