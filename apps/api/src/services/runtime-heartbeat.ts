/**
 * runtime-heartbeat.ts — 24/7 liveness + uptime tracking.
 *
 * Honest scope:
 *   - In-process: tracks process uptime, last heartbeat tick, cycles run.
 *   - Persists a heartbeat event every minute so an external watchdog
 *     (or operator UI) can detect a frozen process.
 *   - Verifies learning-cron handles still exist; if they vanished
 *     (orphaned timer cleanup), re-arms them.
 *
 * Does NOT: restart the process itself (Docker `restart: unless-stopped`
 * handles that). Does NOT: claim health it can't verify.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'

interface RuntimeState {
  bootedAt:        number
  lastHeartbeatAt: number
  cyclesRun:       number
  cronStartCount:  number
  lastErrors:      Array<{ at: number; task: string; message: string }>
}

const state: RuntimeState = {
  bootedAt: Date.now(),
  lastHeartbeatAt: Date.now(),
  cyclesRun: 0,
  cronStartCount: 0,
  lastErrors: [],
}

export function getRuntimeStatus() {
  const now = Date.now()
  return {
    bootedAt:        state.bootedAt,
    uptimeMs:        now - state.bootedAt,
    uptimeHuman:     formatDuration(now - state.bootedAt),
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastHeartbeatAgoMs: now - state.lastHeartbeatAt,
    cyclesRun:       state.cyclesRun,
    cronStartCount:  state.cronStartCount,
    lastErrors:      state.lastErrors.slice(-10),
    nodeVersion:     process.version,
    pid:             process.pid,
    memoryMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s % 60}s`
}

export function recordError(task: string, message: string) {
  state.lastErrors.push({ at: Date.now(), task, message })
  if (state.lastErrors.length > 50) state.lastErrors.shift()
}

export async function heartbeat(): Promise<void> {
  state.lastHeartbeatAt = Date.now()
  state.cyclesRun++

  // Persist a heartbeat event roughly every 5 cycles (every 5min if cycle=1min)
  // Otherwise events table would grow too fast.
  if (state.cyclesRun % 5 === 0) {
    await db.insert(events).values({
      id: uuidv7(), type: 'runtime.heartbeat', workspaceId: 'global',
      payload: {
        uptimeMs: Date.now() - state.bootedAt,
        cyclesRun: state.cyclesRun,
        memoryMb: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
      },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'runtime-heartbeat', version: 1, createdAt: Date.now(),
    }).catch(() => null)
  }

  // Re-arm learning-cron if its handles vanished (e.g. someone called stop)
  try {
    const { startLearningCron, learningCronHandleCount } = await import('./learning-cron.js')
    if (learningCronHandleCount() === 0) {
      startLearningCron()
      state.cronStartCount++
    }
  } catch (e) {
    recordError('heartbeat:cron-rearm', (e as Error).message)
  }
}

let timer: NodeJS.Timeout | null = null
export function startHeartbeat(intervalMs = 60_000): void {
  if (timer) return
  // Fire once immediately so the boot is reflected
  void heartbeat()
  timer = setInterval(() => void heartbeat(), intervalMs)
  timer.unref?.()
}

export function stopHeartbeat(): void {
  if (timer) { clearInterval(timer); timer = null }
}
