/**
 * R401 — Auto-variants for winners.
 *
 * Pulls top N winners from R395 that don't have variants yet and runs
 * R374.generateWinnerVariants on each. Closes the "force-variant-gen for
 * proven winners" loop without operator intervention.
 *
 * Hourly tick. Caps at MAX_PER_RUN to avoid blasting design generation
 * credits in one burst.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const MAX_PER_RUN_DEFAULT = 3
const MIN_WINNER_SCORE_DEFAULT = 5      // anything below this is too low-signal to invest in variants

export interface AutoVariantsResult {
  workspaces:    number
  triggered:     Array<{ workspaceId: string; designId: string; prompt: string; winnerScore: number; variantsCreated: number }>
  skipped:       number
}

export async function runAutoVariantsForWinners(): Promise<AutoVariantsResult> {
  const result: AutoVariantsResult = { workspaces: 0, triggered: [], skipped: 0 }

  let workspaceIds: string[] = []
  try {
    const r = await db.execute(sql`SELECT DISTINCT workspace_id FROM design_upload_queue`)
    workspaceIds = (r as unknown as Array<{ workspace_id: string }>).map(x => x.workspace_id).filter(Boolean)
  } catch { /* tolerated */ }
  if (workspaceIds.length === 0) return result
  result.workspaces = workspaceIds.length

  const { rankDesignPerformance } = await import('./r395-design-performance.js')
  const { generateWinnerVariants } = await import('./r374-winner-variant-generator.js')

  for (const ws of workspaceIds) {
    try {
      // R443 — skip if operator engaged the autonomous_writes kill switch.
      const { isAutonomyAllowed } = await import('./r443-autonomy-gate.js')
      if (!await isAutonomyAllowed(ws)) { result.skipped++; continue }
      // R428 — bail on budget exhaustion before burning image-gen credits.
      const { isBudgetExhausted, recordSpend } = await import('./r428-ai-spend-tracker.js')
      if (await isBudgetExhausted(ws)) { result.skipped++; continue }
      // R470 — per-workspace tunables
      const { getNumSetting } = await import('./r437-operator-timezone.js')
      const MAX_PER_RUN = await getNumSetting(ws, 'r401_max_per_run', MAX_PER_RUN_DEFAULT)
      const MIN_WINNER_SCORE = await getNumSetting(ws, 'r401_min_winner_score', MIN_WINNER_SCORE_DEFAULT)
      const r = await rankDesignPerformance(ws, 10)
      const candidates = r.designs
        .filter(d => !d.hasVariants && d.winnerScore >= MIN_WINNER_SCORE)
        .slice(0, MAX_PER_RUN)
      for (const c of candidates) {
        // R499 — record ATTEMPTED spend (3 images at ~$0.04 = 12 cents) BEFORE
        // the call so provider charges for partial generation aren't invisible.
        // We over-record then reconcile if fewer are created.
        await recordSpend(ws, 'auto_variants_attempted', 12)
        const gen = await generateWinnerVariants({ workspaceId: ws, parentDesignId: c.designId, count: 3 })
        if (gen.ok && gen.variantsCreated > 0) await recordSpend(ws, 'auto_variants', gen.variantsCreated * 4 /* ~$0.04 image-gen */)
        if (gen.ok && gen.variantsCreated > 0) {
          result.triggered.push({
            workspaceId: ws, designId: c.designId,
            prompt: c.prompt, winnerScore: c.winnerScore,
            variantsCreated: gen.variantsCreated,
          })
        } else {
          result.skipped++
        }
      }
    } catch (e) {
      void e // tolerated
    }
  }
  return result
}
