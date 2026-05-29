/**
 * platform-smoke.ts — the brain's continuous self-check.
 *
 * Pure-ish service: given a list of probe URLs, hit each against the
 * locally running API, persist the results, and detect regressions
 * vs the previous run. The cron in learning-cron.ts calls
 * `runPlatformSmoke(workspaceId)` on an interval. The on-demand route
 * (POST /api/v1/self/platform-smoke) does the same.
 *
 * Findings classification:
 *   ok          200/201/204 within slowThreshold
 *   slow        200/201/204 but ≥ slowThreshold ms (perf regression)
 *   bad_input   400 (route exists, just missing a param — not a bug)
 *   not_found   404
 *   server_err  ≥500
 *   unreachable timeout / network error
 *
 * Regressions = paths that were ok on the previous run but now in any
 * non-ok bucket (or vice versa for stability metrics).
 *
 * Honest scope:
 *   - Read-only probes only. Mutations live in dedicated integration
 *     tests with proper fixtures.
 *   - Probes are loopback (http://127.0.0.1:PORT) so this never hits
 *     anything external.
 */
import { v7 as uuidv7 } from 'uuid'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { events, platformSmokeRuns } from '../db/schema.js'

export interface ProbeResult {
  path:        string
  status:      number     // 0 = unreachable
  ms:          number
  bodyExcerpt: string
}

export interface SmokeRun {
  id:          string
  ranAt:       number
  durationMs:  number
  okCount:     number
  failCount:   number
  slowCount:   number
  probes:      ProbeResult[]
  regressions: Array<{ path: string; prevStatus: number; nowStatus: number }>
}

const DEFAULT_SLOW_MS    = 3_000      // anything ≥ 3 s is suspicious
const PER_PROBE_TIMEOUT  = 12_000     // 12 s hard cap

/**
 * Catalog of read-only routes that mirror what the UI buttons hit.
 * Adding to this list = adding to the brain's self-check coverage.
 * `{ws}` is replaced with the actual workspace_id at run time.
 */
export const SMOKE_CATALOG: string[] = [
  // System
  '/api/v1/health',
  '/health/ready',
  '/api/v1/workspaces',

  // Brain
  '/api/v1/brain/graph?workspace_id={ws}&lod=systems',

  // Chat
  '/api/v1/chat/conversations?workspace_id={ws}',
  '/api/v1/chat/providers?workspace_id={ws}',

  // Agency
  '/api/v1/agency/catalog/status?workspace_id={ws}',
  '/api/v1/agency/departments?workspace_id={ws}',
  '/api/v1/agency/definitions?workspace_id={ws}&limit=5',
  '/api/v1/agency/delegations?workspace_id={ws}',

  // TTS
  '/api/v1/tts/sidecar/health',
  '/api/v1/tts/profiles?workspace_id={ws}',

  // Intel-ops (recent primitives)
  '/api/v1/intel-ops/models/trust?workspace_id={ws}',
  '/api/v1/intel-ops/narrative/recent?workspace_id={ws}',
  '/api/v1/intel-ops/rhythm?workspace_id={ws}',
  '/api/v1/intel-ops/failover/health?workspace_id={ws}',
  '/api/v1/intel-ops/plugins/permissions',

  // Operational pages
  '/api/v1/cognition/snapshot?workspace_id={ws}',
  '/api/v1/cognition/accuracy?workspace_id={ws}',
  '/api/v1/truth/drift/warnings?workspace_id={ws}',
  '/api/v1/truth/assumptions/summary?workspace_id={ws}',
  '/api/v1/economy/war-room?workspace_id={ws}',
  '/api/v1/commerce/war-room?workspace_id={ws}',
  '/api/v1/commerce/trust?workspace_id={ws}',
  '/api/v1/commerce/governance/sovereignty?workspace_id={ws}',
  '/api/v1/commerce/governance/alignment?workspace_id={ws}',
  '/api/v1/commerce/governance/ethical-blocks?workspace_id={ws}&hours=24',
  '/api/v1/commerce/governance/overrides?workspace_id={ws}',
  '/api/v1/fabric/snapshot?workspace_id={ws}',
  '/api/v1/sim/war-room?workspace_id={ws}',
  '/api/v1/mission/charter',
  '/api/v1/mission/adherence?workspace_id={ws}',
  '/api/v1/identity/drift?workspace_id={ws}',

  // Self cluster
  '/api/v1/self/git/snapshots?workspace_id={ws}',
  '/api/v1/self/introspect?workspace_id={ws}',
  '/api/v1/self/proposals?workspace_id={ws}',
  '/api/v1/self/preferences/providers?workspace_id={ws}',
  '/api/v1/self/preferences/workers?workspace_id={ws}',
  '/api/v1/self/discovered-capabilities?workspace_id={ws}',
  '/api/v1/self/notification-drivers',

  // Runtime
  '/api/v1/runtime/status?workspace_id={ws}',
  '/api/v1/runtime/budgets?workspace_id={ws}',
  '/api/v1/runtime/calibration?workspace_id={ws}',

  // Skills
  '/api/v1/skills?workspace_id={ws}',
  '/api/v1/skills/gaps?workspace_id={ws}',
]

