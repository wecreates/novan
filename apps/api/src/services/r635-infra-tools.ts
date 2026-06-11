/**
 * R635 — Infra tools: Ollama probe (G1), MCP marketplace (G3), backup snap (G4),
 *        migration runner (G5), feature flags (G6), workspace switcher (G7).
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

// ─── G1 Ollama health probe ─────────────────────────────────────────────────

export interface OllamaHealth {
  ok:          boolean
  baseUrl:     string
  models:      Array<{ name: string; size: number; modified: number }>
  configured:  boolean
  error?:      string
}

export async function ollamaHealth(): Promise<OllamaHealth> {
  const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://ollama:11434'
  const result: OllamaHealth = { ok: false, baseUrl, models: [], configured: !!process.env['OLLAMA_BASE_URL'] }
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    if (!r.ok) { result.error = `http ${r.status}`; return result }
    const j = await r.json().catch(() => ({})) as { models?: Array<{ name?: string; size?: number; modified_at?: string }> }
    result.ok = true
    result.models = (j.models ?? []).map(m => ({
      name:      String(m.name ?? ''),
      size:      Number(m.size ?? 0),
      modified:  m.modified_at ? Date.parse(m.modified_at) : 0,
    }))
    return result
  } catch (e) {
    result.error = (e as Error).message
    return result
  }
}

// ─── G3 MCP marketplace surface ─────────────────────────────────────────────

export interface McpEntry {
  id:           string
  name:         string
  description:  string
  category:     string
  installCommand: string
  configured:   boolean
}

const MCP_CATALOG: Array<Omit<McpEntry, 'configured'> & { envFlag?: string }> = [
  { id: 'filesystem',   name: 'Filesystem',  description: 'Read/write local files via @modelcontextprotocol/server-filesystem', category: 'core',     installCommand: 'npx -y @modelcontextprotocol/server-filesystem' },
  { id: 'github',       name: 'GitHub',      description: 'Repos / PRs / issues', category: 'dev',  installCommand: 'npx -y @modelcontextprotocol/server-github', envFlag: 'GITHUB_TOKEN' },
  { id: 'memory',       name: 'Memory',      description: 'Knowledge-graph memory', category: 'core', installCommand: 'npx -y @modelcontextprotocol/server-memory' },
  { id: 'puppeteer',    name: 'Puppeteer',   description: 'Browser automation',   category: 'web',  installCommand: 'npx -y @modelcontextprotocol/server-puppeteer' },
  { id: 'postgres',     name: 'Postgres',    description: 'Read-only Postgres queries', category: 'data', installCommand: 'npx -y @modelcontextprotocol/server-postgres', envFlag: 'DATABASE_URL' },
  { id: 'slack',        name: 'Slack',       description: 'Channels + messages',  category: 'comms', installCommand: 'npx -y @modelcontextprotocol/server-slack', envFlag: 'SLACK_BOT_TOKEN' },
  { id: 'google_drive', name: 'Google Drive',description: 'Files + folders',      category: 'data', installCommand: 'npx -y @modelcontextprotocol/server-gdrive', envFlag: 'GOOGLE_DRIVE_CREDENTIALS' },
  { id: 'sentry',       name: 'Sentry',      description: 'Error monitoring',     category: 'obs',  installCommand: 'npx -y @modelcontextprotocol/server-sentry', envFlag: 'SENTRY_AUTH_TOKEN' },
  { id: 'fetch',        name: 'Fetch',       description: 'HTTP fetch any URL',   category: 'web',  installCommand: 'npx -y @modelcontextprotocol/server-fetch' },
  { id: 'time',         name: 'Time',        description: 'Timezone conversions', category: 'core', installCommand: 'npx -y @modelcontextprotocol/server-time' },
]

export function listMcp(): { count: number; entries: McpEntry[] } {
  const entries: McpEntry[] = MCP_CATALOG.map(m => ({
    id: m.id, name: m.name, description: m.description, category: m.category, installCommand: m.installCommand,
    configured: m.envFlag ? !!process.env[m.envFlag] : true,
  }))
  return { count: entries.length, entries }
}

// ─── G4 Backup snapshot ─────────────────────────────────────────────────────

export interface BackupResult {
  ok:        boolean
  snapshotId: string
  tables:    Array<{ name: string; rows: number }>
  totalRows: number
  durationMs: number
  s3Url?:    string
  error?:    string
}

const BACKUP_TABLES = [
  'workspace_memory', 'kg_nodes', 'kg_edges', 'generated_assets',
  'rag_documents', 'rag_chunks', 'novan_inbox', 'pipelines',
  'business_revenue', 'business_portfolio', 'ab_tests',
  'r629_approvals', 'spend_caps', 'public_shares',
]

export async function snapshot(workspaceId: string): Promise<BackupResult> {
  const t0 = Date.now()
  const snapshotId = `snap-${new Date().toISOString().slice(0, 10)}-${uuidv7().slice(0, 8)}`
  const tables: BackupResult['tables'] = []
  const payload: Record<string, unknown[]> = {}
  let totalRows = 0
  for (const t of BACKUP_TABLES) {
    try {
      const r = await db.execute(sql.raw(`SELECT * FROM ${t} WHERE workspace_id = '${workspaceId.replace(/'/g, "''")}'`))
      const rows = r as unknown[]
      tables.push({ name: t, rows: rows.length })
      payload[t] = rows
      totalRows += rows.length
    } catch (e) {
      tables.push({ name: t, rows: -1 })
      void e
    }
  }
  // Optionally upload to S3 via R616 persistAsset (reuse Sigv4)
  let s3Url: string | undefined
  try {
    const { persistAsset } = await import('./r616-asset-persistence.js')
    const body = Buffer.from(JSON.stringify({ snapshotId, workspaceId, takenAt: Date.now(), data: payload }))
    const r = await persistAsset({
      workspaceId, kind: 'audio' as const,    // persistAsset has narrow kind type; use 'audio' as catch-all
      bytes: body, mime: 'application/json',
      prompt: `Backup snapshot ${snapshotId}`,
      sourceKind: 'r635-snapshot',
      metadata: { snapshotId, tables: tables.map(t => t.name), totalRows, isBackup: true },
    })
    s3Url = r.publicUrl ?? ''
  } catch { /* S3 upload optional */ }
  const result: BackupResult = { ok: true, snapshotId, tables, totalRows, durationMs: Date.now() - t0 }
  if (s3Url) result.s3Url = s3Url
  return result
}

