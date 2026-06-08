/**
 * R358 — Local-agent telemetry & heartbeat service.
 *
 * Three concerns:
 *  1. heartbeat — agent posts every poll tick; we store last-seen timestamps
 *     and aggregate platform readiness for dashboard render.
 *  2. event — agent posts upload-success / upload-skip / driver-error events.
 *  3. failure — agent posts a screenshot + error context when a driver
 *     crashes mid-flow; persisted as a base64-encoded payload in events
 *     (no separate blob store).
 *
 * Everything lands in the existing `events` table so recap, anomaly detection,
 * and the self-improvement loop see agent activity for free.
 */
import { v7 as uuidv7 } from 'uuid'
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const SOURCE = 'local-agent'

async function insertEvent(opts: {
  workspaceId: string
  type:        string
  payload:     Record<string, unknown>
}): Promise<{ ok: true; id: string }> {
  const id    = uuidv7()
  const trace = uuidv7()
  await db.execute(sql`
    INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
    VALUES (${id}, ${opts.type}, ${opts.workspaceId}, ${JSON.stringify(opts.payload)}::jsonb,
            ${trace}, ${trace}, ${SOURCE}, 1, ${Date.now()})
  `)
  return { ok: true, id }
}

// ── heartbeat ──────────────────────────────────────────────────────────────

export interface HeartbeatInput {
  workspaceId: string
  agentId:     string                    // operator-set or generated once per profile
  platforms:   string[]                  // which platforms enabled this tick
  uploads:     number                    // uploads completed since boot
  failures:    number                    // failures since boot
  versionTag?: string                    // git short SHA or pkg version
}

export async function recordHeartbeat(input: HeartbeatInput): Promise<{ ok: true; id: string }> {
  return insertEvent({
    workspaceId: input.workspaceId,
    type:        'agent.heartbeat',
    payload: {
      agentId:    input.agentId,
      platforms:  input.platforms,
      uploads:    input.uploads,
      failures:   input.failures,
      versionTag: input.versionTag ?? 'r358',
      ts:         Date.now(),
    },
  })
}

// ── upload events ─────────────────────────────────────────────────────────

export interface UploadEventInput {
  workspaceId:  string
  agentId:      string
  platform:     string
  queueItemId:  string
  status:       'success' | 'skipped' | 'failed'
  externalUrl?: string
  reason?:      string
  durationMs?:  number
}

export async function recordUploadEvent(input: UploadEventInput): Promise<{ ok: true; id: string }> {
  return insertEvent({
    workspaceId: input.workspaceId,
    type:        `agent.upload.${input.status}`,
    payload: {
      agentId:     input.agentId,
      platform:    input.platform,
      queueItemId: input.queueItemId,
      ...(input.externalUrl ? { externalUrl: input.externalUrl } : {}),
      ...(input.reason      ? { reason:      input.reason      } : {}),
      ...(input.durationMs  ? { durationMs:  input.durationMs  } : {}),
    },
  })
}

// ── failure with screenshot ───────────────────────────────────────────────

export interface FailureReportInput {
  workspaceId:        string
  agentId:            string
  platform:           string
  queueItemId?:       string
  errorMessage:       string
  errorStack?:        string
  screenshotBase64?:  string                // PNG dataurl-less base64
  pageUrl?:           string
}

export async function recordFailureReport(input: FailureReportInput): Promise<{ ok: true; id: string }> {
  // Truncate screenshot to 500KB base64 to keep events row sane
  const MAX = 500 * 1024
  const shot = input.screenshotBase64 && input.screenshotBase64.length > MAX
    ? input.screenshotBase64.slice(0, MAX) + '__TRUNCATED__'
    : input.screenshotBase64
  return insertEvent({
    workspaceId: input.workspaceId,
    type:        'agent.failure',
    payload: {
      agentId:      input.agentId,
      platform:     input.platform,
      ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
      errorMessage: input.errorMessage,
      ...(input.errorStack  ? { errorStack:  input.errorStack.slice(0, 4000) } : {}),
      ...(shot              ? { screenshotBase64: shot } : {}),
      ...(input.pageUrl     ? { pageUrl:     input.pageUrl } : {}),
    },
  })
}

// ── account birthday lookup ───────────────────────────────────────────────

/**
 * Returns the operator-set account-creation epoch ms for a platform, or null
 * if no birthday is recorded. Used by the local agent to clamp daily velocity
 * during the 7-day account-warming window.
 *
 * Operator sets these via workspace_memory keys:
 *   account.<platform>.birthday  -> "1780820000000" (epoch ms)
 */
export async function getAccountBirthday(workspaceId: string, platform: string): Promise<number | null> {
  try {
    const rows = await db.execute(sql`
      SELECT value FROM workspace_memory
      WHERE workspace_id = ${workspaceId} AND key = ${`account.${platform}.birthday`}
      LIMIT 1
    `)
    const r = (rows as unknown as Array<{ value: string }>)[0]
    if (!r) return null
    const n = Number.parseInt(r.value, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export async function getAllAccountBirthdays(workspaceId: string): Promise<Record<string, number>> {
  try {
    const rows = await db.execute(sql`
      SELECT key, value FROM workspace_memory
      WHERE workspace_id = ${workspaceId} AND key LIKE 'account.%.birthday'
    `)
    const out: Record<string, number> = {}
    for (const r of (rows as unknown as Array<{ key: string; value: string }>)) {
      const m = r.key.match(/^account\.([^.]+)\.birthday$/)
      if (!m) continue
      const n = Number.parseInt(r.value, 10)
      if (Number.isFinite(n) && n > 0) out[m[1]!] = n
    }
    return out
  } catch {
    return {}
  }
}
