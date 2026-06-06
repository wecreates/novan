/**
 * R146.330 #25-29, #35-42, #43-46 — disaster, pentest, quality bars.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { sql, gte, and, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #26 All-providers-down test ─────────────────────────────────────────
export async function allProvidersDownTest(workspaceId: string): Promise<{
  ok: boolean
  reachable:  Array<{ provider: string; ms: number }>
  unreachable: Array<{ provider: string; reason: string }>
  fallbackChainExpected: string[]
}> {
  const probes = [
    { provider: 'anthropic', url: 'https://api.anthropic.com/v1/messages', expectedStatus: [200, 400, 401, 403] },
    { provider: 'openai',    url: 'https://api.openai.com/v1/chat/completions', expectedStatus: [200, 400, 401, 403] },
    { provider: 'gemini',    url: 'https://generativelanguage.googleapis.com/v1beta/models', expectedStatus: [200, 400, 401, 403] },
  ]
  const reachable:   Array<{ provider: string; ms: number }> = []
  const unreachable: Array<{ provider: string; reason: string }> = []
  for (const p of probes) {
    const start = Date.now()
    try {
      const res = await fetch(p.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      if (p.expectedStatus.includes(res.status)) {
        reachable.push({ provider: p.provider, ms: Date.now() - start })
      } else {
        unreachable.push({ provider: p.provider, reason: `status ${res.status}` })
      }
    } catch (e) {
      unreachable.push({ provider: p.provider, reason: (e as Error).message })
    }
  }
  void workspaceId
  return {
    ok: reachable.length > 0,
    reachable, unreachable,
    fallbackChainExpected: ['anthropic', 'openai', 'gemini', 'local'],
  }
}

// ─── #27 PG corruption graceful degradation ──────────────────────────────
export async function pgGracefulProbe(): Promise<{
  ok: boolean; queryMs: number; rowsExpected: boolean; reason?: string
}> {
  const start = Date.now()
  try {
    const r = await db.execute(sql`SELECT 1 AS one`)
    const rows = (r as unknown as { rows?: Array<{ one: number }> }).rows ?? []
    return { ok: rows.length === 1, queryMs: Date.now() - start, rowsExpected: rows[0]?.one === 1 }
  } catch (e) {
    return { ok: false, queryMs: Date.now() - start, rowsExpected: false, reason: (e as Error).message }
  }
}

// ─── #28 Disk-full check ─────────────────────────────────────────────────
export async function diskUsage(): Promise<{
  ok: boolean; warning?: string;
  note: string
}> {
  // Host disk-usage isn't reachable from inside the container without a
  // mount; surface this honestly so operator wires it externally.
  return {
    ok: true,
    note: 'Container has no view of host disk. Operator should run `df -h` on droplet weekly OR mount /proc/diskstats.',
  }
}

// ─── #29 Soak test signal ────────────────────────────────────────────────
export async function soakSignal(): Promise<{
  uptimeSec: number; memoryMb: number; recommendation: string
}> {
  const mem = process.memoryUsage()
  const memMb = Math.round(mem.rss / 1024 / 1024)
  return {
    uptimeSec: Math.round(process.uptime()),
    memoryMb: memMb,
    recommendation: memMb > 800 ? 'Memory above 800MB — consider container restart or heap dump' : 'OK',
  }
}

// ─── #35 External pentest sketch ─────────────────────────────────────────
export async function externalPentestSketch(): Promise<{
  attemptsPlanned: string[]
  status: string
}> {
  // Lives as a documented scaffold; actual fire-the-payloads happens via
  // scripts/external-pentest.sh from a non-loopback host.
  return {
    attemptsPlanned: [
      'Anonymous POST /api/v1/setup/state — must 401',
      'Public POST /api/v1/brain/op {op:"db.query"} — must 401',
      'IDOR /scores/<other-workspace> — must 403',
      'SSRF POST /api/v1/timeline/today?url=http://169.254.169.254 — must reject',
      'Bootstrap reuse w/o BOOTSTRAP_REUSABLE — must 409',
    ],
    status: 'sketch — run scripts/external-pentest.sh from outside the droplet',
  }
}

// ─── #39 End-to-end latency p95 ──────────────────────────────────────────
const _latencySamples: number[] = []
const MAX_SAMPLES = 1000
export function recordChatLatency(ms: number): void {
  _latencySamples.push(ms)
  if (_latencySamples.length > MAX_SAMPLES) _latencySamples.shift()
}
export function latencyP95(): { count: number; p50: number; p95: number; p99: number } {
  if (_latencySamples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0 }
  const sorted = [..._latencySamples].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) }
}

// ─── #40 First-day retention ─────────────────────────────────────────────
export async function firstDayRetention(workspaceId: string): Promise<{
  firstSeenAt: number | null
  returnedSameDay: boolean
  returnedNextDay: boolean
  totalSessionsDay1: number
}> {
  const rows = await db.select({ createdAt: events.createdAt })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'novan-chat.turn'),
    ))
    .orderBy(events.createdAt)
    .limit(200)
    .catch(() => [])
  if (rows.length === 0) return { firstSeenAt: null, returnedSameDay: false, returnedNextDay: false, totalSessionsDay1: 0 }
  const firstSeenAt = Number(rows[0]!.createdAt)
  const sameDayEnd = firstSeenAt + 24 * 3600_000
  const nextDayEnd = sameDayEnd + 24 * 3600_000
  const day1 = rows.filter(r => Number(r.createdAt) < sameDayEnd).length
  const day2 = rows.filter(r => Number(r.createdAt) >= sameDayEnd && Number(r.createdAt) < nextDayEnd).length
  return {
    firstSeenAt,
    returnedSameDay: day1 > 1,
    returnedNextDay: day2 > 0,
    totalSessionsDay1: day1,
  }
}

// ─── #41 Cost per completed task ─────────────────────────────────────────
export async function costPerTask(workspaceId: string, windowDays = 30): Promise<{
  taskCount: number; totalCostUsd: number; avgCostPerTaskUsd: number
}> {
  const since = Date.now() - windowDays * 86400_000
  const { aiUsage, brainTaskExecutions } = await import('../db/schema.js')
  const [taskRows, costRows] = await Promise.all([
    db.select({ id: brainTaskExecutions.id })
      .from(brainTaskExecutions)
      .where(and(
        eq(brainTaskExecutions.workspaceId, workspaceId),
        gte(brainTaskExecutions.createdAt, since),
        eq(brainTaskExecutions.status, 'completed'),
      ))
      .catch(() => []),
    db.select({ cost: aiUsage.costUsd })
      .from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
      .catch(() => []),
  ])
  const totalCostUsd = costRows.reduce((s, r) => s + Number(r.cost ?? 0), 0)
  const taskCount = taskRows.length
  const avgCostPerTaskUsd = taskCount > 0 ? totalCostUsd / taskCount : 0
  return {
    taskCount,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    avgCostPerTaskUsd: Number(avgCostPerTaskUsd.toFixed(4)),
  }
}

// ─── #42 Meta-metric: operator-request → working-result ──────────────────
export async function effectivenessMetric(workspaceId: string, windowDays = 7): Promise<{
  totalRequests: number; completed: number; failed: number; effectivenessRate: number; avgMs: number
}> {
  const since = Date.now() - windowDays * 86400_000
  const { brainTaskExecutions } = await import('../db/schema.js')
  const rows = await db.select({
    status: brainTaskExecutions.status,
    createdAt: brainTaskExecutions.createdAt,
    finishedAt: brainTaskExecutions.finishedAt,
  }).from(brainTaskExecutions)
    .where(and(eq(brainTaskExecutions.workspaceId, workspaceId), gte(brainTaskExecutions.createdAt, since)))
    .catch(() => [])
  const totalRequests = rows.length
  const completed = rows.filter(r => r.status === 'completed').length
  const failed    = rows.filter(r => r.status === 'failed').length
  const durations = rows
    .filter(r => r.finishedAt && r.createdAt)
    .map(r => Number(r.finishedAt) - Number(r.createdAt))
  const avgMs = durations.length > 0 ? durations.reduce((s, m) => s + m, 0) / durations.length : 0
  return {
    totalRequests, completed, failed,
    effectivenessRate: totalRequests > 0 ? Number((completed / totalRequests).toFixed(2)) : 0,
    avgMs: Math.round(avgMs),
  }
}

void events  // anchor
