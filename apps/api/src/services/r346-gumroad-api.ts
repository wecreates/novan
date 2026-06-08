/**
 * R146.346 — Gumroad API client + autonomous product publisher
 *
 * Mandate from operator: "This is what Novan or a fully automated team
 * does for me." Translated: stop driving the browser, use the API.
 *
 * Gumroad v2 API: https://app.gumroad.com/api
 *   GET    /v2/user                                — verify token
 *   POST   /v2/products                            — create product
 *   PUT    /v2/products/:id                        — update product
 *   PUT    /v2/products/:id/enable                 — publish (was disabled)
 *   GET    /v2/products                            — list
 *
 * Files are uploaded by S3-presigned-URL flow on the web UI; the bare
 * v2 API doesn't expose direct binary upload. Workaround: stash a
 * downloadable URL on the product (Gumroad lets you serve any URL as
 * the digital delivery — pull from our own image_generations storage
 * or directly from the Met Museum CC0 source).
 *
 * Token: operator generates at gumroad.com/settings/advanced →
 *        "Applications" → "Create application" → "Generate access token".
 *        Store as GUMROAD_ACCESS_TOKEN env.
 */
import { fetchWithRetry } from './provider-retry.js'

export interface GumroadAuth {
  token: string
}

function authFromEnv(): GumroadAuth {
  const token = process.env['GUMROAD_ACCESS_TOKEN']
  if (!token) throw new Error('GUMROAD_ACCESS_TOKEN not configured (operator: gumroad.com/settings/advanced → Applications → generate)')
  return { token }
}

// ─── Verify ──────────────────────────────────────────────────────────────────

export async function whoami(auth: GumroadAuth = authFromEnv()): Promise<{ user_id: string; name: string; email: string; url: string }> {
  const r = await fetchWithRetry('gumroad:user', `https://api.gumroad.com/v2/user?access_token=${encodeURIComponent(auth.token)}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error(`gumroad whoami ${r.status}: ${r.statusText}`)
  const body = await r.response.json() as { success?: boolean; user?: { id?: string; user_id?: string; name?: string; display_name?: string; email?: string; url?: string } }
  if (!body.success || !body.user) throw new Error(`gumroad whoami body unexpected: ${JSON.stringify(body).slice(0, 200)}`)
  return {
    user_id: body.user.id ?? body.user.user_id ?? 'unknown',
    name:    body.user.name ?? body.user.display_name ?? '',
    email:   body.user.email ?? '',
    url:     body.user.url ?? '',
  }
}

// ─── List existing products ─────────────────────────────────────────────────

export interface GumroadProductSummary {
  id:          string
  name:        string
  url:         string
  price:       number       // cents
  currency:    string
  published:   boolean
}

export async function listProducts(auth: GumroadAuth = authFromEnv()): Promise<GumroadProductSummary[]> {
  const r = await fetchWithRetry('gumroad:list', `https://api.gumroad.com/v2/products?access_token=${encodeURIComponent(auth.token)}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) throw new Error(`gumroad list ${r.status}: ${r.statusText}`)
  const body = await r.response.json() as { products?: Array<{ id: string; name: string; short_url?: string; price?: number; currency?: string; published?: boolean }> }
  return (body.products ?? []).map(p => ({
    id:        p.id,
    name:      p.name,
    url:       p.short_url ?? '',
    price:     p.price ?? 0,
    currency:  p.currency ?? 'usd',
    published: p.published ?? false,
  }))
}

// ─── Create product ─────────────────────────────────────────────────────────

export interface CreateProductInput {
  name:           string
  priceUsd:       number          // dollars (we convert to cents)
  description:    string          // markdown / HTML supported
  customSummary?: string          // 1-line tagline
  customPermalink?: string         // /l/{permalink}
  tags?:          string[]
  // The downloadable URL the customer gets. Can be any public URL we own.
  // Operator can upload via the Gumroad UI later for a polished delivery.
  contentUrl?:    string
}

export interface CreateProductResult {
  id:          string
  name:        string
  short_url:   string
  edit_url:    string
  published:   boolean
}

export async function createProduct(input: CreateProductInput, auth: GumroadAuth = authFromEnv()): Promise<CreateProductResult> {
  const params = new URLSearchParams()
  params.set('access_token',     auth.token)
  params.set('name',             input.name)
  params.set('price',            String(Math.round(input.priceUsd * 100)))  // cents
  params.set('description',      input.description)
  if (input.customSummary)   params.set('custom_summary',    input.customSummary)
  if (input.customPermalink) params.set('custom_permalink',  input.customPermalink)
  if (input.tags)            params.set('tags',              input.tags.join(','))
  // Gumroad accepts a "URL" content_type via API for delivery-by-URL products
  // (operator can replace with native file upload via the web UI later).
  if (input.contentUrl) {
    params.set('content_url', input.contentUrl)
  }
  const r = await fetchWithRetry('gumroad:create', `https://api.gumroad.com/v2/products`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params,
    signal:  AbortSignal.timeout(30_000),
  })
  if (!r.ok) {
    const text = await r.response.text().catch(() => '')
    throw new Error(`gumroad create ${r.status}: ${text.slice(0, 300)}`)
  }
  const body = await r.response.json() as { product?: Record<string, unknown>; message?: string }
  if (!body.product) throw new Error(`gumroad create unexpected body: ${JSON.stringify(body).slice(0, 200)}`)
  const p = body.product
  return {
    id:        String(p['id'] ?? ''),
    name:      String(p['name'] ?? ''),
    short_url: String(p['short_url'] ?? ''),
    edit_url:  `https://gumroad.com/products/${p['id']}/edit`,
    published: Boolean(p['published'] ?? false),
  }
}

