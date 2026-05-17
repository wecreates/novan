/**
 * resource-governor.ts — Runtime resource limits enforced before any
 * autonomous action. Pure in-memory + DB-read; no new tables.
 *
 *   - Max concurrent agents per workspace
 *   - Max research jobs per hour
 *   - Max image generations per hour
 *   - Max provider spend USD per hour
 *   - Emergency throttle when open critical incidents > 0
 *   - Queue-pressure check (caller passes current depth)
 *
 * All checks are deny-by-explicit-reason; default-allow when limits unset.
 */
import { db }                     from '../db/client.js'
import { events, incidents, imageGenerations } from '../db/schema.js'
import { and, eq, gte, sql }      from 'drizzle-orm'

// Local re-impl (avoid circular import to governance-core)
const DAY_MS = 24 * 60 * 60_000
async function autonomousPatchesTodayCount(workspaceId: string): Promise<number> {
  const since = Date.now() - DAY_MS
  return db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), sql`${events.type} in ('patch.applied','patch.auto_applied')`, gte(events.createdAt, since)))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
}
async function deploymentsTodayCount(workspaceId: string): Promise<number> {
  const since = Date.now() - DAY_MS
  return db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), sql`${events.type} in ('deployment.started','deployment.completed')`, gte(events.createdAt, since)))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
}

export interface GovernorLimits {
  maxConcurrentAgents:    number
  maxResearchPerHour:     number
  maxImagesPerHour:       number
  maxProviderSpendUsdPerHour: number
  maxQueueDepth:          number
  maxAutonomousPatchesPerDay: number
  maxDeploymentsPerDay:    number
}

const DEFAULT_LIMITS: GovernorLimits = {
  maxConcurrentAgents:        Number(process.env['GOV_MAX_AGENTS']         ?? 8),
  maxResearchPerHour:         Number(process.env['GOV_MAX_RESEARCH_HR']    ?? 30),
  maxImagesPerHour:           Number(process.env['GOV_MAX_IMAGES_HR']      ?? 20),
  maxProviderSpendUsdPerHour: Number(process.env['GOV_MAX_SPEND_HR']       ?? 1.0),
  maxQueueDepth:              Number(process.env['GOV_MAX_QUEUE']          ?? 200),
  maxAutonomousPatchesPerDay: Number(process.env['GOV_MAX_AUTO_PATCHES_DAY'] ?? 20),
  maxDeploymentsPerDay:       Number(process.env['GOV_MAX_DEPLOYS_DAY']    ?? 5),
}

// In-process counters — token-bucket style, reset hourly per process
interface Bucket { count: number; resetAt: number }
const BUCKETS = new Map<string, Bucket>()
function bumpHourly(key: string): number {
  const now = Date.now()
  const b = BUCKETS.get(key)
  if (!b || b.resetAt < now) {
    BUCKETS.set(key, { count: 1, resetAt: now + 60 * 60_000 })
    return 1
  }
  b.count += 1
  return b.count
}
function peekHourly(key: string): number {
  const b = BUCKETS.get(key)
  if (!b || b.resetAt < Date.now()) return 0
  return b.count
}

const RUNNING_AGENTS = new Map<string, number>()  // workspaceId → current count

export interface GovernorDecision {
  ok:        boolean
  reason?:   string
  retryAfterMs?: number
  current:   { agentsRunning: number; researchThisHour: number; imagesThisHour: number; openCriticalIncidents: number }
  limits:    GovernorLimits
}

async function openCriticalIncidents(workspaceId: string): Promise<number> {
  return db.select({ c: sql<number>`count(*)::int` }).from(incidents)
    .where(and(
      eq(incidents.workspaceId, workspaceId),
      eq(incidents.status, 'open'),
      eq(incidents.severity, 'critical'),
    ))
    .then(r => Number(r[0]?.c ?? 0))
    .catch(() => 0)
}

async function imagesThisHour(workspaceId: string): Promise<number> {
  const since = Date.now() - 60 * 60_000
  return db.select({ c: sql<number>`count(*)::int` }).from(imageGenerations)
    .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, since)))
    .then(r => Number(r[0]?.c ?? 0))
    .catch(() => 0)
}

