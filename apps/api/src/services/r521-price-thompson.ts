/**
 * R521 — Per-product price-tier Thompson sampler.
 *
 * Each product has 2-3 candidate price tiers (e.g. $5 / $9 / $14). When
 * operator lists a new variant, sampleNextPriceCents picks the next price
 * to TRY based on observed conversion (sale / view) — biased toward
 * winners but still exploring losers.
 *
 * Records observations:
 *   - markView(productKey, priceCents)
 *   - markSale(productKey, priceCents)
 *
 * Sample (Beta posterior):
 *   - sampleNextPriceCents(productKey, candidates) → price to use next
 *
 * Table: price_experiments(workspace_id, product_key, price_cents, views, sales)
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS price_experiments (
      workspace_id TEXT NOT NULL,
      product_key  TEXT NOT NULL,
      price_cents  INT  NOT NULL,
      views        INT  NOT NULL DEFAULT 0,
      sales        INT  NOT NULL DEFAULT 0,
      last_used_at BIGINT,
      PRIMARY KEY (workspace_id, product_key, price_cents)
    )
  `).catch(() => {})
}

export async function markView(workspaceId: string, productKey: string, priceCents: number): Promise<void> {
  await ensureTable()
  await db.execute(sql`
    INSERT INTO price_experiments (workspace_id, product_key, price_cents, views, sales, last_used_at)
    VALUES (${workspaceId}, ${productKey}, ${priceCents}, 1, 0, ${Date.now()})
    ON CONFLICT (workspace_id, product_key, price_cents)
      DO UPDATE SET views = price_experiments.views + 1, last_used_at = EXCLUDED.last_used_at
  `).catch(() => {/* tolerated */})
}

export async function markSale(workspaceId: string, productKey: string, priceCents: number): Promise<void> {
  await ensureTable()
  await db.execute(sql`
    INSERT INTO price_experiments (workspace_id, product_key, price_cents, views, sales)
    VALUES (${workspaceId}, ${productKey}, ${priceCents}, 0, 1)
    ON CONFLICT (workspace_id, product_key, price_cents)
      DO UPDATE SET sales = price_experiments.sales + 1
  `).catch(() => {/* tolerated */})
}

// R523 — undo a counted sale (called by refund handler). Clamped at 0.
export async function unmarkSale(workspaceId: string, productKey: string, priceCents: number): Promise<void> {
  await ensureTable()
  await db.execute(sql`
    UPDATE price_experiments
       SET sales = GREATEST(0, sales - 1)
     WHERE workspace_id = ${workspaceId} AND product_key = ${productKey} AND price_cents = ${priceCents}
  `).catch(() => {/* tolerated */})
}

// Beta(α, β) sample via approximate marsaglia-style for integer params.
// For our use-case (small ints), this naive form is sufficient.
function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha)
  const y = sampleGamma(beta)
  return x / (x + y)
}
function sampleGamma(shape: number): number {
  // Marsaglia-Tsang for shape >= 1
  if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape)
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x = 0, v = 0
    do {
      x = boxMuller()
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = Math.random()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}
function boxMuller(): number {
  const u = Math.random() || 1e-9, v = Math.random() || 1e-9
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export async function sampleNextPriceCents(
  workspaceId: string, productKey: string, candidates: number[],
): Promise<{ priceCents: number; reason: 'thompson' | 'cold' }> {
  if (candidates.length === 0) throw new Error('R521: candidates required')
  if (candidates.length === 1) return { priceCents: candidates[0]!, reason: 'cold' }
  await ensureTable()
  // Load stats
  let stats: Array<{ price_cents: number; views: number; sales: number }> = []
  try {
    const r = await db.execute(sql`
      SELECT price_cents, views, sales FROM price_experiments
      WHERE workspace_id = ${workspaceId} AND product_key = ${productKey}
        AND price_cents = ANY(${candidates}::int[])
    `)
    stats = r as unknown as typeof stats
  } catch { /* tolerated */ }
  const lookup = new Map(stats.map(s => [Number(s.price_cents), { v: Number(s.views), s: Number(s.sales) }]))
  let bestScore = -1, bestPrice = candidates[0]!
  for (const p of candidates) {
    const { v, s } = lookup.get(p) ?? { v: 0, s: 0 }
    // Beta(s+1, v-s+1) prior — conversion rate
    const score = sampleBeta(s + 1, Math.max(0, v - s) + 1)
    if (score > bestScore) { bestScore = score; bestPrice = p }
  }
  return { priceCents: bestPrice, reason: 'thompson' }
}

export async function snapshotPriceExperiments(
  workspaceId: string, productKey?: string,
): Promise<Array<{ productKey: string; priceCents: number; views: number; sales: number; conversionPct: number }>> {
  await ensureTable()
  try {
    const r = productKey
      ? await db.execute(sql`SELECT product_key, price_cents, views, sales FROM price_experiments WHERE workspace_id = ${workspaceId} AND product_key = ${productKey} ORDER BY sales DESC, views DESC`)
      : await db.execute(sql`SELECT product_key, price_cents, views, sales FROM price_experiments WHERE workspace_id = ${workspaceId} ORDER BY product_key, price_cents`)
    return (r as unknown as Array<{ product_key: string; price_cents: number; views: number; sales: number }>).map(x => ({
      productKey:    x.product_key,
      priceCents:    Number(x.price_cents),
      views:         Number(x.views),
      sales:         Number(x.sales),
      conversionPct: Number(x.views) > 0 ? Math.round((Number(x.sales) / Number(x.views)) * 1000) / 10 : 0,
    }))
  } catch { return [] }
}
