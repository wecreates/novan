/**
 * execution-fabric.ts — the policy + routing layer for "thin local
 * node, heavy work elsewhere."
 *
 * Three responsibilities, kept together because they're a single
 * decision in practice (classify → check local guard → match remote):
 *
 *   1. classifyJob(kind)           — light vs heavy
 *   2. localHardwareSnapshot()     — what's the laptop doing right now
 *   3. routeJob({ workspaceId, capability, kind })
 *        → { decision: 'local' | 'remote' | 'block', workerId?, reason? }
 *
 * Configuration via env:
 *   NOVAN_LOCAL_HEAVY_COMPUTE  = "allow" | "block" (default: "block")
 *   NOVAN_LOCAL_CPU_LIMIT_PCT  = 0..100   (default: 80)  — pause threshold
 *   NOVAN_LOCAL_MEM_LIMIT_PCT  = 0..100   (default: 85)
 *
 * No hidden behavior: this file never executes anything itself. It
 * answers "can this run locally, and if not, where can it run?" The
 * caller acts on the decision.
 */
import { totalmem, freemem, loadavg, cpus } from 'node:os'
import { and, eq, gt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { workerRegistry } from '../db/schema.js'

// ── Job classification ────────────────────────────────────────────────

/** Workload kinds that must NOT run on the thin local node. */
export const HEAVY_JOB_KINDS = [
  'gpu-inference',
  'model-load',
  'playwright',
  'browser-automation',
  'image-generation',
  'video-generation',
  'voice-stt',
  'voice-tts',
  'research-crawl',
  'massive-indexing',
  'long-agent-run',
  'heavy-build',
  'heavy-test',
  'e2e-test',
  'visual-regression',
] as const
export type HeavyJobKind = typeof HEAVY_JOB_KINDS[number]

/** Workload kinds that are always fine to run locally. */
export const LIGHT_JOB_KINDS = [
  'ui-render',
  'sse-stream',
  'lightweight-cache',
  'log-write',
  'config-read',
  'small-query',
  'connection-mgmt',
] as const
export type LightJobKind = typeof LIGHT_JOB_KINDS[number]

export type JobKind = HeavyJobKind | LightJobKind | string

export function classifyJob(kind: JobKind): 'light' | 'heavy' {
  if ((HEAVY_JOB_KINDS as readonly string[]).includes(kind)) return 'heavy'
  return 'light'
}

// ── Local hardware guard ──────────────────────────────────────────────

export interface HardwareSnapshot {
  /** 1-minute load average ÷ logical-core count, as 0..1+. */
  cpuLoad1m:    number
  /** Process RSS in MB. */
  processMemMb: number
  /** System memory used as a percentage 0..100. */
  systemMemPct: number
  cores:        number
  /** Convenience flags vs configured limits. */
  cpuOverLimit: boolean
  memOverLimit: boolean
}

function envNumber(name: string, def: number): number {
  const v = process.env[name]
  if (!v) return def
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

export function localHardwareSnapshot(): HardwareSnapshot {
  const cores       = cpus().length || 1
  const load1m      = loadavg()[0] ?? 0   // 0 on Windows — loadavg is a no-op
  const cpuLoad1m   = load1m / cores
  const processMem  = process.memoryUsage().rss
  const total       = totalmem()
  const free        = freemem()
  const systemMemPct = total > 0 ? ((total - free) / total) * 100 : 0
  const cpuLimit    = envNumber('NOVAN_LOCAL_CPU_LIMIT_PCT', 80)
  const memLimit    = envNumber('NOVAN_LOCAL_MEM_LIMIT_PCT', 85)
  return {
    cpuLoad1m,
    processMemMb: Math.round(processMem / 1024 / 1024),
    systemMemPct: Math.round(systemMemPct),
    cores,
    cpuOverLimit: cpuLoad1m * 100 > cpuLimit,
    memOverLimit: systemMemPct > memLimit,
  }
}

// ── Capability matcher ────────────────────────────────────────────────

export interface RouteDecision {
  decision: 'local' | 'remote' | 'block'
  /** When decision === 'remote': which worker row owns it. */
  workerId?:    string
  workerName?:  string
  endpointUrl?: string | null
  /** Human-readable rationale, always populated. */
  reason:       string
}

/**
 * Find an alive remote worker that advertises the given capability.
 * "Alive" = heartbeat within the worker's own staleThresholdMs.
 */
async function findRemoteWorker(workspaceId: string, capability: string) {
  const now = Date.now()
  const rows = await db.select().from(workerRegistry)
    .where(and(
      eq(workerRegistry.workspaceId, workspaceId),
      gt(workerRegistry.lastHeartbeatAt, now - 90_000),    // generous freshness
    ))
    .catch(() => [])
  // Prefer workers explicitly tagged with the capability, then any
  // non-cpu type as a fallback (e.g. 'gpu' or 'browser').
  const tagged = rows.find(r => (r.capabilities ?? []).includes(capability))
  if (tagged) return tagged
  if (capability === 'gpu-inference' || capability === 'image-generation' || capability === 'video-generation') {
    return rows.find(r => r.workerType === 'gpu') ?? null
  }
  if (capability === 'playwright' || capability === 'browser-automation') {
    return rows.find(r => r.workerType === 'browser') ?? null
  }
  return null
}

export interface RouteRequest {
  workspaceId: string
  kind:        JobKind
  /** Required capability tag — defaults to the kind itself. */
  capability?: string
}

export async function routeJob(req: RouteRequest): Promise<RouteDecision> {
  const klass = classifyJob(req.kind)
  if (klass === 'light') {
    return { decision: 'local', reason: `kind '${req.kind}' is light — local OK` }
  }

  // Heavy: consult the policy
  const policy = (process.env['NOVAN_LOCAL_HEAVY_COMPUTE'] ?? 'block').toLowerCase()
  const hw     = localHardwareSnapshot()

  // Try to find a remote worker that can take it
  const cap    = req.capability ?? req.kind
  const worker = await findRemoteWorker(req.workspaceId, cap)
  if (worker) {
    return {
      decision:    'remote',
      workerId:    worker.id,
      workerName:  worker.workerName,
      endpointUrl: worker.endpointUrl,
      reason:      `heavy kind '${req.kind}' routed to remote worker '${worker.workerName}' (capability '${cap}')`,
    }
  }

  // No remote worker — fall back per policy
  if (policy === 'allow') {
    if (hw.cpuOverLimit || hw.memOverLimit) {
      return {
        decision: 'block',
        reason:   `heavy kind '${req.kind}' would run local but hardware over limit (cpu ${Math.round(hw.cpuLoad1m * 100)}%, mem ${hw.systemMemPct}%)`,
      }
    }
    return {
      decision: 'local',
      reason:   `heavy kind '${req.kind}' allowed local (NOVAN_LOCAL_HEAVY_COMPUTE=allow, no remote worker found)`,
    }
  }

  return {
    decision: 'block',
    reason:   `heavy kind '${req.kind}' blocked: no remote worker advertises capability '${cap}', and NOVAN_LOCAL_HEAVY_COMPUTE=${policy}`,
  }
}

// ── Fabric snapshot (for war-room view) ──────────────────────────────

export interface FabricSnapshot {
  policy:            'allow' | 'block' | string
  hardware:          HardwareSnapshot
  workers: {
    total:           number
    alive:           number
    byType:          Record<string, number>
    capabilities:    string[]    // union of all advertised capabilities
  }
  heavyKindsCovered:   string[]  // heavy kinds with at least one alive worker
  heavyKindsUncovered: string[]  // heavy kinds with NO alive worker
}

export async function fabricSnapshot(workspaceId: string): Promise<FabricSnapshot> {
  const now  = Date.now()
  const rows = await db.select().from(workerRegistry)
    .where(eq(workerRegistry.workspaceId, workspaceId))
    .catch(() => [])
  const alive = rows.filter(r => (r.lastHeartbeatAt ?? 0) > now - 90_000)
  const byType: Record<string, number> = {}
  const capSet = new Set<string>()
  for (const w of alive) {
    byType[w.workerType] = (byType[w.workerType] ?? 0) + 1
    for (const c of (w.capabilities ?? [])) capSet.add(c)
  }
  // Coverage: which heavy kinds at least one alive worker can serve
  const covered:   string[] = []
  const uncovered: string[] = []
  for (const kind of HEAVY_JOB_KINDS) {
    const hit = alive.some(w =>
      (w.capabilities ?? []).includes(kind) ||
      (kind === 'gpu-inference'      && w.workerType === 'gpu') ||
      (kind === 'image-generation'   && w.workerType === 'gpu') ||
      (kind === 'video-generation'   && w.workerType === 'gpu') ||
      (kind === 'playwright'         && w.workerType === 'browser') ||
      (kind === 'browser-automation' && w.workerType === 'browser'),
    )
    if (hit) covered.push(kind); else uncovered.push(kind)
  }
  return {
    policy:    (process.env['NOVAN_LOCAL_HEAVY_COMPUTE'] ?? 'block').toLowerCase(),
    hardware:  localHardwareSnapshot(),
    workers:   {
      total:        rows.length,
      alive:        alive.length,
      byType,
      capabilities: [...capSet].sort(),
    },
    heavyKindsCovered:   covered,
    heavyKindsUncovered: uncovered,
  }
}
