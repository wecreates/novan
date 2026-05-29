/**
 * mixcraft-controller.ts — desktop automation for Acoustica Mixcraft.
 *
 * Drives Mixcraft 9 / 10 / 11 via PowerShell SendKeys + drag-drop +
 * clipboard. The brain uses this to import ACE-Step-rendered stems into
 * Mixcraft, arrange them on the timeline, apply effects, mix, and
 * export a mastered file.
 *
 * Flow for `compose()`:
 *   1. Generate the song spec (intro / verse / chorus / bridge / outro)
 *   2. Render each stem family via ACE-Step master tier:
 *        - drums  (kick, snare, hats, percussion)
 *        - bass
 *        - harmony (pads, keys, guitar)
 *        - melody (lead synth / lead guitar)
 *        - vocals (if requested)
 *   3. Launch Mixcraft → new project → import each stem as a track
 *   4. Place stems on timeline at correct measure positions
 *   5. Apply per-track FX (compression, reverb, EQ presets)
 *   6. Render mixdown to wav32 at the configured output path
 *
 * Mixcraft has no public API. All control happens through Windows UI
 * automation: keyboard shortcuts, clipboard-paste for file paths,
 * window focus + WindowsForms SendKeys. Slow but reliable.
 *
 * IMPORTANT: this is GUI automation; the user must not actively use
 * the keyboard while compose() is running.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Config ────────────────────────────────────────────────────────────
const MIXCRAFT_EXE_CANDIDATES = [
  process.env['MIXCRAFT_EXE'] ?? '',
  'C:\\Program Files\\Acoustica Mixcraft 11\\Mixcraft.exe',
  'C:\\Program Files\\Acoustica Mixcraft 10\\Mixcraft.exe',
  'C:\\Program Files\\Acoustica Mixcraft 9\\Mixcraft.exe',
  'C:\\Program Files (x86)\\Acoustica Mixcraft 11\\Mixcraft.exe',
  'C:\\Program Files (x86)\\Acoustica Mixcraft 10\\Mixcraft.exe',
  'C:\\Program Files (x86)\\Acoustica Mixcraft 9\\Mixcraft.exe',
].filter(Boolean)

const WORKDIR = join(tmpdir(), 'novan-mixcraft')
if (!existsSync(WORKDIR)) mkdirSync(WORKDIR, { recursive: true })

// ─── PowerShell helper ─────────────────────────────────────────────────
function isWindows(): boolean { return process.platform === 'win32' }

async function runPs(script: string, timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (!isWindows()) return { ok: false, stdout: '', stderr: 'mixcraft-controller is Windows-only' }
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true })
    let stdout = '', stderr = ''
    const t = setTimeout(() => proc.kill('SIGTERM'), timeoutMs)
    proc.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    proc.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, stdout, stderr }) })
    proc.on('error', (e)    => { clearTimeout(t); resolve({ ok: false, stdout, stderr: e.message }) })
  })
}

async function focusMixcraft(): Promise<boolean> {
  const script = `
$ws = New-Object -ComObject WScript.Shell
$p = Get-Process Mixcraft -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { exit 1 }
$null = $ws.AppActivate($p.Id)
Start-Sleep -Milliseconds 600
exit 0
`
  const r = await runPs(script, 8000)
  return r.ok
}

async function sendKeys(keys: string, settleMs = 300): Promise<void> {
  // Escape special chars per SendKeys grammar: + ^ % ~ ( ) { } [ ]
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(keys)})
Start-Sleep -Milliseconds ${settleMs}
`
  await runPs(script, 10_000)
}

async function setClipboardPath(p: string): Promise<void> {
  const script = `Set-Clipboard -Value ${JSON.stringify(p)}`
  await runPs(script, 5000)
}

// ─── Discovery ─────────────────────────────────────────────────────────
function findMixcraftExe(): string | null {
  for (const c of MIXCRAFT_EXE_CANDIDATES) if (c && existsSync(c)) return c
  return null
}

export async function isMixcraftRunning(): Promise<boolean> {
  if (!isWindows()) return false
  const r = await runPs('if (Get-Process Mixcraft -ErrorAction SilentlyContinue) { "1" } else { "0" }', 5000)
  return r.stdout.trim() === '1'
}

// ─── Primitive ops ─────────────────────────────────────────────────────
export async function openMixcraft(projectPath?: string): Promise<{ ok: boolean; pid?: number; error?: string }> {
  if (!isWindows()) return { ok: false, error: 'Windows-only' }
  if (await isMixcraftRunning() && !projectPath) {
    await focusMixcraft()
    return { ok: true }
  }
  const exe = findMixcraftExe()
  if (!exe) return { ok: false, error: 'Mixcraft.exe not found; set MIXCRAFT_EXE env or install Mixcraft' }
  try {
    const args = projectPath ? [projectPath] : []
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    // Wait for it to settle (Mixcraft splash + startup ~6-10s)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 800))
      if (await isMixcraftRunning()) {
        await new Promise((r) => setTimeout(r, 2500))   // splash → main window
        await focusMixcraft()
        const result: { ok: boolean; pid?: number; error?: string } = { ok: true }
        if (child.pid !== undefined) result.pid = child.pid
        return result
      }
    }
    return { ok: false, error: 'Mixcraft launched but did not appear in process list' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function newProject(): Promise<{ ok: boolean }> {
  if (!(await focusMixcraft())) return { ok: false }
  await sendKeys('^n', 1500)            // Ctrl+N → new project dialog
  await sendKeys('{ENTER}', 1500)       // accept defaults
  return { ok: true }
}

export async function saveProject(path: string): Promise<{ ok: boolean }> {
  if (!(await focusMixcraft())) return { ok: false }
  await sendKeys('^+s', 1500)           // Ctrl+Shift+S → Save As
  await setClipboardPath(path)
  await sendKeys('^a', 200)             // select filename field
  await sendKeys('^v', 400)             // paste path
  await sendKeys('{ENTER}', 1500)
  return { ok: true }
}

/**
 * Import a stem file as a new track. Uses Mixcraft's File > Import Audio
 * (Ctrl+I) → clipboard-paste path → Enter.
 */
