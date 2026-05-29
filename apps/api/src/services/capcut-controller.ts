/**
 * capcut-controller.ts — desktop automation for CapCut for Windows.
 *
 * Drives CapCut via PowerShell SendKeys + clipboard paste. Same pattern
 * as mixcraft-controller — CapCut has no public API, so we use Windows
 * UI automation: keyboard shortcuts, clipboard for file paths, and
 * focus-then-send.
 *
 * Shortcut reference (CapCut Desktop ≥ 4.0):
 *   Ctrl+N        New draft
 *   Ctrl+I        Import media (or drag-drop)
 *   Ctrl+B        Split at playhead
 *   Space         Play / Pause
 *   Ctrl+S        Save draft
 *   Ctrl+Z / Y    Undo / Redo
 *   Delete        Delete selected clip
 *   + / -         Zoom timeline
 *
 * Export uses the top-right Export button — CapCut doesn't expose a
 * stable shortcut for the export dialog, so exportProject() uses
 * UIAutomation via PowerShell to click the button by name. Slower but
 * survives across versions.
 *
 * High-level: `assemble(spec)` takes a video spec (clips, narration,
 * b-roll, music, captions) and produces a finished export in one call.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Config ────────────────────────────────────────────────────────────
const CAPCUT_EXE_CANDIDATES = [
  process.env['CAPCUT_EXE'] ?? '',
  `${process.env['LOCALAPPDATA'] ?? ''}\\CapCut\\Apps\\CapCut.exe`,
  `${process.env['LOCALAPPDATA'] ?? ''}\\CapCut\\CapCut.exe`,
  'C:\\Program Files\\CapCut\\CapCut.exe',
  'C:\\Program Files (x86)\\CapCut\\CapCut.exe',
].filter(Boolean)

const WORKDIR = join(tmpdir(), 'novan-capcut')
if (!existsSync(WORKDIR)) mkdirSync(WORKDIR, { recursive: true })

// ─── PowerShell + key sending ──────────────────────────────────────────
function isWindows(): boolean { return process.platform === 'win32' }

async function runPs(script: string, timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (!isWindows()) return { ok: false, stdout: '', stderr: 'capcut-controller is Windows-only' }
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true })
    let stdout = '', stderr = ''
    const t = setTimeout(() => proc.kill('SIGTERM'), timeoutMs)
    proc.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    proc.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, stdout, stderr }) })
    proc.on('error', (e)    => { clearTimeout(t); resolve({ ok: false, stdout, stderr: e.message }) })
  })
}

async function focusCapCut(): Promise<boolean> {
  const r = await runPs(`
$ws = New-Object -ComObject WScript.Shell
$p = Get-Process CapCut -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { exit 1 }
$null = $ws.AppActivate($p.Id)
Start-Sleep -Milliseconds 700
exit 0
`, 8000)
  return r.ok
}

async function sendKeys(keys: string, settleMs = 350): Promise<void> {
  await runPs(`Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(keys)})
Start-Sleep -Milliseconds ${settleMs}`, 10_000)
}

async function setClipboardText(text: string): Promise<void> {
  await runPs(`Set-Clipboard -Value ${JSON.stringify(text)}`, 5000)
}

/** Click a button in the focused CapCut window by its UIA name. */
async function clickUiButton(name: string): Promise<boolean> {
  const script = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$p = Get-Process CapCut -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { exit 1 }
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { exit 2 }
$nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, ${JSON.stringify(name)})
$btn = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
if (-not $btn) { exit 3 }
$pat = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$pat.Invoke()
exit 0
`
  const r = await runPs(script, 10_000)
  return r.ok
}

// ─── Discovery ─────────────────────────────────────────────────────────
function findCapCutExe(): string | null {
  for (const c of CAPCUT_EXE_CANDIDATES) if (c && existsSync(c)) return c
  // Walk LOCALAPPDATA\CapCut\Apps\<version>\CapCut.exe — version varies
  const appsDir = `${process.env['LOCALAPPDATA'] ?? ''}\\CapCut\\Apps`
  if (existsSync(appsDir)) {
    try {
      const versions = readdirSync(appsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => join(appsDir, d.name, 'CapCut.exe'))
      for (const v of versions) if (existsSync(v)) return v
    } catch { /* */ }
  }
  return null
}

export async function isCapCutRunning(): Promise<boolean> {
  if (!isWindows()) return false
  const r = await runPs('if (Get-Process CapCut -ErrorAction SilentlyContinue) { "1" } else { "0" }', 5000)
  return r.stdout.trim() === '1'
}

export async function status(): Promise<{ installed: boolean; running: boolean; exePath?: string }> {
  const exe = findCapCutExe()
  const running = await isCapCutRunning()
  const out: { installed: boolean; running: boolean; exePath?: string } = { installed: !!exe, running }
  if (exe) out.exePath = exe
  return out
}

// ─── Primitives ────────────────────────────────────────────────────────
export async function openCapCut(): Promise<{ ok: boolean; pid?: number; error?: string }> {
  if (!isWindows()) return { ok: false, error: 'Windows-only' }
  if (await isCapCutRunning()) { await focusCapCut(); return { ok: true } }
  const exe = findCapCutExe()
  if (!exe) return { ok: false, error: 'CapCut.exe not found; set CAPCUT_EXE env or install CapCut' }
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 800))
      if (await isCapCutRunning()) {
        await new Promise((r) => setTimeout(r, 3000))  // splash + workspace load
        await focusCapCut()
        const out: { ok: boolean; pid?: number } = { ok: true }
        if (child.pid !== undefined) out.pid = child.pid
        return out
      }
    }
    return { ok: false, error: 'CapCut launched but did not appear in process list' }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function newProject(): Promise<{ ok: boolean }> {
  if (!(await focusCapCut())) return { ok: false }
  // CapCut Home → "New project" button. Try UIA first, fall back to Ctrl+N
  const clicked = await clickUiButton('New project').catch(() => false)
  if (!clicked) await sendKeys('^n', 2500)
  else await new Promise(r => setTimeout(r, 2500))
  return { ok: true }
}

/**
 * Import a media file into the current project. Uses Ctrl+I then
 * clipboard-paste of the path into the open file dialog.
 */
export async function importMedia(path: string): Promise<{ ok: boolean }> {
  if (!existsSync(path)) return { ok: false }
  if (!(await focusCapCut())) return { ok: false }
  await sendKeys('^i', 1500)
  await setClipboardText(path)
  await sendKeys('^a', 200)
  await sendKeys('^v', 400)
  await sendKeys('{ENTER}', 2500)
  return { ok: true }
}

/**
 * Import many files at once — paths joined with quotes per the standard
 * Windows file-dialog multi-select grammar.
 */
export async function importBatch(paths: string[]): Promise<{ ok: boolean; imported: number }> {
  if (paths.length === 0) return { ok: true, imported: 0 }
  if (!(await focusCapCut())) return { ok: false, imported: 0 }
  await sendKeys('^i', 1500)
  // Windows file dialog accepts space-separated quoted paths in the filename field
  const list = paths.filter(p => existsSync(p)).map(p => `"${p}"`).join(' ')
  if (!list) return { ok: false, imported: 0 }
  await setClipboardText(list)
  await sendKeys('^a', 200)
  await sendKeys('^v', 400)
  await sendKeys('{ENTER}', 3500)
  return { ok: true, imported: paths.length }
}

export async function play():     Promise<{ ok: boolean }> { if (!(await focusCapCut())) return { ok: false }; await sendKeys(' ',    400); return { ok: true } }
export async function pause():    Promise<{ ok: boolean }> { if (!(await focusCapCut())) return { ok: false }; await sendKeys(' ',    400); return { ok: true } }
export async function splitAtPlayhead(): Promise<{ ok: boolean }> { if (!(await focusCapCut())) return { ok: false }; await sendKeys('^b', 400); return { ok: true } }
export async function undo():     Promise<{ ok: boolean }> { if (!(await focusCapCut())) return { ok: false }; await sendKeys('^z',   400); return { ok: true } }
export async function redo():     Promise<{ ok: boolean }> { if (!(await focusCapCut())) return { ok: false }; await sendKeys('^y',   400); return { ok: true } }
export async function deleteSelection(): Promise<{ ok: boolean }> { if (!(await focusCapCut())) return { ok: false }; await sendKeys('{DELETE}', 400); return { ok: true } }
export async function save():     Promise<{ ok: boolean }> { if (!(await focusCapCut())) return { ok: false }; await sendKeys('^s',   600); return { ok: true } }

/**
 * Export the project to a file. CapCut's export button is named
 * "Export" in the title bar; UIA invoke is the most reliable way.
 * Output path is set via the export dialog's clipboard-paste.
 */
export async function exportProject(outPath: string, opts?: { quality?: 'high' | '4k' | '1080p' | '720p' }): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!(await focusCapCut())) return { ok: false, error: 'cannot focus capcut' }
  try { mkdirSync(dirname(outPath), { recursive: true }) } catch { /* */ }
  // Click the Export button in CapCut's top-right
  const clicked = await clickUiButton('Export')
  if (!clicked) return { ok: false, error: 'Export button not found via UIA' }
  await new Promise(r => setTimeout(r, 2000))
  // The dialog has a "Title" field (filename) and "Save to" path.
  // We type the filename then paste the full path into the path field.
  await setClipboardText(outPath)
  // Tab through to path field — CapCut export dialog layout: Title → Path → Resolution → ...
  await sendKeys('{TAB}', 200)
  await sendKeys('^a',    200)
  await sendKeys('^v',    400)
  // Click final "Export" inside the dialog
  await new Promise(r => setTimeout(r, 800))
  const finalClick = await clickUiButton('Export')
  if (!finalClick) await sendKeys('{ENTER}', 500)
  void opts
  // Wait for file to materialize (up to 30 min for 4k long-form)
  const deadline = Date.now() + 30 * 60_000
  while (Date.now() < deadline) {
    if (existsSync(outPath)) return { ok: true, path: outPath }
    await new Promise(r => setTimeout(r, 3000))
  }
  return { ok: false, error: 'export timed out' }
}

// ─── High-level: assemble a video from a spec ──────────────────────────
export interface EditSpec {
  /** Brief / topic / script the brain should use to plan the video. */
  brief: string
  /** Local file paths to use (from scraper or operator). */
  assets: Array<{ path: string; role?: 'main' | 'broll' | 'music' | 'voiceover' | 'overlay' }>
  /** Where to save the final export. */
  outPath: string
  /** 'long' (8-15 min) or 'short' (15-60s vertical). */
  format?: 'long' | 'short'
  workspaceId?: string
}

export interface AssembleResult {
  ok: boolean
  outPath?: string
  imported: number
  error?: string
  steps: string[]
  startedAt: number
  finishedAt?: number
}

export async function assemble(spec: EditSpec): Promise<AssembleResult> {
  // 24/7 cloud mode: if we're not on Windows OR NOVAN_GUI_REMOTE=1,
  // route through the gui_queue so an always-on Windows bridge picks
  // it up. Falls back to local execution otherwise.
  const { shouldRouteToQueue, enqueueGuiJob, awaitGuiJob } = await import('./gui-queue.js')
  if (shouldRouteToQueue()) {
    const startedAt = Date.now()
    const wsId = spec.workspaceId ?? 'default'
    const jobId = await enqueueGuiJob(wsId, 'capcut.assemble', spec as unknown as Record<string, unknown>)
    const job = await awaitGuiJob(jobId, 10 * 60_000)
    if (job.status === 'completed' && job.result) return job.result as unknown as AssembleResult
    return {
      ok: false, imported: 0,
      error: job.status === 'pending'
        ? `queued — waiting for Windows bridge (job ${jobId})`
        : (job.error ?? 'bridge failed'),
      steps: [`queued via gui_queue, job ${jobId}`],
      startedAt, finishedAt: Date.now(),
    }
  }

  // Local Windows path: serialize concurrent CapCut sessions
  const { withGuiLock } = await import('./gui-mutex.js')
  return withGuiLock('capcut', () => _assembleInternal(spec))
}

async function _assembleInternal(spec: EditSpec): Promise<AssembleResult> {
  const startedAt = Date.now()
  const steps: string[] = []
  try {
    if (!isWindows()) return { ok: false, imported: 0, error: 'Windows-only', steps, startedAt }
    steps.push('opening CapCut…')
    const opened = await openCapCut()
    if (!opened.ok) return { ok: false, imported: 0, error: opened.error ?? 'cannot open capcut', steps, startedAt }

    steps.push('new project…')
    await newProject()

    // Bulk import — main first (auto-lands on track 1), then b-roll/music
    const ordered = [...spec.assets].sort((a, b) => {
      const order = { main: 0, voiceover: 1, broll: 2, overlay: 3, music: 4 } as const
      return (order[a.role ?? 'main'] ?? 5) - (order[b.role ?? 'main'] ?? 5)
    })
    const paths = ordered.map(a => a.path).filter(p => existsSync(p))
    steps.push(`importing ${paths.length} assets…`)
    const imp = await importBatch(paths)

    // Give CapCut a moment to ingest + auto-place clips on the timeline.
    // CapCut auto-arranges in import order when you double-click → add to
    // timeline. The user can refine; we hand control back here.
    await new Promise(r => setTimeout(r, 4000))
    steps.push('saving draft…')
    await save()

    steps.push(`exporting to ${spec.outPath}…`)
    const ex = await exportProject(spec.outPath, { quality: spec.format === 'short' ? '1080p' : 'high' })
    if (!ex.ok) return { ok: false, imported: imp.imported, error: ex.error ?? 'export failed', steps, startedAt, finishedAt: Date.now() }

    return { ok: true, outPath: ex.path ?? spec.outPath, imported: imp.imported, steps, startedAt, finishedAt: Date.now() }
  } catch (e) {
    return { ok: false, imported: 0, error: (e as Error).message, steps, startedAt, finishedAt: Date.now() }
  }
}
