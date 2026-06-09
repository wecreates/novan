/**
 * R376 — Capability self-test.
 *
 * One op that exercises a representative subset of brain-task ops and
 * reports back what works, what's broken, and what's missing prerequisites.
 * Useful when:
 *   - After a deploy: confirm nothing regressed
 *   - When the operator suspects something is broken
 *   - As a daily heartbeat for the dashboard's "system health" line
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface CapabilityProbe {
  name:         string                              // human-readable
  category:     'queue' | 'pipeline' | 'sales' | 'agent' | 'pinterest' | 'selector' | 'dashboard'
  status:       'ok' | 'degraded' | 'missing' | 'error'
  detail:       string
  durationMs:   number
}

export interface SelfTestResult {
  ts:               number
  workspaceId:      string
  summary: {
    ok:        number
    degraded:  number
    missing:   number
    error:     number
    total:     number
  }
  probes:           CapabilityProbe[]
}

async function probe(name: string, category: CapabilityProbe['category'], fn: () => Promise<{ status: CapabilityProbe['status']; detail: string }>): Promise<CapabilityProbe> {
  const started = Date.now()
  try {
    const r = await fn()
    return { name, category, status: r.status, detail: r.detail, durationMs: Date.now() - started }
  } catch (e) {
    return { name, category, status: 'error', detail: (e as Error).message.slice(0, 200), durationMs: Date.now() - started }
  }
}

export async function runCapabilitySelfTest(workspaceId: string): Promise<SelfTestResult> {
  const probes: CapabilityProbe[] = []

  // 1. Upload queue
  probes.push(await probe('upload_queue table reachable', 'queue', async () => {
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM design_upload_queue WHERE workspace_id = ${workspaceId}`)
    const n = Number((r as Array<{ n: number }>)[0]?.n ?? 0)
    return { status: 'ok', detail: `${n} queue rows total` }
  }))

  probes.push(await probe('design_catalog populated', 'pipeline', async () => {
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM design_catalog WHERE workspace_id = ${workspaceId}`)
    const n = Number((r as Array<{ n: number }>)[0]?.n ?? 0)
    if (n === 0) return { status: 'missing', detail: 'no designs in catalog — run trends.run_pipeline' }
    return { status: 'ok', detail: `${n} designs in catalog` }
  }))

  // 2. Trend pipeline
  probes.push(await probe('trend pipeline (catalog has 4+ designs)', 'pipeline', async () => {
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM design_catalog WHERE workspace_id = ${workspaceId}`)
    const n = Number((r as Array<{ n: number }>)[0]?.n ?? 0)
    if (n < 4) return { status: 'degraded', detail: `only ${n} designs — pipeline may be failing on HF generation` }
    return { status: 'ok', detail: `${n} designs available for upload` }
  }))

  // 3. Sales tracking
  probes.push(await probe('business_revenue table reachable', 'sales', async () => {
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM business_revenue WHERE workspace_id = ${workspaceId}`)
    const n = Number((r as Array<{ n: number }>)[0]?.n ?? 0)
    return { status: n === 0 ? 'missing' : 'ok', detail: n === 0 ? 'no sales recorded yet (pre_first_sale tier)' : `${n} sales recorded` }
  }))

  probes.push(await probe('gumroad access token configured', 'sales', async () => {
    const r = await db.execute(sql`SELECT value FROM workspace_memory WHERE workspace_id = ${workspaceId} AND key = 'connector.gumroad.access_token' LIMIT 1`)
    const token = (r as Array<{ value: string }>)[0]?.value
    if (!token) return { status: 'missing', detail: "set via memory.save key='connector.gumroad.access_token' — needed for sales.sync_gumroad" }
    return { status: 'ok', detail: `gumroad token present (${token.length} chars)` }
  }))

  // 4. Agent telemetry
  probes.push(await probe('agent heartbeat recency', 'agent', async () => {
    const r = await db.execute(sql`SELECT MAX(created_at) AS last_at FROM events WHERE workspace_id = ${workspaceId} AND type = 'agent.heartbeat'`)
    const last = Number((r as Array<{ last_at: number }>)[0]?.last_at ?? 0)
    if (!last) return { status: 'missing', detail: 'no heartbeats — local agent has never run' }
    const ageMin = (Date.now() - last) / 60_000
    if (ageMin > 24 * 60) return { status: 'degraded', detail: `last heartbeat ${ageMin.toFixed(0)}min ago — agent silent >24h` }
    return { status: 'ok', detail: `last heartbeat ${ageMin.toFixed(1)}min ago` }
  }))

  // 5. Pinterest queue
  probes.push(await probe('pinterest queue populated', 'pinterest', async () => {
    const r = await db.execute(sql`SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued FROM pinterest_pin_queue WHERE workspace_id = ${workspaceId}`).catch(() => [] as unknown[])
    const queued = Number((r as Array<{ queued: number }>)[0]?.queued ?? 0)
    if (queued === 0) return { status: 'missing', detail: 'no pins queued — run pnpm seed-pins or use pinterest.enqueue' }
    return { status: 'ok', detail: `${queued} pins queued` }
  }))

  // 6. Self-improving selectors
  probes.push(await probe('platform_selectors learning', 'selector', async () => {
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM platform_selectors WHERE workspace_id = ${workspaceId}`).catch(() => [] as unknown[])
    const n = Number((r as Array<{ n: number }>)[0]?.n ?? 0)
    if (n === 0) return { status: 'missing', detail: 'no selectors cached yet — agents will fall back to LLM suggestions on first failure' }
    return { status: 'ok', detail: `${n} selectors cached across platforms` }
  }))

  // 7. Dashboard reachability (just confirms r370 imports cleanly)
  probes.push(await probe('dashboard service loads', 'dashboard', async () => {
    const mod = await import('./r370-operator-dashboard.js').catch(() => null)
    if (!mod) return { status: 'error', detail: 'r370-operator-dashboard.ts not importable' }
    return { status: 'ok', detail: 'dashboard module loaded' }
  }))

  const summary = { ok: 0, degraded: 0, missing: 0, error: 0, total: probes.length }
  for (const p of probes) summary[p.status]++

  return { ts: Date.now(), workspaceId, summary, probes }
}
