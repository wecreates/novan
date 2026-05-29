/**
 * connector-shopify.ts — Shopify Admin REST API wrappers (API 2024-10).
 *
 * Mirrors the YouTube/Etsy/TikTok/Instagram connector pattern from
 * rounds 118/129/117/119. Shopify is the operator's most-likely third
 * platform after Etsy for POD operations + general e-commerce.
 *
 * Shopify spec quirk: the baseUrl in connector-base.SPECS contains a
 * `{shop}` placeholder. Each call substitutes the shop's myshopify
 * domain (e.g. `acme-pod.myshopify.com`) into the URL.
 *
 * High-value endpoints:
 *   - getShop                — verify auth + shop details
 *   - listProducts           — recent products
 *   - createProduct          — create product (requires approval)
 *   - updateProduct          — title / description / vendor / tags / status
 *   - listVariants           — variants on a product (size/color/etc.)
 *   - updateInventory        — adjust stock level (location-aware)
 *   - listOrders             — orders by fulfillment status
 *   - getOrder               — full order detail
 *   - fulfillOrder           — mark fulfilled with tracking
 *   - listCustomers          — recent customers
 *   - searchCustomers        — search by email / phone
 *   - createDiscountCode     — promo code creation
 *   - getAnalyticsSummary    — sales rollup
 *
 * Honest scope:
 *   - All write operations gated by `approval_token="OPERATOR_APPROVED"`
 *     per SPEC §11.6.
 *   - Shopify leaky-bucket rate limit (4 req/sec sustained, 40 burst)
 *     respected via connector-base; bulk operations not supported here
 *     (use Shopify GraphQL bulk API in a separate module if needed).
 *   - Money-guard layered defense: createDiscountCode + fulfillOrder
 *     are gated; refund / capture / void are intentionally NOT exposed
 *     here — those are money-flow per SPEC §1.4 and require the
 *     three-layer money-guard, not a single connector call.
 */
import { connectorRequest, getConnectorSpec } from './connector-base.js'
import { recordAiUsage } from './ai-cost-tracker.js'

const SHOPIFY_SPEC = getConnectorSpec('shopify')!

type ShopifyAuth = {
  workspaceId:   string
  accessToken:   string
  /** Shop subdomain — e.g. 'acme-pod' for acme-pod.myshopify.com. */
  shop:          string
}

/** Substitute {shop} in the spec URL. Returns a shop-scoped spec we
 *  pass to connectorRequest. */
function shopSpec(shop: string): typeof SHOPIFY_SPEC {
  return {
    ...SHOPIFY_SPEC,
    baseUrl: SHOPIFY_SPEC.baseUrl.replace('{shop}', shop),
  }
}

function quotaTick(units = 1): void {
  recordAiUsage({
    workspaceId:  'shopify-quota',
    provider:     'shopify',
    model:        'admin-rest-2024-10',
    promptTokens: 0,
    outputTokens: units,
    costUsd:      0,
    latencyMs:    0,
    taskType:     'other',
  })
}

// ── Shop ───────────────────────────────────────────────────────────
export async function getShop(input: ShopifyAuth): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/shop.json',
  })
}

// ── Products ───────────────────────────────────────────────────────
export async function listProducts(input: ShopifyAuth & {
  limit?:      number
  status?:     'active' | 'archived' | 'draft' | 'any'
  vendor?:     string
  sinceId?:    string
}): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/products.json',
    query: {
      limit:  Math.min(input.limit ?? 50, 250),
      status: input.status ?? 'active',
      ...(input.vendor   ? { vendor:   input.vendor }   : {}),
      ...(input.sinceId  ? { since_id: input.sinceId }  : {}),
    },
  })
}

export interface CreateProductInput extends ShopifyAuth {
  title:           string
  bodyHtml?:       string         // product description as HTML
  vendor?:         string
  productType?:    string
  tags?:           string[]
  status:          'active' | 'draft' | 'archived'
  /** Variants — at minimum one variant required. */
  variants: Array<{
    title?:        string
    sku?:          string
    priceUsd:      number
    inventoryQuantity?: number
    weight?:       number
    weightUnit?:   'g' | 'kg' | 'lb' | 'oz'
    requiresShipping?: boolean
  }>
  /** Image URLs (operator hosts publicly accessible). */
  imageUrls?:     string[]
  approvalToken?: string
}

