/**
 * R611 — Zero-dep SMTP email fallback for R578 email-system.
 *
 * When Postmark isn't configured (POSTMARK_SERVER_TOKEN missing), but the
 * operator has set SMTP_HOST / SMTP_USER / SMTP_PASS, R578 transparently
 * routes through this implicit-TLS SMTP client. Same brain ops, same
 * response shape — callers don't change.
 *
 * Implementation notes:
 *   - Uses Node's built-in `tls` module — ZERO npm deps (no nodemailer).
 *   - Implicit TLS on SMTP_PORT (default 465). Most modern providers
 *     support this: AWS SES, Postmark SMTP, Gmail, Outlook, Fastmail.
 *   - AUTH LOGIN (base64 user/pass). PLAIN supported as fallback.
 *   - Single message per connection (no pooling — Novan's email volume
 *     is low enough this doesn't matter).
 *   - Times out at SMTP_TIMEOUT_MS (default 15s).
 *
 * Env:
 *   SMTP_HOST          required, e.g. email-smtp.us-east-1.amazonaws.com
 *   SMTP_PORT          optional, default 465
 *   SMTP_USER          required, SMTP username (often base64-encoded for SES)
 *   SMTP_PASS          required, SMTP password
 *   SMTP_FROM          optional, overrides EMAIL_FROM for SMTP path only
 *   SMTP_TIMEOUT_MS    optional, default 15000
 */
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { createConnection as netConnect, type Socket as NetSocket } from 'node:net'

export interface SmtpSendInput {
  from:     string
  to:       string
  subject:  string
  bodyText: string
  bodyHtml?:string
  replyTo?: string
  unsubscribeUrl?: string
}

export interface SmtpSendResult {
  ok:           boolean
  smtpResponse?:string
  error?:       string
  durationMs:   number
}

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? '')
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function smtpConfigured(): boolean {
  return !!(process.env['SMTP_HOST'] && process.env['SMTP_USER'] && process.env['SMTP_PASS'])
}

/** Headers + body in CRLF-delimited RFC 5322 form. */
function buildMessage(input: SmtpSendInput): string {
  const lines: string[] = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject.replace(/[\r\n]/g, ' ').slice(0, 200)}`,
    `MIME-Version: 1.0`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2, 10)}@novan.local>`,
  ]
  if (input.replyTo) lines.push(`Reply-To: ${input.replyTo}`)
  if (input.unsubscribeUrl) {
    lines.push(`List-Unsubscribe: <${input.unsubscribeUrl}>`)
    lines.push(`List-Unsubscribe-Post: List-Unsubscribe=One-Click`)
  }
  if (input.bodyHtml) {
    const boundary = `==NOVAN_${Date.now().toString(36)}==`
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    lines.push('')
    lines.push(`--${boundary}`)
    lines.push(`Content-Type: text/plain; charset=utf-8`)
    lines.push(`Content-Transfer-Encoding: 7bit`)
    lines.push('')
    lines.push(input.bodyText)
    lines.push('')
    lines.push(`--${boundary}`)
    lines.push(`Content-Type: text/html; charset=utf-8`)
    lines.push(`Content-Transfer-Encoding: 7bit`)
    lines.push('')
    lines.push(input.bodyHtml)
    lines.push('')
    lines.push(`--${boundary}--`)
  } else {
    lines.push(`Content-Type: text/plain; charset=utf-8`)
    lines.push(`Content-Transfer-Encoding: 7bit`)
    lines.push('')
    lines.push(input.bodyText)
  }
  return lines.join('\r\n')
}

/** Dot-stuff per RFC 5321 §4.5.2 — any line starting with '.' gets doubled. */
function dotStuff(message: string): string {
  return message.split('\r\n').map(l => l.startsWith('.') ? `.${l}` : l).join('\r\n')
}

interface SmtpConn {
  socket:  TLSSocket | NetSocket
  buffer:  string
  closed:  boolean
  /** Drains pending expecters when new data arrives or after a manual nudge. */
  pump?:   () => void
}

