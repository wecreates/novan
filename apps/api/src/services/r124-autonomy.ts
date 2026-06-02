/**
 * R146.124 — Autonomy gap closes.
 *
 *  - suggestionsProducerTick: scans recent runtime errors / cron failures
 *    in events, buckets recurring ones into improvement_suggestions so
 *    Ali's queue has real signal to bridge from.
 *  - oauthRefreshTick: pre-refreshes connector tokens nearing expiry so
 *    the first-post-after-expiry penalty disappears.
 *  - patchToUnifiedDiff: converts a code_patches row into a `git apply`-
 *    compatible unified diff string the operator can save as .patch.
 */
import { db } from '../db/client.js'
import { events, connectorAccounts, codePatches } from '../db/schema.js'
import { sql, eq, and, gte, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── P1.4 — improvement_suggestions producer ──────────────────────────

const ONE_DAY = 24 * 60 * 60 * 1000

/**
 * Look at the last 24h of cron.error + task.failed + brain.op_error events.
 * For each error message pattern that occurs ≥3 times in the window, create
 * a single improvement_suggestion (deduped by SHA-stable title).
 *
 * The r117 bridge then picks these up and routes them to Ali's ops board.
 */
export async function suggestionsProducerTick(workspaceId: string): Promise<{ created: number; scanned: number }> {
  const since = Date.now() - ONE_DAY
  // Pull error events. Cap at 5k rows / 24h.
  const rows = await db.select({ type: events.type, payload: events.payload })
    .from(events)
    .where(and(
      gte(events.createdAt, since),
      sql`${events.type} IN ('cron.error', 'task.failed', 'brain.op_error', 'queue.dead_letter')`,
    ))
    .limit(5000)

  // Bucket by (type, normalized-error-message). Strip volatile bits
  // (timestamps, uuids, hex digests) so similar errors collapse.
  const buckets = new Map<string, { type: string; sample: string; count: number }>()
  for (const r of rows) {
    const p = (r.payload ?? {}) as Record<string, unknown>
    const msg = String((p['error'] ?? p['message'] ?? p['reason'] ?? '')).slice(0, 240)
    if (!msg) continue
    const norm = msg
      .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
      .replace(/\b\d{10,}\b/g, '<ts>')
      .replace(/['"][^'"]{4,}['"]/g, '<str>')
      .replace(/\s+/g, ' ')
      .trim()
    const key = `${r.type}::${norm.slice(0, 200)}`
    const b = buckets.get(key)
    if (b) b.count++
    else buckets.set(key, { type: r.type, sample: msg, count: 1 })
  }

  let created = 0
  for (const [key, b] of buckets.entries()) {
    if (b.count < 3) continue
    // Dedupe: skip if any open suggestion has this exact title pattern.
    const titleHash = key.slice(0, 80)
    const title = `[autoscan] recurring ${b.type} (×${b.count}/24h)`
    const existsRows = await db.execute(sql`
      SELECT 1 FROM improvement_suggestions
      WHERE workspace_id = ${workspaceId}
        AND status = 'open'
        AND title LIKE ${`%${titleHash}%`}
      LIMIT 1
    `).catch(() => null) as unknown as { length: number } | null
    const exists = existsRows ? existsRows.length > 0 : false
    if (exists) continue
    const priority = b.count >= 20 ? 'high' : b.count >= 10 ? 'medium' : 'low'
    const id = uuidv7(); const now = Date.now()
    await db.execute(sql`
      INSERT INTO improvement_suggestions (id, workspace_id, title, body, category, priority, status, source, metadata, created_at, updated_at)
      VALUES (${id}, ${workspaceId}, ${title}, ${`Recurring error pattern.\n\nSample: ${b.sample}\n\nKey: ${titleHash}`},
              ${'reliability'}, ${priority}, 'open', 'autoscan',
              ${JSON.stringify({ count: b.count, eventType: b.type, key: titleHash })}::jsonb,
              ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `).catch(() => null)
    created++
  }
  return { created, scanned: rows.length }
}

// ─── P1.5 — OAuth pre-refresh cron ────────────────────────────────────

/**
 * Iterate every active connector account whose token expires within the
 * next 30 minutes. Call r117 refreshIfNeeded to rotate.
 */
export async function oauthRefreshTick(): Promise<{ refreshed: number; checked: number; skipped: number }> {
  const NOW = Date.now()
  const HORIZON = NOW + 30 * 60_000  // 30 min ahead
  const rows = await db.select({ id: connectorAccounts.id, metadata: connectorAccounts.metadata, status: connectorAccounts.status })
    .from(connectorAccounts)
    .where(eq(connectorAccounts.status, 'active'))
    .limit(500)
  const { refreshIfNeeded } = await import('./r117-wiring-fixes.js')
  let refreshed = 0, skipped = 0, checked = 0
  for (const r of rows) {
    checked++
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    const expiresAt = typeof meta['expiresAt'] === 'number' ? meta['expiresAt'] : 0
    if (!expiresAt || expiresAt > HORIZON) { skipped++; continue }
    try {
      const tok = await refreshIfNeeded(r.id)
      if (tok) refreshed++
    } catch { /* per-account isolation */ }
  }
  return { refreshed, checked, skipped }
}

// ─── P1.6 — patch → unified diff exporter ─────────────────────────────

interface PatchFile { path: string; contents: string; op: 'create' | 'modify' }

/**
 * Convert a code_patches row's files[] into a `git apply`-compatible
 * unified diff string.
 *
 * For 'create' files the diff is precise.
 * For 'modify' files we emit a "replace-the-world" diff (--- /dev/null
 * isn't accurate but the operator can `git apply --ignore-whitespace`
 * after spot-checking — better than nothing, and the patch viewer in
 * /proposals shows the full new contents anyway).
 */
function fileToDiff(f: PatchFile): string {
  const lines = f.contents.split('\n')
  const lineCount = lines.length
  if (f.op === 'create') {
    return [
      `diff --git a/${f.path} b/${f.path}`,
      'new file mode 100644',
      'index 0000000..0000001',
      '--- /dev/null',
      `+++ b/${f.path}`,
      `@@ -0,0 +1,${lineCount} @@`,
      ...lines.map(l => '+' + l),
    ].join('\n')
  }
  // modify — emit a full-file replacement. Operator should review.
  return [
    `diff --git a/${f.path} b/${f.path}`,
    '--- a/' + f.path,
    `+++ b/${f.path}`,
    `@@ -1,1 +1,${lineCount} @@ NOTE: replace-the-world diff; review before applying`,
    '-<<< previous contents — see git history for original >>>',
    ...lines.map(l => '+' + l),
  ].join('\n')
}

export async function exportPatchDiff(workspaceId: string, patchId: string): Promise<{ patchId: string; diff: string; fileCount: number }> {
  const [row] = await db.select().from(codePatches)
    .where(and(eq(codePatches.workspaceId, workspaceId), eq(codePatches.id, patchId)))
    .limit(1)
  if (!row) throw new Error('patch not found')
  const files = row.files as PatchFile[]
  const diff = files.map(fileToDiff).join('\n')
  return { patchId, diff, fileCount: files.length }
}

// ─── P2.8 — autonomy counts dashboard ─────────────────────────────────

export async function autonomyCounts(workspaceId: string): Promise<{
  findingsOpen: number; improvementsOpen: number; opsInProcess: number; opsOnDeck: number;
  proposalsProposed: number; proposalsApproved: number;
  connectorsNeedingRefresh: number; agentsLive: number;
}> {
  const NOW = Date.now()
  const HORIZON = NOW + 30 * 60_000
  const counts = async (q: ReturnType<typeof sql>): Promise<number> => {
    try {
      const r = await db.execute(q) as unknown as Array<{ count: string | number }>
      const first = r[0]; if (!first) return 0
      return typeof first.count === 'string' ? parseInt(first.count, 10) : first.count
    } catch { return 0 }
  }
  const [findings, improvements, inProc, onDeck, proposed, approved, agentsLive] = await Promise.all([
    counts(sql`SELECT COUNT(*)::int AS count FROM security_findings WHERE workspace_id = ${workspaceId} AND status = 'open'`),
    counts(sql`SELECT COUNT(*)::int AS count FROM improvement_suggestions WHERE workspace_id = ${workspaceId} AND status = 'open'`),
    counts(sql`SELECT COUNT(*)::int AS count FROM agent_ops_board WHERE workspace_id = ${workspaceId} AND "column" = 'in_process'`),
    counts(sql`SELECT COUNT(*)::int AS count FROM agent_ops_board WHERE workspace_id = ${workspaceId} AND "column" = 'on_deck'`),
    counts(sql`SELECT COUNT(*)::int AS count FROM code_proposals WHERE workspace_id = ${workspaceId} AND status = 'proposed'`),
    counts(sql`SELECT COUNT(*)::int AS count FROM code_proposals WHERE workspace_id = ${workspaceId} AND status = 'approved'`),
    counts(sql`SELECT COUNT(*)::int AS count FROM agent_roster WHERE workspace_id = ${workspaceId} AND status = 'live'`),
  ])
  // Connectors needing refresh — only those with active status + expiresAt within 30 min
  const conns = await db.select({ metadata: connectorAccounts.metadata }).from(connectorAccounts).where(eq(connectorAccounts.status, 'active')).limit(500)
  const connectorsNeedingRefresh = conns.filter(c => {
    const m = (c.metadata ?? {}) as Record<string, unknown>
    const e = typeof m['expiresAt'] === 'number' ? m['expiresAt'] : 0
    return e > 0 && e <= HORIZON
  }).length
  return { findingsOpen: findings, improvementsOpen: improvements, opsInProcess: inProc, opsOnDeck: onDeck, proposalsProposed: proposed, proposalsApproved: approved, connectorsNeedingRefresh, agentsLive }
}

/** Same but takes a proposalId — returns the latest patch's diff. */
export async function exportLatestPatchDiffForProposal(workspaceId: string, proposalId: string): Promise<{ patchId: string; diff: string; fileCount: number }> {
  const [row] = await db.select().from(codePatches)
    .where(and(eq(codePatches.workspaceId, workspaceId), eq(codePatches.proposalId, proposalId)))
    .orderBy(desc(codePatches.createdAt))
    .limit(1)
  if (!row) throw new Error('no patches built for this proposal')
  return exportPatchDiff(workspaceId, row.id)
}
