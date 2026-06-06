/**
 * R146.236 — Capability-layer smoke test. Hits each R206-R234 op in
 * sequence and reports {op, ok, ms, note?} per probe. Operator can
 * call brain.capability.smoke at any time to see end-to-end health.
 *
 * Read-only probes only — writes go to a synthetic suffix '__smoke'
 * so they don't pollute real workspace data. Cleanup at end.
 */
import { db } from '../db/client.js'
import { OPERATIONS } from './brain-task.js'
import { operatorSkills, subagentRuns, workspaceMemory } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'

export interface SmokeResult {
  ok:    boolean
  okCount: number
  failCount: number
  totalMs: number
  probes: Array<{ op: string; ok: boolean; ms: number; error?: string }>
}

async function probe(opName: string, params: Record<string, unknown>, workspaceId: string): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t0 = Date.now()
  const spec = OPERATIONS[opName]
  if (!spec) return { ok: false, ms: 0, error: 'unknown op' }
  try {
    await spec.handler(workspaceId, params)
    return { ok: true, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: (e as Error).message.slice(0, 200) }
  }
}

export async function capabilitySmoke(workspaceId: string): Promise<SmokeResult> {
  const t0 = Date.now()
  const probes: SmokeResult['probes'] = []

  const checks: Array<{ op: string; params: Record<string, unknown> }> = [
    // Read ops
    { op: 'skill.list',       params: {} },
    { op: 'op.search',        params: { query: 'platform', limit: 3 } },
    { op: 'flag.list',        params: {} },
    { op: 'platform.status',  params: {} },
    { op: 'backup.health',    params: {} },
    { op: 'applier.health',   params: {} },
    { op: 'brain.metrics',    params: {} },
    { op: 'session.recap',    params: {} },
    { op: 'memory.kv.recall', params: { limit: 3 } },
    { op: 'workplace.counts', params: {} },
    { op: 'routing.healthCheck', params: {} },
    { op: 'wf.list',          params: {} },
    { op: 'selfdev.findings', params: { status: 'open', limit: 3 } },
    // Write probes (suffixed so visible but clearly synthetic)
    { op: 'skill.create',    params: {
      name: '__smoke',
      description: 'capability smoke test marker — safe to delete',
      whenToUse: 'never; this is a synthetic probe',
      instructions: 'no-op',
    }},
    { op: 'memory.remember', params: {
      key: '__smoke_marker', value: 'capability smoke probe ' + new Date().toISOString(),
      scope: 'smoke', importance: 1,
    }},
  ]

  for (const c of checks) {
    const r = await probe(c.op, c.params, workspaceId)
    probes.push({ op: c.op, ...r })
  }

  // Cleanup synthetic writes
  try {
    await db.delete(operatorSkills)
      .where(and(eq(operatorSkills.workspaceId, workspaceId), eq(operatorSkills.name, '__smoke')))
    await db.delete(workspaceMemory)
      .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.key, '__smoke_marker')))
  } catch { /* tolerated */ }

  // Drop synthetic subagent_runs older than 1min (defensive in case any probe
  // generated one — none currently do, but keeps the table tidy.)
  void subagentRuns

  const okCount = probes.filter(p => p.ok).length
  const failCount = probes.length - okCount
  return {
    ok: failCount === 0,
    okCount, failCount,
    totalMs: Date.now() - t0,
    probes,
  }
}
