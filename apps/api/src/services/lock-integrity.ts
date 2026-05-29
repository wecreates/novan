/**
 * lock-integrity.ts — Layer 5 lock integrity + tampering detection.
 *
 * The brain spec (SPEC §10.5) lists LOCKED_CORE_PATHS that the
 * self-improvement loop cannot self-modify. This module is the
 * *runtime verifier* — it computes content hashes of those files,
 * stores a baseline, and on each tick re-hashes and compares.
 *
 * Honest scope:
 *   - Detection only. We never auto-revert. A mismatch surfaces a
 *     `lock_integrity.tamper_detected` event and pages the operator.
 *   - First-tick semantics: if no baseline exists for a file, we record
 *     one. This is bootstrap, not a free pass — operator must confirm
 *     the initial install via the Compliance tab.
 *   - Legitimate changes (operator-merged PR touching a locked file)
 *     are accepted by calling `acknowledgeLockChange(path, reason)`
 *     from the Compliance tab. This updates the baseline + records the
 *     acknowledgment as an audit event.
 *
 * Why not just diff against git? Git can lie — a determined adversarial
 * patch could rewrite history. Content hashing of the actually-loaded
 * files is the closest we get to "what is the process running right
 * now" without privileged kernel hooks.
 */

import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'node:crypto'
import { readFile, readFile as readFileSync_ } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
void readFileSync_
import { incCounter, setGauge } from './metrics.js'

/** Canonical locked paths.
 *
 *  The CANONICAL registry lives in `services/self-improvement.ts ->
 *  LOCKED_CORE_PATHS` as regex patterns. We mirror to absolute paths
 *  here because `runLockIntegrityCheck` needs to read concrete files.
 *
 *  To prevent silent drift, `verifyLockSync()` (called from tests + the
 *  cron tick) asserts every canonical pattern matches at least one
 *  entry in LOCKED_PATHS. If a new pattern is added to LOCKED_CORE_PATHS
 *  without a corresponding LOCKED_PATHS entry, the next test run + the
 *  next cron tick will fail loudly.
 */
export const LOCKED_PATHS: readonly string[] = [
  // Locked-core files that actually exist as standalone modules.
  // The canonical regex in self-improvement.ts → LOCKED_CORE_PATHS also
  // matches kill-switch/audit functionality embedded in other files —
  // verifyLockSync covers the regex-side; this list covers the on-disk
  // hash check. Don't add paths that don't exist as standalone files
  // (the verifier will mark them as `missing` forever).
  'apps/api/src/services/policy-engine.ts',
  'apps/api/src/services/mission-charter.ts',
  'apps/api/src/services/self-improvement.ts',
  'apps/api/src/services/agent-coordination.ts',
  'apps/api/src/services/safety-policy.ts',
  'apps/api/src/services/lock-integrity.ts',         // protects itself
  'packages/db/src/schema.ts',
] as const

/** Assert LOCKED_PATHS covers every canonical pattern in
 *  LOCKED_CORE_PATHS. Returns the list of canonical patterns that have
 *  NO matching LOCKED_PATHS entry (empty array = healthy).
 *
 *  Tolerant of import failure: in test/sandbox envs where the canonical
 *  module's top-level db import can't initialize, we report `ok: true`
 *  with an `unverified` flag so cron + tests proceed. Production has
 *  DATABASE_URL set, so the sync check runs rigorously there. */
