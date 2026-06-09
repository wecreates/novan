/**
 * R375 — Cross-platform sales recorder.
 *
 * Most POD platforms (FAA, RB, INPRNT, TeePublic, Zazzle, etc.) don't expose
 * sales via public API. This op gives the operator a single endpoint to log
 * sales by hand (or via webhook handler if/when a platform sends one), so the
 * goal-ladder MRR rollup includes everything.
 *
 * Auto-triggers winner-variant generation (R374) on each sale.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import { classifyTier, nextMilestone } from './r350-goal-ladder.js'

export type SalesPlatform =
  | 'gumroad' | 'inprnt' | 'fine_art_america' | 'redbubble' | 'etsy'
  | 'zazzle' | 'spreadshirt' | 'teepublic' | 'tiktok_shop' | 'displate' | 'threadless'

export interface RecordSaleInput {
  workspaceId:    string
  businessId?:    string
  platform:       SalesPlatform
  externalSaleId: string                  // idempotency key
  grossUsd:       number
  netUsd?:        number                  // defaults to grossUsd if missing
  productUrl?:    string                  // optional, helps winner-variant matching
  productName?:   string
  occurredAt?:    number                  // epoch ms, defaults to now
  source?:        string                  // 'manual' | 'webhook' | 'api'
}

export interface RecordSaleResult {
  ok:               boolean
  reason?:          string
  inserted:         boolean
  newTotalUsd:      number
  tierBefore:       string
  tierAfter:        string
  tierUnlocked:     boolean
  variantsTriggered: number
}

const DEFAULT_BUSINESS_ID = 'cyzor_creations'

export async function recordSale(input: RecordSaleInput): Promise<RecordSaleResult> {
  const businessId = input.businessId ?? DEFAULT_BUSINESS_ID
  const ts = input.occurredAt ?? Date.now()
  const net = input.netUsd ?? input.grossUsd

  // 30d MRR before
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000
  const beforeRows = await db.execute(sql`
    SELECT COALESCE(SUM(net_usd), 0) AS total FROM business_revenue
    WHERE workspace_id = ${input.workspaceId} AND business_id = ${businessId} AND recorded_at >= ${cutoff}
  `)
  const beforeUsd = Number((beforeRows as Array<{ total: number }>)[0]?.total ?? 0)
  const tierBefore = classifyTier(beforeUsd).tier

  // Idempotent insert
  let inserted = false
  try {
    const res = await db.execute(sql`
      INSERT INTO business_revenue
        (id, workspace_id, business_id, source, external_sale_id, gross_usd, net_usd, recorded_at, metadata)
      VALUES
        (${uuidv7()}, ${input.workspaceId}, ${businessId}, ${input.source ?? `${input.platform}-manual`},
         ${input.externalSaleId}, ${input.grossUsd}, ${net}, ${ts},
         ${JSON.stringify({ platform: input.platform, productUrl: input.productUrl ?? '', productName: input.productName ?? '' })}::jsonb)
      ON CONFLICT DO NOTHING
      RETURNING id
    `)
    inserted = Array.isArray(res) && (res as unknown[]).length > 0
  } catch (e) {
    return {
      ok: false, reason: 'insert failed: ' + (e as Error).message,
      inserted: false, newTotalUsd: beforeUsd, tierBefore, tierAfter: tierBefore,
      tierUnlocked: false, variantsTriggered: 0,
    }
  }

  // 30d MRR after
  const afterRows = await db.execute(sql`
    SELECT COALESCE(SUM(net_usd), 0) AS total FROM business_revenue
    WHERE workspace_id = ${input.workspaceId} AND business_id = ${businessId} AND recorded_at >= ${cutoff}
  `)
  const afterUsd = Number((afterRows as Array<{ total: number }>)[0]?.total ?? 0)
  const tierAfter = classifyTier(afterUsd).tier
  const tierUnlocked = tierBefore !== tierAfter

  if (tierUnlocked) {
    const ms = nextMilestone(afterUsd)
    const id = uuidv7(), trace = uuidv7()
    await db.execute(sql`
      INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
      VALUES (${id}, 'business.tier_unlocked', ${input.workspaceId},
              ${JSON.stringify({
                businessId, fromTier: tierBefore, toTier: tierAfter, mrrUsd: Math.round(afterUsd * 100) / 100,
                unlockedTactics: ms.current.unlockedTactics, blockedTactics: ms.current.blockedTactics,
                nextTier: ms.next?.tier ?? null, nextGapUsd: ms.gapUsd, ts: Date.now(),
              })}::jsonb,
              ${trace}, ${trace}, ${'r375-cross-sales'}, 1, ${Date.now()})
    `).catch(() => {/* events may not exist in some envs */})
  }

  // R374 — trigger variant generation if we have a productUrl
  let variantsTriggered = 0
  if (inserted && input.productUrl) {
    try {
      const q = await db.execute(sql`
        SELECT design_id FROM design_upload_queue
        WHERE workspace_id = ${input.workspaceId} AND external_url = ${input.productUrl} AND status = 'uploaded'
        LIMIT 1
      `)
      const designId = (q as Array<{ design_id: string }>)[0]?.design_id
      if (designId) {
        const existing = await db.execute(sql`
          SELECT 1 FROM design_catalog
          WHERE workspace_id = ${input.workspaceId} AND parent_design_id = ${designId}
          LIMIT 1
        `).catch(() => [] as unknown[])
        if (!Array.isArray(existing) || existing.length === 0) {
          const { generateWinnerVariants } = await import('./r374-winner-variant-generator.js')
          const r = await generateWinnerVariants({ workspaceId: input.workspaceId, parentDesignId: designId, count: 3 })
          variantsTriggered = r.variantsCreated
        }
      }
    } catch (e) {
      console.error('[r375] variant generation skipped:', (e as Error).message)
    }
  }

  return {
    ok: true, inserted, newTotalUsd: afterUsd, tierBefore, tierAfter, tierUnlocked, variantsTriggered,
  }
}

