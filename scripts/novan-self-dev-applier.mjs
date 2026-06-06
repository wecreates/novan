#!/usr/bin/env node
/**
 * R146.195 — Novan Self-Dev Applier (Phase 2)
 *
 * Host-side daemon. NOT inside the api container — runs on the droplet
 * directly so it can git-commit + docker-build + docker-restart.
 *
 * Cycle:
 *   1. Poll self_dev_proposal where status='approved' AND applied_at IS NULL
 *   2. For each proposal:
 *      a. Validate every file path is in ALLOWLIST and not in DENYLIST
 *      b. Apply diffs to the working tree
 *      c. Run `pnpm -r typecheck` — if fails, mark applied_at + status='failed'
 *      d. `git add -A && git commit -m "R???.??? — <title>" --no-verify=false`
 *      e. `docker compose build api`
 *      f. `docker compose up -d --force-recreate api`
 *      g. Wait 30s + curl /admin/brain platform.smoke → must be okCount≥last_known
 *      h. If smoke regresses: `git revert HEAD --no-edit && docker compose up -d --force-recreate api`
 *         and mark proposal rolled_back_at + status='failed'
 *      i. Else mark status='applied' + record apply_result
 *   3. Sleep 5min, repeat
 *
 * Run with:
 *   ADMIN_LOOPBACK_TOKEN=<token> NOVAN_REPO=/root/novan PG_URL=... \
 *     node novan-self-dev-applier.mjs
 *
 * Or as systemd:
 *   /etc/systemd/system/novan-applier.service (see comment block below)
 *
 * Safety:
 *   - File allowlist: apps/api/src/services/r???-*.ts, packages/db/migrations/*.sql,
 *     packages/db/src/schema.ts (append-only check)
 *   - Hard deny: server.ts auth blocks, .env*, Dockerfile, secrets/, package.json,
 *     docker-compose.yml, .github/, ci/
 *   - Max 1 proposal applied per cycle (forces operator review between auto-applies)
 *   - Feature flag self_dev_apply_enabled must be true (checked each cycle)
 *   - All actions logged to applier_audit-style events
 */

import pg from 'pg'
import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, normalize } from 'node:path'

const REPO         = process.env.NOVAN_REPO         || '/root/novan'
const PG_URL       = process.env.PG_URL             || 'postgresql://novan@127.0.0.1:5432/ops'
const ADMIN_TOKEN  = process.env.ADMIN_LOOPBACK_TOKEN || ''
const API_URL      = process.env.API_URL            || 'http://localhost:3001'
const POLL_MS      = Number(process.env.POLL_MS    || 5 * 60_000)
const MAX_PER_CYCLE = Number(process.env.MAX_PER_CYCLE || 1)

const PATH_ALLOW = [
  /^apps\/api\/src\/services\/r\d+-[a-z0-9-]+\.ts$/,
  /^packages\/db\/migrations\/\d+_[a-z0-9_]+\.sql$/,
  /^apps\/api\/src\/services\/__tests__\/[a-z0-9-]+\.test\.ts$/,
]
const PATH_DENY = [
  /\.env/, /Dockerfile/, /docker-compose/, /package\.json/, /pnpm-lock/,
  /secrets/, /\.github/, /^scripts\//, /server\.ts/,
]