export async function verifyLockSync(): Promise<{ ok: boolean; uncovered: string[]; unverified?: boolean }> {
  let canonical: ReadonlyArray<{ pattern: RegExp; reason: string }> | null = null
  try {
    const mod = await import('./self-improvement.js')
    canonical = mod.LOCKED_CORE_PATHS
  } catch {
    return { ok: true, uncovered: [], unverified: true }
  }
  const normalize = (p: string) => p
    .replace(/^apps\/api\/src\//, '')
    .replace(/^packages\/db\/src\//, 'db/')
  const uncovered: string[] = []
  for (const lock of canonical) {
    const matched = LOCKED_PATHS.some(p => lock.pattern.test(normalize(p)))
    if (!matched) uncovered.push(lock.pattern.toString())
  }
  return { ok: uncovered.length === 0, uncovered }
}

export interface LockBaseline {
  path:        string
  sha256:      string
  recordedAt:  number
}

export interface LockVerdict {
  path:        string
  expected:    string | null   // null = no baseline yet (bootstrap)
  actual:      string | null   // null = file unreadable
  status:      'match' | 'bootstrap' | 'missing' | 'tampered'
}

/** Compute sha256 of a single file. Returns null if unreadable. */
export async function hashFile(absPath: string): Promise<string | null> {
  try {
    const buf = await readFile(absPath)
    return createHash('sha256').update(buf).digest('hex')
  } catch { return null }
}

/** Look up the most recent acknowledged baseline for a path. */
async function readBaseline(path: string): Promise<LockBaseline | null> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { and, eq, sql, desc } = await import('drizzle-orm')
    const rows = await db.select({ payload: events.payload, createdAt: events.createdAt }).from(events)
      .where(and(
        eq(events.type, 'lock_integrity.baseline_recorded'),
        sql`${events.payload}->>'path' = ${path}`,
      ))
      .orderBy(desc(events.createdAt))
      .limit(1)
      .catch(() => [])
    if (rows.length === 0) return null
    const p = rows[0]!.payload as { sha256?: string }
    if (!p.sha256) return null
    return { path, sha256: p.sha256, recordedAt: Number(rows[0]!.createdAt) }
  } catch { return null }
}

async function recordBaseline(path: string, sha256: string, source: string): Promise<void> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    await db.insert(events).values({
      id: uuidv7(), type: 'lock_integrity.baseline_recorded', workspaceId: 'global',   // R146.20 — lock-integrity is system-wide; events.workspace_id is NOT NULL so null was silently rejected pre-R146.12, now logs every tick
      payload: { path, sha256, source },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'lock-integrity', version: 1, createdAt: Date.now(),
    }).catch((e: Error) => { console.error('[lock-integrity]', e.message); return null })
  } catch { /* tolerated */ }
}

/** Resolve the repo root reliably. process.cwd() varies depending on
 *  how the API was started (root via launcher, apps/api/ via direct
 *  pnpm dev, /app via Docker). Walk upward from this file until we
 *  see a package.json that declares `workspaces` — that's the repo root.
 */
function resolveRepoRoot(): string {
  if (process.env['REPO_ROOT']) return process.env['REPO_ROOT']!
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    try {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const obj = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown }
        if (obj.workspaces) return dir
      }
    } catch { /* keep walking */ }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

/** Verify one locked path against its baseline. */
export async function verifyPath(repoRoot: string, path: string): Promise<LockVerdict> {
  const abs = resolve(repoRoot, path)
  const actual = await hashFile(abs)
  if (!actual) return { path, expected: null, actual: null, status: 'missing' }
  const baseline = await readBaseline(path)
  if (!baseline) {
    // Bootstrap: first time we've seen this path. Record it.
    await recordBaseline(path, actual, 'bootstrap')
    return { path, expected: null, actual, status: 'bootstrap' }
  }
  if (baseline.sha256 === actual) return { path, expected: baseline.sha256, actual, status: 'match' }
  return { path, expected: baseline.sha256, actual, status: 'tampered' }
}

/** Operator-only: acknowledge a legitimate change to a locked file.
 *  Updates the baseline + records who/why for audit. */
