/**
 * R385 — Next-action recommender.
 *
 * Looks across every signal the system has (capability self-test, queue
 * depth, pacing state, sales, pin stats, tier, agent heartbeat) and returns
 * the SINGLE highest-impact action the operator should take next. Surfaced
 * on the operator dashboard so the operator never has to figure out "what
 * matters most right now".
 *
 * Priority is encoded as a score per action (0-100). Highest wins.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface NextAction {
  id:        string
  title:     string
  detail:    string
  score:     number
  reason:    string
  category:  'unblock' | 'maintenance' | 'growth' | 'maintenance' | 'celebrate'
}

interface Sig {
  capabilityMissing:  number    // count of capability.self_test missing items
  capabilityError:    number
  queueQueued:        number
  queueUploaded:      number
  queueFailed:        number
  pacingGated:        number    // platforms blocked by pacing
  pinsQueued:         number
  pinsPostedToday:    number
  pinsRemainingToday: number
  agentHeartbeatAge:  number    // ms since last heartbeat, Infinity if none
  totalMrrCents:      number    // last 30 days revenue across business_revenue
  parentVariantGap:   number    // designs with sales but no variants yet
}

async function gatherSignals(workspaceId: string): Promise<Sig> {
  const s: Sig = {
    capabilityMissing: 0, capabilityError: 0,
    queueQueued: 0, queueUploaded: 0, queueFailed: 0,
    pacingGated: 0,
    pinsQueued: 0, pinsPostedToday: 0, pinsRemainingToday: 0,
    agentHeartbeatAge: Number.POSITIVE_INFINITY,
    totalMrrCents: 0,
    parentVariantGap: 0,
  }

  // Queue
  try {
    const q = await db.execute(sql`
      SELECT status, COUNT(*)::int AS n FROM design_upload_queue
      WHERE workspace_id = ${workspaceId}
      GROUP BY status
    `)
    for (const r of (q as Array<{ status: string; n: number }>)) {
      if (r.status === 'queued')   s.queueQueued   = Number(r.n)
      if (r.status === 'uploaded') s.queueUploaded = Number(r.n)
      if (r.status === 'failed')   s.queueFailed   = Number(r.n)
    }
  } catch { /* table may not exist yet */ }

  // Pacing
  try {
    const { pacingSnapshot } = await import('./r378-upload-pacing.js')
    const snap = await pacingSnapshot(workspaceId)
    for (const p of snap.platforms) {
      if ((p.nextOkInMs ?? 0) > 0) s.pacingGated++
    }
  } catch { /* optional */ }

  // Pins
  try {
    const { pinStats } = await import('./r368-pinterest-pin-queue.js')
    const ps = await pinStats(workspaceId)
    s.pinsQueued = ps.queued
    s.pinsPostedToday = ps.postedToday
    s.pinsRemainingToday = ps.remainingToday
  } catch { /* optional */ }

  // Capability self-test (from most recent run via daily_cron_runs)
  try {
    const r = await db.execute(sql`
      SELECT summary FROM daily_cron_runs
      WHERE workspace_id = ${workspaceId}
      ORDER BY ran_at DESC LIMIT 1
    `)
    const summary = (r as Array<{ summary: { selfTestSummary?: { missing?: number; error?: number } } }>)[0]?.summary
    if (summary?.selfTestSummary) {
      s.capabilityMissing = summary.selfTestSummary.missing ?? 0
      s.capabilityError   = summary.selfTestSummary.error ?? 0
    }
  } catch { /* optional */ }

  // Agent heartbeat
  try {
    const r = await db.execute(sql`
      SELECT MAX(created_at) AS last FROM events
      WHERE workspace_id = ${workspaceId} AND type = 'agent.heartbeat'
    `)
    const last = Number((r as Array<{ last: number | null }>)[0]?.last ?? 0)
    if (last > 0) s.agentHeartbeatAge = Date.now() - last
  } catch { /* optional */ }

  // 30-day MRR
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const r = await db.execute(sql`
      SELECT COALESCE(SUM(amount_cents), 0)::int AS total FROM business_revenue
      WHERE workspace_id = ${workspaceId} AND created_at >= ${cutoff}
    `)
    s.totalMrrCents = Number((r as Array<{ total: number }>)[0]?.total ?? 0)
  } catch { /* optional */ }

  // Designs with sales but no variants (auto-queued variants should close this)
  try {
    const r = await db.execute(sql`
      SELECT COUNT(DISTINCT duq.design_id)::int AS n
      FROM design_upload_queue duq
      JOIN business_revenue br ON br.metadata->>'permalink' = duq.external_url
      WHERE duq.workspace_id = ${workspaceId} AND duq.status = 'uploaded'
        AND NOT EXISTS (
          SELECT 1 FROM design_catalog dc
          WHERE dc.parent_design_id = duq.design_id
        )
    `)
    s.parentVariantGap = Number((r as Array<{ n: number }>)[0]?.n ?? 0)
  } catch { /* optional */ }

  return s
}

