/**
 * postmortem.ts — Auto-generate a structured post-mortem from an
 * incident's full evidence chain.
 *
 * Inputs (queried, not fabricated):
 *   - The incident row (incidents table)
 *   - The incident timeline (incident_timeline rows in chrono order)
 *   - Linked events (events table, IDs in incident.linkedEventIds)
 *   - Reasoning chains associated with the incident's repair task
 *
 * Output is a deterministic markdown post-mortem with seven blameless
 * sections per the Google SRE template. No LLM call required for the
 * core sections; an optional LLM pass on `lessons` enriches but never
 * replaces the deterministic-fact sections.
 *
 * Honest scope:
 *   - "Root cause" is the operator's recorded hypothesis + the strongest
 *     correlated signal. Engine does NOT claim certainty.
 *   - "Action items" are surfaced from the incident's
 *     recommendedAction + linked repair tasks. Engine doesn't invent
 *     action items the data doesn't justify.
 */
import { db } from '../db/client.js'
import { incidents, incidentTimeline, events, reasoningChains } from '../db/schema.js'
import { eq, inArray, and, asc } from 'drizzle-orm'

export interface Postmortem {
  incidentId:   string
  title:        string
  generatedAt:  number
  /** Markdown body. */
  body:         string
  /** Structured fields for downstream consumers (UI, exports). */
  sections: {
    summary:           string
    impact:            string
    timeline:          Array<{ at: number; what: string }>
    rootCause:         string
    detection:         string
    response:          string
    lessons:           string[]
    actionItems:       Array<{ owner: string; description: string; due: string | null }>
  }
}