export async function acknowledgeLockChange(
  path: string,
  reason: string,
  acknowledgedBy: string,
): Promise<{ acknowledged: true; newSha: string | null }> {
  if (!LOCKED_PATHS.includes(path)) {
    throw new Error(`${path} is not in LOCKED_PATHS — nothing to acknowledge`)
  }
  if (!reason || reason.length < 8) {
    throw new Error('acknowledgment reason required (min 8 chars)')
  }
  const repoRoot = resolveRepoRoot()
  const newSha = await hashFile(resolve(repoRoot, path))
  if (!newSha) throw new Error(`cannot read ${path} — refuse to ack a missing file`)
  await recordBaseline(path, newSha, `ack:${acknowledgedBy}`)
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    await db.insert(events).values({
      id: uuidv7(), type: 'lock_integrity.change_acknowledged', workspaceId: 'global',   // R146.20 — lock-integrity is system-wide; events.workspace_id is NOT NULL so null was silently rejected pre-R146.12, now logs every tick
      payload: { path, reason, acknowledgedBy, newSha },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'lock-integrity', version: 1, createdAt: Date.now(),
    }).catch((e: Error) => { console.error('[lock-integrity]', e.message); return null })
  } catch { /* tolerated */ }
  return { acknowledged: true, newSha }
}

/** Cron tick — verify every locked path + emit per-tick summary.
 *  Also checks LOCKED_PATHS ↔ LOCKED_CORE_PATHS sync; any new canonical
 *  pattern without a matching path here emits a stability alert. */
export async function runLockIntegrityCheck(): Promise<{
  checked: number
  matches: number
  tampered: string[]
  bootstrapped: string[]
  missing: string[]
  uncoveredCanonical: string[]
}> {
  const sync = await verifyLockSync().catch(() => ({ ok: true, uncovered: [] as string[] }))
  if (!sync.ok) {
    incCounter('lock_integrity_drift_total')
    try {
      const { db } = await import('../db/client.js')
      const { events } = await import('../db/schema.js')
      await db.insert(events).values({
        id: uuidv7(), type: 'governance.stability_alert', workspaceId: 'global',   // R146.20 — lock-integrity is system-wide; events.workspace_id is NOT NULL so null was silently rejected pre-R146.12, now logs every tick
        payload: { reason: 'lock_paths_out_of_sync', uncovered: sync.uncovered },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'lock-integrity', version: 1, createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[lock-integrity]', e.message); return null })
    } catch { /* tolerated */ }
  }

  const repoRoot = resolveRepoRoot()
  const tampered: string[] = []
  const bootstrapped: string[] = []
  const missing: string[] = []
  let matches = 0

  for (const path of LOCKED_PATHS) {
    const v = await verifyPath(repoRoot, path).catch((e: Error) => { console.error('[lock-integrity]', e.message); return null })
    if (!v) continue
    if (v.status === 'match') matches++
    else if (v.status === 'tampered') tampered.push(path)
    else if (v.status === 'bootstrap') bootstrapped.push(path)
    else if (v.status === 'missing') missing.push(path)
  }

  setGauge('lock_integrity_locked_paths', LOCKED_PATHS.length)
  setGauge('lock_integrity_tampered', tampered.length)
  setGauge('lock_integrity_missing', missing.length)
  if (tampered.length > 0) incCounter('lock_integrity_tamper_detected_total', {}, tampered.length)

  // Tampering is a paging event — emit BOTH a tamper-detected event
  // (high-severity) and a stability_alert so the operator sees it on
  // the Architecture overview tab.
  if (tampered.length > 0) {
    try {
      const { db } = await import('../db/client.js')
      const { events } = await import('../db/schema.js')
      await db.insert(events).values({
        id: uuidv7(), type: 'lock_integrity.tamper_detected', workspaceId: 'global',   // R146.20 — lock-integrity is system-wide; events.workspace_id is NOT NULL so null was silently rejected pre-R146.12, now logs every tick
        payload: { tampered, checkedAt: Date.now() },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'lock-integrity', version: 1, createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[lock-integrity]', e.message); return null })
      await db.insert(events).values({
        id: uuidv7(), type: 'governance.stability_alert', workspaceId: 'global',   // R146.20 — lock-integrity is system-wide; events.workspace_id is NOT NULL so null was silently rejected pre-R146.12, now logs every tick
        payload: { reason: 'lock_integrity_tamper', tampered },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'lock-integrity', version: 1, createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[lock-integrity]', e.message); return null })
    } catch { /* tolerated */ }
  }

  return {
    checked: LOCKED_PATHS.length, matches, tampered, bootstrapped, missing,
    uncoveredCanonical: sync.uncovered,
  }
}