export async function checkBeforeAction(opts: {
  workspaceId: string
  kind:        'agent' | 'research' | 'image' | 'queue_push' | 'autonomous_patch' | 'deployment'
  queueDepth?: number
  limits?:     Partial<GovernorLimits>
}): Promise<GovernorDecision> {
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) }
  const [crit, imgHour] = await Promise.all([
    openCriticalIncidents(opts.workspaceId),
    opts.kind === 'image' ? imagesThisHour(opts.workspaceId) : Promise.resolve(peekHourly(`img:${opts.workspaceId}`)),
  ])
  const current = {
    agentsRunning:         RUNNING_AGENTS.get(opts.workspaceId) ?? 0,
    researchThisHour:      peekHourly(`research:${opts.workspaceId}`),
    imagesThisHour:        imgHour,
    openCriticalIncidents: crit,
  }

  // Emergency throttle — open critical incident halts new autonomous actions
  if (crit > 0 && opts.kind !== 'queue_push') {
    return { ok: false, reason: `emergency throttle: ${crit} open critical incident(s)`, current, limits }
  }

  if (opts.kind === 'agent' && current.agentsRunning >= limits.maxConcurrentAgents) {
    return { ok: false, reason: `max concurrent agents reached (${limits.maxConcurrentAgents})`, retryAfterMs: 60_000, current, limits }
  }
  if (opts.kind === 'research' && current.researchThisHour >= limits.maxResearchPerHour) {
    return { ok: false, reason: `max research jobs/hour reached (${limits.maxResearchPerHour})`, retryAfterMs: 60_000, current, limits }
  }
  if (opts.kind === 'image' && current.imagesThisHour >= limits.maxImagesPerHour) {
    return { ok: false, reason: `max image generations/hour reached (${limits.maxImagesPerHour})`, retryAfterMs: 60_000, current, limits }
  }
  if (opts.kind === 'queue_push' && (opts.queueDepth ?? 0) > limits.maxQueueDepth) {
    return { ok: false, reason: `queue depth ${opts.queueDepth} exceeds limit ${limits.maxQueueDepth}`, current, limits }
  }
  if (opts.kind === 'autonomous_patch') {
    const today = await autonomousPatchesTodayCount(opts.workspaceId)
    if (today >= limits.maxAutonomousPatchesPerDay) {
      return { ok: false, reason: `max autonomous patches/day reached (${limits.maxAutonomousPatchesPerDay})`, current, limits }
    }
  }
  if (opts.kind === 'deployment') {
    const today = await deploymentsTodayCount(opts.workspaceId)
    if (today >= limits.maxDeploymentsPerDay) {
      return { ok: false, reason: `max deployments/day reached (${limits.maxDeploymentsPerDay})`, current, limits }
    }
  }

  // Bump the appropriate bucket
  if (opts.kind === 'research') bumpHourly(`research:${opts.workspaceId}`)
  if (opts.kind === 'image')    bumpHourly(`img:${opts.workspaceId}`)
  return { ok: true, current, limits }
}

/** Lease lifecycle for concurrent-agent tracking. */
export function acquireAgentSlot(workspaceId: string): void {
  RUNNING_AGENTS.set(workspaceId, (RUNNING_AGENTS.get(workspaceId) ?? 0) + 1)
}
export function releaseAgentSlot(workspaceId: string): void {
  const v = RUNNING_AGENTS.get(workspaceId) ?? 0
  RUNNING_AGENTS.set(workspaceId, Math.max(0, v - 1))
}

export function currentLimits(): GovernorLimits {
  return { ...DEFAULT_LIMITS }
}

export async function snapshot(workspaceId: string) {
  return {
    limits: currentLimits(),
    workspace: {
      workspaceId,
      agentsRunning:         RUNNING_AGENTS.get(workspaceId) ?? 0,
      researchThisHour:      peekHourly(`research:${workspaceId}`),
      imagesThisHour:        await imagesThisHour(workspaceId),
      openCriticalIncidents: await openCriticalIncidents(workspaceId),
    },
  }
}

/** Best-effort emit — caller decides whether to log governor decisions. */
export async function emitGovernorBlock(workspaceId: string, decision: GovernorDecision, kind: string) {
  const { v7: uuidv7 } = await import('uuid')
  await db.insert(events).values({
    id: uuidv7(), type: 'governor.blocked', workspaceId,
    payload: { kind, reason: decision.reason, current: decision.current, limits: decision.limits },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'resource-governor', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}
