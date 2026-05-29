/**
 * external-watchdog.ts — Tier-3: best-effort liveness watchdog.
 *
 * Honest scope: this is IN-PROCESS. It self-pings the runtime status
 * endpoint over the loopback. If the API event loop is fully hung, this
 * cron won't fire — Docker healthcheck + `restart: unless-stopped`
 * remain the ultimate safety net.
 *
 * What it DOES catch: stale heartbeats (>5min old) → emits an alert
 * via notify() so an operator's Slack/Discord/Pushover lights up.
 *
 * For true external watchdogging, run a separate uptime monitor
 * (UptimeRobot / BetterUptime) against /healthz. This cron is a
 * cheap second line of defense.
 */
import { getRuntimeStatus } from './runtime-heartbeat.js'
import { notify } from './notifications.js'

const STALE_THRESHOLD_MS = 5 * 60_000

export async function watchdogTick(): Promise<{ liveness: 'live' | 'stale'; alertedAt?: number }> {
  const s = getRuntimeStatus()
  const liveness = s.lastHeartbeatAgoMs < STALE_THRESHOLD_MS ? 'live' : 'stale'
  if (liveness === 'stale') {
    await notify({
      workspaceId: 'global',
      type: 'runtime.heartbeat_stale',
      title: 'Runtime heartbeat stale',
      body: `Last heartbeat ${Math.floor(s.lastHeartbeatAgoMs / 1000)}s ago. Crons active: ${(await import('./learning-cron.js')).learningCronHandleCount()}. Uptime: ${s.uptimeHuman}.`,
      severity: 'critical',
      signature: `watchdog:stale:${Math.floor(s.lastHeartbeatAgoMs / 60_000)}`,
    }).catch((e: Error) => { console.error('[external-watchdog]', e.message); return null })
    return { liveness, alertedAt: Date.now() }
  }
  return { liveness }
}
