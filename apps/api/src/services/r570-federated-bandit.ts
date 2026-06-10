/**
 * R570 — Federated bandit + trend pool.
 *
 * The single biggest data moat: every Novan operator that opts in contributes
 * anonymized (productKeyHash, priceCents, views, sales) signals; every
 * operator pulling a sample reads the federated prior. With N operators the
 * tail-end product gets faster convergence than any single operator could,
 * and trend signals (which products are gaining sales velocity) become a
 * predictive input no single shop has access to.
 *
 * Privacy model:
 *   - productKey is SHA256-hashed before transmission so source product
 *     identity is not recoverable from the federated pool.
 *   - No operator identifier ships with the signal; only the workspace
 *     submitting the contribution sees its own counts.
 *   - Operator opt-in via workspace_settings.federation_opted_in='1'.
 *
 * Schema:
 *   bandit_federation(product_key_hash, price_cents, samples, sales, last_seen_at)
 *     PRIMARY KEY (product_key_hash, price_cents)
 *
 * For now this runs LOCALLY (single droplet) — the federation pool starts
 * with one contributor. The protocol + opt-in + ingestion endpoint mean
 * adding a second operator is purely an env-var change (FEDERATION_SHARED_KEY
 * + URL) instead of a re-architecture.
 */
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bandit_federation (
      product_key_hash TEXT NOT NULL,
      price_cents      INT  NOT NULL,
      samples          INT  NOT NULL DEFAULT 0,
      sales            INT  NOT NULL DEFAULT 0,
      last_seen_at     BIGINT NOT NULL,
      PRIMARY KEY (product_key_hash, price_cents)
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS bandit_fed_seen_idx ON bandit_federation (last_seen_at DESC)`).catch(() => {})
}

export function hashProductKey(productKey: string): string {
  return createHash('sha256').update(productKey).digest('hex')
}

export async function isFederationOptedIn(workspaceId: string): Promise<boolean> {
  try {
    const { getBoolSetting } = await import('./r437-operator-timezone.js')
    return await getBoolSetting(workspaceId, 'federation_opted_in', false)
  } catch { return false }
}

/** Contribute a (view, sale) delta from the local R521 bandit to the pool. */
export async function contributeBanditDelta(
  workspaceId: string, productKey: string, priceCents: number,
  deltaViews: number, deltaSales: number,
): Promise<{ contributed: boolean; reason?: string }> {
  if (!await isFederationOptedIn(workspaceId)) return { contributed: false, reason: 'opted out' }
  await ensureTable()
  const hash = hashProductKey(productKey)
  try {
    await db.execute(sql`
      INSERT INTO bandit_federation (product_key_hash, price_cents, samples, sales, last_seen_at)
      VALUES (${hash}, ${priceCents}, ${Math.max(0, deltaViews)}, ${Math.max(0, deltaSales)}, ${Date.now()})
      ON CONFLICT (product_key_hash, price_cents) DO UPDATE
      SET samples = bandit_federation.samples + EXCLUDED.samples,
          sales   = bandit_federation.sales   + EXCLUDED.sales,
          last_seen_at = EXCLUDED.last_seen_at
    `)
    return { contributed: true }
  } catch (e) {
    return { contributed: false, reason: (e as Error).message.slice(0, 80) }
  }
}

/** Pull the federated (samples, sales) prior for blending into local sampling. */
export async function pullBanditPrior(productKey: string, priceCents: number): Promise<{ samples: number; sales: number }> {
  await ensureTable()
  const hash = hashProductKey(productKey)
  try {
    const r = await db.execute(sql`
      SELECT samples, sales FROM bandit_federation
      WHERE product_key_hash = ${hash} AND price_cents = ${priceCents}
      LIMIT 1
    `)
    const row = (r as unknown as Array<{ samples: number; sales: number }>)[0]
    return row ? { samples: Number(row.samples), sales: Number(row.sales) } : { samples: 0, sales: 0 }
  } catch { return { samples: 0, sales: 0 } }
}

export interface TrendSignal {
  productKeyHash: string
  priceCents:     number
  recentSales:    number
  velocity:       number   // sales / day over the lookback window
}

/** Top-N rising products in the federated pool (sales velocity over lookback). */
export async function trendingFederated(lookbackDays = 14, topN = 25): Promise<TrendSignal[]> {
  await ensureTable()
  const since = Date.now() - lookbackDays * 24 * 60 * 60_000
  try {
    const r = await db.execute(sql`
      SELECT product_key_hash, price_cents, sales,
             (sales::float / GREATEST(1, ${lookbackDays})) AS velocity
      FROM bandit_federation
      WHERE last_seen_at >= ${since} AND sales > 0
      ORDER BY velocity DESC
      LIMIT ${topN}
    `)
    return (r as unknown as Array<{ product_key_hash: string; price_cents: number; sales: number; velocity: number }>).map(x => ({
      productKeyHash: x.product_key_hash,
      priceCents:     Number(x.price_cents),
      recentSales:    Number(x.sales),
      velocity:       Number(x.velocity),
    }))
  } catch { return [] }
}

/** Federation pool size + freshness for dashboard. */
export async function federationStats(): Promise<{ entries: number; totalSales: number; oldestSeenAt: number | null; newestSeenAt: number | null }> {
  await ensureTable()
  try {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS entries,
             COALESCE(SUM(sales), 0)::int AS total_sales,
             MIN(last_seen_at) AS oldest,
             MAX(last_seen_at) AS newest
      FROM bandit_federation
    `)
    const row = (r as unknown as Array<{ entries: number; total_sales: number; oldest: number | null; newest: number | null }>)[0]
    return {
      entries:      Number(row?.entries ?? 0),
      totalSales:   Number(row?.total_sales ?? 0),
      oldestSeenAt: row?.oldest === null || row?.oldest === undefined ? null : Number(row.oldest),
      newestSeenAt: row?.newest === null || row?.newest === undefined ? null : Number(row.newest),
    }
  } catch { return { entries: 0, totalSales: 0, oldestSeenAt: null, newestSeenAt: null } }
}