// ─── G5 Migration runner (tracks applied SQL files) ─────────────────────────

async function ensureMigrationTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS r635_migrations (
      id          TEXT PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      sql_hash    TEXT NOT NULL,
      applied_at  BIGINT NOT NULL
    )
  `).catch(() => {})
}

export async function listMigrations(): Promise<Array<{ name: string; sqlHash: string; appliedAt: number }>> {
  await ensureMigrationTable()
  const r = await db.execute(sql`SELECT name, sql_hash, applied_at FROM r635_migrations ORDER BY applied_at DESC`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    name: String(row['name']),
    sqlHash: String(row['sql_hash']),
    appliedAt: Number(row['applied_at']),
  }))
}

export async function recordMigration(input: { name: string; sqlHash: string }): Promise<{ ok: boolean; alreadyApplied: boolean }> {
  await ensureMigrationTable()
  const existing = await db.execute(sql`SELECT name FROM r635_migrations WHERE name = ${input.name}`).catch(() => [] as unknown[])
  if ((existing as unknown[]).length > 0) return { ok: true, alreadyApplied: true }
  await db.execute(sql`INSERT INTO r635_migrations (id, name, sql_hash, applied_at) VALUES (${uuidv7()}, ${input.name}, ${input.sqlHash}, ${Date.now()})`).catch(() => {})
  return { ok: true, alreadyApplied: false }
}

// ─── G6 Feature flags ───────────────────────────────────────────────────────

async function ensureFlagsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS feature_flags (
      workspace_id TEXT NOT NULL,
      flag         TEXT NOT NULL,
      enabled      BOOLEAN NOT NULL DEFAULT false,
      value        JSONB,
      updated_at   BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, flag)
    )
  `).catch(() => {})
}

