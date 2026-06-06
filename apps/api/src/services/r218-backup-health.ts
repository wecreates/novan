/**
 * R146.218 — Backup freshness check. Reads /root/backups/ inside the
 * api container's mount (or wherever BACKUP_DIR points) and reports the
 * newest *.sql.gz file's age. Surface into platform.status so a missed
 * daily run is visible immediately.
 *
 * Container must mount /root/backups → /backups for this to read host
 * files; we accept either path via BACKUP_DIR env.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const DEFAULT_DIRS = ['/backups', '/root/backups']

export interface BackupHealth {
  dir:             string | null
  newestAt:        number | null
  newestFilename:  string | null
  newestSizeBytes: number | null
  ageHours:        number | null
  status:          'fresh' | 'stale' | 'missing' | 'unreachable'
  recentCount24h:  number
}

export async function backupHealth(): Promise<BackupHealth> {
  const candidates = [process.env['BACKUP_DIR'], ...DEFAULT_DIRS].filter(Boolean) as string[]
  let dir: string | null = null
  for (const d of candidates) {
    try {
      const stat = await fs.stat(d)
      if (stat.isDirectory()) { dir = d; break }
    } catch { /* not present, try next */ }
  }
  if (!dir) {
    return { dir: null, newestAt: null, newestFilename: null, newestSizeBytes: null, ageHours: null, status: 'unreachable', recentCount24h: 0 }
  }
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return { dir, newestAt: null, newestFilename: null, newestSizeBytes: null, ageHours: null, status: 'unreachable', recentCount24h: 0 }
  }
  const dumps = entries.filter(f => /\.sql(\.gz)?$/.test(f))
  if (dumps.length === 0) {
    return { dir, newestAt: null, newestFilename: null, newestSizeBytes: null, ageHours: null, status: 'missing', recentCount24h: 0 }
  }
  let newestMtime = 0
  let newestName = ''
  let newestSize = 0
  let recent24 = 0
  const now = Date.now()
  for (const name of dumps) {
    try {
      const s = await fs.stat(path.join(dir, name))
      const mt = s.mtime.getTime()
      if (mt > newestMtime) { newestMtime = mt; newestName = name; newestSize = s.size }
      if (now - mt < 24 * 3600_000) recent24++
    } catch { /* skip */ }
  }
  const ageHours = (now - newestMtime) / 3600_000
  const status: BackupHealth['status'] = ageHours <= 36 ? 'fresh' : 'stale'
  return {
    dir, newestAt: newestMtime, newestFilename: newestName, newestSizeBytes: newestSize,
    ageHours: Number(ageHours.toFixed(1)), status, recentCount24h: recent24,
  }
}
