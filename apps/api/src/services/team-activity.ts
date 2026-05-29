/**
 * team-activity.ts — surfaces what the brain's continuously-running
 * cron teams have been doing.
 *
 * Each "team" is a set of cron jobs in learning-cron.ts that emit
 * `cron.*_completed` events to the events table on every tick. We
 * query the events table for the most recent of each type, plus
 * any errors, plus a small recent-findings rollup.
 *
 * This is read-only — no writes, no fake data. If a team hasn't
 * fired yet (e.g. on a freshly-booted API) the entry's `lastRanAt`
 * is null and the UI displays "pending first run".
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { events } from '../db/schema.js'

export interface TeamCron {
  /** Event type emitted on successful completion. */
  eventType:   string
  intervalMs:  number
  /** Human label for the UI. */
  label:       string
}

export interface TeamDef {
  id:        string
  name:      string
  /** Short description of what this team does. */
  charter:   string
  crons:     TeamCron[]
}

export const TEAMS: TeamDef[] = [
  {
    id: 'cybersecurity',
    name: 'Cybersecurity Team',
    charter: 'Auth, suspicious activity, anomaly detection, governance audits — every 5–10 min.',
    crons: [
      { eventType: 'cron.security_team_scan_completed', intervalMs: 10 * 60_000, label: 'Full security sweep' },
      { eventType: 'cron.suspicious_scan_completed',    intervalMs:  5 * 60_000, label: 'Suspicious activity scan' },
    ],
  },
  {
    id: 'engineering',
    name: 'Engineering Team',
    charter: 'Improvement detection, code-proposal drafting, repo audit, capability gap analysis.',
    crons: [
      { eventType: 'cron.improvement_scan_completed', intervalMs: 15 * 60_000, label: 'Improvement scan' },
      { eventType: 'cron.autonomous_mind',            intervalMs: 10 * 60_000, label: 'Capability gap → build plan' },
    ],
  },
  {
    id: 'orchestration',
    name: 'Orchestration Team',
    charter: 'Stuck-assignment recovery, down-agent detection, stale-lock cleanup.',
    crons: [
      { eventType: 'cron.orchestrator_sweep_completed', intervalMs: 2 * 60_000, label: 'Orchestrator sweep' },
      { eventType: 'cron.self_heal',                    intervalMs: 2 * 60_000, label: 'Self-heal recovery' },
    ],
  },
  {
    id: 'observability',
    name: 'Observability Team',
    charter: 'Platform self-check, incident detection, anomaly scan, failover probes.',
    crons: [
      { eventType: 'cron.platform_smoke_completed', intervalMs: 15 * 60_000, label: 'Platform smoke' },
      { eventType: 'cron.incident_scan_completed',  intervalMs:  5 * 60_000, label: 'Incident scan' },
      { eventType: 'cron.anomaly_scan',             intervalMs:  5 * 60_000, label: 'Anomaly scan' },
    ],
  },
]

export interface TeamCronStatus {
  eventType:    string
  label:        string
  intervalMs:   number
  lastRanAt:    number | null
  ranAgoMs:     number | null
  /** "healthy" if last run was within 2x interval, "stale" otherwise.
   *  "pending" when never run yet. */
  health:       'healthy' | 'stale' | 'pending'
  /** A small bag of metric counters from the most recent event's payload
   *  — e.g. { findings: 3, blocking: 0 } for security scans. */
  lastPayload:  Record<string, unknown>
}

export interface TeamStatus {
  id:           string
  name:         string
  charter:      string
  crons:        TeamCronStatus[]
  /** Roll-up: errors emitted to `cron.error` in the last hour matching
   *  any of this team's task labels. */
  recentErrors: Array<{ at: number; task: string; message: string }>
}

/**
 * Build the per-team activity report. One DB query per cron + one
 * shared error query → small + fast (sub-100 ms typical).
 */
export async function getTeamActivity(workspaceId: string): Promise<TeamStatus[]> {
  const now = Date.now()
  const errorWindow = now - 60 * 60_000      // last hour

  // Single error query covering everything — filter client-side per team.
  const errorRows = await db.select().from(events)
    .where(and(
      eq(events.type, 'cron.error'),
      gte(events.createdAt, errorWindow),
      // Errors are workspace-tagged inconsistently; accept global + ws.
      sql`(${events.workspaceId} = ${workspaceId} OR ${events.workspaceId} = 'global')`,
    ))
    .orderBy(desc(events.createdAt))
    .limit(50)
    .catch(() => [])

  const out: TeamStatus[] = []

  for (const team of TEAMS) {
    const crons: TeamCronStatus[] = []
    for (const c of team.crons) {
      const row = await db.select().from(events)
        .where(and(
          eq(events.type, c.eventType),
          sql`(${events.workspaceId} = ${workspaceId} OR ${events.workspaceId} = 'global')`,
        ))
        .orderBy(desc(events.createdAt))
        .limit(1)
        .then(r => r[0] ?? null)
        .catch((e: Error) => { console.error('[team-activity]', e.message); return null })

      const lastRanAt = row?.createdAt ?? null
      const ranAgoMs  = lastRanAt !== null ? now - lastRanAt : null
      const health: TeamCronStatus['health'] =
        lastRanAt === null ? 'pending'
      : (ranAgoMs! < c.intervalMs * 2) ? 'healthy'
      : 'stale'

      crons.push({
        eventType: c.eventType,
        label:     c.label,
        intervalMs: c.intervalMs,
        lastRanAt,
        ranAgoMs,
        health,
        lastPayload: (row?.payload as Record<string, unknown> | null) ?? {},
      })
    }

    // Filter errors to this team's task names. Convention in
    // learning-cron is `cron.error` with payload.task = the cron id.
    const teamTaskNames = new Set(
      // 'cron.security_team_scan_completed' → 'security_team' etc.
      team.crons.map(c => c.eventType.replace(/^cron\./, '').replace(/_completed$/, '').replace(/_scan$/, '')),
    )
    // Also accept the raw bases the cron emits (e.g. 'security_team', 'improvement', 'autonomous_mind')
    if (team.id === 'cybersecurity')  { teamTaskNames.add('security_team'); teamTaskNames.add('suspicious') }
    if (team.id === 'engineering')    { teamTaskNames.add('improvement');   teamTaskNames.add('autonomous_mind') }
    if (team.id === 'orchestration')  { teamTaskNames.add('orchestrator');  teamTaskNames.add('self_heal') }
    if (team.id === 'observability')  { teamTaskNames.add('platform_smoke');teamTaskNames.add('incident'); teamTaskNames.add('anomaly_scan') }

    const recentErrors = errorRows
      .filter(e => {
        const t = String((e.payload as { task?: string } | null)?.task ?? '')
        return teamTaskNames.has(t)
      })
      .slice(0, 5)
      .map(e => ({
        at:      e.createdAt,
        task:    String((e.payload as { task?: string } | null)?.task ?? ''),
        message: String((e.payload as { error?: string } | null)?.error ?? '').slice(0, 200),
      }))

    out.push({
      id:           team.id,
      name:         team.name,
      charter:      team.charter,
      crons,
      recentErrors,
    })
  }

  return out
}