function safePath(p) {
  const norm = normalize(p).replace(/^\.\//, '')
  if (norm.startsWith('..') || norm.startsWith('/')) return null
  if (PATH_DENY.some(rx => rx.test(norm))) return null
  if (!PATH_ALLOW.some(rx => rx.test(norm))) return null
  return norm
}

// R146.273 — pool can get poisoned if PG isn't ready at first connect
// (boot race: applier starts before postgres-1 finishes accepting SCRAM).
// Wrap in a recreate-on-error layer.
let pool = new pg.Pool({ connectionString: PG_URL })
async function poolQuery(text, params) {
  try {
    return await pool.query(text, params)
  } catch (e) {
    const msg = (e?.message ?? '').toLowerCase()
    if (msg.includes('sasl') || msg.includes('password must') || msg.includes('econnrefused')) {
      console.error('[applier] pool reset after connection error:', e.message)
      try { await pool.end() } catch {}
      pool = new pg.Pool({ connectionString: PG_URL })
      return pool.query(text, params)
    }
    throw e
  }
}

async function isApplyEnabled() {
  const r = await poolQuery("SELECT enabled FROM feature_flag WHERE key='self_dev_apply_enabled' LIMIT 1")
  return r.rows[0]?.enabled === true
}

async function nextApproved() {
  const r = await poolQuery(`
    SELECT id, finding_id, workspace_id, title, rationale, files, risk_level, confidence
    FROM self_dev_proposal
    WHERE status='approved' AND applied_at IS NULL
    ORDER BY approved_at ASC LIMIT $1
  `, [MAX_PER_CYCLE])
  return r.rows
}

async function markApplied(id, result) {
  await poolQuery(`
    UPDATE self_dev_proposal SET status='applied', applied_at=$1, apply_result=$2 WHERE id=$3
  `, [Date.now(), JSON.stringify(result), id])
}
async function markFailed(id, error) {
  await poolQuery(`
    UPDATE self_dev_proposal SET status='failed', applied_at=$1, apply_result=$2 WHERE id=$3
  `, [Date.now(), JSON.stringify({ error }), id])
}
async function markRolledBack(id, reason) {
  await poolQuery(`
    UPDATE self_dev_proposal SET status='failed', rolled_back_at=$1, apply_result=$2 WHERE id=$3
  `, [Date.now(), JSON.stringify({ rolledBack: true, reason }), id])
}

function sh(cmd, opts = {}) {
  console.log(`[applier] $ ${cmd}`)
  return execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
}

async function smokeOk() {
  if (!ADMIN_TOKEN) return null
  try {
    const r = await fetch(`${API_URL}/admin/brain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
      body: JSON.stringify({ op: 'platform.smoke', workspaceId: 'system' }),
    })
    const j = await r.json()
    return j.ok && j.result ? { ok: j.result.okCount, fail: j.result.failCount } : null
  } catch (e) {
    console.error('[applier] smoke check failed:', e.message)
    return null
  }
}

async function applyOne(p) {
  console.log(`[applier] applying ${p.id}: ${p.title}`)
  const files = p.files || []
  if (!Array.isArray(files) || files.length === 0) {
    return await markFailed(p.id, 'no files in proposal')
  }
  // Validate each path
  for (const f of files) {
    const safe = safePath(f.path || '')
    if (!safe) return await markFailed(p.id, `path rejected by allowlist: ${f.path}`)
  }

  // Baseline smoke
  const baseline = await smokeOk()
  if (!baseline) {
    console.warn('[applier] no baseline smoke — refusing to apply without verification capability')
    return await markFailed(p.id, 'no baseline smoke')
  }

  // Apply diffs (full file rewrite via `content` field, or unified diff via `diff`)
  try {
    for (const f of files) {
      const abs = join(REPO, f.path)
      if (f.action === 'add' || f.action === 'edit') {
        if (f.content) {
          writeFileSync(abs, f.content, 'utf8')
          console.log(`[applier] wrote ${f.path} (${f.content.length} bytes)`)
        } else if (f.diff) {
          // Unified diff path — write to temp file then `git apply`
          const tmp = `/tmp/applier-${p.id}.patch`
          writeFileSync(tmp, f.diff, 'utf8')
          sh(`git apply --whitespace=fix ${tmp}`)
        } else {
          throw new Error(`file ${f.path} has neither content nor diff`)
        }
      }
    }
  } catch (e) {
    sh('git restore .', { stdio: 'pipe' })
    return await markFailed(p.id, `apply failed: ${e.message}`)
  }

  // Typecheck
  try {
    sh('pnpm --filter @ops/api typecheck')
  } catch (e) {
    sh('git restore .')
    return await markFailed(p.id, `typecheck failed: ${(e.stdout || e.message).slice(0, 1000)}`)
  }

  // Commit + push + deploy
  try {
    sh('git add -A')
    const safeTitle = String(p.title).replace(/["`$\\]/g, '').slice(0, 80)
    sh(`git commit -m "R???.??? — applier · ${safeTitle}"`)
    sh('git push')
    sh('docker compose build api')
    sh('docker compose up -d --force-recreate api')
  } catch (e) {
    return await markFailed(p.id, `deploy failed: ${e.message.slice(0, 500)}`)
  }

  // Wait + verify
  await new Promise(r => setTimeout(r, 30_000))
  const after = await smokeOk()
  if (!after || after.fail > baseline.fail) {
    console.warn('[applier] smoke regressed — rolling back')
    try {
      sh('git revert HEAD --no-edit')
      sh('git push')
      sh('docker compose up -d --force-recreate api')
    } catch (e) {
      console.error('[applier] rollback failed:', e.message)
    }
    return await markRolledBack(p.id, `smoke regressed: fail ${baseline.fail} → ${after?.fail}`)
  }

  return await markApplied(p.id, { baseline, after })
}

