/**
 * R387 — Pacing auto-loosen.
 *
 * As accounts age and prove no flagging, gradually shrink their per-platform
 * MIN_INTERVAL_MS to increase throughput. The baseline pacing in R378 is
 * tuned for brand-new accounts; once a platform has 50+ uploads with zero
 * failures in the last 14 days, it gets a 30% interval reduction. Up to
 * three tiers of loosening (floor: 3 min for most platforms, 10 min for
 * tiktok_shop).
 *
 * Persisted in pacing_overrides table. Updated on a daily cron tick.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const STEP = 0.7                              // multiply interval by 0.7 per tier
const MAX_TIERS = 3                           // hard cap at tier 3 (0.7^3 ≈ 0.34)
const UPLOADS_FOR_PROMOTION = 50
const CLEAN_WINDOW_MS = 14 * 24 * 60 * 60_000
const PLATFORM_FLOOR_MS: Record<string, number> = {
  tiktok_shop: 10 * 60_000,                   // never go below 10 min — fraud surface
}
const DEFAULT_FLOOR_MS = 3 * 60_000

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pacing_overrides (
      workspace_id    TEXT NOT NULL,
      platform        TEXT NOT NULL,
      tier            INTEGER NOT NULL DEFAULT 0,
      effective_min_ms BIGINT NOT NULL,
      computed_at     BIGINT NOT NULL,
      reason          TEXT,
      PRIMARY KEY (workspace_id, platform)
    )
  `).catch(() => {})
}

export interface AutoLoosenResult {
  workspaces: number
  promoted:   Array<{ workspaceId: string; platform: string; fromTier: number; toTier: number; newIntervalMs: number; uploads: number; failures: number }>
  scanned:    number
}

export async function autoLoosenPacing(): Promise<AutoLoosenResult> {
  await ensureTable()
  const out: AutoLoosenResult = { workspaces: 0, promoted: [], scanned: 0 }

  // Workspaces with any upload activity
  let workspaceIds: string[] = []
  try {
    const r = await db.execute(sql`SELECT DISTINCT workspace_id FROM design_upload_queue`)
    workspaceIds = (r as Array<{ workspace_id: string }>).map(x => x.workspace_id).filter(Boolean)
  } catch { /* table missing */ }
  if (workspaceIds.length === 0) return out
  out.workspaces = workspaceIds.length

  const cutoff = Date.now() - CLEAN_WINDOW_MS
  // Per (workspace, platform): count uploads + failures in last 14d
  const statsRows = await db.execute(sql`
    SELECT workspace_id, platform,
      COUNT(*) FILTER (WHERE status = 'uploaded')::int AS uploads,
      COUNT(*) FILTER (WHERE status = 'failed' AND updated_at >= ${cutoff})::int AS recent_failures
    FROM design_upload_queue
    GROUP BY workspace_id, platform
  `).catch(() => [] as unknown[])

  for (const r of (statsRows as Array<{ workspace_id: string; platform: string; uploads: number; recent_failures: number }>)) {
    out.scanned++
    const uploads = Number(r.uploads) || 0
    const failures = Number(r.recent_failures) || 0
    if (uploads < UPLOADS_FOR_PROMOTION || failures > 0) continue

    // Look up current tier
    const curRows = await db.execute(sql`
      SELECT tier FROM pacing_overrides WHERE workspace_id = ${r.workspace_id} AND platform = ${r.platform}
      LIMIT 1
    `).catch(() => [] as unknown[])
    const curTier = Number((curRows as Array<{ tier: number }>)[0]?.tier ?? 0)
    if (curTier >= MAX_TIERS) continue

    const { __baselineFor } = await import('./r378-upload-pacing.js')
    const baseline = __baselineFor(r.platform)

    const nextTier = curTier + 1
    const floor = PLATFORM_FLOOR_MS[r.platform] ?? DEFAULT_FLOOR_MS
    const proposed = Math.max(floor, Math.round(baseline * Math.pow(STEP, nextTier)))
    if (proposed >= baseline) continue        // floor already reached

    await db.execute(sql`
      INSERT INTO pacing_overrides (workspace_id, platform, tier, effective_min_ms, computed_at, reason)
      VALUES (${r.workspace_id}, ${r.platform}, ${nextTier}, ${proposed}, ${Date.now()},
        ${`auto-loosen tier ${nextTier} (${uploads} uploads, 0 failures 14d)`})
      ON CONFLICT (workspace_id, platform) DO UPDATE
      SET tier = EXCLUDED.tier, effective_min_ms = EXCLUDED.effective_min_ms,
          computed_at = EXCLUDED.computed_at, reason = EXCLUDED.reason
    `).catch(() => {/* best-effort */})

    out.promoted.push({
      workspaceId: r.workspace_id, platform: r.platform,
      fromTier: curTier, toTier: nextTier,
      newIntervalMs: proposed, uploads, failures,
    })
  }

  return out
}

/**
 * Look up the effective min-interval for a (workspace, platform), honoring
 * the R387 override if it exists. R378's checkOrAcquire should call this.
 */
export async function effectiveMinIntervalMs(workspaceId: string, platform: string, baseline: number): Promise<number> {
  try {
    const r = await db.execute(sql`
      SELECT effective_min_ms FROM pacing_overrides
      WHERE workspace_id = ${workspaceId} AND platform = ${platform}
      LIMIT 1
    `)
    const v = Number((r as Array<{ effective_min_ms: number }>)[0]?.effective_min_ms ?? 0)
    if (v > 0 && v < baseline) return v
  } catch { /* tolerated */ }
  return baseline
}
