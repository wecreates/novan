/**
 * R613 — Daily digest.
 *
 * Once per day Novan composes a human-readable status:
 *   - revenue: yesterday + MTD + lifetime
 *   - inbox throughput: pending, processed, success rate
 *   - pipeline runs: successes + failures in the last 24h
 *   - notable events: saturation alerts, cron errors, deprecation warnings
 *   - top 3 suggested actions for the operator today
 *
 * Delivers via best-available channel, in priority order:
 *   1. R578/R611 email (Postmark API or SMTP via Brevo)  — if EMAIL_FROM
 *      + (POSTMARK_SERVER_TOKEN OR smtpConfigured()) AND DIGEST_EMAIL_TO set
 *   2. R129 web-push                                      — if VAPID configured
 *      AND there is at least one push_subscription row
 *   3. KG note (always)                                   — written to R601 as
 *      daily/YYYY-MM-DD note, importance 80, source 'digest'
 *
 * The digest ALWAYS persists to KG so the operator can scroll back through
 * past days even when no channel is live. Email/push are bonus surfaces.
 *
 * Cron: 09:00 UTC daily. DISABLE_DIGEST=1 kills it. Operator can also call
 * digest.send manually any time.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

// ─── Compose ─────────────────────────────────────────────────────────────────

export interface Digest {
  workspaceId:   string
  forDateUtc:    string         // YYYY-MM-DD of the day BEING REPORTED ON
  composedAt:    number
  revenue: {
    yesterday:   number
    mtd:         number
    lifetime:    number
    bySource:    Array<{ source: string; usd: number; n: number }>
  }
  inbox: {
    pending:     number
    done24h:     number
    failed24h:   number
    successRate: number | null
    oldestPendingMin: number | null
  }
  pipelines: {
    runs24h:     number
    success24h:  number
    failed24h:   number
    deadPipelines: string[]    // enabled but no successful run in 7 days
  }
  notable: {
    saturationFires24h: number
    cronErrors24h:      number
    autobrowserFailed24h:number
  }
  suggestions: string[]
  markdown:    string
  textBody:    string
}

function dayStartUtc(daysBack: number): number {
  const d = new Date(Date.now() - daysBack * 24 * 60 * 60_000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function utcDateStr(daysBack: number): string {
  const d = new Date(Date.now() - daysBack * 24 * 60 * 60_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function fmtUsd(n: number): string {
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`
}

async function gather(workspaceId: string): Promise<Digest> {
  const yesterdayStart = dayStartUtc(1)
  const todayStart = dayStartUtc(0)
  const sinceMtd = (() => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) })()
  const since24 = Date.now() - 24 * 60 * 60_000
  const since7d = Date.now() - 7 * 24 * 60 * 60_000

  // Each query try-catches so a broken subsystem doesn't kill the digest.
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback)

  const [
    revYest, revMtd, revLife, revSrc,
    inboxStats,
    pipelineRuns, deadPipes,
    saturation, cronErrors, abFailed,
  ] = await Promise.all([
    safe(db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS s FROM business_revenue WHERE workspace_id = ${workspaceId} AND recorded_at >= ${yesterdayStart} AND recorded_at < ${todayStart}`), [{ s: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS s FROM business_revenue WHERE workspace_id = ${workspaceId} AND recorded_at >= ${sinceMtd}`), [{ s: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS s FROM business_revenue WHERE workspace_id = ${workspaceId}`), [{ s: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COALESCE(source,'unknown') AS source, COALESCE(SUM(net_usd),0)::float AS usd, COUNT(*)::int AS n FROM business_revenue WHERE workspace_id = ${workspaceId} AND recorded_at >= ${yesterdayStart} AND recorded_at < ${todayStart} GROUP BY source ORDER BY usd DESC`), [] as unknown[]),

    safe(import('./r612-task-inbox.js').then(m => m.stats(workspaceId)), { pending: 0, working: 0, done24h: 0, failed24h: 0, byKind: {}, oldestPendingAgeMin: null }),

    safe(db.execute(sql`SELECT status, COUNT(*)::int AS n FROM pipeline_runs WHERE workspace_id = ${workspaceId} AND started_at >= ${since24} GROUP BY status`), [] as unknown[]),
    // R614 — only flag pipelines that SHOULD have run (have a cron) but
    // haven't succeeded recently. On-demand pipelines (no schedule_cron)
    // are operator-triggered and not "stale" by absence of recent runs.
    safe(db.execute(sql`SELECT name FROM pipelines WHERE workspace_id = ${workspaceId} AND enabled = true AND schedule_cron IS NOT NULL AND schedule_cron <> '' AND (last_run_at IS NULL OR last_run_at < ${since7d} OR last_run_status <> 'success')`), [] as unknown[]),

    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM events WHERE workspace_id = ${workspaceId} AND type = 'saturation.alert' AND created_at >= ${since24}`), [{ n: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM events WHERE workspace_id = ${workspaceId} AND type = 'cron.error' AND created_at >= ${since24}`), [{ n: 0 }] as unknown[]),
    safe(db.execute(sql`SELECT COUNT(*)::int AS n FROM autobrowser_jobs WHERE workspace_id = ${workspaceId} AND status = 'failed' AND ended_at >= ${since24}`), [{ n: 0 }] as unknown[]),
  ])

  const num = (r: unknown[]): number => Number((r as Array<{ n?: number; s?: number }>)[0]?.n ?? (r as Array<{ n?: number; s?: number }>)[0]?.s ?? 0)
  const yesterdayUsd = num(revYest)
  const mtdUsd       = num(revMtd)
  const lifetimeUsd  = num(revLife)
  const bySource = (revSrc as Array<{ source: string; usd: number; n: number }>).map(x => ({ source: x.source, usd: Math.round(Number(x.usd) * 100) / 100, n: Number(x.n) }))

  const pipelineByStatus: Record<string, number> = {}
  for (const row of pipelineRuns as Array<{ status: string; n: number }>) pipelineByStatus[row.status] = Number(row.n)
  const pipeRuns24 = Object.values(pipelineByStatus).reduce((a, b) => a + b, 0)
  const pipeOk24 = pipelineByStatus['success'] ?? 0
  const pipeFail24 = (pipelineByStatus['failed'] ?? 0) + (pipelineByStatus['partial'] ?? 0)
  const deadPipelines = (deadPipes as Array<{ name: string }>).map(x => x.name).slice(0, 5)

  const totalProcessed = inboxStats.done24h + inboxStats.failed24h
  const inboxSuccessRate = totalProcessed > 0 ? Math.round((inboxStats.done24h / totalProcessed) * 100) / 100 : null

  const saturationN = num(saturation), cronErrN = num(cronErrors), abFailedN = num(abFailed)

  // Build markdown + plaintext side-by-side.
  const date = utcDateStr(1)
  const md: string[] = []
  const tx: string[] = []
  const both = (line: string): void => { md.push(line); tx.push(line) }

  both(`# Novan daily digest · ${date}`)
  both('')
  both(`## Revenue`)
  both(`- Yesterday: **${fmtUsd(yesterdayUsd)}**`)
  both(`- Month-to-date: ${fmtUsd(mtdUsd)}`)
  both(`- Lifetime: ${fmtUsd(lifetimeUsd)}`)
  if (bySource.length > 0) {
    both('')
    both('### Top sources yesterday')
    for (const s of bySource.slice(0, 5)) {
      both(`- ${s.source}: ${fmtUsd(s.usd)} (${s.n} sales)`)
    }
  } else {
    both('')
    both('_No revenue events yesterday._')
  }
  both('')
  both(`## Inbox throughput (R612, last 24h)`)
  both(`- Pending: ${inboxStats.pending}${inboxStats.oldestPendingAgeMin ? ` (oldest ${inboxStats.oldestPendingAgeMin}m)` : ''}`)
  both(`- Done: ${inboxStats.done24h} · Failed: ${inboxStats.failed24h}${inboxSuccessRate != null ? ` (${Math.round(inboxSuccessRate * 100)}% ok)` : ''}`)
  both('')
  both(`## Pipelines (R598, last 24h)`)
  both(`- Runs: ${pipeRuns24} · Success: ${pipeOk24} · Failed/partial: ${pipeFail24}`)
  if (deadPipelines.length > 0) {
    both(`- ⚠ Stale (no success in 7d): ${deadPipelines.join(', ')}`)
  }
  both('')
  both(`## Notable events (last 24h)`)
  both(`- Saturation alerts: ${saturationN}`)
  both(`- Cron errors: ${cronErrN}`)
  both(`- Autobrowser failed jobs: ${abFailedN}`)

  // Suggestions — operator-actionable, derived from state.
  const suggestions: string[] = []
  if (inboxStats.pending > 0 && inboxStats.oldestPendingAgeMin != null && inboxStats.oldestPendingAgeMin > 60) {
    suggestions.push(`Inbox backlog: ${inboxStats.pending} items oldest ${inboxStats.oldestPendingAgeMin}m — check handler errors or bump worker tick concurrency.`)
  }
  if (deadPipelines.length > 0) {
    suggestions.push(`Investigate stale pipelines: ${deadPipelines.join(', ')} — last run failed or aged out.`)
  }
  if (saturationN > 0) {
    suggestions.push(`Saturation fired ${saturationN}× — review tasksInFlight ceiling at /ops/neural.`)
  }
  if (cronErrN > 5) {
    suggestions.push(`${cronErrN} cron errors in 24h — pull the latest from /admin/brain {"op":"events.tail","params":{"type":"cron.error"}}.`)
  }
  if (yesterdayUsd === 0 && mtdUsd > 0) {
    suggestions.push(`Zero revenue yesterday despite MTD ${fmtUsd(mtdUsd)} — confirm POD platforms are still selling.`)
  }
  if (suggestions.length === 0) {
    suggestions.push(`All systems quiet. Consider dropping new image/music briefs into the inbox to keep the loop active.`)
  }
  both('')
  both(`## Suggested next moves`)
  for (const s of suggestions) both(`- ${s}`)
  both('')
  both(`---`)
  both(`Composed at ${new Date().toUTCString()}. Reply with 'inbox.add' to queue any of these as autonomous work.`)

  return {
    workspaceId, forDateUtc: date, composedAt: Date.now(),
    revenue: { yesterday: Math.round(yesterdayUsd * 100) / 100, mtd: Math.round(mtdUsd * 100) / 100, lifetime: Math.round(lifetimeUsd * 100) / 100, bySource },
    inbox: { pending: inboxStats.pending, done24h: inboxStats.done24h, failed24h: inboxStats.failed24h, successRate: inboxSuccessRate, oldestPendingMin: inboxStats.oldestPendingAgeMin },
    pipelines: { runs24h: pipeRuns24, success24h: pipeOk24, failed24h: pipeFail24, deadPipelines },
    notable: { saturationFires24h: saturationN, cronErrors24h: cronErrN, autobrowserFailed24h: abFailedN },
    suggestions,
    markdown: md.join('\n'),
    textBody: tx.join('\n'),
  }
}

export async function compose(workspaceId: string): Promise<Digest> {
  return gather(workspaceId)
}

// ─── Delivery ────────────────────────────────────────────────────────────────

export interface SendResult {
  digest:        Digest
  channels:      Array<{ name: string; ok: boolean; reason?: string; id?: string }>
  kgNodeName:    string
}

export async function send(workspaceId: string, opts: { force?: boolean } = {}): Promise<SendResult> {
  const digest = await compose(workspaceId)
  const channels: SendResult['channels'] = []

  // 1. Email (R578 → R611 fallback). Honor DIGEST_EMAIL_TO env. If missing,
  // skip silently with a clear reason — the KG note is the source of truth.
  const digestTo = process.env['DIGEST_EMAIL_TO']
  if (digestTo) {
    try {
      const { sendEmail } = await import('./r578-email-system.js')
      const r = await sendEmail({
        workspaceId, to: digestTo,
        subject: `Novan daily digest · ${digest.forDateUtc}`,
        bodyText: digest.textBody,
        templateKey: 'r613-daily-digest',
        bypassOptIn: true,
      })
      const c: { name: string; ok: boolean; reason?: string; id?: string } = { name: 'email', ok: r.ok }
      if (r.reason) c.reason = r.reason
      if (r.id) c.id = r.id
      channels.push(c)
    } catch (e) { channels.push({ name: 'email', ok: false, reason: (e as Error).message.slice(0, 200) }) }
  } else {
    channels.push({ name: 'email', ok: false, reason: 'DIGEST_EMAIL_TO not set' })
  }

  // 2. Web-push (R129) — best-effort to any subscribers.
  try {
    const { db: dbRef } = await import('../db/client.js')
    void dbRef
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0 }] as unknown[])
    const subN = Number((r as Array<{ n: number }>)[0]?.n ?? 0)
    if (subN > 0 && process.env['VAPID_PUBLIC_KEY']) {
      try {
        // The R129 module exposes broadcast helpers; we look them up by likely names.
        const pushMod = await import('./push-broadcast.js').catch(() => null) as { broadcastToWorkspace?: (ws: string, title: string, body: string) => Promise<unknown> } | null
        if (pushMod && typeof pushMod.broadcastToWorkspace === 'function') {
          await pushMod.broadcastToWorkspace(workspaceId, `Novan digest · ${digest.forDateUtc}`, `Yesterday: ${fmtUsd(digest.revenue.yesterday)} · ${digest.inbox.pending} pending tasks · ${digest.suggestions.length} suggestions`)
          channels.push({ name: 'web_push', ok: true })
        } else {
          channels.push({ name: 'web_push', ok: false, reason: `${subN} subscribers but broadcast module not found` })
        }
      } catch (e) { channels.push({ name: 'web_push', ok: false, reason: (e as Error).message.slice(0, 200) }) }
    } else {
      channels.push({ name: 'web_push', ok: false, reason: subN === 0 ? 'no subscribers' : 'VAPID not set' })
    }
  } catch (e) { channels.push({ name: 'web_push', ok: false, reason: (e as Error).message.slice(0, 200) }) }

  // 3. KG note — ALWAYS attempted. The digest survives even with no channels.
  let kgNodeName = `daily/${digest.forDateUtc}`
  try {
    const { ingestText } = await import('./r601-knowledge-graph.js')
    const r = await ingestText(workspaceId, {
      name: kgNodeName, body: digest.markdown, type: 'note',
      importance: 80, source: 'digest',
    })
    kgNodeName = r.node.name
    channels.push({ name: 'kg', ok: true })
  } catch (e) { channels.push({ name: 'kg', ok: false, reason: (e as Error).message.slice(0, 200) }) }

  // Emit an event so saturation/observability sees the daily run.
  try {
    const { events } = await import('../db/schema.js')
    const { v7: uuidv7 } = await import('uuid')
    await db.insert(events).values({
      id: uuidv7(), workspaceId,
      type: 'digest.sent',
      payload: { forDate: digest.forDateUtc, revenueYesterday: digest.revenue.yesterday, channels, suggestionsCount: digest.suggestions.length, force: !!opts.force },
      traceId: 'r613', correlationId: 'r613', source: 'r613-daily-digest', createdAt: Date.now(),
    }).catch(() => null)
  } catch { /* tolerated */ }

  return { digest, channels, kgNodeName }
}

// ─── Cron tick — fire once per day at 09:00 UTC ─────────────────────────────

let _lastFiredDate: string | null = null

export async function tickAll(): Promise<{ workspaces: number; fired: number; skipped: string }> {
  if (process.env['DISABLE_DIGEST'] === '1') return { workspaces: 0, fired: 0, skipped: 'env DISABLE_DIGEST=1' }
  const d = new Date()
  const utcHour = d.getUTCHours()
  const todayStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  // Fire only once per day, only after 09:00 UTC. Operator can call send() manually any time.
  if (utcHour < 9) return { workspaces: 0, fired: 0, skipped: `before 09:00 UTC (current ${utcHour})` }
  if (_lastFiredDate === todayStr) return { workspaces: 0, fired: 0, skipped: `already fired ${todayStr}` }
  _lastFiredDate = todayStr

  const r = await db.execute(sql`SELECT id FROM workspaces`).catch(() => [] as unknown[])
  const ids = (r as Array<{ id: string }>).map(x => x.id)
  let fired = 0
  for (const id of ids) {
    try { await send(id); fired++ } catch { /* tolerated */ }
  }
  return { workspaces: ids.length, fired, skipped: '' }
}
