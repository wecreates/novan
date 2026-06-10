/**
 * R572 — Financial product layer (escrow reserves + factoring intent +
 *        insurance enrollment).
 *
 * SCOPE NOTE — this is the SCAFFOLDING, not a live fintech. No funds move,
 * no escrow account exists yet, no insurance policy underwritten. What
 * ships:
 *   - Tables that let operator REASON about reserve targets, factoring
 *     opportunities, and insurance options.
 *   - Algorithms that compute recommended reserve from observed refund rate
 *     (R522/R537/R536 data).
 *   - Intent records operator can capture so when the licensed fintech
 *     partner ships, the history is already there.
 *   - Brain ops + dashboard so operator can SEE the recommended numbers.
 *
 * What CANNOT ship without legal work:
 *   - Holding operator funds in escrow (requires money-transmitter license
 *     or bank partner)
 *   - Underwriting insurance (requires E&O carrier partnership)
 *   - Factoring receivables (requires capital + AR purchase agreement)
 *
 * The honest play: ship the math, the recommendations, the intent capture
 * NOW. Convert to a real product once N operators have N months of intent
 * data showing demand.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTables(): Promise<void> {
  // Reserves — recommended cash buffer per source against refund risk.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS finance_reserves (
      workspace_id      TEXT NOT NULL,
      source            TEXT NOT NULL,
      recommended_usd   NUMERIC(10,2) NOT NULL DEFAULT 0,
      observed_refund_rate NUMERIC(6,4) NOT NULL DEFAULT 0,    -- 0..1
      based_on_sales    INT NOT NULL DEFAULT 0,
      based_on_refunds  INT NOT NULL DEFAULT 0,
      window_days       INT NOT NULL DEFAULT 90,
      computed_at       BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, source)
    )
  `).catch(() => {})

  // Factoring intents — operator says "I want to factor next $X of Gumroad
  // receivables". Today this is captured; tomorrow it routes to a partner.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS factoring_intents (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      source            TEXT NOT NULL,
      amount_usd        NUMERIC(10,2) NOT NULL,
      discount_pct      NUMERIC(5,3) NOT NULL DEFAULT 0.05,    -- ~5% standard
      status            TEXT NOT NULL DEFAULT 'proposed',       -- proposed|accepted|funded|settled|cancelled
      proposed_at       BIGINT NOT NULL,
      status_at         BIGINT,
      notes             TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS factoring_intents_ws_status_idx ON factoring_intents (workspace_id, status, proposed_at DESC)`).catch(() => {})

  // Insurance enrollment — operator opts into a tier; today this is record,
  // tomorrow it's a real E&O policy through a carrier partner.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS insurance_enrollments (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      tier              TEXT NOT NULL,     -- 'basic'|'standard'|'premium'
      monthly_usd       NUMERIC(8,2) NOT NULL,
      coverage_summary  TEXT,
      enrolled_at       BIGINT NOT NULL,
      cancelled_at      BIGINT,
      notes             TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS insurance_ws_active_idx ON insurance_enrollments (workspace_id) WHERE cancelled_at IS NULL`).catch(() => {})
}

// ─── Reserves ────────────────────────────────────────────────────────────────

export interface ReserveRecommendation {
  source:               string
  recommendedUsd:       number
  observedRefundRate:   number
  basedOnSales:         number
  basedOnRefunds:       number
  windowDays:           number
  computedAt:           number
}

/** Compute recommended reserve = (avg-sale × refund-rate × outstanding-window-multiplier).
 *  Multiplier of 3x gives headroom for refunds that lag the sale by weeks. */