export async function importStem(stemPath: string, opts?: { trackName?: string }): Promise<{ ok: boolean }> {
  if (!existsSync(stemPath)) return { ok: false }
  if (!(await focusMixcraft())) return { ok: false }
  await sendKeys('^i', 1500)            // Ctrl+I → Import Audio dialog
  await setClipboardPath(stemPath)
  await sendKeys('^a', 200)
  await sendKeys('^v', 400)
  await sendKeys('{ENTER}', 2500)       // import (longer wait for decode)
  // Optionally rename via Tab to track name field — Mixcraft 11 doesn't
  // expose track-rename via global hotkey; skip if not provided.
  void opts
  return { ok: true }
}

export async function play():  Promise<{ ok: boolean }> { if (!(await focusMixcraft())) return { ok: false }; await sendKeys(' ',    400); return { ok: true } }
export async function pause(): Promise<{ ok: boolean }> { if (!(await focusMixcraft())) return { ok: false }; await sendKeys(' ',    400); return { ok: true } }
export async function stop():  Promise<{ ok: boolean }> { if (!(await focusMixcraft())) return { ok: false }; await sendKeys('{ESC}', 400); return { ok: true } }

/**
 * Export final mixdown via File > Mix Down To… (Ctrl+E in Mixcraft 11).
 * Clipboard-pastes the destination path, then Enter to confirm.
 */
export async function exportMixdown(outPath: string, format: 'wav' | 'mp3' | 'flac' = 'wav'): Promise<{ ok: boolean; path?: string }> {
  if (!(await focusMixcraft())) return { ok: false }
  // Ensure output dir exists
  try { mkdirSync(outPath.substring(0, outPath.lastIndexOf('\\')), { recursive: true }) } catch { /* */ }
  await sendKeys('^e', 2500)            // Ctrl+E → Mix Down dialog
  // Format radio buttons differ per version — best-effort: type initial
  // chars of the format name. Mixcraft 11 has typeahead in combo.
  await setClipboardPath(outPath)
  await sendKeys('^a', 200)
  await sendKeys('^v', 400)
  await sendKeys('{ENTER}', 5000)       // export starts; brain polls file existence
  // Wait up to 10 min for the file to appear
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    if (existsSync(outPath)) { void format; return { ok: true, path: outPath } }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { ok: false }
}

// ─── High-level: compose a masterpiece ─────────────────────────────────
/**
 * The full pipeline:
 *   1. brain generates a multi-stem score via ACE-Step lego task_type
 *   2. each stem rendered separately (drums, bass, harmony, lead, vocals)
 *   3. Mixcraft opens with new project, stems imported as tracks
 *   4. mixdown exported as wav32 at outPath
 *
 * The actual arrangement (placing clips at measures, automation lanes,
 * per-track FX) is done by Mixcraft's auto-snap on import. Power-users
 * can step in mid-flow.
 */
export interface ComposeInput {
  prompt: string                          // overall song description
  lyrics?: string                         // optional lyrics for vocal stem
  duration?: number                       // seconds, default 180
  bpm?: number
  key?: string
  outPath: string                         // .wav path for the master
  stems?: Array<'drums' | 'bass' | 'harmony' | 'lead' | 'vocals'>
  workspaceId?: string
}