export async function generatePostmortem(incidentId: string): Promise<Postmortem | { error: string }> {
  const incRows = await db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1)
  const inc = incRows[0]
  if (!inc) return { error: `incident not found: ${incidentId}` }

  // Timeline — chronological.
  const tl = await db.select().from(incidentTimeline)
    .where(eq(incidentTimeline.incidentId, incidentId))
    .orderBy(asc(incidentTimeline.createdAt))
    .catch(() => [])

  // Linked events — bounded.
  const eventIds = (inc.linkedEventIds ?? []).slice(0, 200)
  const evs = eventIds.length > 0
    ? await db.select({ id: events.id, type: events.type, createdAt: events.createdAt, payload: events.payload })
        .from(events).where(inArray(events.id, eventIds))
        .catch(() => [])
    : []

  // Reasoning chains tied to the repair task (if any).
  const chains = inc.repairTaskId
    ? await db.select().from(reasoningChains)
        .where(and(eq(reasoningChains.workspaceId, inc.workspaceId), eq(reasoningChains.subjectId, `brain-task:${inc.repairTaskId}`)))
        .limit(20)
        .catch(() => [])
    : []

  const detectedAt = Number(inc.detectedAt)
  const resolvedAt = inc.resolvedAt ? Number(inc.resolvedAt) : null
  const durationMin = resolvedAt ? Math.round((resolvedAt - detectedAt) / 60_000) : null

  const summary = inc.summary || inc.title
  const impact = (() => {
    const sys = (inc.affectedSystems as Record<string, unknown>) ?? {}
    const parts: string[] = []
    if (Array.isArray(sys.workflowIds) && sys.workflowIds.length > 0) parts.push(`${sys.workflowIds.length} workflows`)
    if (sys.providerId) parts.push(`provider ${String(sys.providerId)}`)
    if (sys.workerId)   parts.push(`worker ${String(sys.workerId)}`)
    if (sys.queueName)  parts.push(`queue ${String(sys.queueName)}`)
    if (parts.length === 0) parts.push('scope not recorded in affected_systems')
    return parts.join(', ') + (durationMin !== null ? ` · ${durationMin} min duration` : ' · ongoing')
  })()

  const timeline: Array<{ at: number; what: string }> = []
  timeline.push({ at: detectedAt, what: `detected: ${inc.type} · severity=${inc.severity}` })
  for (const row of tl) {
    const at = Number(row.createdAt)
    const summary = (row as { summary?: string; action?: string }).summary
                 ?? (row as { action?: string }).action
                 ?? '(no summary)'
    timeline.push({ at, what: summary })
  }
  for (const ev of evs.slice(0, 30)) {
    timeline.push({ at: Number(ev.createdAt), what: `event: ${ev.type}` })
  }
  if (resolvedAt) {
    timeline.push({ at: resolvedAt, what: `resolved by ${inc.resolvedBy ?? 'unknown'}: ${inc.resolutionNote ?? '(no note)'}` })
  }
  timeline.sort((a, b) => a.at - b.at)

  const rootCause = inc.rootCauseHypothesis
    || (chains[0] ? (chains[0] as { decision?: string }).decision ?? '(reasoning chain present but no decision text)'
                  : 'no recorded hypothesis — investigate via timeline + linked events')
  const detection = `Auto-detected via ${inc.type} signal · ${inc.signalCount} correlated signals`
  const response = inc.recommendedAction
    || (inc.assignedAgent ? `Assigned to agent ${inc.assignedAgent}` : 'No recommended-action recorded')

  // Lessons: derived heuristically from incident type + duration +
  // severity. NOT invented details about the failure — these are
  // template lessons the operator reviews before publishing.
  const lessons: string[] = []
  if (durationMin !== null && durationMin > 60) {
    lessons.push(`Mean-time-to-resolve was ${durationMin} min — consider a faster detection signal or pre-baked runbook for this incident type.`)
  }
  if (inc.signalCount < 2) {
    lessons.push('Single-signal detection — add a correlation rule so we don\'t depend on one source.')
  }
  if (inc.severity === 'critical' || inc.severity === 'emergency') {
    lessons.push('Critical-severity incidents should always create a kill-switch entry until root cause is patched.')
  }
  if (lessons.length === 0) {
    lessons.push('No template lessons triggered. Operator should add 1-2 specific lessons from human analysis.')
  }

  // Action items: pull recommendedAction + repair task if any. Engine
  // never invents items the data doesn't justify.
  const actionItems: Array<{ owner: string; description: string; due: string | null }> = []
  if (inc.recommendedAction) {
    actionItems.push({
      owner: inc.assignedAgent ?? 'operator',
      description: inc.recommendedAction,
      due: null,
    })
  }
  if (inc.repairTaskId) {
    actionItems.push({
      owner: 'operator',
      description: `Verify repair task ${inc.repairTaskId} produced a durable fix (not a workaround).`,
      due: null,
    })
  }

  const body = renderMarkdown({
    title: inc.title,
    summary, impact, timeline, rootCause, detection, response, lessons, actionItems,
    detectedAt, resolvedAt, severity: inc.severity,
  })

  return {
    incidentId, title: inc.title, generatedAt: Date.now(),
    body,
    sections: { summary, impact, timeline, rootCause, detection, response, lessons, actionItems },
  }
}

function renderMarkdown(p: {
  title: string; summary: string; impact: string
  timeline: Array<{ at: number; what: string }>
  rootCause: string; detection: string; response: string
  lessons: string[]
  actionItems: Array<{ owner: string; description: string; due: string | null }>
  detectedAt: number; resolvedAt: number | null; severity: string
}): string {
  const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  return [
    `# Post-mortem: ${p.title}`,
    '',
    `**Severity:** ${p.severity} · **Detected:** ${fmt(p.detectedAt)} · **Resolved:** ${p.resolvedAt ? fmt(p.resolvedAt) : 'ongoing'}`,
    '',
    '## Summary',
    p.summary,
    '',
    '## Impact',
    p.impact,
    '',
    '## Timeline',
    ...p.timeline.map(t => `- ${fmt(t.at)} — ${t.what}`),
    '',
    '## Root cause (hypothesis)',
    p.rootCause,
    '',
    '## Detection',
    p.detection,
    '',
    '## Response',
    p.response,
    '',
    '## Lessons',
    ...p.lessons.map(l => `- ${l}`),
    '',
    '## Action items',
    ...(p.actionItems.length > 0
      ? p.actionItems.map(a => `- [${a.owner}] ${a.description}${a.due ? ` · due ${a.due}` : ''}`)
      : ['- (none — operator to add follow-ups)']),
    '',
    '_Generated by Novan postmortem engine. Edit before publishing._',
  ].join('\n')
}
