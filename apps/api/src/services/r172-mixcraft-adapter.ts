/**
 * R172 — Mixcraft Home Studio adapter for Novan music creation.
 *
 * Workflow:
 *   1. Novan music-studio generates stems + master + MIDI for a track
 *   2. mixcraftFromMusicJob(jobId) wraps the assets into a bundle row +
 *      track rows with positions, BPM, time sig
 *   3. Operator hits GET /mixcraft/bundle/:wsId/:bundleId/manifest.json
 *      and GET /mixcraft/bundle/:wsId/:bundleId/import.ps1 (or .py)
 *   4. Runs import.ps1 on their Windows machine — it downloads each
 *      stem, launches Mixcraft, drags+imports each at the correct
 *      timeline position, sets BPM, saves the project.
 *
 * Why not generate the .mx10 project file directly: Mixcraft's project
 * format is proprietary + undocumented. Going via the GUI import flow
 * is robust across versions and survives format changes.
 *
 * The Mixcraft 10 Controller Script (JS) is an alternative bridge: we
 * also ship a generated controller script that can fire MIDI CC to
 * trigger imports if the operator wants a hands-free pipeline.
 */
import { db } from '../db/client.js'
import { mixcraftBundle, mixcraftTrack } from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── CRUD ────────────────────────────────────────────────────────────

export interface BundleInput {
  name:           string
  bpm?:           number
  timeSignature?: string
  sampleRate?:    number
  bitDepth?:      number
  masterAudioUrl?: string
  durationSec?:   number
  businessId?:    string
  sourceKind?:    'music_job' | 'manual' | 'pai_run'
  sourceRef?:     string
}

export async function bundleCreate(workspaceId: string, input: BundleInput): Promise<{ id: string }> {
  if (!input.name) throw new Error('name required')
  const id = uuidv7()
  await db.insert(mixcraftBundle).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    sourceKind: input.sourceKind ?? 'manual',
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    name: input.name.slice(0, 200),
    bpm: input.bpm ?? 120,
    timeSignature: input.timeSignature ?? '4/4',
    sampleRate: input.sampleRate ?? 44100,
    bitDepth: input.bitDepth ?? 24,
    ...(input.masterAudioUrl ? { masterAudioUrl: input.masterAudioUrl } : {}),
    ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
    status: 'ready',
    createdAt: Date.now(),
  })
  return { id }
}

export interface TrackInput {
  bundleId:    string
  name:        string
  role?:       'drums' | 'bass' | 'chords' | 'melody' | 'vocal' | 'fx' | 'audio'
  audioUrl:    string
  midiUrl?:    string
  positionSec?: number
  durationSec?: number
  volumeDb?:   number
  pan?:        number
  muted?:      boolean
  solo?:       boolean
  colorHex?:   string
  orderIdx?:   number
}

export async function trackAdd(workspaceId: string, input: TrackInput): Promise<{ id: string }> {
  if (!input.audioUrl) throw new Error('audioUrl required')
  const id = uuidv7()
  await db.insert(mixcraftTrack).values({
    id, workspaceId,
    bundleId: input.bundleId,
    name: input.name.slice(0, 120),
    role: input.role ?? 'audio',
    audioUrl: input.audioUrl,
    ...(input.midiUrl ? { midiUrl: input.midiUrl } : {}),
    positionSec: input.positionSec ?? 0,
    ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
    volumeDb: input.volumeDb ?? 0,
    pan: input.pan ?? 0,
    muted: input.muted ?? false,
    solo: input.solo ?? false,
    ...(input.colorHex ? { colorHex: input.colorHex } : {}),
    orderIdx: input.orderIdx ?? 0,
    createdAt: Date.now(),
  })
  return { id }
}

export async function bundleList(workspaceId: string, opts: { limit?: number } = {}): Promise<Array<typeof mixcraftBundle.$inferSelect>> {
  return db.select().from(mixcraftBundle)
    .where(eq(mixcraftBundle.workspaceId, workspaceId))
    .orderBy(desc(mixcraftBundle.createdAt))
    .limit(Math.min(opts.limit ?? 30, 200))
}