// ─── Pure helpers ─────────────────────────────────────────────────────

/** Classify a single probe result. Pure. */
export function classify(p: ProbeResult, slowMs: number = DEFAULT_SLOW_MS):
  'ok' | 'slow' | 'bad_input' | 'not_found' | 'server_err' | 'unreachable' {
  if (p.status === 0) return 'unreachable'
  if (p.status === 404) return 'not_found'
  if (p.status === 400) return 'bad_input'
  if (p.status >= 500) return 'server_err'
  if (p.status >= 200 && p.status < 300) {
    return p.ms >= slowMs ? 'slow' : 'ok'
  }
  return 'server_err'    // 401/403/3xx — flag for attention
}

/** Compare two runs and return paths whose ok-status flipped. Pure. */
export function detectRegressions(
  prev: ReadonlyArray<ProbeResult>,
  next: ReadonlyArray<ProbeResult>,
): Array<{ path: string; prevStatus: number; nowStatus: number }> {
  const prevByPath = new Map(prev.map(p => [p.path, p.status]))
  const out: Array<{ path: string; prevStatus: number; nowStatus: number }> = []
  for (const n of next) {
    const ps = prevByPath.get(n.path)
    if (ps === undefined) continue
    const prevOk = ps >= 200 && ps < 300
    const nowOk  = n.status >= 200 && n.status < 300
    if (prevOk && !nowOk) {
      out.push({ path: n.path, prevStatus: ps, nowStatus: n.status })
    }
  }
  return out
}

/** Build the live probe list with workspace substituted. Pure. */
export function buildProbeList(workspaceId: string, catalog: ReadonlyArray<string> = SMOKE_CATALOG): string[] {
  const ws = encodeURIComponent(workspaceId)
  return catalog.map(p => p.replace(/\{ws\}/g, ws))
}

// ─── HTTP ─────────────────────────────────────────────────────────────

async function probeOne(base: string, path: string): Promise<ProbeResult> {
  const start = Date.now()
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), PER_PROBE_TIMEOUT)
    const res = await fetch(`${base}${path}`, { signal: ctrl.signal })
    clearTimeout(t)
    const text = await res.text().catch(() => '')
    return { path, status: res.status, ms: Date.now() - start, bodyExcerpt: text.slice(0, 200) }
  } catch (e) {
    return { path, status: 0, ms: Date.now() - start, bodyExcerpt: (e as Error).message }
  }
}

// ─── Orchestrator (DB-aware) ──────────────────────────────────────────

export interface SmokeOpts {
  /** Loopback API base. Defaults to local Fastify port. */
  base?:     string
  source?:   string
  slowMs?:   number
  /** Override the probe catalog for tests / targeted re-runs. */
  catalog?:  ReadonlyArray<string>
}

