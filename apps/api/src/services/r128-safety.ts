/**
 * R146.128 — Tier 1 safety bundle.
 *
 *  - SPEND CAPS: per-workspace daily/monthly LLM+image USD ceiling.
 *    Enforced at chat-providers.streamChat entry (callers don't need
 *    to know). Hard-block by default; can be set to warn-only.
 *  - MODERATION: pre-post check on captions/scripts. LLM + keyword
 *    scan returns verdict (pass/flag/block). Persisted to
 *    moderation_results.
 *  - BACKUP: ops to run pg_dump → external destination (S3 / DO
 *    Spaces) and log runs. Cron at 04:00 UTC daily.
 */
import { db } from '../db/client.js'
import { aiUsage, spendCaps, moderationResults, backupRuns } from '../db/schema.js'
import { and, eq, gte, sum, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'crypto'

const DAY_MS   = 24 * 60 * 60 * 1000
const MONTH_MS = 30 * DAY_MS

// ─── Spend caps ────────────────────────────────────────────────────────

export interface SpendStatus {
  dailyUsd:    number
  monthlyUsd:  number
  dailyCap:    number
  monthlyCap:  number
  hardBlock:   boolean
  blocked:     boolean
  reason?:     string
}

export async function getSpendStatus(workspaceId: string): Promise<SpendStatus> {
  const now = Date.now()
  const [cap] = await db.select().from(spendCaps).where(eq(spendCaps.workspaceId, workspaceId)).limit(1)
  // R146.134 — default to UNLIMITED (0 = no cap). Operator must opt-in
  // to enforcement via spend.setCap. Mass-production mode incompatible
  // with hard ceilings.
  const dailyCap   = cap?.dailyUsdCap   ?? 0
  const monthlyCap = cap?.monthlyUsdCap ?? 0
  const hardBlock  = cap?.hardBlock     ?? false

  // Sum costs in window. Indexed on (workspace_id, timestamp).
  const dayTotal = await db.select({ s: sum(aiUsage.costUsd) }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, now - DAY_MS)))
  const monTotal = await db.select({ s: sum(aiUsage.costUsd) }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, now - MONTH_MS)))

  const dailyUsd   = Number(dayTotal[0]?.s ?? 0)
  const monthlyUsd = Number(monTotal[0]?.s ?? 0)
  let blocked = false; let reason: string | undefined
  // 0 = unlimited (skip the comparison entirely)
  if (dailyCap   > 0 && dailyUsd   >= dailyCap)   { blocked = true; reason = `daily cap ${dailyUsd.toFixed(2)} >= ${dailyCap.toFixed(2)} USD` }
  else if (monthlyCap > 0 && monthlyUsd >= monthlyCap) { blocked = true; reason = `monthly cap ${monthlyUsd.toFixed(2)} >= ${monthlyCap.toFixed(2)} USD` }
  return { dailyUsd, monthlyUsd, dailyCap, monthlyCap, hardBlock, blocked, ...(reason !== undefined ? { reason } : {}) }
}

export async function setSpendCap(workspaceId: string, opts: { dailyUsdCap?: number; monthlyUsdCap?: number; hardBlock?: boolean; updatedBy?: string }): Promise<void> {
  const now = Date.now()
  const dailyUsdCap   = typeof opts.dailyUsdCap   === 'number' ? Math.max(0, opts.dailyUsdCap)   : 50
  const monthlyUsdCap = typeof opts.monthlyUsdCap === 'number' ? Math.max(0, opts.monthlyUsdCap) : 500
  const hardBlock     = opts.hardBlock !== false
  const updatedBy     = String(opts.updatedBy ?? 'operator')
  await db.insert(spendCaps).values({ workspaceId, dailyUsdCap, monthlyUsdCap, hardBlock, updatedAt: now, updatedBy })
    .onConflictDoUpdate({ target: spendCaps.workspaceId, set: { dailyUsdCap, monthlyUsdCap, hardBlock, updatedAt: now, updatedBy } })
}

/** Throw if hard-block + over cap. Soft-warn otherwise. Called at streamChat entry. */
export async function enforceSpendCap(workspaceId: string): Promise<void> {
  if (process.env['DISABLE_SPEND_CAPS'] === '1') return
  const s = await getSpendStatus(workspaceId)
  if (s.blocked && s.hardBlock) throw new Error(`SPEND_CAP_EXCEEDED: ${s.reason}`)
}

// ─── Pre-post moderation ──────────────────────────────────────────────

/** Crude keyword scan — catches the obvious. LLM scan is the real check. */
const KEYWORD_FLAGS: Array<[RegExp, string, number]> = [
  [/\b(n[i1]gg(er|a)|fag|kike|chink|spic|tranny)\b/i, 'slur',      1.0],
  [/\bkill\s+(yourself|urself|ur ?self)\b/i,           'self_harm', 1.0],
  [/\b(rape|raping|pedo|cp)\b/i,                       'sexual_violence', 1.0],
  [/\b(buy\s+followers|fake\s+followers|engagement\s+pod)\b/i, 'tos_violation', 0.6],
  [/copyright|©|all\s+rights\s+reserved/i,             'copyright_marker', 0.4],
]