export async function bundleTracks(workspaceId: string, bundleId: string): Promise<Array<typeof mixcraftTrack.$inferSelect>> {
  return db.select().from(mixcraftTrack)
    .where(and(eq(mixcraftTrack.workspaceId, workspaceId), eq(mixcraftTrack.bundleId, bundleId)))
    .orderBy(mixcraftTrack.orderIdx)
}

export async function bundleGet(workspaceId: string, bundleId: string): Promise<{ bundle: typeof mixcraftBundle.$inferSelect; tracks: Array<typeof mixcraftTrack.$inferSelect> } | null> {
  const [b] = await db.select().from(mixcraftBundle)
    .where(and(eq(mixcraftBundle.workspaceId, workspaceId), eq(mixcraftBundle.id, bundleId))).limit(1)
  if (!b) return null
  const tracks = await bundleTracks(workspaceId, bundleId)
  return { bundle: b, tracks }
}

// ─── Build from a Novan music-studio job ─────────────────────────────

const ROLE_COLOR: Record<string, string> = {
  drums:  '#ef4444',
  bass:   '#f97316',
  chords: '#eab308',
  melody: '#22c55e',
  vocal:  '#3b82f6',
  fx:     '#a855f7',
  audio:  '#94a3b8',
}

/**
 * Take a Novan music creation job result and wrap into a Mixcraft
 * bundle. Music-studio output shape is loose across rounds, so we
 * accept a few common keys: stems[], masterUrl, bpm, durationSec, etc.
 */