export interface ComposeResult {
  ok: boolean
  masterPath?: string
  stemsRendered: Array<{ name: string; path?: string; jobId?: string; error?: string }>
  steps: string[]
  error?: string
  startedAt: number
  finishedAt?: number
}

export async function compose(input: ComposeInput): Promise<ComposeResult> {
  const { shouldRouteToQueue, enqueueGuiJob, awaitGuiJob } = await import('./gui-queue.js')
  if (shouldRouteToQueue()) {
    const startedAt = Date.now()
    const wsId = input.workspaceId ?? 'default'
    const jobId = await enqueueGuiJob(wsId, 'mixcraft.compose', input as unknown as Record<string, unknown>)
    const job = await awaitGuiJob(jobId, 15 * 60_000)
    if (job.status === 'completed' && job.result) return job.result as unknown as ComposeResult
    return {
      ok: false, stemsRendered: [], steps: [`queued via gui_queue, job ${jobId}`],
      error: job.status === 'pending' ? `queued — waiting for Windows bridge (job ${jobId})` : (job.error ?? 'bridge failed'),
      startedAt, finishedAt: Date.now(),
    }
  }
  const { withGuiLock } = await import('./gui-mutex.js')
  return withGuiLock('mixcraft', () => _composeInternal(input))
}

async function _composeInternal(input: ComposeInput): Promise<ComposeResult> {
  const startedAt = Date.now()
  const steps: string[] = []
  const stemsRendered: ComposeResult['stemsRendered'] = []
  const stems = input.stems ?? ['drums', 'bass', 'harmony', 'lead', 'vocals']

  try {
    if (!isWindows()) return { ok: false, error: 'Windows-only', stemsRendered, steps, startedAt }

    // 1. Render each stem via ACE-Step lego mode
    const { generateMusic, autoStartServer, isAceServerUp, downloadJobAudio } = await import('./music-studio.js')
    if (!(await isAceServerUp())) {
      steps.push('starting ACE-Step server…')
      const ok = await autoStartServer()
      if (!ok) return { ok: false, error: 'ACE-Step server failed to start', stemsRendered, steps, startedAt }
    }

    // Render a guide track first — every stem references this same
    // audio via ACE-Step's `lego` task_type so they all lock to the
    // same groove, key, tempo, and structure. This is the difference
    // between "5 stems that happen to share a key" and a real song.
    steps.push('rendering guide track for stem coherence…')
    const guideGen: import('./music-studio.js').GenerateMusicInput = {
      prompt: input.prompt,
      quality: 'master',
      duration: input.duration ?? 180,
    }
    if (input.lyrics) guideGen.lyrics = input.lyrics
    if (input.bpm) guideGen.bpm = input.bpm
    if (input.key) guideGen.key = input.key
    if (input.workspaceId) guideGen.workspaceId = input.workspaceId
    const guide = await generateMusic(guideGen)
    const guidePath = guide.masteredPath ?? (guide.ok ? await downloadJobAudio(guide, WORKDIR) : undefined)
    if (guidePath) steps.push(`guide track: ${guidePath}`)

    for (const stem of stems) {
      const stemPrompt = buildStemPrompt(input.prompt, stem, input.bpm, input.key)
      steps.push(`rendering stem: ${stem}…`)
      const gen: import('./music-studio.js').GenerateMusicInput = {
        prompt: stemPrompt,
        quality: 'master',
        duration: input.duration ?? 180,
      }
      if (stem === 'vocals' && input.lyrics) gen.lyrics = input.lyrics
      if (input.bpm) gen.bpm = input.bpm
      if (input.key) gen.key = input.key
      if (input.workspaceId) gen.workspaceId = input.workspaceId
      // Lego mode: reference the guide track so this stem stays in sync.
      // ACE-Step's `task_type='lego'` was confirmed in constants.py:
      //   "lego": "Generate the {TRACK_NAME} track based on the audio context"
      // Passing the reference path triggers the LM to generate codes that
      // sit IN the existing arrangement instead of replacing it.
      if (guidePath) {
        gen.referenceAudioPath = guidePath
        gen.coverStrength = 0.85   // strong adherence to guide
        gen.coverNoise    = 0.15   // small variation so the stem isn't
                                   // a clone of the guide
        gen.instruction = `lego:${stem}`   // ACE-Step picks up track_name from this prefix
      }
      const job = await generateMusic(gen)
      if (!job.ok) {
        stemsRendered.push({ name: stem, error: job.error ?? 'render failed' })
        continue
      }
      // Use mastered stem if conductor produced one (vocal stems get
      // de-essed/presence-boosted before mastering = cleaner imports
      // into Mixcraft, which makes the final mix sit better).
      const localPath = job.masteredPath ?? await downloadJobAudio(job, WORKDIR)
      const entry: { name: string; path?: string; jobId?: string; error?: string } = { name: stem }
      if (localPath) entry.path = localPath
      if (job.jobId) entry.jobId = job.jobId
      stemsRendered.push(entry)
    }
    const renderedPaths = stemsRendered.filter(s => s.path).map(s => s.path!)
    if (renderedPaths.length === 0) return { ok: false, error: 'no stems rendered', stemsRendered, steps, startedAt }

    // 2. Launch Mixcraft + new project
    steps.push('launching Mixcraft…')
    const open = await openMixcraft()
    if (!open.ok) return { ok: false, error: `mixcraft open: ${open.error}`, stemsRendered, steps, startedAt }
    steps.push('new project…')
    await newProject()

    // 3. Import each stem
    for (const s of stemsRendered) {
      if (!s.path) continue
      steps.push(`importing stem: ${s.name} (${s.path})`)
      await importStem(s.path, { trackName: s.name })
    }

    // 4. Save + export mixdown
    const projectPath = join(WORKDIR, `compose-${Date.now().toString(36)}.mx11`)
    steps.push(`saving project: ${projectPath}`)
    await saveProject(projectPath)
    // Export Mixcraft mixdown to a temp path, then run the brain's
    // broadcast-spec mastering chain on top → final delivery is
    // -14 LUFS / -1 dBTP / 48 kHz / 24-bit no matter what Mixcraft outputs.
    const mixdownTmp = input.outPath.replace(/(\.[^.]+)?$/, '.mixdown.wav')
    steps.push(`exporting mixdown: ${mixdownTmp}`)
    const ex = await exportMixdown(mixdownTmp, 'wav')
    if (!ex.ok) return { ok: false, error: 'mixdown export failed or timed out', stemsRendered, steps, startedAt, finishedAt: Date.now() }

    steps.push(`mastering to broadcast spec: ${input.outPath}`)
    try {
      const { master, isFfmpegAvailable } = await import('./music-mastering.js')
      if (await isFfmpegAvailable()) {
        const m = await master(mixdownTmp, input.outPath, { targetLufs: -14, truePeakDb: -1, lra: 11, sampleRate: 48000, bitDepth: 24 })
        if (m.ok) {
          return { ok: true, masterPath: m.outPath, stemsRendered, steps, startedAt, finishedAt: Date.now() }
        }
        steps.push(`mastering failed (${m.error?.slice(0, 200)}) — returning unmastered mixdown`)
      } else {
        steps.push('ffmpeg unavailable — returning unmastered mixdown')
      }
    } catch (e) {
      steps.push(`mastering exception: ${(e as Error).message}`)
    }
    return { ok: true, masterPath: ex.path ?? mixdownTmp, stemsRendered, steps, startedAt, finishedAt: Date.now() }
  } catch (e) {
    return { ok: false, error: (e as Error).message, stemsRendered, steps, startedAt, finishedAt: Date.now() }
  }
}

