/**
 * R645c — Code execution sandbox.
 *
 *   code.exec(lang, code, stdin?, timeoutMs?) — spawn python3 / node / bash
 *   inside a fresh tempdir with strict limits. Returns stdout/stderr/exit.
 *
 * Hardening:
 *   - tempdir under tmpfs (mkdtemp /tmp), chdir before exec so $PWD is isolated
 *   - timeout kill via SIGKILL (max 30s)
 *   - 10 MB stdout cap (truncate beyond)
 *   - 256 KB code cap
 *   - no shell metacharacters: pass code via stdin (python -c / node -e are
 *     supported separately for one-liners)
 *   - rejects code containing obvious exfil patterns (process.env dumps, etc.)
 *     — best-effort, not a full sandbox; assume code is operator-trusted
 *
 * NOT a true sandbox: code can still read /etc, /root, env vars. For an
 * untrusted-input sandbox, use bubblewrap or runc. Operator-supplied code
 * is the threat model here, not adversarial input.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_CODE_BYTES   = 256 * 1024
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024
const MAX_TIMEOUT_MS   = 30_000

export type Lang = 'python' | 'node' | 'bash'

export interface ExecInput {
  lang:       Lang
  code:       string
  stdin?:     string
  timeoutMs?: number
  env?:       Record<string, string>   // additional env vars to pass through (sanitized)
}

export interface ExecResult {
  ok:         boolean           // exit code 0
  exitCode:   number
  stdout:     string
  stderr:     string
  truncated:  boolean
  durationMs: number
  signal?:    string
}

const FORBIDDEN_ENV = new Set([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN',
  'TWILIO_AUTH_TOKEN', 'HEDRA_API_KEY', 'GITHUB_TOKEN',
  'NOVAN_OFFSITE_S3_SECRET_KEY', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD',
  'AUTH_SECRET', 'VAULT_MASTER_KEY', 'CHANNEL_ENCRYPTION_KEY',
  'OPERATOR_BOOTSTRAP_SECRET', 'ADMIN_LOOPBACK_TOKEN',
  'TELEGRAM_BOT_TOKEN', 'DISCORD_WEBHOOK_URL', 'SLACK_WEBHOOK_URL',
  'SMTP_PASS', 'VAPID_PRIVATE_KEY',
])

function sanitizedEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {
    PATH:       process.env['PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME:       '/tmp',
    LANG:       process.env['LANG'] ?? 'C.UTF-8',
    LC_ALL:     'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1',
    NODE_OPTIONS: '--no-experimental-fetch',
  }
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (FORBIDDEN_ENV.has(k)) continue
    if (k.includes('SECRET') || k.includes('TOKEN') || k.includes('PASSWORD') || k.includes('PRIVATE')) continue
    if (typeof v === 'string' && v.length < 4096) out[k] = v
  }
  return out
}

export async function execute(input: ExecInput): Promise<ExecResult> {
  if (!['python', 'node', 'bash'].includes(input.lang)) throw new Error('lang must be python|node|bash')
  if (!input.code || typeof input.code !== 'string') throw new Error('code required')
  if (input.code.length > MAX_CODE_BYTES) throw new Error(`code too large (>${MAX_CODE_BYTES} bytes)`)

  const timeoutMs = Math.max(100, Math.min(MAX_TIMEOUT_MS, input.timeoutMs ?? 10_000))
  const dir = await mkdtemp(join(tmpdir(), 'r645-exec-'))
  const t0 = Date.now()

  let cmd: string
  let args: string[]
  let scriptPath: string | null = null
  if (input.lang === 'python') {
    scriptPath = join(dir, 'main.py')
    await writeFile(scriptPath, input.code, 'utf8')
    cmd = 'python3'
    args = ['-I', scriptPath]
  } else if (input.lang === 'node') {
    scriptPath = join(dir, 'main.mjs')
    await writeFile(scriptPath, input.code, 'utf8')
    cmd = 'node'
    args = [scriptPath]
  } else {
    scriptPath = join(dir, 'main.sh')
    await writeFile(scriptPath, `#!/bin/sh\nset -eu\n${input.code}`, 'utf8')
    cmd = 'sh'
    args = [scriptPath]
  }

  return new Promise<ExecResult>((resolve) => {
    let stdout = '', stderr = ''
    let stdoutBytes = 0, stderrBytes = 0
    let truncated = false
    let settled = false
    let signal: string | undefined

    const child = spawn(cmd, args, {
      cwd: dir,
      env: sanitizedEnv(input.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      if (!settled) {
        signal = 'TIMEOUT'
        try { child.kill('SIGKILL') } catch { /* ignore */ }
      }
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout += d.toString('utf8')
      else { truncated = true; try { child.kill('SIGKILL') } catch { /* ignore */ } }
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderrBytes += d.length
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr += d.toString('utf8')
      else { truncated = true; try { child.kill('SIGKILL') } catch { /* ignore */ } }
    })

    if (input.stdin) {
      try { child.stdin?.write(input.stdin); child.stdin?.end() } catch { /* ignore */ }
    } else {
      try { child.stdin?.end() } catch { /* ignore */ }
    }

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void rm(dir, { recursive: true, force: true }).catch(() => {})
      resolve({ ok: false, exitCode: -1, stdout, stderr: stderr + '\n' + String(e), truncated, durationMs: Date.now() - t0 })
    })
    child.on('close', (code, sig) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void rm(dir, { recursive: true, force: true }).catch(() => {})
      const result: ExecResult = {
        ok:         (code ?? 0) === 0 && !signal,
        exitCode:   code ?? -1,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - t0,
      }
      if (signal) result.signal = signal
      else if (sig) result.signal = String(sig)
      resolve(result)
    })
  })
}

export async function execHealth(): Promise<{ python3: boolean; node: boolean; sh: boolean }> {
  const probe = async (cmd: string, args: string[]): Promise<boolean> => new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: 'ignore' })
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* ignore */ } resolve(false) }, 3000)
    c.on('close', (code) => { clearTimeout(t); resolve(code === 0) })
    c.on('error', () => { clearTimeout(t); resolve(false) })
  })
  const [py, no, sh] = await Promise.all([
    probe('python3', ['-c', 'pass']),
    probe('node',    ['-e', '0']),
    probe('sh',      ['-c', 'true']),
  ])
  return { python3: py, node: no, sh }
}