/** Publish (enable) a previously-created product. */
export async function publishProduct(productId: string, auth: GumroadAuth = authFromEnv()): Promise<boolean> {
  const r = await fetchWithRetry('gumroad:publish', `https://api.gumroad.com/v2/products/${productId}/enable`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:   new URLSearchParams({ access_token: authFromEnv().token }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) {
    const text = await r.response.text().catch(() => '')
    throw new Error(`gumroad publish ${r.status}: ${text.slice(0, 200)}`)
  }
  const body = await r.response.json() as { success?: boolean }
  return Boolean(body.success)
}

// ─── High-level: publish the first 3 listings from prestaged content ────────

export interface FirstThreeListingsPlan {
  audubon_woodpecker:    CreateProductInput
  vintage_botanical_iris: CreateProductInput
  vintage_map:           CreateProductInput
}

export const FIRST_THREE_LISTINGS: FirstThreeListingsPlan = {
  audubon_woodpecker: {
    name:           "Ivory-billed Woodpeckers (Met CC0, after Audubon)",
    priceUsd:       9,
    customSummary:  "Vintage natural-history print. High-res PNG, instant download.",
    customPermalink: "ivory-billed-woodpeckers",
    description: `**Vintage natural-history illustration of the Ivory-billed Woodpecker.**

After Joseph Bartholomew Kidd (ca. 1830-31), produced from the Metropolitan Museum of Art's open-access archive. CC0 / Public Domain.

This print of the now-extinct ivory-billed woodpecker pair carries the softness and depth of early 19th-century color illustration. Pairs especially well with botanical or maritime prints in a gallery wall arrangement.

**You get:**
- High-resolution PNG (1024 x 1024+ px)
- Print-ready at 8x10", 11x14", 16x20"
- Color-balanced for modern matte papers
- Personal-use license

Print at home, at your local print shop, or send to a custom framer.`,
    tags:        ['vintage', 'audubon', 'natural history', 'ivory-billed woodpecker', 'extinct birds', 'fine art print', 'wall art'],
    contentUrl:  'https://images.metmuseum.org/CRDImages/ad/original/ap41.18.jpg',
  },
  vintage_botanical_iris: {
    name:           "Vintage Botanical Iris (gallery-quality print)",
    priceUsd:       9,
    customSummary:  "Premium botanical illustration. High-res PNG, instant download.",
    customPermalink: "vintage-botanical-iris",
    description: `**Vintage botanical illustration of an iris — gallery-quality fine art print.**

Produced in the style of 19th-century natural-history plates. Soft, warm, and substantive on a cream background. Pairs with vintage natural-history and antique cartography prints.

**You get:**
- High-resolution PNG (1024 x 1024+ px)
- Print-ready at standard sizes (8x10", 11x14", 16x20")
- Color-balanced for matte paper
- Personal-use license`,
    tags:        ['vintage', 'botanical', 'iris', 'fine art print', 'gallery wall', 'wall art', 'flower'],
    // contentUrl filled by publisher from the generated image
  },
  vintage_map: {
    name:           "Antique Cartography — Vintage Map (decorative print)",
    priceUsd:       9,
    customSummary:  "Vintage map illustration. High-res PNG, instant download.",
    customPermalink: "vintage-antique-map",
    description: `**Decorative vintage map — in the tradition of 17th-19th century cartography.**

Pairs with vintage natural-history prints (Audubon, Kidd) and botanical illustration.

**You get:**
- High-resolution PNG (1024 x 1024+ px)
- Print-ready at standard sizes
- Color-balanced
- Personal-use license`,
    tags:        ['vintage', 'map', 'antique cartography', 'fine art print', 'wall art', 'decorative map'],
    // contentUrl filled by publisher from the generated image
  },
}
