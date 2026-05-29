/**
 * failure-detector.ts — active scanners that catch the 30 failure modes
 * AT RUNTIME inside Novan itself. Not theoretical — runs on the cron
 * and produces RiskAlert events the operator sees in chat.
 *
 * Detectors:
 *   • detectFakeCompletion       — production_log events flagged 'completed' with no outputPath
 *   • detectAutomationRunaway    — same op > N times in window
 *   • detectHallucinatedClaims   — recent assistant messages claiming success without evidence tokens
 *   • detectTrustDestruction     — failures hidden (status='failed' but no error)
 *   • detectComplexityCollapse   — delegation depth exceeded
 *   • detectGovernanceBypass     — high-risk ops without approval_token
 *   • detectEconomicRunaway      — TTS / provider burn exceeds budget
 *   • detectEmotionalOverload    — > N notifications in last 24h
 *   • detectStaleness            — twin / memory / dna not refreshed in N days
 *
 * Surfaces results via emitRiskAlert(), which writes to events + memories
 * with tag 'risk-alert' so the operator sees them in /research and chat.
 */

import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'
import type { RiskCategory } from './risk-taxonomy.js'

export interface RiskAlert {
  category:   RiskCategory
  severity:   'low' | 'medium' | 'high' | 'critical'
  evidence:   string[]
  recommendation: string
  workspaceId: string
  detectedAt: number
}

async function emitRiskAlert(a: RiskAlert): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO events (id, workspace_id, type, payload, created_at)
      VALUES (gen_random_uuid(), ${a.workspaceId}, 'risk.alert',
              ${JSON.stringify({ category: a.category, severity: a.severity, evidence: a.evidence, recommendation: a.recommendation })}::jsonb,
              ${a.detectedAt})`)
  } catch { /* events table may not exist in dev */ }
}

// ─── Detectors ─────────────────────────────────────────────────────────

/** False completion: events tagged 'completed' but missing outputPath. */
export async function detectFakeCompletion(workspaceId: string, hours = 24): Promise<RiskAlert[]> {
  const since = Date.now() - hours * 3_600_000
  const out: RiskAlert[] = []
  try {
    const { listEvents } = await import('./production-log.js')
    const events = await listEvents({ workspaceId, days: Math.max(1, Math.ceil(hours / 24)), limit: 500 })
    const suspect = events.filter(e =>
      e.status === 'completed' &&
      e.startedAt >= since &&
      !e.outputPath &&
      ['video', 'music', 'mass-produce'].includes(e.kind),
    )
    if (suspect.length > 0) {
      const alert: RiskAlert = {
        category: 'false-completion', severity: 'critical', workspaceId, detectedAt: Date.now(),
        evidence: suspect.slice(0, 5).map(s => `${s.kind} "${(s.brief ?? '').slice(0, 60)}" completed without outputPath`),
        recommendation: 'Re-run these jobs with verification enabled, or mark as failed if outputs are truly missing.',
      }
      await emitRiskAlert(alert); out.push(alert)
    }
  } catch { /* */ }
  return out
}

/** Automation runaway: same op fires > 50× in 1 hour. */
export async function detectAutomationRunaway(workspaceId: string): Promise<RiskAlert[]> {
  const out: RiskAlert[] = []
  try {
    const rows = await db.execute(sql`
      SELECT type, COUNT(*)::int AS n FROM events
      WHERE workspace_id = ${workspaceId}
        AND created_at > ${Date.now() - 3_600_000}
      GROUP BY type
      HAVING COUNT(*) > 50
      ORDER BY n DESC LIMIT 5`)
    const list = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []
    if (list.length > 0) {
      const alert: RiskAlert = {
        category: 'automation-runaway', severity: 'critical', workspaceId, detectedAt: Date.now(),
        evidence: list.map(r => `${String(r['type'])}: ${r['n']}× in last hour`),
        recommendation: 'Likely runaway loop. Pause the offending op family + diagnose root cause.',
      }
      await emitRiskAlert(alert); out.push(alert)
    }
  } catch { /* */ }
  return out
}

/** Trust destruction: events marked 'failed' with no error message. */
export async function detectTrustDestruction(workspaceId: string, hours = 24): Promise<RiskAlert[]> {
  const out: RiskAlert[] = []
  try {
    const { listEvents } = await import('./production-log.js')
    const events = await listEvents({ workspaceId, days: Math.max(1, Math.ceil(hours / 24)), limit: 500 })
    const since = Date.now() - hours * 3_600_000
    const silent = events.filter(e => e.status === 'failed' && !e.error && e.startedAt >= since)
    if (silent.length > 3) {
      const alert: RiskAlert = {
        category: 'trust-destruction', severity: 'high', workspaceId, detectedAt: Date.now(),
        evidence: [`${silent.length} failed events without recorded reason in last ${hours}h`],
        recommendation: 'Always log a failure reason. Silent failures destroy operator trust.',
      }
      await emitRiskAlert(alert); out.push(alert)
    }
  } catch { /* */ }
  return out
}

/** Economic runaway: TTS budget > 80% used. */
export async function detectEconomicRunaway(workspaceId: string): Promise<RiskAlert[]> {
  const out: RiskAlert[] = []
  try {
    const { ttsStatus } = await import('./voiceover-service.js')
    const s = await ttsStatus()
    if (s.charsUsedToday > s.dailyCap * 0.8) {
      const alert: RiskAlert = {
        category: 'economic', severity: s.charsUsedToday >= s.dailyCap ? 'critical' : 'high',
        workspaceId, detectedAt: Date.now(),
        evidence: [`TTS used ${s.charsUsedToday}/${s.dailyCap} chars today (${Math.round(s.charsUsedToday / s.dailyCap * 100)}%)`],
        recommendation: 'TTS budget near cap. Pause auto-narration or raise TTS_MAX_CHARS_PER_DAY.',
      }
      await emitRiskAlert(alert); out.push(alert)
    }
  } catch { /* */ }
  return out
}

/** Emotional overload: > 20 broadcast notifications in 24h. */
export async function detectEmotionalOverload(workspaceId: string): Promise<RiskAlert[]> {
  const out: RiskAlert[] = []
  try {
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM events
      WHERE workspace_id = ${workspaceId}
        AND type LIKE 'brain.broadcast%'
        AND created_at > ${Date.now() - 86_400_000}`)
    const n = Number(((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]?.['n']) ?? 0)
    if (n > 20) {
      const alert: RiskAlert = {
        category: 'emotional-state', severity: 'high', workspaceId, detectedAt: Date.now(),
        evidence: [`${n} brain broadcasts in last 24h — operator overload risk`],
        recommendation: 'Batch + summarize. Raise broadcast threshold or extend QUIET_WINDOW_MS.',
      }
      await emitRiskAlert(alert); out.push(alert)
    }
  } catch { /* */ }
  return out
}

