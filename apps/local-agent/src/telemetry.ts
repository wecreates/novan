/**
 * R358 — Telemetry client. Posts heartbeat, upload events, and failure
 * reports to the droplet via brain-task ops.
 *
 * All calls are best-effort — telemetry never throws or blocks the upload
 * loop. Operator sees telemetry gaps as the dashboard signal.
 */
import type { AgentConfig } from './config.js'

const VERSION_TAG = 'r358'

async function safeBrainTask(cfg: AgentConfig, op: string, params: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ workspace_id: cfg.workspaceId, plan: [{ op, params }] }),
    })
    if (!res.ok) console.warn(`[telemetry] ${op} non-2xx: ${res.status}`)
  } catch (e) {
    console.warn(`[telemetry] ${op} threw: ${(e as Error).message}`)
  }
}

export interface SessionCounters {
  uploads:  number
  failures: number
}

export async function postHeartbeat(cfg: AgentConfig, agentId: string, platforms: string[], counters: SessionCounters): Promise<void> {
  await safeBrainTask(cfg, 'agent.heartbeat', {
    agentId, platforms,
    uploads:    counters.uploads,
    failures:   counters.failures,
    versionTag: VERSION_TAG,
  })
}

export async function postUploadEvent(cfg: AgentConfig, agentId: string, opts: {
  platform:     string
  queueItemId:  string
  status:       'success' | 'skipped' | 'failed'
  externalUrl?: string
  reason?:      string
  durationMs?:  number
}): Promise<void> {
  await safeBrainTask(cfg, 'agent.report_event', { agentId, ...opts })
}

export async function postFailureReport(cfg: AgentConfig, agentId: string, opts: {
  platform:           string
  queueItemId?:       string
  errorMessage:       string
  errorStack?:        string
  screenshotBase64?:  string
  pageUrl?:           string
}): Promise<void> {
  await safeBrainTask(cfg, 'agent.report_failure', { agentId, ...opts })
}