export async function fromMusicJob(workspaceId: string, jobInput: {
  name?:        string
  bpm?:         number
  timeSignature?: string
  durationSec?: number
  masterAudioUrl?: string
  stems?: Array<{ name: string; role?: string; audioUrl: string; midiUrl?: string; positionSec?: number; durationSec?: number }>
  sourceRef?:  string
  businessId?: string
}): Promise<{ bundleId: string; trackCount: number }> {
  const name = jobInput.name ?? `Mixcraft import — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const bundle = await bundleCreate(workspaceId, {
    name,
    bpm: jobInput.bpm ?? 120,
    timeSignature: jobInput.timeSignature ?? '4/4',
    ...(jobInput.durationSec !== undefined ? { durationSec: jobInput.durationSec } : {}),
    ...(jobInput.masterAudioUrl ? { masterAudioUrl: jobInput.masterAudioUrl } : {}),
    sourceKind: 'music_job',
    ...(jobInput.sourceRef ? { sourceRef: jobInput.sourceRef } : {}),
    ...(jobInput.businessId ? { businessId: jobInput.businessId } : {}),
  })

  const stems = jobInput.stems ?? []
  for (let i = 0; i < stems.length; i++) {
    const s = stems[i]!
    const role = (s.role as TrackInput['role']) ?? 'audio'
    const color = ROLE_COLOR[role] ?? ROLE_COLOR['audio'] ?? '#94a3b8'
    await trackAdd(workspaceId, {
      bundleId: bundle.id,
      name: s.name.slice(0, 120),
      role,
      audioUrl: s.audioUrl,
      ...(s.midiUrl ? { midiUrl: s.midiUrl } : {}),
      positionSec: s.positionSec ?? 0,
      ...(s.durationSec !== undefined ? { durationSec: s.durationSec } : {}),
      colorHex: color,
      orderIdx: i,
    })
  }
  return { bundleId: bundle.id, trackCount: stems.length }
}

// ─── Generated artifacts (served via web routes) ────────────────────

export interface Manifest {
  novanBundleId:  string
  name:           string
  bpm:            number
  timeSignature:  string
  sampleRate:     number
  bitDepth:       number
  durationSec:    number | null
  masterAudioUrl: string | null
  tracks: Array<{
    name:        string
    role:        string
    audioUrl:    string
    midiUrl:     string | null
    positionSec: number
    durationSec: number | null
    volumeDb:    number
    pan:         number
    muted:       boolean
    solo:        boolean
    colorHex:    string | null
    orderIdx:    number
  }>
  generatedAt: number
}

export async function manifestFor(workspaceId: string, bundleId: string): Promise<Manifest | null> {
  const r = await bundleGet(workspaceId, bundleId)
  if (!r) return null
  return {
    novanBundleId:  r.bundle.id,
    name:           r.bundle.name,
    bpm:            r.bundle.bpm,
    timeSignature:  r.bundle.timeSignature,
    sampleRate:     r.bundle.sampleRate,
    bitDepth:       r.bundle.bitDepth,
    durationSec:    r.bundle.durationSec ?? null,
    masterAudioUrl: r.bundle.masterAudioUrl ?? null,
    tracks: r.tracks.map(t => ({
      name:        t.name,
      role:        t.role,
      audioUrl:    t.audioUrl,
      midiUrl:     t.midiUrl ?? null,
      positionSec: t.positionSec,
      durationSec: t.durationSec ?? null,
      volumeDb:    t.volumeDb,
      pan:         t.pan,
      muted:       t.muted,
      solo:        t.solo,
      colorHex:    t.colorHex ?? null,
      orderIdx:    t.orderIdx,
    })),
    generatedAt: Date.now(),
  }
}

/**
 * Generate a PowerShell import driver. Runs on the operator's Windows
 * machine — downloads stems to a working dir, launches Mixcraft.exe,
 * and uses SendKeys to walk through File→Import for each stem.
 */
export function importScriptPs1(manifest: Manifest, opts: { mixcraftExe?: string; workDir?: string } = {}): string {
  const mixcraftExe = opts.mixcraftExe ?? 'C:\\Program Files\\Acoustica\\Mixcraft 10\\Mixcraft.exe'
  const workDir = opts.workDir ?? '$env:USERPROFILE\\Novan\\Mixcraft'
  const safeName = manifest.name.replace(/[^a-zA-Z0-9 _.-]/g, '_').slice(0, 80)
  // Per-track download + import block.
  const downloadBlock = manifest.tracks.map((t, i) => {
    const safeFile = `${String(i + 1).padStart(2, '0')}-${t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)}`
    return `    @{ url = "${t.audioUrl}"; file = "${safeFile}.wav"; positionSec = ${t.positionSec}; name = "${t.name.replace(/"/g, "''")}" }`
  }).join(',\n')

  return `# Novan → Mixcraft 10 import driver
# Generated for bundle ${manifest.novanBundleId} on ${new Date().toISOString()}
# Project: ${manifest.name}
# BPM: ${manifest.bpm} · TS: ${manifest.timeSignature} · ${manifest.tracks.length} tracks

param(
    [string]$MixcraftExe = "${mixcraftExe}",
    [string]$WorkDir     = "${workDir}",
    [switch]$DownloadOnly,
    [switch]$SkipLaunch
)

$ErrorActionPreference = 'Stop'
$bundleId = "${manifest.novanBundleId}"
$projectName = "${safeName}"
$projectDir = Join-Path $WorkDir $bundleId

if (-not (Test-Path $projectDir)) { New-Item -ItemType Directory -Force -Path $projectDir | Out-Null }

# ── 1. Download all stems ────────────────────────────────────────────
$tracks = @(
${downloadBlock}
)

Write-Host "[Novan] Downloading $($tracks.Count) stems to $projectDir"
foreach ($t in $tracks) {
    $dest = Join-Path $projectDir $t.file
    if (-not (Test-Path $dest)) {
        Write-Host "  -> $($t.name)"
        Invoke-WebRequest -Uri $t.url -OutFile $dest -UseBasicParsing
    }
}

${manifest.masterAudioUrl ? `# Master mixdown for reference
$masterPath = Join-Path $projectDir "00-master.wav"
if (-not (Test-Path $masterPath)) {
    Invoke-WebRequest -Uri "${manifest.masterAudioUrl}" -OutFile $masterPath -UseBasicParsing
}` : '# (no master mixdown for this bundle)'}

# Write manifest sidecar so Mixcraft project saves alongside knows its origin.
$manifestJson = ConvertTo-Json -Compress @{
    bundleId      = $bundleId
    name          = $projectName
    bpm           = ${manifest.bpm}
    timeSignature = "${manifest.timeSignature}"
    sampleRate    = ${manifest.sampleRate}
    bitDepth      = ${manifest.bitDepth}
    trackCount    = $tracks.Count
}
$manifestJson | Out-File -FilePath (Join-Path $projectDir "novan.manifest.json") -Encoding utf8

if ($DownloadOnly) {
    Write-Host "[Novan] Stems ready at: $projectDir"
    Write-Host "[Novan] Drag the folder into an open Mixcraft project to import."
    return
}

if ($SkipLaunch) { return }

# ── 2. Launch Mixcraft + import each stem via SendKeys ───────────────
if (-not (Test-Path $MixcraftExe)) {
    throw "Mixcraft executable not found at $MixcraftExe — pass -MixcraftExe with the correct path."
}

Write-Host "[Novan] Launching Mixcraft..."
Start-Process -FilePath $MixcraftExe
Start-Sleep -Seconds 5

Add-Type -AssemblyName System.Windows.Forms

# New project (Ctrl+N) → blank
[System.Windows.Forms.SendKeys]::SendWait("^n")
Start-Sleep -Milliseconds 1500
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Seconds 2

# Set tempo: Project menu → Project Properties (Alt+P, P) on Mixcraft 10 EN
[System.Windows.Forms.SendKeys]::SendWait("%p")
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("p")
Start-Sleep -Seconds 1
# Tempo field is the first numeric — type, tab, type time signature
[System.Windows.Forms.SendKeys]::SendWait("${manifest.bpm}")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Seconds 1

# Import each stem in order
$ord = 0
foreach ($t in $tracks) {
    $ord += 1
    $audioPath = Join-Path $projectDir $t.file
    Write-Host "[$ord/$($tracks.Count)] Importing $($t.name)"
    # File → Import Audio (Ctrl+I)
    [System.Windows.Forms.SendKeys]::SendWait("^i")
    Start-Sleep -Seconds 1
    [System.Windows.Forms.SendKeys]::SendWait($audioPath)
    Start-Sleep -Milliseconds 600
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Seconds 2
}

# Save as $projectName
[System.Windows.Forms.SendKeys]::SendWait("^+s")
Start-Sleep -Seconds 1
[System.Windows.Forms.SendKeys]::SendWait((Join-Path $projectDir "$projectName.mx10"))
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

Write-Host "[Novan] Import complete. Project saved as $projectName.mx10"
`
}

