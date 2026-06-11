/**
 * R620 — Desktop action queue (Manus/Claude-Computer-Use parity).
 *
 * The droplet can't drive operator's desktop directly (no GUI). The
 * already-shipped R357 novan-local-agent (Electron + Playwright) polls
 * a queue and executes jobs locally. R620 adds a `desktop_action_queue`
 * for **non-browser** desktop actions (Photoshop, Affinity, file
 * operations, Notion app, anything Windows-MCP can reach).
 *
 * Brain ops:
 *   - desktop.enqueue   — queue an action; returns id
 *   - desktop.list      — list pending / recent
 *   - desktop.claim     — local agent atomically claims next job
 *   - desktop.complete  — local agent reports result
 *   - desktop.cancel    — operator can drop a stuck job
 *
 * Schema is deliberately permissive (jsonb payload, jsonb result) so
 * adding new action kinds doesn't require migrations.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

const VALID_KINDS = new Set([
  'desktop.open_app',         // open Photoshop / Affinity / etc.
  'desktop.run_script',       // run a .ps1 / .bat with allowlist
  'desktop.export_file',      // read a file from operator's machine + upload to S3
  'desktop.screenshot',       // capture screen + upload to S3
  'desktop.click_sequence',   // generic UI automation via Windows-MCP
  'desktop.notify',           // toast notification on operator's desktop
])

export type DesktopJobStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled'

export interface DesktopJob {
  id:           string
  workspaceId:  string
  kind:         string
  brief:        string
  params:       Record<string, unknown>
  status:       DesktopJobStatus
  attempts:     number
  maxAttempts:  number
  createdAt:    number
  claimedAt?:   number
  claimedBy?:   string
  completedAt?: number
  result?:      Record<string, unknown>
  error?:       string
}

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS desktop_action_queue (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      kind          TEXT NOT NULL,
      brief         TEXT NOT NULL,
      params        JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'pending',
      attempts      INTEGER NOT NULL DEFAULT 0,
      max_attempts  INTEGER NOT NULL DEFAULT 3,
      created_at    BIGINT NOT NULL,
      claimed_at    BIGINT,
      claimed_by    TEXT,
      completed_at  BIGINT,
      result        JSONB,
      error         TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS desktop_q_ws_status_idx ON desktop_action_queue (workspace_id, status, created_at)`).catch(() => {})
}

function rowToJob(r: Record<string, unknown>): DesktopJob {
  const job: DesktopJob = {
    id:          String(r['id']),
    workspaceId: String(r['workspace_id']),
    kind:        String(r['kind']),
    brief:       String(r['brief']),
    params:      (r['params'] as Record<string, unknown>) ?? {},
    status:      String(r['status']) as DesktopJobStatus,
    attempts:    Number(r['attempts'] ?? 0),
    maxAttempts: Number(r['max_attempts'] ?? 3),
    createdAt:   Number(r['created_at']),
  }
  if (r['claimed_at'] != null) job.claimedAt = Number(r['claimed_at'])
  if (r['claimed_by'] != null) job.claimedBy = String(r['claimed_by'])
  if (r['completed_at'] != null) job.completedAt = Number(r['completed_at'])
  if (r['result'] != null) job.result = r['result'] as Record<string, unknown>
  if (r['error'] != null) job.error = String(r['error'])
  return job
}

export interface EnqueueInput {
  kind:  string
  brief: string
  params?: Record<string, unknown>
  maxAttempts?: number
}

export async function enqueue(workspaceId: string, input: EnqueueInput): Promise<{ id: string }> {
  await ensureTable()
  if (!VALID_KINDS.has(input.kind)) throw new Error(`unknown kind: ${input.kind} (allowed: ${[...VALID_KINDS].join(', ')})`)
  if (!input.brief?.trim()) throw new Error('brief required')
  const id = uuidv7()
  await db.execute(sql`
    INSERT INTO desktop_action_queue (id, workspace_id, kind, brief, params, max_attempts, created_at)
    VALUES (${id}, ${workspaceId}, ${input.kind}, ${input.brief}, ${JSON.stringify(input.params ?? {})}::jsonb,
            ${Math.max(1, Math.min(10, input.maxAttempts ?? 3))}, ${Date.now()})
  `)
  return { id }
}

export async function listJobs(workspaceId: string, opts: { status?: DesktopJobStatus; limit?: number } = {}): Promise<DesktopJob[]> {
  await ensureTable()
  const lim = Math.max(1, Math.min(100, opts.limit ?? 30))
  const r = opts.status
    ? await db.execute(sql`SELECT * FROM desktop_action_queue WHERE workspace_id = ${workspaceId} AND status = ${opts.status} ORDER BY created_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
    : await db.execute(sql`SELECT * FROM desktop_action_queue WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(rowToJob)
}

/** Local agent calls this to atomically grab next job. SKIP LOCKED prevents two agents racing. */
export async function claimNext(workspaceId: string, claimedBy: string): Promise<DesktopJob | null> {
  await ensureTable()
  const now = Date.now()
  const r = await db.execute(sql`
    WITH picked AS (
      SELECT id FROM desktop_action_queue
      WHERE workspace_id = ${workspaceId} AND status = 'pending' AND attempts < max_attempts
      ORDER BY created_at LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE desktop_action_queue SET status = 'claimed', claimed_at = ${now}, claimed_by = ${claimedBy}, attempts = attempts + 1
    WHERE id IN (SELECT id FROM picked)
    RETURNING *
  `).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  return row ? rowToJob(row) : null
}

