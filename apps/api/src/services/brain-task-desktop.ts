/**
 * brain-task-desktop.ts — Desktop control via Node child_process + fs.
 *
 * Operations:
 *   desktop.exec        → run a shell command (timeout-bounded)
 *   desktop.read_file   → read a file from disk
 *   desktop.write_file  → write a file (path safety enforced)
 *   desktop.list_dir    → list a directory
 *   desktop.open_app    → launch an application by name or path
 *   desktop.screenshot  → screenshot the full desktop (PNG, base64)
 *   desktop.processes   → list running processes
 *   desktop.kill        → kill a process by pid
 *
 * Safety:
 *   - exec commands are run via `cmd /c` on Windows; output is captured.
 *   - File writes refuse to touch protected paths (auth, secrets,
 *     payments, env files, lockfiles, .git, system32).
 *   - The money-guard runs upstream and rejects financial content
 *     regardless of operation.
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { resolve, dirname, isAbsolute } from 'node:path'

const EXEC_TIMEOUT_MS    = 30_000
const EXEC_MAX_OUTPUT    = 256 * 1024   // 256 KB stdout cap
const FILE_MAX_READ      = 5 * 1024 * 1024   // 5 MB read cap
const FILE_MAX_WRITE     = 2 * 1024 * 1024   // 2 MB write cap

// File paths the brain absolutely cannot touch
const PROTECTED_WRITE_PATTERNS: RegExp[] = [
  /\.env(\.\w+)?$/i,
  /\.git[\\/]/i,
  /[\\/]system32[\\/]/i,
  /[\\/]windows[\\/]/i,
  /pnpm-lock\.yaml$/i,
  /package-lock\.json$/i,
  /yarn\.lock$/i,
  /[\\/]node_modules[\\/]/,
  /[\\/]secrets?-vault\./i,
  /[\\/]auth\.ts$/i,
  /[\\/]billing\./i,
  /[\\/]payment/i,
  /id_rsa|id_ed25519|\.pem$|\.key$|\.crt$/i,
  /\.bashrc|\.zshrc|\.profile|\.bash_history/i,
]

// Commands that are NEVER allowed even in exec
const FORBIDDEN_EXEC_PATTERNS: RegExp[] = [
  /\b(?:rm|del)\s+-rf?\s+\/|format\s+c:|diskpart|mkfs/i,
  /shutdown|reboot|halt\b/i,
  // Privilege escalation
  /\bsudo\b|runas\s*\/user:|net\s+localgroup\s+administrators/i,
  // Network attacks / scanning
  /\bnmap\b|\bmasscan\b|\bnikto\b|\bmetasploit\b/i,
  // Credential exfil
  /cat\s+.*\.ssh|type\s+.*\.ssh|export.*AWS_SECRET|export.*GITHUB_TOKEN/i,
]

function isProtectedWrite(path: string): boolean {
  const norm = path.replace(/\\/g, '/')
  return PROTECTED_WRITE_PATTERNS.some(re => re.test(norm))
}

function isForbiddenCommand(cmd: string): boolean {
  return FORBIDDEN_EXEC_PATTERNS.some(re => re.test(cmd))
}

function isWindows(): boolean {
  return process.platform === 'win32'
}

// ─── Operations ────────────────────────────────────────────────────────

export interface ExecResult {
  command:   string
  exitCode:  number | null
  stdout:    string
  stderr:    string
  durationMs: number
  truncated: boolean
}

export async function desktopExec(_ws: string, params: Record<string, unknown>): Promise<ExecResult> {
  const command = String(params['command'] ?? '').trim()
  if (!command) throw new Error('desktop.exec: command required')
  if (isForbiddenCommand(command)) throw new Error(`desktop.exec: command rejected by safety policy`)
  const timeout = Math.min(Number(params['timeoutMs'] ?? EXEC_TIMEOUT_MS), 120_000)
  const cwd     = params['cwd'] ? String(params['cwd']) : process.cwd()

  const t0 = Date.now()
  const shell = isWindows() ? 'cmd.exe' : 'sh'
  const shellArgs = isWindows() ? ['/d', '/s', '/c', command] : ['-c', command]

  return new Promise<ExecResult>((resolveResult) => {
    const child = spawn(shell, shellArgs, { cwd, env: { ...process.env, NOVAN_BRAIN_EXEC: '1' } })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let killed = false
    const timer = setTimeout(() => { killed = true; child.kill('SIGTERM') }, timeout)
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < EXEC_MAX_OUTPUT) stdout += d.toString('utf8')
      else truncated = true
    })
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < EXEC_MAX_OUTPUT) stderr += d.toString('utf8')
      else truncated = true
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveResult({
        command,
        exitCode: killed ? -1 : code,
        stdout: stdout.slice(0, EXEC_MAX_OUTPUT),
        stderr: stderr.slice(0, EXEC_MAX_OUTPUT),
        durationMs: Date.now() - t0,
        truncated,
      })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolveResult({
        command, exitCode: -1, stdout, stderr: `${stderr}\n${e.message}`,
        durationMs: Date.now() - t0, truncated,
      })
    })
  })
}

export async function desktopReadFile(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const path = String(params['path'] ?? '').trim()
  if (!path) throw new Error('desktop.read_file: path required')
  if (!isAbsolute(path) && path.startsWith('..')) throw new Error('desktop.read_file: path traversal blocked')
  const abs = resolve(path)
  const s = await stat(abs)
  if (!s.isFile()) throw new Error('desktop.read_file: not a file')
  if (s.size > FILE_MAX_READ) throw new Error(`desktop.read_file: file too large (${s.size} > ${FILE_MAX_READ})`)
  const content = await readFile(abs, 'utf8')
  return { path: abs, size: s.size, content }
}

export async function desktopWriteFile(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const path    = String(params['path'] ?? '').trim()
  const content = String(params['content'] ?? '')
  if (!path)               throw new Error('desktop.write_file: path required')
  if (path.includes('..')) throw new Error('desktop.write_file: path traversal blocked')
  if (content.length > FILE_MAX_WRITE) throw new Error(`desktop.write_file: content too large (${content.length} > ${FILE_MAX_WRITE})`)
  const abs = resolve(path)
  if (isProtectedWrite(abs)) throw new Error(`desktop.write_file: protected path: ${abs}`)
  await mkdir(dirname(abs), { recursive: true }).catch(() => null)
  await writeFile(abs, content, 'utf8')
  return { path: abs, bytes: Buffer.byteLength(content, 'utf8') }
}

export async function desktopListDir(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const path = String(params['path'] ?? process.cwd()).trim()
  const abs = resolve(path)
  const entries = await readdir(abs, { withFileTypes: true })
  return {
    path: abs,
    entries: entries.slice(0, 500).map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    })),
    total: entries.length,
  }
}

export async function desktopOpenApp(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const target = String(params['target'] ?? '').trim()
  if (!target) throw new Error('desktop.open_app: target required (app name or URL)')
  if (isForbiddenCommand(target)) throw new Error('desktop.open_app: target rejected by safety policy')

  // Windows: `start "" "<target>"` opens via shell associations.
  // macOS/Linux: `open` / `xdg-open`.
  const t0 = Date.now()
  const cmd  = isWindows() ? 'cmd.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open')
  const args = isWindows() ? ['/d', '/s', '/c', 'start', '""', target] : [target]
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', (e) => rejectResult(new Error(`desktop.open_app: ${e.message}`)))
    setTimeout(() => {
      child.unref()
      resolveResult({ target, launched: true, durationMs: Date.now() - t0 })
    }, 600)
  })
}

export async function desktopScreenshot(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  // Windows-only path: use PowerShell with .NET Drawing.
  if (!isWindows()) {
    return { ok: false, reason: `desktop.screenshot: not supported on ${process.platform}` }
  }
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray()) | Write-Host -NoNewline
`.trim()
  return new Promise((resolveResult) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript])
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
    const timer = setTimeout(() => child.kill(), Number(params['timeoutMs'] ?? 10_000))
    child.on('close', () => {
      clearTimeout(timer)
      const b64 = out.trim()
      if (!b64) { resolveResult({ ok: false, reason: 'no output', stderr: err.slice(0, 500) }); return }
      resolveResult({ ok: true, pngBase64: b64, bytes: Math.floor(b64.length * 0.75) })
    })
  })
}

export async function desktopProcesses(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const filter = params['filter'] ? String(params['filter']).toLowerCase() : null
  if (isWindows()) {
    // tasklist /FO CSV produces "ImageName","PID","SessionName","Session#","MemUsage"
    const r = await desktopExec(_ws, { command: 'tasklist /FO CSV /NH', timeoutMs: 10_000 })
    const lines = (r as ExecResult).stdout.split('\n').filter(Boolean).slice(0, 500)
    const rows = lines.map(l => {
      const m = l.match(/^"([^"]+)","(\d+)","([^"]+)","(\d+)","([^"]+)"/)
      if (!m) return null
      return { name: m[1], pid: Number(m[2]), session: m[3], memKb: Number(m[5]!.replace(/[^\d]/g, '')) }
    }).filter((x): x is { name: string; pid: number; session: string; memKb: number } => x !== null)
    const filtered = filter ? rows.filter(r => r.name.toLowerCase().includes(filter)) : rows
    return { count: filtered.length, processes: filtered.slice(0, 100) }
  }
  const r = await desktopExec(_ws, { command: 'ps -eo pid,comm,rss --no-headers | head -200', timeoutMs: 10_000 })
  return { raw: (r as ExecResult).stdout }
}

export async function desktopKill(_ws: string, params: Record<string, unknown>): Promise<unknown> {
  const pid = Number(params['pid'])
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('desktop.kill: numeric pid required')
  // Refuse to kill self
  if (pid === process.pid) throw new Error('desktop.kill: refusing to kill the API process itself')
  try {
    process.kill(pid, 'SIGTERM')
    return { pid, killed: true }
  } catch (e) {
    return { pid, killed: false, error: (e as Error).message }
  }
}
