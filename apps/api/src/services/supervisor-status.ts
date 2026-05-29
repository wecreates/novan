/**
 * supervisor-status.ts — surfaces the launcher's supervisor state to
 * the API so the UI can show what's actually alive on the device.
 *
 * The launcher writes service-pids.json under .launch-logs/ on every
 * supervisor tick (~10 s). This service reads + parses that file,
 * verifies each PID is still alive (the file may be stale if the
 * launcher itself crashed), and reports a structured snapshot.
 *
 * Read-only. Restart controls live in scripts/novan.ps1 — the API
 * intentionally cannot kill its own parent supervisor.
 */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Repo root is two levels up from apps/api/dist (compiled) or apps/api/src.
// Resolve from process.cwd() instead — pnpm dev launches with cwd = apps/api.
function repoRoot(): string {
  const cwd = process.cwd()
  // Walk up looking for pnpm-workspace.yaml
  let dir = cwd
  for (let i = 0; i < 6; i++) {
    try {
      // sync check via require would be cleaner but we're in ESM
      // — we just probe with stat in the caller. For now hard-code the
      // expected relative jump (cwd is typically apps/api).
      if (dir.endsWith('apps\\api') || dir.endsWith('apps/api')) {
        return resolve(dir, '..', '..')
      }
    } catch { /* */ }
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return resolve(cwd, '..', '..')
}

export interface SupervisorChild {
  name:     string
  pid:      number | null
  alive:    boolean
  restarts: number
}

export interface SupervisorStatus {
  /** True when the supervisor has updated within the last 30 s. */
  supervisorAlive: boolean
  /** Path to the live state file (for debugging). */
  pidFilePath:     string
  /** "Last tick" age in ms. null if the file doesn't exist yet. */
  lastTickAgoMs:   number | null
  startedAt:       number | null
  children:        SupervisorChild[]
}

function processExists(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    // kill(pid, 0) doesn't actually kill — it probes for existence.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface PidFileShape {
  api?:          number
  web?:          number
  workers?:      number[]
  workerNames?:  string[]
  restartCounts?: Record<string, number>
  startedAt?:    string
  lastCheckAt?:  string
}

export async function getSupervisorStatus(): Promise<SupervisorStatus> {
  const pidFilePath = join(repoRoot(), '.launch-logs', 'service-pids.json')
  let raw: string
  try {
    raw = await readFile(pidFilePath, 'utf8')
  } catch {
    return {
      supervisorAlive: false,
      pidFilePath,
      lastTickAgoMs:   null,
      startedAt:       null,
      children:        [],
    }
  }

  // Use file mtime as a freshness signal — the supervisor rewrites
  // the file every 10 s, so anything older than ~30 s means the
  // supervisor itself stopped ticking.
  let lastTickAgoMs: number | null = null
  try {
    const s = await stat(pidFilePath)
    lastTickAgoMs = Date.now() - s.mtimeMs
  } catch { /* */ }

  let data: PidFileShape
  try { data = JSON.parse(raw) as PidFileShape }
  catch {
    return {
      supervisorAlive: false,
      pidFilePath,
      lastTickAgoMs,
      startedAt:       null,
      children:        [],
    }
  }

  const restarts = data.restartCounts ?? {}
  const children: SupervisorChild[] = []

  children.push({
    name:     'api',
    pid:      data.api ?? null,
    alive:    data.api ? processExists(data.api) : false,
    restarts: restarts['api'] ?? 0,
  })
  children.push({
    name:     'web',
    pid:      data.web ?? null,
    alive:    data.web ? processExists(data.web) : false,
    restarts: restarts['web'] ?? 0,
  })

  const workers = data.workers ?? []
  const names   = data.workerNames ?? []
  for (let i = 0; i < workers.length; i++) {
    const name = names[i] ?? `worker-${i}`
    const pid  = workers[i] ?? null
    children.push({
      name,
      pid,
      alive:    pid ? processExists(pid) : false,
      restarts: restarts[name] ?? 0,
    })
  }

  return {
    supervisorAlive: lastTickAgoMs !== null && lastTickAgoMs < 30_000,
    pidFilePath,
    lastTickAgoMs,
    startedAt:       data.startedAt ? Date.parse(data.startedAt) : null,
    children,
  }
}