export interface CrossPlatformMrrBreakdown {
  totalMrrUsd:        number
  byPlatform:         Array<{ platform: string; mrrUsd: number; saleCount: number }>
  tier:               string
  nextTier:           string | null
  gapUsd:             number
  percentToNext:      number
}

export async function getCrossPlatformMrr(workspaceId: string, businessId = DEFAULT_BUSINESS_ID): Promise<CrossPlatformMrrBreakdown> {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000
  const rows = await db.execute(sql`
    SELECT
      COALESCE(metadata->>'platform', source) AS platform,
      COALESCE(SUM(net_usd), 0) AS mrr_usd,
      COUNT(*)::int AS sale_count
    FROM business_revenue
    WHERE workspace_id = ${workspaceId} AND business_id = ${businessId} AND recorded_at >= ${cutoff}
    GROUP BY COALESCE(metadata->>'platform', source)
    ORDER BY mrr_usd DESC
  `).catch(() => [] as unknown[])
  const byPlatform = (rows as Array<{ platform: string; mrr_usd: number; sale_count: number }>).map(r => ({
    platform:  String(r.platform ?? '?'),
    mrrUsd:    Math.round(Number(r.mrr_usd) * 100) / 100,
    saleCount: Number(r.sale_count) || 0,
  }))
  const totalMrrUsd = byPlatform.reduce((a, b) => a + b.mrrUsd, 0)
  const ms = nextMilestone(totalMrrUsd)
  return {
    totalMrrUsd: Math.round(totalMrrUsd * 100) / 100,
    byPlatform,
    tier:         ms.current.tier,
    nextTier:     ms.next?.tier ?? null,
    gapUsd:       ms.gapUsd,
    percentToNext: ms.percentToNext,
  }
}