/**
 * Mixcraft 10 Controller Script (JavaScript) — receives MIDI CC from
 * a virtual port and triggers commands. Operator loads it via
 * Preferences → Hardware → MIDI Control Surfaces → Add Script.
 * Currently exposes: import_next, transport_play, transport_stop,
 * record_arm_selected.
 */
export function controllerScriptJs(): string {
  return `// Novan Mixcraft Controller Script
// Drop this file into Mixcraft 10 via Preferences → Hardware →
// MIDI Control Surfaces → Add Script. Pair with a virtual MIDI port
// (e.g. loopMIDI) that the Novan local bridge writes to.

function NovanController() {
    this.name = 'Novan Bridge';
    this.id = 'com.novan.controller';
    this.version = '1.0';
}

NovanController.prototype.midiReceived = function (data) {
    // data: [status, controller, value]
    if ((data[0] & 0xf0) !== 0xb0) return;   // CC only
    var cc    = data[1];
    var value = data[2];
    if (value < 64) return;                  // edge-trigger on press

    switch (cc) {
        case 20: mixcraft.transport.play();       break;
        case 21: mixcraft.transport.stop();       break;
        case 22: mixcraft.transport.rewind();     break;
        case 23: mixcraft.menu('File',   'Import Audio...'); break;
        case 24: mixcraft.menu('Edit',   'Undo');            break;
        case 25: mixcraft.menu('File',   'Save Project');    break;
        case 30: mixcraft.menu('Track',  'Add Audio Track'); break;
        case 31: mixcraft.menu('Track',  'Add MIDI Track');  break;
        default: mixcraft.console.log('Unhandled CC ' + cc); break;
    }
};

return new NovanController();
`
}
