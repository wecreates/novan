/**
 * gui-queue.ts — queue Windows-only GUI ops to be picked up by a
 * Windows worker bridge, so the cloud API can run 24/7 without a
 * laptop online.
 *
 * Flow:
 *   1. Cloud API receives capcut.assemble / mixcraft.compose /
 *      music.generate (ACE-Step) request.
 *   2. If process.platform !== 'win32' OR NOVAN_GUI_REMOTE=1,
 *      enqueueGuiJob() writes a row to the `gui_queue` table and
 *      returns a job id immediately.
 *   3. A Windows-bridge process (apps/windows-bridge) on the operator's
 *      always-on PC polls pullPendingJob() over the API, executes the
 *      job locally via the real controllers, posts the result back
 *      via completeGuiJob().
 *   4. The original brain-task op resolves either:
 *        a. synchronously if a bridge is connected + responded in time, or
 *        b. with a pending status + the job id so the operator/UI can
 *           poll later.
 *
 * The table is created lazily on first enqueue so we don't need a
 * schema migration for this to work.
 */

import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

let _tableEnsured = false
async function ensureTable(): Promise<void> {
  if (_tableEnsured) return
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gui_queue (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      op            TEXT NOT NULL,
      params        JSONB NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      result        JSONB,
      error         TEXT,
      bridge_id     TEXT,
      claimed_at    BIGINT,
      created_at    BIGINT NOT NULL,
      completed_at  BIGINT
    )
  `)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gui_queue_status_idx  ON gui_queue (status, created_at)`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gui_queue_ws_idx      ON gui_queue (workspace_id, created_at DESC)`)
  _tableEnsured = true
}

export type GuiJobStatus = 'pending' | 'claimed' | 'completed' | 'failed'

export interface GuiJob {
  id:          string
  workspaceId: string
  op:          string
  params:      Record<string, unknown>
  status:      GuiJobStatus
  result?:     Record<string, unknown>
  error?:      string
  bridgeId?:   string
  claimedAt?:  number
  createdAt:   number
  completedAt?: number
}

export async function enqueueGuiJob(workspaceId: string, op: string, params: Record<string, unknown>): Promise<string> {
  await ensureTable()
  const id = randomUUID()
  await db.execute(sql`
    INSERT INTO gui_queue (id, workspace_id, op, params, status, created_at)
    VALUES (${id}, ${workspaceId}, ${op}, ${JSON.stringify(params)}::jsonb, 'pending', ${Date.now()})
  `)
  return id
}

/**
 * Bridge calls this to claim the oldest pending job for an op family
 * (e.g. 'capcut.*' or 'mixcraft.*' or 'music.*'). Atomic claim via
 * UPDATE … RETURNING to prevent two bridges grabbing the same row.
 */
export async function claimNextJob(bridgeId: string, opPrefix: string): Promise<GuiJob | null> {
  await ensureTable()
  const now = Date.now()
  const rows = await db.execute(sql`
    UPDATE gui_queue
    SET status = 'claimed', bridge_id = ${bridgeId}, claimed_at = ${now}
    WHERE id = (
      SELECT id FROM gui_queue
      WHERE status = 'pending' AND op LIKE ${opPrefix + '%'}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, workspace_id, op, params, status, created_at
  `)
  const row = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
  if (!row) return null
  return {
    id:          String(row['id']),
    workspaceId: String(row['workspace_id']),
    op:          String(row['op']),
    params:      row['params'] as Record<string, unknown>,
    status:      'claimed',
    bridgeId,
    claimedAt:   now,
    createdAt:   Number(row['created_at']),
  }
}

export async function completeGuiJob(id: string, ok: boolean, result?: Record<string, unknown>, error?: string): Promise<void> {
  await ensureTable()
  await db.execute(sql`
    UPDATE gui_queue
    SET status = ${ok ? 'completed' : 'failed'},
        result = ${result ? JSON.stringify(result) : null}::jsonb,
        error  = ${error ?? null},
        completed_at = ${Date.now()}
    WHERE id = ${id}
  `)
}

export async function getGuiJob(id: string): Promise<GuiJob | null> {
  await ensureTable()
  const rows = await db.execute(sql`SELECT * FROM gui_queue WHERE id = ${id} LIMIT 1`)
  const row = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
  if (!row) return null
  const out: GuiJob = {
    id: String(row['id']),
    workspaceId: String(row['workspace_id']),
    op: String(row['op']),
    params: row['params'] as Record<string, unknown>,
    status: row['status'] as GuiJobStatus,
    createdAt: Number(row['created_at']),
  }
  if (row['result'])       out.result      = row['result'] as Record<string, unknown>
  if (row['error'])        out.error       = String(row['error'])
  if (row['bridge_id'])    out.bridgeId    = String(row['bridge_id'])
  if (row['claimed_at'])   out.claimedAt   = Number(row['claimed_at'])
  if (row['completed_at']) out.completedAt = Number(row['completed_at'])
  return out
}

/**
 * Synchronous wait — used by the calling op to optionally block on
 * the bridge result so the caller still gets the answer in one shot
 * when the bridge is online. Falls back to returning pending if the
 * timeout expires.
 *
 * Default timeout is short (5 min) so request threads don't hog on
 * a missing bridge. Long-running ops should pass an explicit timeout
 * OR use `enqueueGuiJob` directly and poll via `getGuiJob` separately.
 */
export async function awaitGuiJob(id: string, timeoutMs = 5 * 60_000, pollMs = 2000): Promise<GuiJob> {
  const deadline = Date.now() + timeoutMs
  // Fast-fail if no bridge is alive — saves the operator from a 5-min
  // hang when they know the Windows box is off.
  try {
    const st = await bridgeStatus()
    if (!st.active && st.pendingJobs > 3) {
      // Bridge offline + backlog growing → don't even wait; return pending.
      const j = await getGuiJob(id)
      return j ?? { id, workspaceId: '', op: '', params: {}, status: 'pending', createdAt: 0 }
    }
  } catch { /* */ }
  while (Date.now() < deadline) {
    const j = await getGuiJob(id)
    if (j && (j.status === 'completed' || j.status === 'failed')) return j
    await new Promise(r => setTimeout(r, pollMs))
  }
  const j = await getGuiJob(id)
  return j ?? { id, workspaceId: '', op: '', params: {}, status: 'pending', createdAt: 0 }
}

export async function listGuiJobs(workspaceId?: string, status?: GuiJobStatus, limit = 50): Promise<GuiJob[]> {
  await ensureTable()
  const whereWs = workspaceId ? sql`workspace_id = ${workspaceId}` : sql`TRUE`
  const whereSt = status      ? sql`status = ${status}`             : sql`TRUE`
  const rows = await db.execute(sql`
    SELECT id, workspace_id, op, params, status, result, error, bridge_id, claimed_at, created_at, completed_at
    FROM gui_queue
    WHERE ${whereWs} AND ${whereSt}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)
  const list = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []
  return list.map(r => {
    const out: GuiJob = {
      id: String(r['id']), workspaceId: String(r['workspace_id']),
      op: String(r['op']), params: r['params'] as Record<string, unknown>,
      status: r['status'] as GuiJobStatus, createdAt: Number(r['created_at']),
    }
    if (r['result'])       out.result      = r['result'] as Record<string, unknown>
    if (r['error'])        out.error       = String(r['error'])
    if (r['bridge_id'])    out.bridgeId    = String(r['bridge_id'])
    if (r['claimed_at'])   out.claimedAt   = Number(r['claimed_at'])
    if (r['completed_at']) out.completedAt = Number(r['completed_at'])
    return out
  })
}

