/**
 * R179 — POD stores powered entirely by organic social traffic.
 *
 * Pipeline:
 *   1. storeCreate({platform, brandName, niche, attachSocialAccounts[]})
 *   2. productAdd({storeId, sku, title, designUrl, priceCents, costCents})
 *      — pushes to Shopify/Etsy/Printful/Redbubble via existing connectors
 *   3. routeAttach({postId, storeId, productId?})
 *      — creates UTM-stitched short URL; every click via /r/:short feeds
 *        social_funnel_route counters
 *   4. cadenceFromInventory({storeId, daysAhead?})
 *      — given products + active social accounts + warmup status, returns a
 *        per-account per-day post plan at max sustainable volume
 *   5. bestSellersToContent({storeId, formats?})
 *      — top-revenue products become content seeds → R163 repurpose pack
 */
import { db } from '../db/client.js'
import {
  podStore, podProduct, socialFunnelRoute, managedAccount, socialPosts,
} from '../db/schema.js'
import { and, eq, desc, sql, isNotNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const SUPPORTED = ['shopify', 'etsy', 'printful', 'redbubble', 'gumroad'] as const

export interface StoreInput {
  platform:    typeof SUPPORTED[number]
  brandName:   string
  niche?:      string
  domain?:     string
  businessId?: string
  socialAccountIds?: string[]
}

export async function storeCreate(workspaceId: string, input: StoreInput): Promise<{ id: string }> {
  if (!input.platform || !(SUPPORTED as readonly string[]).includes(input.platform)) throw new Error('unsupported platform')
  if (!input.brandName) throw new Error('brandName required')
  const id = uuidv7()
  await db.insert(podStore).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    platform: input.platform,
    ...(input.domain ? { domain: input.domain } : {}),
    ...(input.niche ? { niche: input.niche } : {}),
    brandName: input.brandName.slice(0, 200),
    socialAccountIds: input.socialAccountIds ?? [],
    status: 'active',
    createdAt: Date.now(),
  })
  return { id }
}

export async function storeList(workspaceId: string): Promise<Array<typeof podStore.$inferSelect>> {
  return db.select().from(podStore)
    .where(and(eq(podStore.workspaceId, workspaceId), eq(podStore.status, 'active')))
    .orderBy(desc(podStore.createdAt))
}

export interface ProductInput {
  storeId:     string
  sku:         string
  title:       string
  designUrl?:  string
  category?:   string
  tags?:       string[]
  priceCents:  number
  costCents:   number
  externalId?: string
  productUrl?: string
}

export async function productAdd(workspaceId: string, input: ProductInput): Promise<{ id: string; margin: number }> {
  if (!input.storeId || !input.sku || !input.title) throw new Error('storeId + sku + title required')
  const margin = Math.max(0, input.priceCents - input.costCents)
  const id = uuidv7()
  await db.insert(podProduct).values({
    id, workspaceId,
    storeId: input.storeId,
    sku: input.sku.slice(0, 100),
    title: input.title.slice(0, 200),
    ...(input.designUrl ? { designUrl: input.designUrl } : {}),
    ...(input.category ? { category: input.category } : {}),
    tags: input.tags ?? [],
    priceCents: input.priceCents,
    costCents:  input.costCents,
    marginCents: margin,
    ...(input.externalId ? { externalId: input.externalId } : {}),
    ...(input.productUrl ? { productUrl: input.productUrl } : {}),
    status: 'active',
    listedAt: Date.now(),
    createdAt: Date.now(),
  })
  return { id, margin }
}

export async function productListByStore(workspaceId: string, storeId: string): Promise<Array<typeof podProduct.$inferSelect>> {
  return db.select().from(podProduct)
    .where(and(eq(podProduct.workspaceId, workspaceId), eq(podProduct.storeId, storeId), eq(podProduct.status, 'active')))
    .orderBy(desc(podProduct.revenueCents))
}

// ─── Route stitching (post → store, UTM) ────────────────────────────