export async function flagSet(workspaceId: string, input: { flag: string; enabled: boolean; value?: unknown }): Promise<{ ok: boolean }> {
  await ensureFlagsTable()
  if (!input.flag?.trim()) throw new Error('flag required')
  await db.execute(sql`
    INSERT INTO feature_flags (workspace_id, flag, enabled, value, updated_at)
    VALUES (${workspaceId}, ${input.flag}, ${input.enabled}, ${input.value !== undefined ? sql`${JSON.stringify(input.value)}::jsonb` : sql`NULL`}, ${Date.now()})
    ON CONFLICT (workspace_id, flag) DO UPDATE SET
      enabled = EXCLUDED.enabled, value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `)
  return { ok: true }
}

export async function flagGet(workspaceId: string, flag: string): Promise<{ enabled: boolean; value: unknown | null }> {
  await ensureFlagsTable()
  const r = await db.execute(sql`SELECT enabled, value FROM feature_flags WHERE workspace_id = ${workspaceId} AND flag = ${flag}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return { enabled: false, value: null }
  return { enabled: Boolean(row['enabled']), value: row['value'] ?? null }
}

export async function flagList(workspaceId: string): Promise<Array<{ flag: string; enabled: boolean; value: unknown; updatedAt: number }>> {
  await ensureFlagsTable()
  const r = await db.execute(sql`SELECT flag, enabled, value, updated_at FROM feature_flags WHERE workspace_id = ${workspaceId} ORDER BY flag`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    flag: String(row['flag']), enabled: Boolean(row['enabled']),
    value: row['value'] ?? null, updatedAt: Number(row['updated_at'] ?? 0),
  }))
}

// ─── G7 Multi-workspace switcher ────────────────────────────────────────────

export async function listWorkspaces(): Promise<Array<{ workspaceId: string; assets: number; memories: number; lastActivity: number }>> {
  // Best-effort: derive from existing rows
  const r = await db.execute(sql`
    SELECT
      workspace_id AS workspaceid,
      MAX(updated_at) AS last_activity
    FROM workspace_memory GROUP BY workspace_id
  `).catch(() => [] as unknown[])
  const memMap = new Map<string, number>()
  for (const row of r as Array<Record<string, unknown>>) memMap.set(String(row['workspaceid']), Number(row['last_activity'] ?? 0))

  const assetR = await db.execute(sql`SELECT workspace_id, count(*)::int AS n FROM generated_assets GROUP BY workspace_id`).catch(() => [] as unknown[])
  const assetMap = new Map<string, number>()
  for (const row of assetR as Array<Record<string, unknown>>) assetMap.set(String(row['workspace_id']), Number(row['n']))

  const memCountR = await db.execute(sql`SELECT workspace_id, count(*)::int AS n FROM workspace_memory GROUP BY workspace_id`).catch(() => [] as unknown[])
  const memCount = new Map<string, number>()
  for (const row of memCountR as Array<Record<string, unknown>>) memCount.set(String(row['workspace_id']), Number(row['n']))

  const all = new Set<string>([...memMap.keys(), ...assetMap.keys(), ...memCount.keys()])
  return [...all].map(ws => ({
    workspaceId: ws,
    assets:       assetMap.get(ws) ?? 0,
    memories:     memCount.get(ws) ?? 0,
    lastActivity: memMap.get(ws) ?? 0,
  })).sort((a, b) => b.lastActivity - a.lastActivity)
}
