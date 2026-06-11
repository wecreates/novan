/**
 * R647d — Computer-use bridge.
 *
 * `desktop.act(goal)` enqueues a high-level goal into a job table the R357
 * novan-local-agent picks up via long-poll. The agent (Electron + Playwright +
 * Windows-MCP equivalent on the operator's machine) executes screenshot →
 * reason → act loops locally. We never run computer-control from the droplet.
 *
 * On the API side this round adds:
 *   - r647_desktop_jobs table
 *   - desktop.act       — enqueue a goal
 *   - desktop.list      — list recent jobs
 *   - desktop.next      — agent pulls next pending job (idempotent claim)
 *   - desktop.complete  — agent reports result (success | failure | partial)
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'
import crypto from 'crypto'

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r647_desktop_jobs (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        goal          TEXT NOT NULL,
        context       JSONB,
        status        TEXT NOT NULL DEFAULT 'pending',
        agent_id      TEXT,
        result        JSONB,
        error         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        claimed_at    TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ
      )
    `).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r647_desktop_jobs_status_idx ON r647_desktop_jobs (status, created_at)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export interface DesktopJob {
  id:           string
  workspaceId:  string
  goal:         string
  context?:     Record<string, unknown>
  status:       'pending' | 'claimed' | 'done' | 'failed' | 'partial'
  agentId?:     string
  result?:      unknown
  error?:       string
  createdAt:    string
  claimedAt?:   string
  completedAt?: string
}

function rowToJob(r: Record<string, unknown>): DesktopJob {
  const j: DesktopJob = {
    id:          String(r['id']),
    workspaceId: String(r['workspace_id']),
    goal:        String(r['goal']),
    status:      (r['status'] as DesktopJob['status']) ?? 'pending',
    createdAt:   String(r['created_at']),
  }
  if (r['context'])      j.context     = r['context'] as Record<string, unknown>
  if (r['agent_id'])     j.agentId     = String(r['agent_id'])
  if (r['result'])       j.result      = r['result']
  if (r['error'])        j.error       = String(r['error'])
  if (r['claimed_at'])   j.claimedAt   = String(r['claimed_at'])
  if (r['completed_at']) j.completedAt = String(r['completed_at'])
  return j
}

export async function enqueueDesktop(workspaceId: string, goal: string, context?: Record<string, unknown>): Promise<DesktopJob> {
  await ensureDdl()
  const id = `dsk_${crypto.randomBytes(8).toString('hex')}`
  try {
    await db.execute(sql`
      INSERT INTO r647_desktop_jobs (id, workspace_id, goal, context, status)
      VALUES (${id}, ${workspaceId}, ${goal}, ${context ? JSON.stringify(context) : null}::jsonb, 'pending')
    `)
  } catch { /* tolerated */ }
  const job: DesktopJob = {
    id, workspaceId, goal, status: 'pending', createdAt: new Date().toISOString(),
  }
  if (context) job.context = context
  return job
}

export async function listDesktopJobs(workspaceId: string, limit = 50): Promise<DesktopJob[]> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT * FROM r647_desktop_jobs
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC LIMIT ${limit}
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(rowToJob)
  } catch { return [] }
}

export async function claimNextDesktopJob(workspaceId: string, agentId: string): Promise<DesktopJob | null> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      WITH picked AS (
        SELECT id FROM r647_desktop_jobs
        WHERE workspace_id = ${workspaceId} AND status = 'pending'
        ORDER BY created_at ASC LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE r647_desktop_jobs SET status = 'claimed', agent_id = ${agentId}, claimed_at = now()
      WHERE id IN (SELECT id FROM picked)
      RETURNING *
    `)
    const row = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    return row ? rowToJob(row) : null
  } catch { return null }
}

export async function completeDesktopJob(workspaceId: string, jobId: string, outcome: { status: 'done' | 'failed' | 'partial'; result?: unknown; error?: string }): Promise<{ ok: boolean }> {
  await ensureDdl()
  try {
    await db.execute(sql`
      UPDATE r647_desktop_jobs
      SET status = ${outcome.status},
          result = ${outcome.result != null ? JSON.stringify(outcome.result) : null}::jsonb,
          error  = ${outcome.error ?? null},
          completed_at = now()
      WHERE id = ${jobId} AND workspace_id = ${workspaceId}
    `)
    return { ok: true }
  } catch (e) { return { ok: false } }
}

export async function renderDesktopHtml(workspaceId: string): Promise<string> {
  const jobs = await listDesktopJobs(workspaceId, 100)
  const counts: Record<string, number> = {}
  for (const j of jobs) counts[j.status] = (counts[j.status] ?? 0) + 1
  const rows = jobs.map(j => `
    <tr>
      <td><code>${j.id.slice(0, 12)}</code></td>
      <td>${j.status}</td>
      <td>${escapeHtml(j.goal.slice(0, 120))}</td>
      <td>${j.agentId ?? ''}</td>
      <td>${j.createdAt.slice(0, 16)}</td>
      <td>${j.completedAt?.slice(0, 16) ?? ''}</td>
      <td>${j.error ? escapeHtml(j.error.slice(0, 80)) : ''}</td>
    </tr>`).join('')
  return `<!doctype html><html><head><title>R647 desktop jobs</title>
    <style>body{font:14px system-ui;max-width:1200px;margin:2rem auto;padding:1rem}
    table{width:100%;border-collapse:collapse}th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;font-size:13px}
    th{background:#f7f7f7}.s{font:13px monospace;color:#555}</style></head>
    <body><h1>R647 desktop jobs (computer-use bridge)</h1>
    <p class="s">${jobs.length} jobs · ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
    <!-- R647d -->
    <table><thead><tr><th>id</th><th>status</th><th>goal</th><th>agent</th><th>created</th><th>completed</th><th>error</th></tr></thead>
    <tbody>${rows}</tbody></table></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