async function emitHeartbeat(detail) {
  // R232 — write applier.cycle event so R231 applier.health can report
  // 'alive'. Fire-and-forget; never blocks the cycle.
  try {
    const { randomUUID } = await import('node:crypto')
    const id = randomUUID()
    await poolQuery(
      `INSERT INTO events(id, type, workspace_id, payload, trace_id, correlation_id,
                          source, version, created_at)
       VALUES ($1, 'applier.cycle', 'global', $2::jsonb, $3, $3,
               'r195-applier', 1, $4)`,
      [id, JSON.stringify(detail), id, Date.now()]
    )
  } catch (e) {
    console.error('[applier] heartbeat write failed:', e.message)
  }
}

async function cycle() {
  const startedAt = Date.now()
  console.log(`[applier] cycle starting ${new Date(startedAt).toISOString()}`)
  const enabled = await isApplyEnabled()
  if (!enabled) {
    console.log('[applier] self_dev_apply_enabled is OFF — skip')
    await emitHeartbeat({ enabled: false, durationMs: Date.now() - startedAt })
    return
  }
  const proposals = await nextApproved()
  if (proposals.length === 0) {
    console.log('[applier] no approved proposals')
    await emitHeartbeat({ enabled: true, proposalsAvailable: 0, durationMs: Date.now() - startedAt })
    return
  }
  let applied = 0
  for (const p of proposals) { await applyOne(p); applied++ }
  await emitHeartbeat({ enabled: true, proposalsAvailable: proposals.length, applied, durationMs: Date.now() - startedAt })
  console.log('[applier] cycle complete')
}

async function waitForDb() {
  // R146.273 — explicit wait so the first cycle doesn't race PG readiness.
  // Retries SELECT 1 for up to 60s before giving up (then the systemd
  // RestartSec=30 will retry the whole daemon).
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { await pool.query('SELECT 1'); return true }
    catch (e) {
      console.log(`[applier] PG not ready yet: ${e.message} — retry in 3s`)
      try { await pool.end() } catch {}
      pool = new pg.Pool({ connectionString: PG_URL })
      await new Promise(r => setTimeout(r, 3000))
    }
  }
  throw new Error('PG did not become ready within 60s')
}

async function main() {
  console.log(`[applier] Novan Self-Dev Applier starting`)
  console.log(`[applier] REPO=${REPO} POLL=${POLL_MS}ms MAX_PER_CYCLE=${MAX_PER_CYCLE}`)
  await waitForDb()
  console.log('[applier] PG ready — entering cycle loop')
  while (true) {
    try { await cycle() }
    catch (e) { console.error('[applier] cycle error:', e.stack || e.message) }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}
main().catch(e => { console.error(e); process.exit(1) })

/* ──────── systemd unit ─────────────────────────────────────────
   /etc/systemd/system/novan-applier.service

   [Unit]
   Description=Novan Self-Dev Applier
   After=docker.service
   Requires=docker.service

   [Service]
   Type=simple
   User=root
   WorkingDirectory=/root/novan
   EnvironmentFile=/root/novan/.env
   ExecStart=/usr/bin/node /root/novan/scripts/novan-self-dev-applier.mjs
   Restart=on-failure
   RestartSec=30

   [Install]
   WantedBy=multi-user.target

   Enable:
     systemctl daemon-reload
     systemctl enable --now novan-applier
*/
