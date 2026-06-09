/**
 * R429 — Nightly pg_dump backup of Novan-specific tables.
 *
 * Runs once per UTC day at 04:00 UTC (low-traffic window). Dumps the tables
 * the autonomous loop owns into /root/novan/backups/<date>.sql.gz and rolls
 * the last 14 days. Single-node droplet so this is on-host — not off-site,
 * but recoverable from snapshot history if filesystem survives.
 *
 * For off-site: operator should additionally configure DigitalOcean droplet
 * snapshots (weekly) OR rsync to a remote.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// R449 — moved backups outside the project dir so docker compose down -v can't
// touch them, and so git status stays clean.
const BACKUP_DIR = process.env['NOVAN_BACKUP_DIR'] ?? '/var/lib/novan/backups'
const DESIGN_STORE = process.env['NOVAN_DESIGN_STORE'] ?? '/var/lib/novan/design-files'
const RETENTION_DAYS = Number(process.env['NOVAN_BACKUP_RETENTION_DAYS'] ?? 14)
const NOVAN_TABLES = [
  'business_revenue', 'design_catalog', 'design_upload_queue',
  'pinterest_pin_queue', 'pacing_overrides', 'upload_pacing',
  'disabled_platforms', 'platform_first_sale',
  'platform_selectors',
  'cron_health', 'ai_spend',
  'daily_cron_runs', 'daily_summary_pushes', 'weekly_recap_pushes',
  'next_action_pushes',
  'listing_template_outcomes',
  'design_files',
  'workspace_settings',
  // R450 — include events so the agent.upload.failed payloads R421 reads
  // for selector improvement survive a DB rebuild.
  'events',
]

function todayYYYYMMDD(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

export interface BackupResult {
  ok:               boolean
  path?:            string
  sizeBytes?:       number
  durationMs:       number
  prunedFiles:      string[]
  designTarPath?:   string
  designTarBytes?:  number
  error?:           string
}

export async function runNightlyBackup(): Promise<BackupResult> {
  const start = Date.now()
  const dbUrl = process.env['DATABASE_URL']
  if (!dbUrl) return { ok: false, durationMs: 0, prunedFiles: [], error: 'DATABASE_URL not set' }

  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }) } catch { /* tolerated */ }
  const file = path.join(BACKUP_DIR, `novan-${todayYYYYMMDD()}.sql.gz`)
  const args = ['--no-owner', '--no-acl', '--data-only', ...NOVAN_TABLES.flatMap(t => ['-t', t]), dbUrl]

  await new Promise<void>((resolve, reject) => {
    const dump = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const gzip = spawn('gzip', ['-9'], { stdio: ['pipe', 'pipe', 'pipe'] })
    dump.stdout.pipe(gzip.stdin)
    const out = fs.createWriteStream(file)
    gzip.stdout.pipe(out)
    let stderr = ''
    dump.stderr.on('data', d => { stderr += d.toString() })
    gzip.stderr.on('data', d => { stderr += d.toString() })
    out.on('close', () => resolve())
    out.on('error', e => reject(new Error(`write: ${e.message}; stderr: ${stderr}`)))
    dump.on('error', e => reject(new Error(`pg_dump: ${e.message}`)))
    gzip.on('error', e => reject(new Error(`gzip: ${e.message}`)))
    dump.on('close', code => { if (code !== 0) reject(new Error(`pg_dump exit ${code}: ${stderr}`)) })
  })

  let sizeBytes = 0
  try { sizeBytes = fs.statSync(file).size } catch { /* tolerated */ }

  // R451 — also tar the design-files dir so R438-uploaded image bytes survive.
  let designTarPath: string | undefined
  let designTarBytes = 0
  try {
    if (fs.existsSync(DESIGN_STORE)) {
      designTarPath = path.join(BACKUP_DIR, `novan-designs-${todayYYYYMMDD()}.tar.gz`)
      await new Promise<void>((resolve, reject) => {
        const tar = spawn('tar', ['-czf', designTarPath!, '-C', path.dirname(DESIGN_STORE), path.basename(DESIGN_STORE)])
        tar.on('error', e => reject(e))
        tar.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)))
      })
      try { designTarBytes = fs.statSync(designTarPath).size } catch { /* tolerated */ }
    }
  } catch (e) { console.error('[r429] design tar:', (e as Error).message) }

  // Retention: prune files older than RETENTION_DAYS
  const pruned: string[] = []
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60_000
    for (const name of fs.readdirSync(BACKUP_DIR)) {
      if (!name.startsWith('novan-') || !name.endsWith('.sql.gz')) continue
      const full = path.join(BACKUP_DIR, name)
      try {
        const stat = fs.statSync(full)
        if (stat.mtimeMs < cutoff) { fs.unlinkSync(full); pruned.push(name) }
      } catch { /* tolerated */ }
    }
  } catch { /* tolerated */ }

  return { ok: true, path: file, sizeBytes, durationMs: Date.now() - start, prunedFiles: pruned, designTarPath, designTarBytes }
}