export async function createProduct(input: CreateProductInput): Promise<{ ok: true; productId: string; handle: string } | { ok: false; error: string }> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'createProduct requires approval_token="OPERATOR_APPROVED" — affects live storefront' }
  }
  if (!input.variants || input.variants.length === 0) {
    return { ok: false, error: 'at least one variant required' }
  }
  if (input.variants.some(v => v.priceUsd <= 0)) {
    return { ok: false, error: 'all variant prices must be > 0' }
  }
  quotaTick(2)
  const result = await connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/products.json',
    method:      'POST',
    body: {
      product: {
        title:        input.title.slice(0, 255),
        body_html:    (input.bodyHtml ?? '').slice(0, 65_000),
        vendor:       input.vendor,
        product_type: input.productType,
        tags:         (input.tags ?? []).join(', ').slice(0, 255),
        status:       input.status,
        variants: input.variants.map(v => ({
          title:              v.title,
          sku:                v.sku,
          price:              v.priceUsd.toFixed(2),
          inventory_quantity: v.inventoryQuantity ?? 0,
          inventory_management: 'shopify',
          weight:             v.weight,
          weight_unit:        v.weightUnit ?? 'g',
          requires_shipping:  v.requiresShipping ?? true,
        })),
        ...(input.imageUrls && input.imageUrls.length > 0
          ? { images: input.imageUrls.map(src => ({ src })) }
          : {}),
      },
    },
  })
  if (!result.ok) return { ok: false, error: 'create product failed' }
  const p = (result.data as { product?: { id?: number; handle?: string } }).product
  if (!p?.id || !p.handle) return { ok: false, error: 'Shopify did not return product id + handle' }
  return { ok: true, productId: String(p.id), handle: p.handle }
}

export async function updateProduct(input: ShopifyAuth & {
  productId:       string
  title?:          string
  bodyHtml?:       string
  vendor?:         string
  tags?:           string[]
  status?:         'active' | 'draft' | 'archived'
  approvalToken?:  string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'updateProduct requires approval_token="OPERATOR_APPROVED"' }
  }
  const body: Record<string, unknown> = { id: Number(input.productId) }
  if (input.title    !== undefined) body['title']     = input.title.slice(0, 255)
  if (input.bodyHtml !== undefined) body['body_html'] = input.bodyHtml.slice(0, 65_000)
  if (input.vendor   !== undefined) body['vendor']    = input.vendor
  if (input.tags     !== undefined) body['tags']      = input.tags.join(', ').slice(0, 255)
  if (input.status   !== undefined) body['status']    = input.status
  if (Object.keys(body).length === 1) return { ok: false, error: 'no fields to update' }
  quotaTick()
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        `/products/${input.productId}.json`,
    method:      'PUT',
    body:        { product: body },
  })
}

// ── Inventory ──────────────────────────────────────────────────────
export async function listVariants(input: ShopifyAuth & { productId: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        `/products/${input.productId}/variants.json`,
  })
}

export async function updateInventory(input: ShopifyAuth & {
  inventoryItemId:  string
  locationId:       string
  available:        number      // absolute stock level, not delta
  approvalToken?:   string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'updateInventory requires approval_token="OPERATOR_APPROVED" — affects live stock' }
  }
  quotaTick(2)
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/inventory_levels/set.json',
    method:      'POST',
    body: {
      inventory_item_id: Number(input.inventoryItemId),
      location_id:       Number(input.locationId),
      available:         input.available,
    },
  })
}

// ── Orders ─────────────────────────────────────────────────────────
export async function listOrders(input: ShopifyAuth & {
  status?:           'open' | 'closed' | 'cancelled' | 'any'
  fulfillmentStatus?: 'shipped' | 'partial' | 'unshipped' | 'any'
  limit?:            number
  sinceId?:          string
}): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/orders.json',
    query: {
      status:             input.status ?? 'any',
      fulfillment_status: input.fulfillmentStatus ?? 'any',
      limit:              Math.min(input.limit ?? 50, 250),
      ...(input.sinceId ? { since_id: input.sinceId } : {}),
    },
  })
}

export async function getOrder(input: ShopifyAuth & { orderId: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        `/orders/${input.orderId}.json`,
  })
}