/** Install a persistent data handler that just accumulates into conn.buffer and
 *  calls conn.pump() whenever data arrives. expect() registers a temporary
 *  resolver — no per-call socket.on('data') leak. */
function attachDataPump(conn: SmtpConn): void {
  const onData = (d: Buffer): void => {
    conn.buffer += d.toString('utf8')
    if (conn.pump) conn.pump()
  }
  conn.socket.on('data', onData)
}

/** Decide whether to use implicit TLS (port 465 / SMTP_SECURE=1) or STARTTLS
 *  upgrade (everything else, including Brevo's port 587). */
function shouldUseImplicitTls(port: number): boolean {
  if (process.env['SMTP_SECURE'] === '1' || process.env['SMTP_SECURE'] === 'true') return true
  return port === 465
}

/** Open a connected, EHLO'd, TLS-secured socket ready for AUTH.
 *  Handles both implicit-TLS (465) and STARTTLS-upgrade (587) paths. */
async function openSecureSmtp(host: string, port: number, timeoutMs: number): Promise<SmtpConn> {
  if (shouldUseImplicitTls(port)) {
    // Implicit TLS — direct TLS connect, then EHLO
    const socket = tlsConnect({ host, port, servername: host })
    const conn: SmtpConn = { socket, buffer: '', closed: false }
    socket.on('close', () => { conn.closed = true })
    socket.on('error', () => { /* surface via expect() timeout */ })
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`SMTP TLS connect timeout to ${host}:${port}`)), timeoutMs)
      socket.once('secureConnect', () => { clearTimeout(t); res() })
      socket.once('error', e => { clearTimeout(t); rej(e) })
    })
    attachDataPump(conn)
    await expect(conn, '220', timeoutMs)
    send(conn, `EHLO novan.local`)
    await expect(conn, '250', timeoutMs)
    return conn
  }

  // STARTTLS path: plain TCP → 220 → EHLO → STARTTLS → 220 → upgrade → re-EHLO
  const plainSocket = netConnect({ host, port })
  const plainConn: SmtpConn = { socket: plainSocket, buffer: '', closed: false }
  plainSocket.on('close', () => { plainConn.closed = true })
  plainSocket.on('error', () => { /* surface via expect() timeout */ })
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`SMTP plain connect timeout to ${host}:${port}`)), timeoutMs)
    plainSocket.once('connect', () => { clearTimeout(t); res() })
    plainSocket.once('error', e => { clearTimeout(t); rej(e) })
  })
  attachDataPump(plainConn)
  await expect(plainConn, '220', timeoutMs)
  send(plainConn, `EHLO novan.local`)
  await expect(plainConn, '250', timeoutMs)
  send(plainConn, `STARTTLS`)
  await expect(plainConn, '220', timeoutMs)
  // Strip plain-socket data listeners before TLS upgrade; the upgraded TLS
  // socket needs to receive the post-handshake data itself.
  plainSocket.removeAllListeners('data')
  // Upgrade to TLS over the same TCP socket
  const tlsSocket = tlsConnect({ socket: plainSocket, host, servername: host })
  const conn: SmtpConn = { socket: tlsSocket, buffer: '', closed: false }
  tlsSocket.on('close', () => { conn.closed = true })
  tlsSocket.on('error', () => { /* surface via expect() timeout */ })
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`SMTP STARTTLS upgrade timeout for ${host}:${port}`)), timeoutMs)
    tlsSocket.once('secureConnect', () => { clearTimeout(t); res() })
    tlsSocket.once('error', e => { clearTimeout(t); rej(e) })
  })
  attachDataPump(conn)
  // RFC 3207: must re-EHLO after STARTTLS
  send(conn, `EHLO novan.local`)
  await expect(conn, '250', timeoutMs)
  return conn
}