export interface ModerationVerdict {
  verdict: 'pass' | 'flag' | 'block'
  reasons: string[]
  categoryScores: Record<string, number>
}

export async function moderate(workspaceId: string, opts: { contentType: 'shortform' | 'caption' | 'image' | 'video'; text: string; contentRefId?: string; useLlm?: boolean }): Promise<ModerationVerdict & { id: string }> {
  const reasons: string[] = []
  const scores: Record<string, number> = {}
  let maxScore = 0
  for (const [re, cat, weight] of KEYWORD_FLAGS) {
    if (re.test(opts.text)) {
      scores[cat] = Math.max(scores[cat] ?? 0, weight)
      reasons.push(`keyword:${cat}`)
      if (weight > maxScore) maxScore = weight
    }
  }
  // LLM scan (cheap fallback model) — defaults on for shortform/caption.
  if (opts.useLlm !== false && (opts.contentType === 'shortform' || opts.contentType === 'caption')) {
    try {
      const { streamChat } = await import('./chat-providers.js')
      const gen = streamChat(workspaceId, [
        { role: 'system', content: 'You are a content moderator. Return STRICT JSON: {"safe":bool,"categories":{"hate":0..1,"harassment":0..1,"self_harm":0..1,"sexual":0..1,"violence":0..1,"copyright":0..1,"tos":0..1},"reason":"<<one short sentence if not safe>>"}. No prose.' },
        { role: 'user',   content: opts.text.slice(0, 4000) },
      ], { suppressQualityBar: true, taskType: 'other' } as Parameters<typeof streamChat>[2])
      let acc = ''
      for await (const ch of gen) acc += ch.delta
      const m = acc.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as { safe?: boolean; categories?: Record<string, number>; reason?: string }
        if (parsed.categories) {
          for (const [k, v] of Object.entries(parsed.categories)) {
            if (typeof v === 'number' && v > 0.3) {
              scores[k] = Math.max(scores[k] ?? 0, v)
              if (v > maxScore) maxScore = v
            }
          }
        }
        if (parsed.safe === false && parsed.reason) reasons.push(`llm:${parsed.reason.slice(0, 120)}`)
      }
    } catch { /* LLM optional; fall back to keyword-only */ }
  }
  const verdict: 'pass' | 'flag' | 'block' = maxScore >= 0.85 ? 'block' : maxScore >= 0.5 ? 'flag' : 'pass'
  const id = uuidv7()
  const hash = createHash('sha256').update(opts.text).digest('hex').slice(0, 32)
  await db.insert(moderationResults).values({
    id, workspaceId,
    contentType: opts.contentType,
    contentRefId: opts.contentRefId ?? null,
    contentHash: hash, verdict, reasons,
    categoryScores: scores,
    reviewer: 'auto',
    createdAt: Date.now(),
  }).catch(() => null)
  return { id, verdict, reasons, categoryScores: scores }
}

// ─── Backup ───────────────────────────────────────────────────────────

/**
 * Run pg_dump and push to DO Spaces / S3.
 * Requires env: BACKUP_DESTINATION_URL (e.g. s3://bucket/prefix),
 *              BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY, BACKUP_S3_ENDPOINT
 * If unset, returns a clear "not configured" failure logged to backup_runs.
 */
export async function runBackup(): Promise<{ id: string; status: string; sizeBytes?: number; error?: string }> {
  const dest = process.env['BACKUP_DESTINATION_URL'] ?? ''
  const id = uuidv7()
  const started = Date.now()
  await db.insert(backupRuns).values({
    id, startedAt: started, finishedAt: null,
    status: 'running', destination: dest || '<unconfigured>',
    sizeBytes: null, error: null,
  }).catch(() => null)
  if (!dest) {
    const error = 'BACKUP_DESTINATION_URL not configured. See docs/backup-setup.md.'
    await db.update(backupRuns).set({ status: 'failed', finishedAt: Date.now(), error }).where(eq(backupRuns.id, id))
    return { id, status: 'failed', error }
  }
  // The actual pg_dump + upload runs as a sidecar shell script invoked
  // here. To keep the api container clean (no postgres-client install
  // needed), we shell out to /usr/local/bin/novan-backup.sh which is
  // expected to be provided by ops (mounted from /root/scripts/).
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const exec = promisify(execFile)
    const { stdout } = await exec('/usr/local/bin/novan-backup.sh', [dest], { timeout: 30 * 60_000 })
    // Expected stdout: JSON {"sizeBytes":N}
    let sizeBytes = 0
    try { const j = JSON.parse(stdout.trim()) as { sizeBytes?: number }; if (typeof j.sizeBytes === 'number') sizeBytes = j.sizeBytes } catch { /* leave 0 */ }
    await db.update(backupRuns).set({ status: 'ok', finishedAt: Date.now(), sizeBytes }).where(eq(backupRuns.id, id))
    return { id, status: 'ok', sizeBytes }
  } catch (e) {
    const error = (e as Error).message.slice(0, 500)
    await db.update(backupRuns).set({ status: 'failed', finishedAt: Date.now(), error }).where(eq(backupRuns.id, id))
    return { id, status: 'failed', error }
  }
}

export async function listBackups(limit = 30): Promise<Array<typeof backupRuns.$inferSelect>> {
  return db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(Math.min(limit, 100))
}