export async function computeReserves(workspaceId: string, windowDays = 90): Promise<ReserveRecommendation[]> {
  await ensureTables()
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  let rows: Array<{ source: string; sales: number; refunds: number; gross: number }> = []
  try {
    const r = await db.execute(sql`
      SELECT source,
             COUNT(*) FILTER (WHERE net_usd > 0)::int AS sales,
             COUNT(*) FILTER (WHERE net_usd < 0)::int AS refunds,
             COALESCE(SUM(net_usd) FILTER (WHERE net_usd > 0), 0)::float AS gross
      FROM business_revenue
      WHERE workspace_id = ${workspaceId} AND recorded_at >= ${since}
            AND source IS NOT NULL
      GROUP BY source
    `)
    rows = r as unknown as typeof rows
  } catch { return [] }
  const out: ReserveRecommendation[] = []
  for (const row of rows) {
    const sales   = Number(row.sales)   || 0
    const refunds = Number(row.refunds) || 0
    const gross   = Number(row.gross)   || 0
    if (sales === 0) continue
    const avgSale = gross / sales
    const refundRate = refunds / sales
    const recommended = Math.round(avgSale * refundRate * 3 * 100) / 100   // 3x sale-to-refund lag buffer
    out.push({
      source:             row.source,
      recommendedUsd:     recommended,
      observedRefundRate: Math.round(refundRate * 10000) / 10000,
      basedOnSales:       sales,
      basedOnRefunds:     refunds,
      windowDays,
      computedAt:         Date.now(),
    })
    try {
      await db.execute(sql`
        INSERT INTO finance_reserves (workspace_id, source, recommended_usd, observed_refund_rate,
                                       based_on_sales, based_on_refunds, window_days, computed_at)
        VALUES (${workspaceId}, ${row.source}, ${recommended}, ${refundRate}, ${sales}, ${refunds}, ${windowDays}, ${Date.now()})
        ON CONFLICT (workspace_id, source) DO UPDATE SET
          recommended_usd      = EXCLUDED.recommended_usd,
          observed_refund_rate = EXCLUDED.observed_refund_rate,
          based_on_sales       = EXCLUDED.based_on_sales,
          based_on_refunds     = EXCLUDED.based_on_refunds,
          window_days          = EXCLUDED.window_days,
          computed_at          = EXCLUDED.computed_at
      `).catch(() => {/* tolerated */})
    } catch { /* tolerated */ }
  }
  return out
}

export async function listReserves(workspaceId: string): Promise<ReserveRecommendation[]> {
  await ensureTables()
  try {
    const r = await db.execute(sql`
      SELECT source, recommended_usd, observed_refund_rate, based_on_sales,
             based_on_refunds, window_days, computed_at
      FROM finance_reserves WHERE workspace_id = ${workspaceId}
      ORDER BY recommended_usd DESC
    `)
    return (r as unknown as Array<{
      source: string; recommended_usd: number; observed_refund_rate: number;
      based_on_sales: number; based_on_refunds: number; window_days: number;
      computed_at: number;
    }>).map(x => ({
      source:             x.source,
      recommendedUsd:     Number(x.recommended_usd),
      observedRefundRate: Number(x.observed_refund_rate),
      basedOnSales:       Number(x.based_on_sales),
      basedOnRefunds:     Number(x.based_on_refunds),
      windowDays:         Number(x.window_days),
      computedAt:         Number(x.computed_at),
    }))
  } catch { return [] }
}

// ─── Factoring intent ───────────────────────────────────────────────────────

export interface FactoringIntent {
  id:           string
  source:       string
  amountUsd:    number
  discountPct:  number
  status:       string
  proposedAt:   number
  statusAt:     number | null
}

export async function proposeFactoring(workspaceId: string, source: string, amountUsd: number, discountPct = 0.05, notes?: string): Promise<FactoringIntent | null> {
  await ensureTables()
  if (!source || !Number.isFinite(amountUsd) || amountUsd <= 0) return null
  const id = uuidv7()
  const now = Date.now()
  try {
    await db.execute(sql`
      INSERT INTO factoring_intents (id, workspace_id, source, amount_usd, discount_pct, status, proposed_at, notes)
      VALUES (${id}, ${workspaceId}, ${source}, ${amountUsd}, ${discountPct}, 'proposed', ${now}, ${notes ?? null})
    `)
    return { id, source, amountUsd, discountPct, status: 'proposed', proposedAt: now, statusAt: null }
  } catch { return null }
}