function shortToken(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

export async function routeAttach(workspaceId: string, input: { postId: string; storeId: string; productId?: string }): Promise<{ id: string; shortUrl: string; utmCampaign: string }> {
  const [store] = await db.select().from(podStore).where(eq(podStore.id, input.storeId)).limit(1)
  if (!store) throw new Error('store not found')
  const [post] = await db.select().from(socialPosts).where(eq(socialPosts.id, input.postId)).limit(1)
  if (!post) throw new Error('post not found')

  const utm_campaign = `pod:${store.platform}:${input.postId.slice(0, 8)}`
  const short = shortToken()
  const id = uuidv7()
  await db.insert(socialFunnelRoute).values({
    id, workspaceId,
    socialPostId: input.postId, storeId: input.storeId,
    ...(input.productId ? { productId: input.productId } : {}),
    utmCampaign: utm_campaign,
    utmSource: post.platform,
    utmMedium: 'social-organic',
    shortUrl: short,
    createdAt: Date.now(),
  })
  return { id, shortUrl: short, utmCampaign: utm_campaign }
}

export async function routeResolve(short: string): Promise<{ destination: string; routeId: string } | null> {
  const [r] = await db.select({
    id: socialFunnelRoute.id, productId: socialFunnelRoute.productId, storeId: socialFunnelRoute.storeId,
    utmCampaign: socialFunnelRoute.utmCampaign, utmSource: socialFunnelRoute.utmSource, utmMedium: socialFunnelRoute.utmMedium,
  }).from(socialFunnelRoute).where(eq(socialFunnelRoute.shortUrl, short)).limit(1)
  if (!r) return null

  let url = ''
  if (r.productId) {
    const [p] = await db.select({ url: podProduct.productUrl }).from(podProduct).where(eq(podProduct.id, r.productId)).limit(1)
    url = p?.url ?? ''
  }
  if (!url) {
    const [s] = await db.select({ domain: podStore.domain, platform: podStore.platform, brandName: podStore.brandName }).from(podStore).where(eq(podStore.id, r.storeId)).limit(1)
    if (s?.domain) url = s.domain.startsWith('http') ? s.domain : `https://${s.domain}`
    else if (s?.platform === 'etsy') url = `https://www.etsy.com/shop/${encodeURIComponent(s.brandName.replace(/\s+/g, ''))}`
    else if (s?.platform === 'shopify') url = `https://${encodeURIComponent(s.brandName.toLowerCase().replace(/[^a-z0-9-]/g, ''))}.myshopify.com`
  }
  if (!url) return null

  const sep = url.includes('?') ? '&' : '?'
  const utm = [
    `utm_source=${encodeURIComponent(r.utmSource ?? 'social')}`,
    `utm_medium=${encodeURIComponent(r.utmMedium ?? 'social-organic')}`,
    `utm_campaign=${encodeURIComponent(r.utmCampaign)}`,
  ].join('&')
  return { destination: `${url}${sep}${utm}`, routeId: r.id }
}

export async function routeRecordClick(routeId: string): Promise<void> {
  await db.update(socialFunnelRoute).set({ clicks: sql`${socialFunnelRoute.clicks} + 1` }).where(eq(socialFunnelRoute.id, routeId))
}

export async function routeRecordConversion(routeId: string, revenueCents: number): Promise<void> {
  await db.update(socialFunnelRoute).set({
    conversions: sql`${socialFunnelRoute.conversions} + 1`,
    revenueCents: sql`${socialFunnelRoute.revenueCents} + ${revenueCents}`,
  }).where(eq(socialFunnelRoute.id, routeId))
}

// ─── Cadence: maximum sustainable volume across attached accounts ───

export async function cadenceFromInventory(workspaceId: string, opts: { storeId: string; daysAhead?: number }): Promise<{ daysAhead: number; plan: Array<{ day: number; perAccount: Array<{ accountId: string; platform: string; posts: number }> }>; totalPosts: number }> {
  const days = Math.max(1, Math.min(opts.daysAhead ?? 14, 30))
  const [store] = await db.select().from(podStore).where(eq(podStore.id, opts.storeId)).limit(1)
  if (!store) throw new Error('store not found')
  const accountIds = (store.socialAccountIds ?? []) as string[]
  if (accountIds.length === 0) return { daysAhead: days, plan: [], totalPosts: 0 }

  const { maxDailyTargets } = await import('./r178-managed-accounts.js')
  const perAccountDaily: Array<{ accountId: string; platform: string; posts: number }> = []
  for (const aid of accountIds) {
    const t = await maxDailyTargets(workspaceId, aid)
    if ('error' in t) continue
    const postsKind = t.targets.find(x => x.kind === 'post' || x.kind === 'reel')
    perAccountDaily.push({ accountId: aid, platform: '', posts: postsKind?.count ?? 0 })
  }
  // Look up platform per account.
  for (const row of perAccountDaily) {
    const [a] = await db.select({ platform: managedAccount.platform }).from(managedAccount).where(eq(managedAccount.id, row.accountId)).limit(1)
    if (a) row.platform = a.platform
  }
  const plan = Array.from({ length: days }, (_, i) => ({ day: i + 1, perAccount: perAccountDaily.map(r => ({ ...r })) }))
  const totalPosts = perAccountDaily.reduce((a, r) => a + r.posts, 0) * days
  return { daysAhead: days, plan, totalPosts }
}

// ─── Best-sellers → content seeds (R163) ────────────────────────────

export async function bestSellersToContent(workspaceId: string, opts: { storeId: string; topN?: number }): Promise<{ packs: Array<{ productId: string; packId: string; variantCount: number }> }> {
  const N = Math.max(1, Math.min(opts.topN ?? 3, 10))
  const products = await db.select().from(podProduct)
    .where(and(eq(podProduct.workspaceId, workspaceId), eq(podProduct.storeId, opts.storeId), isNotNull(podProduct.designUrl)))
    .orderBy(desc(podProduct.revenueCents))
    .limit(N)

  const { repurposeCreate } = await import('./r163-volume-engines.js')
  const packs: Array<{ productId: string; packId: string; variantCount: number }> = []
  for (const p of products) {
    const sourceBody = [
      `Product: ${p.title}`,
      p.category ? `Category: ${p.category}` : '',
      `Why it sells: ${p.soldCount} units, $${(p.revenueCents / 100).toFixed(2)} revenue.`,
      `Tags: ${(p.tags ?? []).join(', ')}.`,
      `The angle for social: highlight the design + emotion + one-line use-case → CTA to the store.`,
    ].filter(Boolean).join('\n\n')
    const r = await repurposeCreate(workspaceId, {
      sourceBody, title: p.title, sourceKind: 'text', sourceRef: `pod_product:${p.id}`,
    })
    packs.push({ productId: p.id, packId: r.packId, variantCount: r.variantCount })
  }
  return { packs }
}
