/**
 * R508 — Off-site backup sync.
 *
 * After R429 writes a fresh nightly dump, this service uploads it to an
 * S3-compatible bucket (DO Spaces / Backblaze B2 / Cloudflare R2 / AWS S3
 * — all share the same API). Pure-Node SigV4, no aws-sdk dependency.
 *
 * Configuration via env:
 *   NOVAN_OFFSITE_S3_ENDPOINT      e.g. nyc3.digitaloceanspaces.com
 *   NOVAN_OFFSITE_S3_REGION        e.g. nyc3
 *   NOVAN_OFFSITE_S3_BUCKET        e.g. novan-backups
 *   NOVAN_OFFSITE_S3_KEY_PREFIX    e.g. droplet-novan/
 *   NOVAN_OFFSITE_S3_ACCESS_KEY    spaces / B2 / R2 access key id
 *   NOVAN_OFFSITE_S3_SECRET_KEY    spaces / B2 / R2 secret
 *
 * If any are unset, this is a no-op.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest()
}
function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

interface S3Config {
  endpoint:   string
  region:     string
  bucket:     string
  prefix:     string
  accessKey:  string
  secretKey:  string
}
function loadConfig(): S3Config | null {
  const e = process.env['NOVAN_OFFSITE_S3_ENDPOINT']
  const r = process.env['NOVAN_OFFSITE_S3_REGION']
  const b = process.env['NOVAN_OFFSITE_S3_BUCKET']
  const ak = process.env['NOVAN_OFFSITE_S3_ACCESS_KEY']
  const sk = process.env['NOVAN_OFFSITE_S3_SECRET_KEY']
  if (!e || !r || !b || !ak || !sk) return null
  return { endpoint: e, region: r, bucket: b, prefix: process.env['NOVAN_OFFSITE_S3_KEY_PREFIX'] ?? '', accessKey: ak, secretKey: sk }
}

/** Minimal S3 PUT with AWS SigV4. Uploads file as object at <prefix>/<basename>. */
async function s3Put(cfg: S3Config, file: string): Promise<{ ok: boolean; status: number; key: string }> {
  const body = fs.readFileSync(file)
  const bodyHash = sha256(body)
  const key = `${cfg.prefix}${path.basename(file)}`
  const host = `${cfg.bucket}.${cfg.endpoint}`
  const url  = `https://${host}/${key}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d+Z$/, 'Z')
  const dateStamp = amzDate.slice(0, 8)
  const service = 's3'
  const canonicalUri = `/${key}`
  const canonicalQuery = ''
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = `PUT\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`
  const credentialScope = `${dateStamp}/${cfg.region}/${service}/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256(canonicalRequest)}`
  const kDate = hmac('AWS4' + cfg.secretKey, dateStamp)
  const kRegion = hmac(kDate, cfg.region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = hmac(kSigning, stringToSign).toString('hex')
  const authHeader = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Host':                  host,
      'x-amz-content-sha256':  bodyHash,
      'x-amz-date':            amzDate,
      'Authorization':         authHeader,
      'Content-Length':        String(body.length),
    },
    body,
  })
  return { ok: res.ok, status: res.status, key }
}

export interface OffsiteSyncResult {
  configured:    boolean
  uploaded:      Array<{ key: string; status: number; bytes: number }>
  failed:        Array<{ file: string; reason: string }>
}

export async function syncBackupsOffsite(localDir = '/var/lib/novan/backups'): Promise<OffsiteSyncResult> {
  const cfg = loadConfig()
  const out: OffsiteSyncResult = { configured: cfg !== null, uploaded: [], failed: [] }
  if (!cfg) return out
  if (!fs.existsSync(localDir)) return out
  // R546 — first prune orphan .uploaded markers whose underlying file was
  // rotated out by R429 nightly-backup. Otherwise the markers accumulate
  // forever and `fs.readdirSync` slows linearly with retention age.
  for (const name of fs.readdirSync(localDir)) {
    if (!name.endsWith('.uploaded')) continue
    const sourceFile = path.join(localDir, name.replace(/\.uploaded$/, ''))
    if (!fs.existsSync(sourceFile)) {
      try { fs.unlinkSync(path.join(localDir, name)) } catch { /* tolerated */ }
    }
  }
  // Push files newer than 24h that haven't been uploaded yet (.uploaded marker)
  const cutoff = Date.now() - 25 * 60 * 60_000
  for (const name of fs.readdirSync(localDir)) {
    if (!/\.(sql|tar)\.gz$/.test(name)) continue
    const full = path.join(localDir, name)
    const marker = full + '.uploaded'
    if (fs.existsSync(marker)) continue
    try {
      const stat = fs.statSync(full)
      if (stat.mtimeMs < cutoff) continue
      const r = await s3Put(cfg, full)
      if (r.ok) {
        out.uploaded.push({ key: r.key, status: r.status, bytes: stat.size })
        fs.writeFileSync(marker, String(Date.now()))
      } else {
        out.failed.push({ file: name, reason: `HTTP ${r.status}` })
      }
    } catch (e) {
      out.failed.push({ file: name, reason: (e as Error).message.slice(0, 200) })
    }
  }
  return out
}
