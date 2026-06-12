/**
 * R692 — Automated Postgres backups to S3 (via R616 bucket).
 *
 * Runs `pg_dump` in the API container against the postgres service, gzips
 * the output, uploads to s3://<bucket>/backups/YYYY-MM-DD-HHmm.sql.gz.
 * Cron: 03:00 UTC daily. Retention: 14 days hot + monthly snapshot for 12 months.
 *
 * Lives alongside R616's S3 client. Failures are loud (R686 notify) because
 * a silent broken backup is the worst kind of bug.
 */
import { spawn } from 'child_process'
import { mkdtemp, rm, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest()
}
function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

export interface BackupResult {
  ok:         boolean
  s3Key?:     string
  publicUrl?: string  // present only on success
  bytes?:     number
  durationMs: number
  error?:     string
}

const DB_HOST = process.env['POSTGRES_HOST'] ?? 'postgres'
const DB_USER = process.env['POSTGRES_USER'] ?? 'novan'
const DB_NAME = process.env['POSTGRES_DB']   ?? 'ops'
const DB_PASS = process.env['POSTGRES_PASSWORD'] ?? ''

function s3Key(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `backups/${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.sql.gz`
}

export async function runBackup(): Promise<BackupResult> {
  const t0 = Date.now()
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'r692-'))
  const outFile = path.join(tmp, 'dump.sql.gz')

  try {
    // pg_dump | gzip → file. Spawn pg_dump with PGPASSWORD env.
    await new Promise<void>((resolve, reject) => {
      const env = { ...process.env, PGPASSWORD: DB_PASS }
      const dump = spawn('pg_dump', ['-h', DB_HOST, '-U', DB_USER, '-d', DB_NAME, '-Z', '6', '-f', outFile], { env, stdio: ['ignore', 'inherit', 'inherit'] })
      const killer = setTimeout(() => { try { dump.kill('SIGKILL') } catch { /* ignore */ } reject(new Error('pg_dump timeout')) }, 5 * 60_000)
      dump.on('exit', code => { clearTimeout(killer); code === 0 ? resolve() : reject(new Error(`pg_dump exit ${code}`)) })
      dump.on('error', reject)
    })

    const st = await stat(outFile)

    // Upload off-site via the same S3 creds R616 uses for assets.
    // R692 — stream the file in to avoid OOM on multi-hundred-MB dumps.
    const key = s3Key()
    const publicUrl: string = await directS3PutStream(key, outFile, st.size)

    return {
      ok: true,
      s3Key: key,
      publicUrl,
      bytes: st.size,
      durationMs: Date.now() - t0,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message, durationMs: Date.now() - t0 }
  } finally {
    try { await rm(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

interface S3Cfg { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string }
function loadCfg(): S3Cfg {
  const endpoint  = process.env['NOVAN_OFFSITE_S3_ENDPOINT']
  const region    = process.env['NOVAN_OFFSITE_S3_REGION']    ?? 'us-east-1'
  const bucket    = process.env['NOVAN_OFFSITE_S3_BUCKET']    ?? 'novan-backups'
  const accessKey = process.env['NOVAN_OFFSITE_S3_ACCESS_KEY']
  const secretKey = process.env['NOVAN_OFFSITE_S3_SECRET_KEY']
  if (!endpoint || !accessKey || !secretKey) throw new Error('NOVAN_OFFSITE_S3_* env not configured')
  return { endpoint: endpoint.replace(/^https?:\/\//, ''), region, bucket, accessKey, secretKey }
}

/** AWS SigV4 PUT (streaming + UNSIGNED-PAYLOAD). Works against DO Spaces / AWS S3 / MinIO. */
async function directS3PutStream(key: string, filePath: string, contentLength: number): Promise<string> {
  const cfg = loadCfg()
  const host = `${cfg.bucket}.${cfg.endpoint}`
  const url  = `https://${host}/${key}`
  const bodyHash = 'UNSIGNED-PAYLOAD'
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d+Z$/, 'Z')
  const dateStamp = amzDate.slice(0, 8)
  const canonicalUri = `/${key}`
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`
  const kDate = hmac('AWS4' + cfg.secretKey, dateStamp)
  const kRegion = hmac(kDate, cfg.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = hmac(kSigning, stringToSign).toString('hex')
  const authHeader = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const stream = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Host':                 host,
      'x-amz-content-sha256': bodyHash,
      'x-amz-date':           amzDate,
      'Authorization':        authHeader,
      'Content-Type':         'application/gzip',
      'Content-Length':       String(contentLength),
    },
    body: stream,
    // @ts-expect-error — undici-specific; required to send a streaming body
    duplex: 'half',
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`S3 PUT ${res.status}: ${txt.slice(0, 300)}`)
  }
  return url
}

async function s3SignedRequest(method: 'GET' | 'DELETE', pathPlusQuery: string): Promise<Response> {
  const cfg = loadCfg()
  const host = `${cfg.bucket}.${cfg.endpoint}`
  const bodyHash = sha256Hex('')
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d+Z$/, 'Z')
  const dateStamp = amzDate.slice(0, 8)
  const qIdx = pathPlusQuery.indexOf('?')
  const canonicalUri = qIdx >= 0 ? pathPlusQuery.slice(0, qIdx) : pathPlusQuery
  // SigV4 canonical query: sort by key, URI-encode value separately. Each `key=val`
  // pair joined with `&`, value with RFC 3986 encoding (slashes become %2F, etc.).
  const rawQuery = qIdx >= 0 ? pathPlusQuery.slice(qIdx + 1) : ''
  const canonicalQuery = rawQuery
    ? rawQuery.split('&').map(p => {
        const [k, ...rest] = p.split('=')
        const v = rest.join('=')
        return `${k}=${encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`
      }).sort().join('&')
    : ''
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`
  const kDate = hmac('AWS4' + cfg.secretKey, dateStamp)
  const kRegion = hmac(kDate, cfg.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = hmac(kSigning, stringToSign).toString('hex')
  const authHeader = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  // Use the canonicalized query in the URL too so the signature matches.
  const finalPath = canonicalQuery ? `${canonicalUri}?${canonicalQuery}` : canonicalUri
  return fetch(`https://${host}${finalPath}`, {
    method,
    headers: {
      'Host':                 host,
      'x-amz-content-sha256': bodyHash,
      'x-amz-date':           amzDate,
      'Authorization':        authHeader,
    },
  })
}

export async function listBackups(): Promise<Array<{ key: string; size: number; lastModified: string }>> {
  try {
    const res = await s3SignedRequest('GET', '/?list-type=2&prefix=backups/&max-keys=200')
    if (!res.ok) return []
    const xml = await res.text()
    const out: Array<{ key: string; size: number; lastModified: string }> = []
    const re = /<Contents>([\s\S]*?)<\/Contents>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml)) !== null) {
      const block = m[1] ?? ''
      const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? ''
      const size = Number(block.match(/<Size>([^<]+)<\/Size>/)?.[1] ?? '0')
      const lm = block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? ''
      if (key) out.push({ key, size, lastModified: lm })
    }
    return out.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
  } catch { return [] }
}

/** Delete backups older than `retentionDays` except those from the 1st of each month (12mo keepers). */
export async function pruneOldBackups(retentionDays = 14): Promise<{ ok: boolean; deleted: number; kept: number }> {
  const all = await listBackups()
  if (all.length === 0) return { ok: true, deleted: 0, kept: 0 }
  const cutoff = Date.now() - retentionDays * 86400_000
  const aYearAgo = Date.now() - 365 * 86400_000
  let deleted = 0, kept = 0
  for (const b of all) {
    const t = new Date(b.lastModified).getTime()
    if (!Number.isFinite(t)) { kept++; continue }
    const isMonthlyKeeper = b.key.match(/-(\d{4})-(\d{2})-01-/) && t > aYearAgo
    if (t < cutoff && !isMonthlyKeeper) {
      try {
        const res = await s3SignedRequest('DELETE', `/${b.key}`)
        if (res.ok || res.status === 204) deleted++; else kept++
      } catch { kept++ }
    } else kept++
  }
  return { ok: true, deleted, kept }
}
