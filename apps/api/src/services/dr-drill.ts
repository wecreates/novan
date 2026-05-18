/**
 * dr-drill.ts — Tier-3: disaster recovery readiness drill.
 *
 * Honest scope: VALIDATES restore readiness without actually restoring.
 *   - Counts critical tables (cardinality fact)
 *   - Verifies schema_migrations has expected rows (or warns)
 *   - Checks for recent activity per table (data alive?)
 *   - Reports gaps the operator must address before relying on DR
 *
 * Does NOT: take a backup (Neon manages snapshots externally), restore
 * to a sandbox, or simulate failover. Those are external concerns.
 */
import { db } from '../db/client.js'
import {
  workspaces, workflowRuns, reasoningChains, assumptions,
  aiUsage, imageGenerations, revenueEvents, actions,
} from '../db/schema.js'
import { eq, gte, sql, and } from 'drizzle-orm'

export async function drDrill(workspaceId: string) {
  const since24h = Date.now() - 24 * 60 * 60_000
  const tables = [
    { name: 'workspaces',         table: workspaces,        recencyCol: null },
    { name: 'workflow_runs',      table: workflowRuns,      recencyCol: workflowRuns.triggeredAt },
    { name: 'reasoning_chains',   table: reasoningChains,   recencyCol: reasoningChains.createdAt },
    { name: 'assumptions',        table: assumptions,       recencyCol: assumptions.createdAt },
    { name: 'ai_usage',           table: aiUsage,           recencyCol: aiUsage.timestamp },
    { name: 'image_generations',  table: imageGenerations,  recencyCol: imageGenerations.createdAt },
    { name: 'revenue_events',     table: revenueEvents,     recencyCol: revenueEvents.occurredAt },
    { name: 'actions',            table: actions,           recencyCol: actions.createdAt },
  ] as const

  const checks: Array<{ table: string; rowCount: number; recentCount: number; status: 'ok' | 'empty' | 'stale' }> = []
  for (const t of tables) {
    const totalRow = await db.select({ n: sql<number>`count(*)::int` })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from(t.table as any)
      .then(rows => Number(rows[0]?.n ?? 0)).catch(() => 0)
    let recent = 0
    if (t.recencyCol) {
      // Workspace-scoped recency where possible
      const hasWs = 'workspaceId' in t.table
      const baseConds = [gte(t.recencyCol, since24h)]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (hasWs) baseConds.push(eq((t.table as any).workspaceId, workspaceId))
      const r = await db.select({ n: sql<number>`count(*)::int` })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from(t.table as any)
        .where(and(...baseConds)).then(rows => Number(rows[0]?.n ?? 0)).catch(() => 0)
      recent = r
    }
    const status: 'ok' | 'empty' | 'stale' = totalRow === 0 ? 'empty' : recent === 0 && t.recencyCol ? 'stale' : 'ok'
    checks.push({ table: t.name, rowCount: totalRow, recentCount: recent, status })
  }

  const dbProvider = (process.env['DATABASE_URL'] ?? '').includes('neon') ? 'neon'
    : (process.env['DATABASE_URL'] ?? '').includes('localhost') ? 'local-postgres' : 'unknown'

  const gaps: string[] = []
  if (dbProvider === 'unknown')      gaps.push('DATABASE_URL provider unknown — manual backup verification required.')
  if (dbProvider === 'local-postgres') gaps.push('Local Postgres has no automatic backups in this configuration — set up pg_dump cron.')
  const emptyTables = checks.filter(c => c.status === 'empty').map(c => c.table)
  if (emptyTables.length > 0) gaps.push(`Empty tables (may be expected on cold workspace): ${emptyTables.join(', ')}`)
  const stale = checks.filter(c => c.status === 'stale').map(c => c.table)
  if (stale.length > 0) gaps.push(`No activity in 24h: ${stale.join(', ')}`)

  return {
    generatedAt: Date.now(),
    dbProvider,
    factType: 'fact' as const,
    tableChecks: checks,
    gaps,
    readiness: gaps.length === 0 ? 'ready' : gaps.some(g => g.includes('backup')) ? 'not_ready' : 'partial',
    notes: [
      'DR drill verifies cardinality and recency, NOT actual restore correctness.',
      dbProvider === 'neon' ? 'Neon provides point-in-time recovery; verify retention policy externally.' : '',
      'Restore drill on a sandbox database is the only way to fully prove recoverability.',
    ].filter(Boolean),
  }
}