/** True if we should route GUI ops through the queue instead of running locally. */
export function shouldRouteToQueue(): boolean {
  return process.platform !== 'win32' || process.env['NOVAN_GUI_REMOTE'] === '1'
}

// DB-backed bridge heartbeat — survives restart + multi-instance API.
// Previously: in-memory Map, restart = lost liveness signal.
let _heartbeatsEnsured = false
async function ensureHeartbeats(): Promise<void> {
  if (_heartbeatsEnsured) return
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bridge_heartbeats (
      bridge_id TEXT PRIMARY KEY,
      last_seen_at BIGINT NOT NULL
    )`)
  _heartbeatsEnsured = true
}

// In-memory cache for fast bridgeStatus() reads (5-sec TTL)
const _heartbeatCache = new Map<string, number>()
let _heartbeatCacheAt = 0

/** Bridge calls this every poll cycle to prove it's alive even when idle. */
export async function recordBridgeHeartbeat(bridgeId: string): Promise<void> {
  await ensureHeartbeats()
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO bridge_heartbeats (bridge_id, last_seen_at)
    VALUES (${bridgeId}, ${now})
    ON CONFLICT (bridge_id) DO UPDATE SET last_seen_at = ${now}`)
  _heartbeatCache.set(bridgeId, now)
}

/** Liveness — bridge is active if any heartbeat in last 30s OR job
 *  claimed in last 5 min. Catches both busy and idle-but-online bridges.
 *  Now DB-backed so multi-instance API sees the same liveness state. */
export async function bridgeStatus(): Promise<{ active: boolean; lastSeenMs?: number; pendingJobs: number; bridges: string[] }> {
  await ensureTable()
  await ensureHeartbeats()
  const r1 = await db.execute(sql`SELECT MAX(claimed_at) AS last FROM gui_queue WHERE claimed_at IS NOT NULL`)
  const r2 = await db.execute(sql`SELECT COUNT(*)::int AS n FROM gui_queue WHERE status = 'pending'`)
  const lastClaim = Number(((r1 as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]?.['last']) ?? 0)
  const pending = Number(((r2 as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]?.['n']) ?? 0)

  // Refresh heartbeat cache every 5s
  if (Date.now() - _heartbeatCacheAt > 5_000) {
    _heartbeatCache.clear()
    try {
      const hb = await db.execute(sql`SELECT bridge_id, last_seen_at FROM bridge_heartbeats WHERE last_seen_at > ${Date.now() - 3_600_000}`)
      const rows = (hb as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []
      for (const r of rows) _heartbeatCache.set(String(r['bridge_id']), Number(r['last_seen_at']))
    } catch { /* */ }
    _heartbeatCacheAt = Date.now()
  }

  let mostRecentHeartbeat = 0
  const liveBridges: string[] = []
  for (const [id, ts] of _heartbeatCache) {
    if (Date.now() - ts < 30_000) liveBridges.push(id)
    if (ts > mostRecentHeartbeat) mostRecentHeartbeat = ts
  }
  const lastSeen = Math.max(lastClaim, mostRecentHeartbeat)
  const out: { active: boolean; lastSeenMs?: number; pendingJobs: number; bridges: string[] } = {
    active: liveBridges.length > 0 || (lastClaim > 0 && Date.now() - lastClaim < 5 * 60_000),
    pendingJobs: pending,
    bridges: liveBridges,
  }
  if (lastSeen > 0) out.lastSeenMs = Date.now() - lastSeen
  return out
}
