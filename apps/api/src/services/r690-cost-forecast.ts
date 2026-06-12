/**
 * R690 — Cost forecast + spike alerts.
 *
 * Looks at the last 14 days of r649_agent_runs cost_usd, fits a simple
 * 7-day-trailing-avg + linear-trend projection over the next 7 days,
 * and compares the projected daily peak to the R660 daily cap.
 *
 * When the trend would trip the cap, fire R686 push/webhook notifications.
 * Cron-runs once every 6 hours to avoid alert fatigue.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'
import { getDailyCap } from './r660-agent-budget.js'

interface DayRow { day: string; cost: number }

export interface ForecastResult {
  ok:                 boolean
  workspaceId:        string
  cap:                number
  history14d:         Array<{ day: string; cost: number }>
  projection7d:       Array<{ day: string; projectedCost: number; trippedCap: boolean }>
  trailingAvg7d:      number
  slopePerDay:        number
  peakProjected:      number
  peakOnDay:          string | null
  capWillTrip:        boolean
  daysUntilCap:       number | null
}

async function fetchDailyCosts(workspaceId: string): Promise<DayRow[]> {
  try {
    const rows = await db.execute(sql`
      SELECT date_trunc('day', created_at)::date AS day,
             COALESCE(sum(cost_usd), 0)::numeric(14,6) AS cost
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId}
        AND created_at >= now() - interval '14 days'
      GROUP BY day
      ORDER BY day ASC
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(r => ({
      day: String(r['day']).slice(0, 10),
      cost: Number(r['cost']),
    }))
  } catch { return [] }
}

/** Simple linear regression to find slope (cost per day) over the 14d window. */
function linearTrend(rows: DayRow[]): number {
  if (rows.length < 2) return 0
  const n = rows.length
  const xs = rows.map((_, i) => i)
  const ys = rows.map(r => r.cost)
  const meanX = xs.reduce((s, v) => s + v, 0) / n
  const meanY = ys.reduce((s, v) => s + v, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY)
    den += (xs[i]! - meanX) ** 2
  }
  return den === 0 ? 0 : num / den
}

function trailingAvg(rows: DayRow[], windowDays: number): number {
  if (rows.length === 0) return 0
  const tail = rows.slice(-windowDays)
  return tail.reduce((s, r) => s + r.cost, 0) / Math.max(1, tail.length)
}

export async function forecast(workspaceId: string): Promise<ForecastResult> {
  const [cap, history] = await Promise.all([getDailyCap(workspaceId), fetchDailyCosts(workspaceId)])
  const trailingAvg7 = trailingAvg(history, 7)
  const slope = linearTrend(history)
  const baseDate = new Date()
  baseDate.setUTCHours(0, 0, 0, 0)

  // Project: base = trailing 7d avg, + slope per day. Floor at 0.
  const projection: ForecastResult['projection7d'] = []
  let peak = 0, peakOn: string | null = null, capWillTrip = false, daysUntilCap: number | null = null
  for (let i = 1; i <= 7; i++) {
    const d = new Date(baseDate.getTime() + i * 86400_000)
    const proj = Math.max(0, trailingAvg7 + slope * i)
    const tripped = proj >= cap
    if (proj > peak) { peak = proj; peakOn = d.toISOString().slice(0, 10) }
    if (tripped && daysUntilCap === null) { capWillTrip = true; daysUntilCap = i }
    projection.push({ day: d.toISOString().slice(0, 10), projectedCost: Number(proj.toFixed(4)), trippedCap: tripped })
  }

  return {
    ok: true,
    workspaceId,
    cap: Number(cap.toFixed(4)),
    history14d: history.map(h => ({ day: h.day, cost: Number(h.cost.toFixed(4)) })),
    projection7d: projection,
    trailingAvg7d: Number(trailingAvg7.toFixed(4)),
    slopePerDay: Number(slope.toFixed(6)),
    peakProjected: Number(peak.toFixed(4)),
    peakOnDay: peakOn,
    capWillTrip,
    daysUntilCap,
  }
}

/** Cron-callable: check all workspaces with recent activity, alert when cap will trip. */
export async function alertSpikes(): Promise<{ checked: number; alerted: number }> {
  let workspaces: string[] = []
  try {
    const rows = await db.execute(sql`
      SELECT DISTINCT workspace_id FROM r649_agent_runs
      WHERE created_at >= now() - interval '7 days'
    `)
    workspaces = ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(r => String(r['workspace_id']))
  } catch { return { checked: 0, alerted: 0 } }

  let alerted = 0
  await Promise.all(workspaces.map(async (ws) => {
    const f = await forecast(ws)
    if (!f.capWillTrip) return
    try {
      const { notifyAgentCompletion } = await import('./r686-agent-notify.js')
      await notifyAgentCompletion({
        workspaceId: ws,
        runId: `r690_${Date.now()}`,
        goal: `[R690 spend alert] Projected to hit \$${f.cap.toFixed(2)} daily cap in ${f.daysUntilCap} day(s); peak \$${f.peakProjected.toFixed(4)} on ${f.peakOnDay}.`,
        answer: `7d trailing avg: \$${f.trailingAvg7d.toFixed(4)}/day. Trend slope: ${f.slopePerDay >= 0 ? '+' : ''}\$${f.slopePerDay.toFixed(4)}/day. Raise cap with novan.budget.set or pause schedules.`,
        status: 'capped',
        costUsd: 0,
        tokens: 0,
      })
      alerted++
    } catch { /* tolerated */ }
  }))
  return { checked: workspaces.length, alerted }
}
