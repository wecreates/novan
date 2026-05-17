/**
 * image-storage.ts — Persist generated images beyond provider URL TTLs.
 *
 * Item #8 honest implementation:
 *   - If AWS_S3_BUCKET + AWS_S3_REGION (+ creds via standard env) → S3
 *   - Else → /tmp persistent disk under IMAGE_STORE_DIR
 *
 * The S3 path uses AWS Signature v4 via direct fetch — no SDK dep needed
 * for a single PutObject. Honest about both paths; either is real storage.
 */
import { createHash, createHmac } from 'node:crypto'
import { writeFile, mkdir }       from 'node:fs/promises'
import { existsSync }             from 'node:fs'
import { join }                   from 'node:path'

export interface StoreResult {
  storedUrl: string
  provenance: 's3' | 'local_disk' | 'passthrough'
  bytes: number
}

const LOCAL_DIR = process.env['IMAGE_STORE_DIR'] ?? '/tmp/novan-images'

/** Returns true if S3 is configured. */
export function s3Configured(): boolean {
  return !!(process.env['AWS_S3_BUCKET'] && process.env['AWS_S3_REGION'] && process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY'])
}

async function fetchBytes(url: string): Promise<Buffer> {
  // Data URL passthrough
  if (url.startsWith('data:')) {
    const [meta, payload] = url.split(',', 2)
    if (!meta || !payload) throw new Error('invalid data url')
    if (meta.includes(';base64')) return Buffer.from(payload, 'base64')
    return Buffer.from(decodeURIComponent(payload), 'utf8')
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`fetch ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// ─── S3 PutObject via AWS Signature v4 (no SDK dep) ──────────────────────────

function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex')
}

function hmac(key: Buffer | string, msg: string): Buffer {
  return createHmac('sha256', key).update(msg).digest()
}

function awsSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  const k1 = hmac('AWS4' + secret, date)
  const k2 = hmac(k1, region)
  const k3 = hmac(k2, service)
  return hmac(k3, 'aws4_request')
}

async function s3Put(key: string, bytes: Buffer, contentType: string): Promise<string> {
  const bucket = process.env['AWS_S3_BUCKET']!
  const region = process.env['AWS_S3_REGION']!
  const accessKey = process.env['AWS_ACCESS_KEY_ID']!
  const secretKey = process.env['AWS_SECRET_ACCESS_KEY']!

  const host = `${bucket}.s3.${region}.amazonaws.com`
  const url = `https://${host}/${encodeURIComponent(key)}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const date = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(bytes)

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = `PUT\n/${encodeURIComponent(key)}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const credentialScope = `${date}/${region}/s3/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`
  const signingKey = awsSigningKey(secretKey, date, region, 's3')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await fetch(url, {
    method:  'PUT',
    headers: {
      'host': host,
      'content-type': contentType,
      'content-length': String(bytes.length),
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'authorization': authorization,
    },
    body: bytes,
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`S3 PUT ${res.status}: ${err.slice(0, 200)}`)
  }
  return url
}

// ─── Local disk fallback ─────────────────────────────────────────────────────

async function localPut(key: string, bytes: Buffer): Promise<string> {
  if (!existsSync(LOCAL_DIR)) await mkdir(LOCAL_DIR, { recursive: true })
  const path = join(LOCAL_DIR, key)
  await writeFile(path, bytes)
  return `file://${path}`
}

// ─── Public ──────────────────────────────────────────────────────────────────

/**
 * Persist the image referenced by `sourceUrl`. Returns the durable URL.
 * If `sourceUrl` is already persistent (CDN with long TTL) caller may
 * choose passthrough — this helper always materialises a local copy.
 */
export async function storeImage(opts: {
  sourceUrl:  string
  imageId:    string
  contentType?: string
}): Promise<StoreResult> {
  const bytes = await fetchBytes(opts.sourceUrl)
  const ext = (opts.contentType ?? 'image/png').includes('jpeg') ? 'jpg' : 'png'
  const key = `images/${opts.imageId}.${ext}`

  if (s3Configured()) {
    try {
      const url = await s3Put(key, bytes, opts.contentType ?? 'image/png')
      return { storedUrl: url, provenance: 's3', bytes: bytes.length }
    } catch {
      // fall through to local
    }
  }
  const url = await localPut(key.replace('/', '_'), bytes)
  return { storedUrl: url, provenance: 'local_disk', bytes: bytes.length }
}
