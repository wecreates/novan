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
import { join, resolve, sep }     from 'node:path'

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

/** Hard cap on bytes downloaded per image. Provider-generated images are
 *  ~5 MB at the high end; 50 MB gives 10× headroom while preventing a
 *  malicious URL from filling the disk in one call. */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

/** R146.37 — SSRF guard. Block obviously-internal targets before the
 *  fetch even happens. Live-confirmed pre-patch that fetchBytes would
 *  reach http://127.0.0.1:3001 (the API's own loopback), internal Docker
 *  hostnames like novan-redis-1, and link-local (169.254.169.254 metadata).
 *
 *  Residual risk we explicitly accept:
 *    - DNS rebind: a hostname that resolves public then re-resolves
 *      private mid-fetch. Mitigated only by custom dispatcher; out of
 *      scope here.
 *    - Redirects to internal targets. fetch() default redirect: 'follow';
 *      we use redirect: 'error' below so any redirect throws — image
 *      providers (Gemini/OpenAI/Replicate) all return 200 direct, so
 *      this doesn't break legit traffic. */
function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '' || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h.startsWith('novan-') || h === 'postgres' || h === 'redis') return true
  // IPv4 literal — block private + loopback + link-local + 0.0.0.0
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [, a, b] = m.map(Number) as [number, number, number, number, number]
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  // IPv6 literal — block loopback + link-local + ULA + bracketed forms
  if (h === '::1' || h === '[::1]' || h.startsWith('[fe80:') || h.startsWith('[fc') || h.startsWith('[fd') || h === '::') return true
  return false
}

async function fetchBytes(url: string): Promise<Buffer> {
  // Data URL passthrough
  if (url.startsWith('data:')) {
    const [meta, payload] = url.split(',', 2)
    if (!meta || !payload) throw new Error('invalid data url')
    const buf = meta.includes(';base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(`data url too large: ${buf.length} bytes (max ${MAX_IMAGE_BYTES})`)
    }
    return buf
  }
  // R146.37 — SSRF guard: scheme + host allowlist before fetch.
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('invalid url') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`scheme not allowed: ${parsed.protocol}`)
  }
  if (isInternalHost(parsed.hostname)) {
    throw new Error(`internal host blocked: ${parsed.hostname}`)
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' })
  if (!res.ok) throw new Error(`fetch ${res.status}`)
  // Pre-check Content-Length when present. Catches large payloads before
  // we materialize them in memory.
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${declared} bytes (max ${MAX_IMAGE_BYTES})`)
  }
  // Stream + enforce running total in case Content-Length was lying or absent.
  const reader = res.body?.getReader()
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large: ${buf.length} bytes`)
    return buf
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch((e: Error) => { console.error('[image-storage]', e.message); return null })
      throw new Error(`image exceeded ${MAX_IMAGE_BYTES} bytes mid-stream — aborted`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)))
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
  // Defense in depth: even though `key` here is built from imageId +
  // a known extension, callers have been known to pass values like
  // `../../../etc/passwd`. resolve() + prefix-check ensures the final
  // path stays within LOCAL_DIR.
  const base = resolve(LOCAL_DIR)
  const target = resolve(base, key)
  if (!target.startsWith(base + sep) && target !== base) {
    throw new Error(`localPut: refused path traversal: ${key}`)
  }
  await writeFile(target, bytes)
  return `file://${target}`
}

// ─── Public ──────────────────────────────────────────────────────────────────

/** Sniff the leading bytes of a buffer for a supported image MIME type.
 *  Returns null if no signature matches — the caller refuses persistence
 *  on null. Without this check, a `data:text/plain;…` URL or an HTML
 *  error page from a provider would land on disk as a `.png`. */
function detectImageMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | null {
  if (buf.length < 12) return null
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png'
  // WebP: 'RIFF' …4 bytes… 'WEBP'
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  // GIF: 'GIF87a' | 'GIF89a'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  return null
}

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
  // MIME validation: sniff the magic bytes rather than trusting the
  // caller-supplied contentType. A data URL like `data:text/plain;…`
  // would previously land on disk with a `.png` extension because the
  // detection used `.includes('jpeg')` on the contentType string alone.
  const detected = detectImageMime(bytes)
  if (!detected) {
    throw new Error(`storeImage: bytes do not match any supported image format (jpeg/png/webp/gif)`)
  }
  const ext = detected === 'image/jpeg' ? 'jpg'
            : detected === 'image/png'  ? 'png'
            : detected === 'image/webp' ? 'webp'
            : 'gif'
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
