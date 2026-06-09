/**
 * R367 — Gumroad sales sync + goal-ladder auto-progression.
 *
 * Pulls the operator's Gumroad sales via the Gumroad API (or a manually-set
 * webhook), persists each sale to business_revenue, then checks if the
 * cumulative net_usd has crossed a goal-ladder threshold. If so, emits a
 * tier-unlock event and a brain-broadcast announcing the tier transition.
 *
 * This closes the first-dollar loop: SKU → sale → MRR rollup → goal-tier
 * progression → tactical unlock surfaced in chat.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import { classifyTier, nextMilestone } from './r350-goal-ladder.js'

const GUMROAD_API_BASE = 'https://api.gumroad.com/v2'
const DEFAULT_BUSINESS_ID = 'cyzor_creations'
const SOURCE = 'gumroad-sync'

export interface SyncResult {
  ok:           boolean
  fetched:      number
  persisted:    number
  newTotalUsd:  number
  tierBefore:   string
  tierAfter:    string
  tierUnlocked: boolean
  reason?:      string
}

interface GumroadSale {
  id:            string
  email?:        string
  price:         number          // cents
  formatted_total_price?: string
  product_name?: string
  permalink?:    string
  short_product_id?: string
  refunded?:     boolean
  partially_refunded?: boolean
  created_at:    string          // ISO
}

async function getGumroadToken(workspaceId: string): Promise<string | null> {
  // The Gumroad access token lives in workspace_memory under
  // 'connector.gumroad.access_token' (operator-set per R332 / connector pattern).
  try {
    const rows = await db.execute(sql`
      SELECT value FROM workspace_memory
      WHERE workspace_id = ${workspaceId} AND key = 'connector.gumroad.access_token'
      LIMIT 1
    `)
    const r = (rows as unknown as Array<{ value: string }>)[0]
    return r?.value ?? null
  } catch { return null }
}

async function fetchPage(token: string, after?: string): Promise<{ sales: GumroadSale[]; next_page_url?: string }> {
  const url = new URL(`${GUMROAD_API_BASE}/sales`)
  url.searchParams.set('access_token', token)
  if (after) url.searchParams.set('after', after)
  url.searchParams.set('per_page', '100')
  // R469 — 10s timeout so a hung Gumroad doesn't hang the cron tick.
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 10_000)
  try {
    const res = await fetch(url.href, { signal: ac.signal })
    if (!res.ok) throw new Error(`Gumroad sales API ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return await res.json() as { sales: GumroadSale[]; next_page_url?: string }
  } finally { clearTimeout(t) }
}

export async function syncGumroadSales(workspaceId: string, businessId = DEFAULT_BUSINESS_ID): Promise<SyncResult> {
  const token = await getGumroadToken(workspaceId)
  if (!token) {
    return { ok: false, fetched: 0, persisted: 0, newTotalUsd: 0, tierBefore: 'pre_first_sale', tierAfter: 'pre_first_sale', tierUnlocked: false, reason: 'gumroad access token not set in workspace_memory.connector.gumroad.access_token' }
  }

  // Compute tier BEFORE the sync so we can detect a transition
  const beforeRows = await db.execute(sql`
    SELECT COALESCE(SUM(net_usd), 0) AS total FROM business_revenue
    WHERE workspace_id = ${workspaceId} AND business_id = ${businessId}
      AND recorded_at >= ${Date.now() - 30 * 24 * 3600 * 1000}
  `)
  const before30dUsd = Number((beforeRows as unknown as Array<{ total: number }>)[0]?.total ?? 0)
  const tierBefore = classifyTier(before30dUsd).tier

  // Pull pages until empty. We rely on Gumroad's `after` cursor.
  // Track most-recent date we've already synced so we don't re-insert.
  const lastSeenRows = await db.execute(sql`
    SELECT MAX(recorded_at) AS last_at FROM business_revenue
    WHERE workspace_id = ${workspaceId} AND business_id = ${businessId} AND source = ${SOURCE}
  `)
  const lastAtMs = Number((lastSeenRows as unknown as Array<{ last_at: number }>)[0]?.last_at ?? 0)
  const lastAtISO = lastAtMs > 0 ? new Date(lastAtMs).toISOString() : undefined

  let fetched = 0, persisted = 0
  let cursor: string | undefined = lastAtISO
  let pages = 0
  while (pages < 10) {       // hard cap to 1000 sales per sync
    pages++
    let resp: { sales: GumroadSale[]; next_page_url?: string }
    try { resp = await fetchPage(token, cursor) }
    catch (e) { return { ok: false, fetched, persisted, newTotalUsd: before30dUsd, tierBefore, tierAfter: tierBefore, tierUnlocked: false, reason: (e as Error).message } }
    fetched += resp.sales.length
    for (const sale of resp.sales) {
      if (sale.refunded) continue
      const netCents = sale.partially_refunded ? Math.floor(sale.price / 2) : sale.price
      const netUsd = netCents / 100
      const ts = new Date(sale.created_at).getTime()
      if (!Number.isFinite(ts) || ts <= 0) continue
      // R431 — normalize permalink so webhook + poll dedupe correctly via metadata->>'permalink'
      const normalizedPermalink = String(sale.permalink ?? '').trim()
        .replace(/^http:\/\//i, 'https://').replace(/\/$/, '').toLowerCase()
      // Idempotent insert: same external_sale_id won't dupe
      const res = await db.execute(sql`
        INSERT INTO business_revenue (id, workspace_id, business_id, source, external_sale_id, gross_usd, net_usd, recorded_at, metadata)
        VALUES (${uuidv7()}, ${workspaceId}, ${businessId}, ${SOURCE}, ${sale.id}, ${sale.price / 100}, ${netUsd}, ${ts}, ${JSON.stringify({ product: sale.product_name ?? '', permalink: normalizedPermalink })}::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id
      `).catch(() => undefined)
      if (Array.isArray(res) && res.length > 0) persisted++
    }
    if (!resp.next_page_url || resp.sales.length === 0) break
    // Use last sale's created_at as the next cursor
    const last = resp.sales[resp.sales.length - 1]
    if (!last) break
    cursor = last.created_at
  }

  // Recompute tier AFTER the sync
  const afterRows = await db.execute(sql`
    SELECT COALESCE(SUM(net_usd), 0) AS total FROM business_revenue
    WHERE workspace_id = ${workspaceId} AND business_id = ${businessId}
      AND recorded_at >= ${Date.now() - 30 * 24 * 3600 * 1000}
  `)
  const after30dUsd = Number((afterRows as unknown as Array<{ total: number }>)[0]?.total ?? 0)
  const tierAfter = classifyTier(after30dUsd).tier

  const tierUnlocked = tierBefore !== tierAfter
  if (tierUnlocked) {
    await emitTierUnlock(workspaceId, businessId, tierBefore, tierAfter, after30dUsd)
  }

  // R374 — if any new sales landed, trigger variant generation for the winning designs
  if (persisted > 0) {
    try {
      const newSaleRows = await db.execute(sql`
        SELECT external_sale_id FROM business_revenue
        WHERE workspace_id = ${workspaceId} AND business_id = ${businessId} AND source = ${SOURCE}
          AND recorded_at >= ${lastAtMs || (Date.now() - 7 * 24 * 3600 * 1000)}
      `)
      const newIds = (newSaleRows as Array<{ external_sale_id: string }>).map(r => r.external_sale_id).filter(Boolean)
      if (newIds.length > 0) {
        const { reactToNewSales } = await import('./r374-winner-variant-generator.js')
        const r = await reactToNewSales(workspaceId, newIds)
        console.log(`[r367] R374 winner-variant generator: triggered=${r.triggered} skipped=${r.skipped} variants=${r.totalVariants}`)
      }
    } catch (e) {
      console.error('[r367] R374 winner-variant trigger failed:', (e as Error).message)
    }
  }

  return {
    ok: true, fetched, persisted,
    newTotalUsd: after30dUsd, tierBefore, tierAfter, tierUnlocked,
  }
}

async function emitTierUnlock(workspaceId: string, businessId: string, from: string, to: string, mrrUsd: number): Promise<void> {
  const ms = nextMilestone(mrrUsd)
  const payload = {
    businessId,
    fromTier:        from,
    toTier:          to,
    mrrUsd:          Math.round(mrrUsd * 100) / 100,
    unlockedTactics: ms.current.unlockedTactics,
    blockedTactics:  ms.current.blockedTactics,
    nextTier:        ms.next?.tier ?? null,
    nextGapUsd:      ms.gapUsd,
    ts:              Date.now(),
  }
  const id    = uuidv7()
  const trace = uuidv7()
  await db.execute(sql`
    INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
    VALUES (${id}, 'business.tier_unlocked', ${workspaceId}, ${JSON.stringify(payload)}::jsonb, ${trace}, ${trace}, ${SOURCE}, 1, ${Date.now()})
  `).catch(() => {/* events table may not exist in some test envs */})

  // R397 — fire web push so operator gets the celebration on their phone.
  try {
    const { broadcastPush } = await import('./web-push.js')
    void broadcastPush(workspaceId, {
      title: `🎉 Tier unlocked: ${to}`,
      body:  `30d MRR $${payload.mrrUsd}. Next tier: ${payload.nextTier ?? 'top'} — $${payload.nextGapUsd} away.`,
      url:   '/ops/dashboard',
      tag:   `tier-${to}`,
    })
  } catch { /* tolerated */ }
}

export async function lastSyncSummary(workspaceId: string): Promise<{ ts: number; payload: Record<string, unknown> } | null> {
  try {
    const rows = await db.execute(sql`
      SELECT created_at, payload FROM events
      WHERE workspace_id = ${workspaceId} AND type = 'business.tier_unlocked'
      ORDER BY created_at DESC
      LIMIT 1
    `)
    const r = (rows as unknown as Array<{ created_at: number; payload: Record<string, unknown> }>)[0]
    if (!r) return null
    return { ts: Number(r.created_at), payload: r.payload }
  } catch { return null }
}