export async function listFactoringIntents(workspaceId: string, statusFilter?: string): Promise<FactoringIntent[]> {
  await ensureTables()
  try {
    const r = statusFilter
      ? await db.execute(sql`SELECT id, source, amount_usd, discount_pct, status, proposed_at, status_at FROM factoring_intents WHERE workspace_id = ${workspaceId} AND status = ${statusFilter} ORDER BY proposed_at DESC LIMIT 100`)
      : await db.execute(sql`SELECT id, source, amount_usd, discount_pct, status, proposed_at, status_at FROM factoring_intents WHERE workspace_id = ${workspaceId} ORDER BY proposed_at DESC LIMIT 100`)
    return (r as unknown as Array<{ id: string; source: string; amount_usd: number; discount_pct: number; status: string; proposed_at: number; status_at: number | null }>).map(x => ({
      id: x.id, source: x.source, amountUsd: Number(x.amount_usd), discountPct: Number(x.discount_pct),
      status: x.status, proposedAt: Number(x.proposed_at), statusAt: x.status_at === null ? null : Number(x.status_at),
    }))
  } catch { return [] }
}

// ─── Insurance enrollment ──────────────────────────────────────────────────

export interface InsuranceTier {
  tier:             'basic' | 'standard' | 'premium'
  monthlyUsd:       number
  coverageSummary:  string
}

export const INSURANCE_TIERS: InsuranceTier[] = [
  { tier: 'basic',    monthlyUsd: 19,  coverageSummary: 'Account-recovery service if a POD platform terminates your seller account (no fund coverage).' },
  { tier: 'standard', monthlyUsd: 49,  coverageSummary: 'Basic + up to $2,000 against operator-error refund storms (verified via refund event log).' },
  { tier: 'premium',  monthlyUsd: 99,  coverageSummary: 'Standard + up to $10,000 against DMCA misfiling penalties + legal-defense referral.' },
]

export interface InsuranceEnrollment {
  id:               string
  tier:             string
  monthlyUsd:       number
  coverageSummary:  string
  enrolledAt:       number
  cancelledAt:      number | null
}

export async function enrollInsurance(workspaceId: string, tierName: string): Promise<InsuranceEnrollment | null> {
  await ensureTables()
  const tier = INSURANCE_TIERS.find(t => t.tier === tierName)
  if (!tier) return null
  const id = uuidv7()
  try {
    await db.execute(sql`
      INSERT INTO insurance_enrollments (id, workspace_id, tier, monthly_usd, coverage_summary, enrolled_at)
      VALUES (${id}, ${workspaceId}, ${tier.tier}, ${tier.monthlyUsd}, ${tier.coverageSummary}, ${Date.now()})
    `)
    return { id, tier: tier.tier, monthlyUsd: tier.monthlyUsd, coverageSummary: tier.coverageSummary, enrolledAt: Date.now(), cancelledAt: null }
  } catch { return null }
}

export async function activeInsurance(workspaceId: string): Promise<InsuranceEnrollment | null> {
  await ensureTables()
  try {
    const r = await db.execute(sql`
      SELECT id, tier, monthly_usd, coverage_summary, enrolled_at, cancelled_at
      FROM insurance_enrollments
      WHERE workspace_id = ${workspaceId} AND cancelled_at IS NULL
      ORDER BY enrolled_at DESC LIMIT 1
    `)
    const row = (r as unknown as Array<{ id: string; tier: string; monthly_usd: number; coverage_summary: string; enrolled_at: number; cancelled_at: number | null }>)[0]
    if (!row) return null
    return { id: row.id, tier: row.tier, monthlyUsd: Number(row.monthly_usd), coverageSummary: row.coverage_summary, enrolledAt: Number(row.enrolled_at), cancelledAt: row.cancelled_at === null ? null : Number(row.cancelled_at) }
  } catch { return null }
}