export interface CompleteInput {
  id:       string
  ok:       boolean
  result?:  Record<string, unknown>
  error?:   string
}

export async function complete(workspaceId: string, input: CompleteInput): Promise<{ ok: boolean }> {
  await ensureTable()
  const status: DesktopJobStatus = input.ok ? 'done' : 'failed'
  await db.execute(sql`
    UPDATE desktop_action_queue
    SET status = ${status}, completed_at = ${Date.now()},
        result = ${input.result ? sql`${JSON.stringify(input.result)}::jsonb` : sql`NULL`},
        error  = ${input.error ?? null}
    WHERE id = ${input.id} AND workspace_id = ${workspaceId}
  `).catch(() => {})
  return { ok: true }
}

export async function cancel(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await ensureTable()
  await db.execute(sql`
    UPDATE desktop_action_queue
    SET status = 'cancelled', completed_at = ${Date.now()}
    WHERE id = ${id} AND workspace_id = ${workspaceId} AND status IN ('pending','claimed')
  `).catch(() => {})
  return { ok: true }
}

export async function stats(workspaceId: string): Promise<{ pending: number; claimed: number; done24h: number; failed24h: number; cancelled24h: number }> {
  await ensureTable()
  const day = Date.now() - 24 * 60 * 60_000
  const r = await db.execute(sql`
    SELECT
      sum(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END)::int AS pending,
      sum(CASE WHEN status = 'claimed'   THEN 1 ELSE 0 END)::int AS claimed,
      sum(CASE WHEN status = 'done'      AND completed_at > ${day} THEN 1 ELSE 0 END)::int AS done24h,
      sum(CASE WHEN status = 'failed'    AND completed_at > ${day} THEN 1 ELSE 0 END)::int AS failed24h,
      sum(CASE WHEN status = 'cancelled' AND completed_at > ${day} THEN 1 ELSE 0 END)::int AS cancelled24h
    FROM desktop_action_queue WHERE workspace_id = ${workspaceId}
  `).catch(() => [{ pending: 0, claimed: 0, done24h: 0, failed24h: 0, cancelled24h: 0 }] as unknown[])
  const row = (r as Array<Record<string, number | null>>)[0] ?? {}
  return {
    pending:      Number(row['pending']      ?? 0),
    claimed:      Number(row['claimed']      ?? 0),
    done24h:      Number(row['done24h']      ?? 0),
    failed24h:    Number(row['failed24h']    ?? 0),
    cancelled24h: Number(row['cancelled24h'] ?? 0),
  }
}