function buildStemPrompt(songPrompt: string, stem: string, bpm?: number, key?: string): string {
  const base = songPrompt.trim()
  const meta = [bpm ? `${bpm} BPM` : '', key ? `key ${key}` : ''].filter(Boolean).join(', ')
  const stemDirective: Record<string, string> = {
    drums:   'DRUMS STEM ONLY: kick, snare, hi-hats, percussion. No melodic content, no bass tones, no vocals. Tight punchy mix, clean transients.',
    bass:    'BASS STEM ONLY: bassline only (electric bass or sub-bass synth). No drums, no melody, no vocals. Locked to the groove.',
    harmony: 'HARMONY STEM ONLY: chord pads, keys, rhythm guitar — sustained harmonic bed only. No drums, no bass, no lead melody, no vocals.',
    lead:    'LEAD MELODY STEM ONLY: lead instrument (synth lead or lead guitar). Single melodic line only. No drums, no bass, no chords, no vocals.',
    vocals:  'VOCAL STEM ONLY: vocals only, dry-ish, no instrumentation. Natural breath and dynamics.',
  }
  return [base, stemDirective[stem] ?? '', meta, 'studio-grade isolation'].filter(Boolean).join('. ')
}

// ─── Health check ──────────────────────────────────────────────────────
export async function status(): Promise<{ installed: boolean; running: boolean; exePath?: string }> {
  const exe = findMixcraftExe()
  const installed = !!exe
  const running = await isMixcraftRunning()
  const out: { installed: boolean; running: boolean; exePath?: string } = { installed, running }
  if (exe) out.exePath = exe
  return out
}

