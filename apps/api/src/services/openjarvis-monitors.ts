/**
 * openjarvis-monitors.ts — Runs the OpenJarvis monitor-operative
 * agents on their declared cadence.
 *
 * Each agent_definitions row tagged `monitor-operative` carries an
 * `interval:<seconds>` tag. This cron tick finds them, checks
 * last-fired (via reasoning_chains source='openjarvis-monitor:<slug>'),
 * and fires the ones that are due.
 *
 * Firing = delegateToAgent with the monitor's task = "Run your cycle".
 * The agent's system prompt (set at bootstrap) tells it what to do.
 */
import { db } from '../db/client.js'
import { agentDefinitions, reasoningChains } from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { delegateToAgent } from './ceo-orchestrator.js'

interface MonitorRow {
  slug:        string
  intervalSec: number
}

export interface MonitorCycleResult {
  workspaceId:  string
  scanned:      number
  fired:        number
  skipped:      number
  notes:        string[]
}

function parseInterval(tags: string[]): number {
  for (const t of tags) {
    const m = t.match(/^interval:(\d+)$/)
    if (m) return Number(m[1])
  }
  return 0
}

async function lastFiredAt(workspaceId: string, slug: string): Promise<number> {
  const r = await db.select({ createdAt: reasoningChains.createdAt })
    .from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.source, `openjarvis-monitor:${slug}`),
    ))
    .orderBy(desc(reasoningChains.createdAt))
    .limit(1).then(rows => rows[0]).catch(() => undefined)
  return r?.createdAt ?? 0
}

export async function runMonitorCycle(workspaceId: string): Promise<MonitorCycleResult> {
  const result: MonitorCycleResult = { workspaceId, scanned: 0, fired: 0, skipped: 0, notes: [] }
  const now = Date.now()

  const monitors = await db.select({
      slug: agentDefinitions.slug, tags: agentDefinitions.tags,
    }).from(agentDefinitions)
    .where(eq(agentDefinitions.workspaceId, workspaceId))
    .catch(() => [])
  const operatives: MonitorRow[] = monitors
    .filter(m => (m.tags ?? []).includes('monitor-operative'))
    .map(m => ({ slug: m.slug, intervalSec: parseInterval(m.tags ?? []) }))
    .filter(m => m.intervalSec > 0)

  result.scanned = operatives.length

  for (const m of operatives) {
    const last = await lastFiredAt(workspaceId, m.slug)
    const ageSec = (now - last) / 1000
    if (last > 0 && ageSec < m.intervalSec) {
      result.skipped++
      continue
    }

    const r = await delegateToAgent({
      workspaceId,
      task: 'Run your monitor cycle. Follow your system prompt exactly. Output only what the operator would consume.',
      hint: m.slug,
      requestedBy: 'openjarvis-monitor',
      context: { monitorSlug: m.slug, lastFiredAt: last, intervalSec: m.intervalSec },
    }).catch(() => null)

    if (r && r.ok) {
      // Stamp a chain so the next cycle knows the last-fired time
      await db.insert(reasoningChains).values({
        id: crypto.randomUUID(),
        workspaceId,
        kind: 'observation',
        subjectId: `monitor:${m.slug}`,
        decision: `OpenJarvis monitor "${m.slug}" fired (took ${r.tokens} tokens)`,
        evidence: [{ type: 'delegation', id: r.delegationId, extract: r.slug }],
        confidence: 0.7,
        source: `openjarvis-monitor:${m.slug}`,
        indexedForSearch: false,
        createdAt: now,
      } as typeof reasoningChains.$inferInsert).catch(() => null)
      result.fired++
      result.notes.push(`fired ${m.slug}`)
    } else {
      result.notes.push(`failed ${m.slug}`)
    }
  }

  return result
}
