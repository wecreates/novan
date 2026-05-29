/**
 * digital-twin.ts — live operational mirrors of every important entity.
 *
 * A twin is a frequently-refreshed snapshot of an entity (business,
 * product, channel, workflow, infrastructure component) that fuses:
 *   • health (from production-log + analytics + cron telemetry)
 *   • workflows (active vs idle vs failing)
 *   • analytics (recent metrics)
 *   • risks (open issues + degraded connectors)
 *   • opportunities (recent winners + emergent patterns)
 *
 * Built on top of world-model nodes; refreshed by snapshot() which
 * the learning-cron can call periodically.
 */

import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'
import { upsertNode, type WorldNode, type NodeKind } from './world-model.js'

export interface DigitalTwin {
  id: string
  kind: NodeKind
  label: string
  health: number              // 0..1
  status: 'healthy' | 'degraded' | 'failing' | 'idle'
  metrics: Record<string, number>
  workflows: { active: number; idle: number; failed24h: number }
  risks: string[]
  opportunities: string[]
  snapshotAt: number
}

export async function snapshotChannelTwin(workspaceId: string, channelId: string, channelLabel: string): Promise<DigitalTwin> {
  // Pull last 30d of analytics for this channel
  const rows = await db.execute(sql`
    SELECT content, confidence FROM memories
    WHERE workspace_id = ${workspaceId}
      AND source = 'content-analytics'
      AND tags @> ARRAY['video-performance']
    ORDER BY updated_at DESC LIMIT 50`)
  const memos = ((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [])
    .map(r => ({ content: String(r['content']), confidence: Number(r['confidence']) }))

  let totalViews = 0, winners = 0, ctrs: number[] = []
  for (const m of memos) {
    const v = Number(m.content.match(/(\d[\d,]*)\s+views/)?.[1]?.replace(/,/g, '') ?? 0)
    totalViews += v
    if (v > 10_000) winners++
    const c = Number(m.content.match(/([\d.]+)%\s+CTR/)?.[1] ?? 0)
    if (c > 0) ctrs.push(c)
  }
  const avgCtr = ctrs.length > 0 ? ctrs.reduce((a, b) => a + b) / ctrs.length : 0

  // Recent productions for this workspace
  const { listEvents } = await import('./production-log.js')
  const events = await listEvents({ workspaceId, days: 7, limit: 100 })
  const active   = events.filter(e => e.status === 'started').length
  const idle     = events.filter(e => e.status === 'completed').length
  const failed   = events.filter(e => e.status === 'failed').length

  // Open issues for this workspace
  const issuesRows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM issues
    WHERE workspace_id = ${workspaceId} AND status NOT IN ('resolved', 'closed')`)
  const openIssues = Number(((issuesRows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]?.['n']) ?? 0)

  // Health: weight CTR + winner ratio + failure ratio
  const winnerRatio = memos.length > 0 ? winners / memos.length : 0
  const failureRatio = events.length > 0 ? failed / events.length : 0
  const health = Math.max(0, Math.min(1, 0.4 + avgCtr / 20 + winnerRatio * 0.4 - failureRatio * 0.5 - openIssues * 0.02))

  const status: DigitalTwin['status'] =
    failureRatio > 0.3 ? 'failing'
    : openIssues > 5 || avgCtr < 1 ? 'degraded'
    : active === 0 && events.length < 3 ? 'idle'
    : 'healthy'

  const risks: string[] = []
  if (failureRatio > 0.2) risks.push(`${(failureRatio * 100).toFixed(0)}% recent productions failed`)
  if (openIssues > 0)     risks.push(`${openIssues} unresolved issues`)
  if (avgCtr > 0 && avgCtr < 2) risks.push(`low CTR ${avgCtr.toFixed(1)}% — thumbnails or titles need work`)

  const opportunities: string[] = []
  if (winnerRatio > 0.2)   opportunities.push(`${winners} hits in last 50 — replicate the pattern`)
  if (avgCtr > 5)          opportunities.push('thumbnail formula working — scale cadence')
  if (idle > 0 && active === 0) opportunities.push('production queue empty — schedule next batch')

  const twin: DigitalTwin = {
    id: channelId, kind: 'channel', label: channelLabel,
    health, status,
    metrics: { totalViews, avgCtr, winners, openIssues, failureRatio },
    workflows: { active, idle, failed24h: failed },
    risks, opportunities,
    snapshotAt: Date.now(),
  }

  // Mirror to world-model
  await upsertNode({
    id: `channel:${channelId}`, workspaceId, kind: 'channel',
    label: channelLabel,
    attrs: { ...twin.metrics, status, ...twin.workflows },
    health, importance: 0.7,
  })

  return twin
}

export async function snapshotBusinessTwin(workspaceId: string, businessId: string): Promise<DigitalTwin | null> {
  const rows = await db.execute(sql`
    SELECT id, name, status FROM businesses
    WHERE workspace_id = ${workspaceId} AND id = ${businessId} LIMIT 1`)
  const r = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
  if (!r) return null

  const eventsRows = await db.execute(sql`
    SELECT type, COUNT(*)::int AS n FROM events
    WHERE workspace_id = ${workspaceId}
      AND created_at > ${Date.now() - 7 * 86_400_000}
    GROUP BY type ORDER BY n DESC LIMIT 10`)
  const recent = ((eventsRows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [])
    .map(x => `${String(x['type'])}×${x['n']}`)

  const status: DigitalTwin['status'] = String(r['status'] ?? '') === 'live' ? 'healthy' : 'idle'
  const twin: DigitalTwin = {
    id: businessId, kind: 'business', label: String(r['name'] ?? businessId),
    health: status === 'healthy' ? 0.85 : 0.4,
    status,
    metrics: { recentEventTypes: recent.length },
    workflows: { active: 0, idle: 0, failed24h: 0 },
    risks: [], opportunities: recent.length > 0 ? [`recent activity: ${recent.slice(0, 3).join(', ')}`] : [],
    snapshotAt: Date.now(),
  }
  await upsertNode({
    id: `business:${businessId}`, workspaceId, kind: 'business',
    label: twin.label, attrs: twin.metrics,
    health: twin.health, importance: 0.9,
  })
  return twin
}

/** Snapshot a scheduled-production schedule as a twin. */
export async function snapshotScheduleTwin(workspaceId: string, scheduleId: string): Promise<DigitalTwin | null> {
  try {
    const { getSchedule } = await import('./scheduled-production.js')
    const s = await getSchedule(scheduleId)
    if (!s || s.workspaceId !== workspaceId) return null
    // Use the schedule's declared timezone (defaults to UTC) instead of
    // server-local time — same fix as scheduled-production.shouldFire.
    const tz = s.timezone ?? 'UTC'
    const curHour = (() => {
      try {
        return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date())) % 24
      } catch { return new Date().getUTCHours() }
    })()
    const dueToday = s.enabled && s.hoursOfDay.includes(curHour)
    const lastRunHrs = s.lastRunAt ? (Date.now() - s.lastRunAt) / 3_600_000 : null
    const status: DigitalTwin['status'] = !s.enabled ? 'idle' : (dueToday ? 'healthy' : 'idle')
    const twin: DigitalTwin = {
      id: scheduleId, kind: 'schedule', label: s.name,
      health: s.enabled ? 0.9 : 0.3,
      status,
      metrics: { dailyQuota: s.dailyQuota, prompts: s.prompts.length, lastRunHrs: lastRunHrs ?? -1 },
      workflows: { active: 0, idle: s.enabled ? 1 : 0, failed24h: 0 },
      risks:  !s.enabled ? ['schedule disabled'] : (lastRunHrs !== null && lastRunHrs > 48 ? ['no run in 48h'] : []),
      opportunities: s.enabled && s.publishChannels.length === 0 ? ['no publish channels — productions go nowhere'] : [],
      snapshotAt: Date.now(),
    }
    await upsertNode({
      id: `schedule:${scheduleId}`, workspaceId, kind: 'schedule',
      label: twin.label, attrs: { enabled: s.enabled, format: s.format, ...twin.metrics },
      health: twin.health, importance: 0.7,
    })
    return twin
  } catch { return null }
}

/** Snapshot an active agent as a twin. */
export async function snapshotAgentTwin(workspaceId: string, agentId: string, agentLabel: string): Promise<DigitalTwin | null> {
  try {
    const { getScore } = await import('./trust-reputation.js')
    const trust = await getScore(workspaceId, `agent:${agentId}`)
    const trustScore = trust?.score ?? 0.5
    const totalCalls = trust?.totalCalls ?? 0
    const status: DigitalTwin['status'] = trustScore < 0.3 && totalCalls > 3 ? 'failing'
                : trustScore < 0.6 && totalCalls > 3 ? 'degraded'
                : totalCalls === 0 ? 'idle' : 'healthy'
    const twin: DigitalTwin = {
      id: agentId, kind: 'agent', label: agentLabel,
      health: trustScore, status,
      metrics: { totalCalls, successRate: trust?.successRate ?? 0, avgLatencyMs: trust?.avgLatencyMs ?? 0 },
      workflows: { active: 0, idle: 0, failed24h: trust?.failures ?? 0 },
      risks:  trustScore < 0.5 && totalCalls > 5 ? [`low trust ${(trustScore * 100).toFixed(0)}% over ${totalCalls} calls`] : [],
      opportunities: trustScore > 0.85 && totalCalls > 10 ? ['high-trust agent — increase delegation reliance'] : [],
      snapshotAt: Date.now(),
    }
    await upsertNode({
      id: `agent:${agentId}`, workspaceId, kind: 'agent',
      label: agentLabel, attrs: twin.metrics, health: twin.health, importance: 0.6,
    })
    return twin
  } catch { return null }
}

export async function snapshotAllForWorkspace(workspaceId: string): Promise<{ count: number; twins: DigitalTwin[] }> {
  const out: DigitalTwin[] = []
  // Channels
  try {
    const { listChannels } = await import('./channel-manager.js')
    const channels = await listChannels(workspaceId)
    for (const c of channels) {
      const t = await snapshotChannelTwin(workspaceId, c.id, c.label).catch((e: Error) => { console.error('[digital-twin]', e.message); return null })
      if (t) out.push(t)
    }
  } catch { /* */ }
  // Businesses
  try {
    const rows = await db.execute(sql`SELECT id FROM businesses WHERE workspace_id = ${workspaceId} LIMIT 50`)
    for (const r of (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []) {
      const t = await snapshotBusinessTwin(workspaceId, String(r['id'])).catch((e: Error) => { console.error('[digital-twin]', e.message); return null })
      if (t) out.push(t)
    }
  } catch { /* */ }
  // Schedules
  try {
    const { listSchedules } = await import('./scheduled-production.js')
    const schedules = await listSchedules(workspaceId)
    for (const s of schedules) {
      const t = await snapshotScheduleTwin(workspaceId, s.id).catch((e: Error) => { console.error('[digital-twin]', e.message); return null })
      if (t) out.push(t)
    }
  } catch { /* */ }
  // Agents (top trust subjects — proxy for active agents)
  try {
    const rows = await db.execute(sql`
      SELECT subject FROM trust_ewma_scores
      WHERE workspace_id = ${workspaceId} AND subject LIKE 'agent:%'
      ORDER BY total_calls DESC LIMIT 20`)
    for (const r of (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []) {
      const id = String(r['subject']).replace(/^agent:/, '')
      const t = await snapshotAgentTwin(workspaceId, id, id).catch((e: Error) => { console.error('[digital-twin]', e.message); return null })
      if (t) out.push(t)
    }
  } catch { /* */ }
  return { count: out.length, twins: out }
}

/** Retrieve cached world-model nodes as twins (for fast read paths). */
export async function listTwinsFromModel(workspaceId: string): Promise<WorldNode[]> {
  const { listNodes } = await import('./world-model.js')
  return listNodes(workspaceId)
}