function rank(s: Sig): NextAction[] {
  const actions: NextAction[] = []

  // CRITICAL: agent hasn't heartbeated in > 24h — operator needs to run pnpm daily
  if (s.agentHeartbeatAge > 24 * 60 * 60 * 1000) {
    actions.push({
      id: 'run_daily',
      title: 'Run pnpm daily on your laptop',
      detail: `Local agent hasn't heartbeated in ${Math.round(s.agentHeartbeatAge / 3600_000)}h. Queue can't drain without it.`,
      score: 95,
      reason: `agentHeartbeatAge=${Math.round(s.agentHeartbeatAge / 60_000)}min`,
      category: 'unblock',
    })
  }

  // Queue is full but pacing-gated: operator should add more design types/platforms
  if (s.queueQueued > 50 && s.pacingGated >= 3) {
    actions.push({
      id: 'add_platforms',
      title: 'Add more platforms — current ones are pacing-gated',
      detail: `${s.pacingGated} platforms blocked by anti-flag pacing. ${s.queueQueued} items queued but throughput is throttled. Connect another platform (Threadless, TikTok Shop) to parallelize.`,
      score: 80,
      reason: `queueQueued=${s.queueQueued} pacingGated=${s.pacingGated}`,
      category: 'growth',
    })
  }

  // High capability gaps
  if (s.capabilityMissing >= 3) {
    actions.push({
      id: 'fill_capabilities',
      title: 'Fill capability gaps',
      detail: `${s.capabilityMissing} capability probes missing. Common fix: configure Gumroad access token, connect missing platforms, set INPRNT_SELLER_URL.`,
      score: 70,
      reason: `capabilityMissing=${s.capabilityMissing}`,
      category: 'unblock',
    })
  }

  // Pinterest queue not draining
  if (s.pinsQueued > 0 && s.pinsRemainingToday > 0 && s.pinsPostedToday === 0) {
    actions.push({
      id: 'post_pins',
      title: 'Run pnpm daily to post today\'s Pinterest pins',
      detail: `${s.pinsQueued} pins waiting. ${s.pinsRemainingToday} slots remaining today (5/day cap). Pinterest auto-posts as part of pnpm daily.`,
      score: 60,
      reason: `pinsQueued=${s.pinsQueued} pinsRemainingToday=${s.pinsRemainingToday}`,
      category: 'growth',
    })
  }

  // Failures need attention
  if (s.queueFailed > 5) {
    actions.push({
      id: 'review_failures',
      title: `Review ${s.queueFailed} failed uploads`,
      detail: 'Failed uploads usually mean a driver selector broke. R366 self-improving selectors should heal them automatically, but inspect the failed_reason to confirm.',
      score: 50,
      reason: `queueFailed=${s.queueFailed}`,
      category: 'maintenance',
    })
  }

  // Parent variant gap means R381 isn't covering everything
  if (s.parentVariantGap > 0) {
    actions.push({
      id: 'gen_variants',
      title: `${s.parentVariantGap} winning design(s) missing variants`,
      detail: 'Designs with sales but no R374 variants yet. Force variant generation via brain.task variants.generate_for_winner.',
      score: 65,
      reason: `parentVariantGap=${s.parentVariantGap}`,
      category: 'growth',
    })
  }

  // Celebrate: first sale!
  if (s.totalMrrCents > 0 && s.totalMrrCents < 100_00) {
    actions.push({
      id: 'celebrate_first',
      title: `🎉 First sales landed ($${(s.totalMrrCents/100).toFixed(2)} this month)`,
      detail: 'Winner-variant generation triggered automatically. Watch the queue fill with variants over the next few hours.',
      score: 90,
      reason: `totalMrrCents=${s.totalMrrCents}`,
      category: 'celebrate',
    })
  }

  // Default growth action when nothing is broken
  if (actions.length === 0) {
    if (s.queueQueued > 0) {
      actions.push({
        id: 'keep_draining',
        title: 'Keep draining — system is healthy',
        detail: `${s.queueQueued} items queued, ${s.queueUploaded} already uploaded. No blockers. Run pnpm daily on your usual cadence.`,
        score: 30,
        reason: 'no_blockers',
        category: 'maintenance',
      })
    } else {
      actions.push({
        id: 'queue_empty',
        title: 'Queue empty — trigger trend pipeline',
        detail: 'No items queued. Run pnpm dev:pipeline or wait for the 13:00 UTC droplet cron (R382) to refill.',
        score: 40,
        reason: 'queue_empty',
        category: 'growth',
      })
    }
  }

  return actions.sort((a, b) => b.score - a.score)
}

export async function nextActions(workspaceId: string): Promise<{ actions: NextAction[]; signals: Sig }> {
  const signals = await gatherSignals(workspaceId)
  const actions = rank(signals)
  return { actions, signals }
}