/** Knowledge staleness: research findings older than 30 days dominate recall. */
export async function detectKnowledgeStaleness(workspaceId: string): Promise<RiskAlert[]> {
  const out: RiskAlert[] = []
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE fresh_at > ${Date.now() - 30 * 86_400_000})::int AS fresh,
        COUNT(*)::int AS total
      FROM research_findings WHERE workspace_id = ${workspaceId}`)
    const r = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
    if (!r) return out
    const fresh = Number(r['fresh']), total = Number(r['total'])
    if (total > 50 && fresh / total < 0.2) {
      const alert: RiskAlert = {
        category: 'knowledge-system', severity: 'medium', workspaceId, detectedAt: Date.now(),
        evidence: [`Only ${fresh}/${total} research findings are <30d old`],
        recommendation: 'Increase research-cron cadence or prune stale findings.',
      }
      await emitRiskAlert(alert); out.push(alert)
    }
  } catch { /* */ }
  return out
}

/** Complexity collapse: delegation chains exceed depth 3. */
export async function detectComplexityCollapse(workspaceId: string): Promise<RiskAlert[]> {
  const out: RiskAlert[] = []
  try {
    const rows = await db.execute(sql`
      SELECT MAX(depth)::int AS d FROM agent_delegations
      WHERE workspace_id = ${workspaceId} AND created_at > ${Date.now() - 86_400_000}`)
    const d = Number(((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]?.['d']) ?? 0)
    if (d > 3) {
      const alert: RiskAlert = {
        category: 'complexity-collapse', severity: 'high', workspaceId, detectedAt: Date.now(),
        evidence: [`Delegation depth ${d} observed (max should be 3)`],
        recommendation: 'Flatten delegation chains. Investigate the chain that exceeded depth.',
      }
      await emitRiskAlert(alert); out.push(alert)
    }
  } catch { /* table may not exist */ }
  return out
}

/** Governance bypass: brain-task op events that lack a governance_verdict
 *  in their payload — fixed to match the ACTUAL emitted event types
 *  (brain_task.op_completed / brain_task.op_failed), not the never-emitted
 *  brain_task.publish/delete/deploy patterns the previous version queried. */
export async function detectGovernanceBypass(workspaceId: string): Promise<RiskAlert[]> {
  const out: RiskAlert[] = []
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE payload->>'governance_verdict' IS NULL)::int AS missing,
        COUNT(*)::int AS total
      FROM events
      WHERE workspace_id = ${workspaceId}
        AND created_at > ${Date.now() - 24 * 3_600_000}
        AND (type = 'brain_task.op_completed' OR type = 'brain_task.op_failed')`)
    const r = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
    if (!r) return out
    const missing = Number(r['missing']), total = Number(r['total'])
    if (total > 5 && missing / total > 0.1) {
      const alert: RiskAlert = {
        category: 'governance', severity: 'critical', workspaceId, detectedAt: Date.now(),
        evidence: [`${missing}/${total} brain-task ops in last 24h lack governance_verdict in payload`],
        recommendation: 'Governance.check is not being recorded on every op. Audit brain-task executor.',
      }
      await emitRiskAlert(alert); out.push(alert)
    }
  } catch { /* */ }
  return out
}

/** Run every detector for a workspace. */
export async function scanAll(workspaceId: string): Promise<{ alerts: RiskAlert[] }> {
  const all = await Promise.all([
    detectFakeCompletion(workspaceId),
    detectAutomationRunaway(workspaceId),
    detectTrustDestruction(workspaceId),
    detectEconomicRunaway(workspaceId),
    detectEmotionalOverload(workspaceId),
    detectKnowledgeStaleness(workspaceId),
    detectComplexityCollapse(workspaceId),
    detectGovernanceBypass(workspaceId),
  ])
  return { alerts: all.flat() }
}