function expect(conn: SmtpConn, code: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true; conn.pump = undefined
      reject(new Error(`SMTP timeout waiting for ${code} (buffer head: ${conn.buffer.slice(0, 100).replace(/\r\n/g, ' | ')})`))
    }, timeoutMs)
    const tryDrain = (): void => {
      if (settled) return
      const lines = conn.buffer.split('\r\n')
      // Multi-line replies: continue with '-' until final ' ' separator on a line that starts with code.
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!
        if (line.length < 4) continue
        const sep = line.charAt(3)
        if (sep === ' ') {
          settled = true
          clearTimeout(timer)
          conn.pump = undefined
          const consumed = lines.slice(0, i + 1).join('\r\n') + '\r\n'
          conn.buffer = conn.buffer.slice(consumed.length)
          if (line.startsWith(code)) resolve(line)
          else reject(new Error(`SMTP expected ${code}, got: ${line.slice(0, 200)}`))
          return
        }
      }
    }
    conn.pump = tryDrain
    tryDrain()   // in case data already buffered
  })
}

function send(conn: SmtpConn, line: string): void {
  conn.socket.write(line + '\r\n')
}

export async function sendViaSMTP(input: SmtpSendInput): Promise<SmtpSendResult> {
  const t0 = Date.now()
  if (!smtpConfigured()) {
    return { ok: false, error: 'SMTP not configured (SMTP_HOST/USER/PASS missing)', durationMs: Date.now() - t0 }
  }
  const host = process.env['SMTP_HOST']!
  const port = envNum('SMTP_PORT', 465)
  const user = process.env['SMTP_USER']!
  const pass = process.env['SMTP_PASS']!
  const timeoutMs = envNum('SMTP_TIMEOUT_MS', 15_000)
  const from = process.env['SMTP_FROM'] ?? input.from
  const fromAddr = from.match(/<([^>]+)>/)?.[1] ?? from.trim()
  const toAddr   = input.to.match(/<([^>]+)>/)?.[1] ?? input.to.trim()

  let conn: SmtpConn | null = null
  try {
    conn = await openSecureSmtp(host, port, timeoutMs)
    send(conn, `AUTH LOGIN`)
    await expect(conn, '334', timeoutMs)
    send(conn, Buffer.from(user, 'utf8').toString('base64'))
    await expect(conn, '334', timeoutMs)
    send(conn, Buffer.from(pass, 'utf8').toString('base64'))
    await expect(conn, '235', timeoutMs)
    send(conn, `MAIL FROM:<${fromAddr}>`)
    await expect(conn, '250', timeoutMs)
    send(conn, `RCPT TO:<${toAddr}>`)
    await expect(conn, '250', timeoutMs)
    send(conn, `DATA`)
    await expect(conn, '354', timeoutMs)

    const message = dotStuff(buildMessage({ ...input, from }))
    send(conn, message)
    send(conn, '.')
    const final = await expect(conn, '250', timeoutMs)

    send(conn, 'QUIT')
    try { conn.socket.end() } catch { /* ignore */ }
    return { ok: true, smtpResponse: final.slice(0, 200), durationMs: Date.now() - t0 }
  } catch (e) {
    try { conn?.socket.destroy() } catch { /* ignore */ }
    return { ok: false, error: (e as Error).message.slice(0, 300), durationMs: Date.now() - t0 }
  }
}

/** Health probe — connects, completes TLS (incl. STARTTLS if 587), EHLO, QUIT. */
export async function smtpHealth(): Promise<{ ok: boolean; configured: boolean; reason?: string; mode?: 'implicit-tls' | 'starttls'; durationMs: number }> {
  const t0 = Date.now()
  if (!smtpConfigured()) return { ok: false, configured: false, reason: 'SMTP_HOST/USER/PASS not set', durationMs: 0 }
  const host = process.env['SMTP_HOST']!
  const port = envNum('SMTP_PORT', 465)
  const timeoutMs = envNum('SMTP_TIMEOUT_MS', 8_000)
  const mode: 'implicit-tls' | 'starttls' = shouldUseImplicitTls(port) ? 'implicit-tls' : 'starttls'
  try {
    const conn = await openSecureSmtp(host, port, timeoutMs)
    send(conn, 'QUIT')
    try { conn.socket.end() } catch { /* ignore */ }
    return { ok: true, configured: true, mode, durationMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, configured: true, mode, reason: (e as Error).message.slice(0, 200), durationMs: Date.now() - t0 }
  }
}
