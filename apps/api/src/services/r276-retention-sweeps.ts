/**
 * R146.276 — Retention sweeps for tables that were growing unbounded.
 *
 * Found during live diagnostics:
 *   - external_knowledge  234 MB / 6.5 k rows / 7 days   (≈ 1 GB / month at current rate)
 *   - platform_smoke_runs   6.7 MB / 2.4 k rows / 8 days (slow growth, but no cap)
 *
 * Both are append-only with no foreign keys pointing in (verified
 * mid-session: no other table references their PKs). Safe to prune by
 * timestamp.
 */
import { db } from '../db/client.js'
import { externalKnowledge, platformSmokeRuns } from '../db/schema.js'
import { lt } from 'drizzle-orm'

const EK_RETAIN_DAYS  = 30
const SR_RETAIN_DAYS  = 14

export interface SweepResult { ek: number; sr: number }

export async function runRetentionSweeps(): Promise<SweepResult> {
  const now = Date.now()
  const ekCut = now - EK_RETAIN_DAYS * 86_400_000
  const srCut = now - SR_RETAIN_DAYS * 86_400_000

  const ek = await db.delete(externalKnowledge)
    .where(lt(externalKnowledge.fetchedAt, ekCut))
    .catch(() => null)
  const sr = await db.delete(platformSmokeRuns)
    .where(lt(platformSmokeRuns.ranAt, srCut))
    .catch(() => null)

  return {
    ek: Number((ek as { rowCount?: number } | null)?.rowCount ?? 0),
    sr: Number((sr as { rowCount?: number } | null)?.rowCount ?? 0),
  }
}