export async function fulfillOrder(input: ShopifyAuth & {
  orderId:        string
  fulfillmentOrderId: string
  trackingNumber?: string
  trackingCompany?: string
  trackingUrl?:    string
  notifyCustomer?: boolean
  approvalToken?:  string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'fulfillOrder requires approval_token="OPERATOR_APPROVED" — affects customer + may trigger email' }
  }
  quotaTick(3)
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/fulfillments.json',
    method:      'POST',
    body: {
      fulfillment: {
        line_items_by_fulfillment_order: [{ fulfillment_order_id: Number(input.fulfillmentOrderId) }],
        notify_customer: input.notifyCustomer ?? true,
        ...(input.trackingNumber || input.trackingCompany || input.trackingUrl ? {
          tracking_info: {
            number:   input.trackingNumber,
            company:  input.trackingCompany,
            url:      input.trackingUrl,
          },
        } : {}),
      },
    },
  })
}

// ── Customers ─────────────────────────────────────────────────────
export async function listCustomers(input: ShopifyAuth & { limit?: number; sinceId?: string }): Promise<unknown> {
  quotaTick()
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/customers.json',
    query: {
      limit: Math.min(input.limit ?? 50, 250),
      ...(input.sinceId ? { since_id: input.sinceId } : {}),
    },
  })
}

export async function searchCustomers(input: ShopifyAuth & { email?: string; phone?: string }): Promise<unknown> {
  if (!input.email && !input.phone) return { ok: false, error: 'email or phone required' }
  quotaTick()
  const queryParts: string[] = []
  if (input.email) queryParts.push(`email:${input.email}`)
  if (input.phone) queryParts.push(`phone:${input.phone}`)
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/customers/search.json',
    query:       { query: queryParts.join(' ') },
  })
}

// ── Discount codes ────────────────────────────────────────────────
export async function createDiscountCode(input: ShopifyAuth & {
  /** Operator must pre-create a price_rule (see Shopify docs); we
   *  attach a code to it. */
  priceRuleId:    string
  code:           string
  approvalToken?: string
}): Promise<unknown> {
  if (input.approvalToken !== 'OPERATOR_APPROVED') {
    return { ok: false, error: 'createDiscountCode requires approval_token="OPERATOR_APPROVED" — affects live storefront promos' }
  }
  if (input.code.length > 64) return { ok: false, error: `discount code too long (${input.code.length} > 64)` }
  quotaTick(2)
  return connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        `/price_rules/${input.priceRuleId}/discount_codes.json`,
    method:      'POST',
    body:        { discount_code: { code: input.code.toUpperCase() } },
  })
}

// ── Analytics summary ─────────────────────────────────────────────
export async function getAnalyticsSummary(input: ShopifyAuth & { days?: number }): Promise<{
  ok:                true
  ordersCount:       number
  unshippedCount:    number
  totalRevenueUsd:   number
  averageOrderValueUsd: number
  productCount:      number
} | { ok: false; error: string }> {
  const days = input.days ?? 30
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  // Aggregate orders.
  const orders = await connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/orders.json',
    query: { status: 'any', created_at_min: since, limit: 250, fields: 'id,total_price,fulfillment_status,cancelled_at' },
  })
  if (!orders.ok) return { ok: false, error: 'failed to fetch orders' }
  const ordersList = ((orders.data as { orders?: Array<{ id: number; total_price?: string; fulfillment_status?: string | null; cancelled_at?: string | null }> }).orders ?? [])
    .filter(o => !o.cancelled_at)
  quotaTick()

  const totalRevenueUsd = ordersList.reduce((s, o) => s + Number(o.total_price ?? 0), 0)
  const unshippedCount = ordersList.filter(o => o.fulfillment_status !== 'shipped' && o.fulfillment_status !== 'fulfilled').length
  const aov = ordersList.length > 0 ? totalRevenueUsd / ordersList.length : 0

  // Product count.
  const products = await connectorRequest({
    spec:        shopSpec(input.shop),
    accessToken: input.accessToken,
    path:        '/products/count.json',
  })
  quotaTick()
  const productCount = products.ok ? Number((products.data as { count?: number }).count ?? 0) : 0

  return {
    ok: true,
    ordersCount:           ordersList.length,
    unshippedCount,
    totalRevenueUsd:       Number(totalRevenueUsd.toFixed(2)),
    averageOrderValueUsd:  Number(aov.toFixed(2)),
    productCount,
  }
}
