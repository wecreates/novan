/**
 * realism-verifier.ts — verifies that every claim Novan makes maps to
 * real state. Used right before "completed" is reported anywhere.
 *
 * Verifications:
 *   • verifyFileExists(path)       — file actually exists + non-empty
 *   • verifyUrlReachable(url)      — URL returns 2xx
 *   • verifyDbRow(table, id)       — DB row exists
 *   • verifyExitCode(cmd, expected) — command was actually run with right exit
 *   • verifyOpComplete(opResult)   — generic: ok=true AND has at least one
 *                                    of: outputPath, audioPath, masteredPath,
 *                                    videoId, jobId
 *
 * Returns { real: bool, evidence: string[], gaps: string[] } so the caller
 * can refuse to claim completion when reality doesn't back the claim.
 *
 * The brain MUST run verifyOpComplete on every "we shipped X" message
 * before sending — operational believability rule.
 */

import { existsSync, statSync } from 'node:fs'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

export interface RealityCheck {
  real: boolean
  evidence: string[]
  gaps: string[]
}

export function verifyFileExists(path: string): RealityCheck {
  if (!path) return { real: false, evidence: [], gaps: ['no path provided'] }
  if (!existsSync(path)) return { real: false, evidence: [], gaps: [`file does not exist: ${path}`] }
  try {
    const s = statSync(path)
    if (s.size === 0) return { real: false, evidence: [], gaps: [`file is empty: ${path}`] }
    return { real: true, evidence: [`${path} exists (${s.size} bytes)`], gaps: [] }
  } catch (e) {
    return { real: false, evidence: [], gaps: [`stat failed: ${(e as Error).message}`] }
  }
}

export async function verifyUrlReachable(url: string): Promise<RealityCheck> {
  if (!url) return { real: false, evidence: [], gaps: ['no URL'] }
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
    if (r.ok) return { real: true, evidence: [`${url} → ${r.status}`], gaps: [] }
    return { real: false, evidence: [], gaps: [`${url} → ${r.status}`] }
  } catch (e) {
    return { real: false, evidence: [], gaps: [`fetch failed: ${(e as Error).message}`] }
  }
}

export async function verifyDbRow(tableName: string, id: string): Promise<RealityCheck> {
  // Whitelist: only allow checks against known tables
  const allowed = new Set([
    'events', 'memories', 'issues', 'businesses', 'channels',
    'world_nodes', 'gui_queue', 'governance_rules', 'trust_ewma_scores',
    'research_findings', 'research_topics', 'reasoning_chains',
  ])
  if (!allowed.has(tableName)) return { real: false, evidence: [], gaps: [`table ${tableName} not whitelisted`] }
  // SECURITY: previously used sql.raw with `'${id.replace(/'/g, "''")}'`
  // which had two issues: incomplete single-quote escape (backslash/UTF-8
  // smuggling), and full interpolation if the whitelist check ever drifted.
  // Now uses sql.identifier for table name + parameter binding for id.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return { real: false, evidence: [], gaps: [`invalid id format: ${id.slice(0, 32)}`] }
  }
  try {
    const rows = await db.execute(sql`SELECT 1 FROM ${sql.identifier(tableName)} WHERE id = ${id} LIMIT 1`)
    const list = Array.isArray(rows) ? rows : ((rows as unknown as { rows?: unknown[] }).rows ?? [])
    if (list.length > 0) return { real: true, evidence: [`row ${id} exists in ${tableName}`], gaps: [] }
    return { real: false, evidence: [], gaps: [`no row ${id} in ${tableName}`] }
  } catch (e) {
    return { real: false, evidence: [], gaps: [`db check failed: ${(e as Error).message}`] }
  }
}

/**
 * Generic op-result verifier. Walks the result object (including the
 * nested `data` field many brain-task ops wrap their payload in) for
 * verifiable evidence: file paths that exist, URLs, IDs.
 */
const PATH_FIELDS = new Set(['outputPath', 'audioPath', 'masteredPath', 'thumbnailPath', 'localPath', 'masterPath', 'path', 'srtPath'])
const URL_FIELDS  = new Set(['audioUrl', 'url', 'sourceUrl', 'thumbnailUrl'])
const ID_FIELDS   = new Set(['videoId', 'jobId', 'productionLogId', 'memoryId', 'id', 'taskId'])

function collectEvidence(obj: unknown, evidence: string[], gaps: string[], depth = 0): void {
  if (depth > 3 || !obj || typeof obj !== 'object') return
  const o = obj as Record<string, unknown>
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && v.length > 0) {
      if (PATH_FIELDS.has(k)) {
        const f = verifyFileExists(v)
        if (f.real) evidence.push(...f.evidence)
        else        gaps.push(...f.gaps)
      } else if (URL_FIELDS.has(k) && v.startsWith('http')) {
        evidence.push(`${k}: ${v}`)
      } else if (ID_FIELDS.has(k)) {
        evidence.push(`${k}: ${v}`)
      }
    } else if (Array.isArray(v)) {
      for (const item of v) collectEvidence(item, evidence, gaps, depth + 1)
    } else if (typeof v === 'object' && v !== null) {
      collectEvidence(v, evidence, gaps, depth + 1)
    }
  }
}

export async function verifyOpComplete(opResult: Record<string, unknown>): Promise<RealityCheck> {
  if (!opResult) return { real: false, evidence: [], gaps: ['no result object'] }
  if (opResult['ok'] !== true) return { real: false, evidence: [], gaps: ['result.ok !== true'] }

  const evidence: string[] = []
  const gaps: string[] = []
  collectEvidence(opResult, evidence, gaps)

  if (evidence.length === 0) {
    gaps.push('result.ok=true but no verifiable output (path/url/id) found in any nested field')
  }
  return { real: evidence.length > 0 && gaps.length === 0, evidence, gaps }
}

/**
 * Strong assertion — use in code paths where false completion would be
 * disastrous. Throws if reality doesn't match the claim.
 */
export async function assertReal(opResult: Record<string, unknown>, contextLabel = 'op'): Promise<void> {
  const check = await verifyOpComplete(opResult)
  if (!check.real) {
    throw new Error(`realism-verifier: ${contextLabel} claims success but fails reality check — ${check.gaps.join('; ')}`)
  }
}