export async function runPlatformSmoke(workspaceId: string, opts: SmokeOpts = {}): Promise<SmokeRun> {
  const base = opts.base ?? `http://127.0.0.1:${process.env['PORT'] ?? '3001'}`
  const slowMs = opts.slowMs ?? DEFAULT_SLOW_MS
  const paths = buildProbeList(workspaceId, opts.catalog ?? SMOKE_CATALOG)
  const start = Date.now()

  // Serial probing — concurrency on the same process under self-test
  // induces phantom 500s as the cron + smoke compete for the DB pool.
  const probes: ProbeResult[] = []
  for (const p of paths) {
    probes.push(await probeOne(base, p))
  }
  const durationMs = Date.now() - start

  // Counts
  let ok = 0, fail = 0, slow = 0
  for (const r of probes) {
    const k = classify(r, slowMs)
    if (k === 'ok') ok++
    else if (k === 'slow') { ok++; slow++ }
    else if (k === 'bad_input') ok++   // 400 due to omitted param = not a bug
    else fail++
  }

  // Find prior run for regression detection
  const prior = await db.select().from(platformSmokeRuns)
    .where(eq(platformSmokeRuns.workspaceId, workspaceId))
    .orderBy(desc(platformSmokeRuns.ranAt))
    .limit(1).then(r => r[0] ?? null).catch(() => null)

  const regressions = prior
    ? detectRegressions(prior.probes as ProbeResult[], probes)
    : []

  // Persist
  const id = uuidv7()
  const ranAt = Date.now()
  await db.insert(platformSmokeRuns).values({
    id, workspaceId, ranAt, durationMs,
    okCount: ok, failCount: fail, slowCount: slow,
    probes, regressions,
    source: opts.source ?? 'cron',
  }).catch(() => null)

  // Emit a regression event when something newly broke — the operator
  // wires notifications + the existing incident detector picks this up.
  if (regressions.length > 0) {
    await db.insert(events).values({
      id: uuidv7(),
      type: 'platform.smoke.regression',
      workspaceId,
      payload: { runId: id, count: regressions.length, paths: regressions.map(r => r.path) },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'platform-smoke', version: 1, createdAt: ranAt,
    }).catch(() => null)
  }

  return { id, ranAt, durationMs, okCount: ok, failCount: fail, slowCount: slow, probes, regressions }
}

export async function getLatestSmokeRun(workspaceId: string): Promise<SmokeRun | null> {
  const row = await db.select().from(platformSmokeRuns)
    .where(eq(platformSmokeRuns.workspaceId, workspaceId))
    .orderBy(desc(platformSmokeRuns.ranAt))
    .limit(1).then(r => r[0] ?? null).catch(() => null)
  if (!row) return null
  return {
    id: row.id, ranAt: row.ranAt, durationMs: row.durationMs,
    okCount: row.okCount, failCount: row.failCount, slowCount: row.slowCount,
    probes: row.probes as ProbeResult[],
    regressions: row.regressions as SmokeRun['regressions'],
  }
}

export async function listRecentSmokeRuns(workspaceId: string, limit = 20) {
  return db.select({
    id: platformSmokeRuns.id,
    ranAt: platformSmokeRuns.ranAt,
    durationMs: platformSmokeRuns.durationMs,
    okCount: platformSmokeRuns.okCount,
    failCount: platformSmokeRuns.failCount,
    slowCount: platformSmokeRuns.slowCount,
    regressionCount: platformSmokeRuns.regressions,   // jsonb — UI will sum length
    source: platformSmokeRuns.source,
  })
    .from(platformSmokeRuns)
    .where(eq(platformSmokeRuns.workspaceId, workspaceId))
    .orderBy(desc(platformSmokeRuns.ranAt))
    .limit(limit)
    .catch(() => [])
}
