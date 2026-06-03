/**
 * R174 — CapCut full-access adapter.
 *
 * Same bridge pattern as R172 Mixcraft. CapCut has no public project API,
 * so we generate the format CapCut already understands and drop it into
 * the local drafts folder.
 *
 * Workflow:
 *   1. Novan PAI run completes → executor produces a finalOutputPath + per-shot clips
 *   2. capcutFromVideoRun(runId) wraps the clips into a capcut_project + capcut_clip rows
 *   3. Operator hits:
 *        GET /capcut/:ws/:projectId/draft_content.json
 *        GET /capcut/:ws/:projectId/import.ps1
 *      Script downloads every asset, writes draft_content.json into
 *      %localappdata%\CapCut\User Data\Projects\com.lveditor.draft\<id>\
 *      → CapCut shows the project on next launch.
 */
import { db } from '../db/client.js'
import {
  capcutProject, capcutClip, videoPaiRun,
} from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── CRUD ────────────────────────────────────────────────────────────

export interface ProjectInput {
  name:        string
  width?:      number
  height?:     number
  fps?:        number
  sourceKind?: 'pai_run' | 'music_job' | 'manual'
  sourceRef?:  string
  masterAudioUrl?: string
  coverUrl?:   string
  businessId?: string
}

export async function projectCreate(workspaceId: string, input: ProjectInput): Promise<{ id: string }> {
  if (!input.name) throw new Error('name required')
  const id = uuidv7()
  await db.insert(capcutProject).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    sourceKind: input.sourceKind ?? 'manual',
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    name: input.name.slice(0, 200),
    width: input.width ?? 1080,
    height: input.height ?? 1920,
    fps: input.fps ?? 30,
    ...(input.masterAudioUrl ? { masterAudioUrl: input.masterAudioUrl } : {}),
    ...(input.coverUrl ? { coverUrl: input.coverUrl } : {}),
    status: 'ready',
    createdAt: Date.now(),
  })
  return { id }
}

export interface ClipInput {
  projectId:     string
  kind:          'video' | 'audio' | 'text' | 'sticker' | 'effect' | 'image'
  assetUrl?:     string
  trackIdx?:     number
  startMs:       number
  durationMs:    number
  sourceStartMs?: number
  transform?:    Record<string, unknown>
  orderIdx?:     number
}

export async function clipAdd(workspaceId: string, input: ClipInput): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(capcutClip).values({
    id, workspaceId,
    projectId: input.projectId,
    kind: input.kind,
    ...(input.assetUrl ? { assetUrl: input.assetUrl } : {}),
    trackIdx: input.trackIdx ?? 0,
    startMs: input.startMs,
    durationMs: input.durationMs,
    sourceStartMs: input.sourceStartMs ?? 0,
    transform: input.transform ?? {},
    orderIdx: input.orderIdx ?? 0,
    createdAt: Date.now(),
  })
  // Bump project duration if this clip extends past current end.
  const endMs = input.startMs + input.durationMs
  const { sql } = await import('drizzle-orm')
  await db.execute(sql`UPDATE capcut_project SET duration_ms = GREATEST(duration_ms, ${endMs}) WHERE workspace_id = ${workspaceId} AND id = ${input.projectId}`)
  return { id }
}

export async function projectList(workspaceId: string, opts: { limit?: number } = {}): Promise<Array<typeof capcutProject.$inferSelect>> {
  return db.select().from(capcutProject)
    .where(eq(capcutProject.workspaceId, workspaceId))
    .orderBy(desc(capcutProject.createdAt))
    .limit(Math.min(opts.limit ?? 30, 200))
}

export async function projectGet(workspaceId: string, projectId: string): Promise<{ project: typeof capcutProject.$inferSelect; clips: Array<typeof capcutClip.$inferSelect> } | null> {
  const [p] = await db.select().from(capcutProject)
    .where(and(eq(capcutProject.workspaceId, workspaceId), eq(capcutProject.id, projectId))).limit(1)
  if (!p) return null
  const clips = await db.select().from(capcutClip)
    .where(and(eq(capcutClip.workspaceId, workspaceId), eq(capcutClip.projectId, projectId)))
    .orderBy(capcutClip.trackIdx, capcutClip.startMs)
  return { project: p, clips }
}

// ─── Build from a R160 PAI run ───────────────────────────────────────

/**
 * Wrap a completed PAI video run into a CapCut project. Reads the run's
 * execute phase output (final concat + per-shot results) and lays out
 * the shots sequentially on the main video track.
 */
export async function capcutFromVideoRun(workspaceId: string, runId: string, opts: { name?: string; width?: number; height?: number; fps?: number } = {}): Promise<{ projectId: string; clipCount: number } | { error: string }> {
  const [run] = await db.select().from(videoPaiRun)
    .where(and(eq(videoPaiRun.workspaceId, workspaceId), eq(videoPaiRun.id, runId))).limit(1)
  if (!run) return { error: 'run not found' }

  const exec = (run.execute ?? {}) as { shotResults?: Array<{ localPath?: string; durationSec?: number; shotId: string }> }
  const plan = (run.plan ?? {}) as { episode?: { shots?: Array<{ id: string; durationSec?: number; prompt?: string }> } }
  const shots = plan.episode?.shots ?? []
  if (shots.length === 0) return { error: 'no shots in run' }

  const p = await projectCreate(workspaceId, {
    name: opts.name ?? `PAI run ${runId.slice(0, 8)}`,
    width: opts.width ?? 1080,
    height: opts.height ?? 1920,
    fps: opts.fps ?? 30,
    sourceKind: 'pai_run',
    sourceRef: runId,
  })

  let cursor = 0
  let order = 0
  let clipCount = 0
  for (const s of shots) {
    const shotResult = exec.shotResults?.find(r => r.shotId === s.id)
    const url = shotResult?.localPath
    if (!url) continue
    const durMs = Math.round((shotResult?.durationSec ?? s.durationSec ?? 4) * 1000)
    await clipAdd(workspaceId, {
      projectId: p.id, kind: 'video', assetUrl: url,
      trackIdx: 0, startMs: cursor, durationMs: durMs, orderIdx: order,
    })
    // Optional: text overlay with the shot prompt at the start.
    if (s.prompt) {
      await clipAdd(workspaceId, {
        projectId: p.id, kind: 'text',
        trackIdx: 1, startMs: cursor, durationMs: Math.min(durMs, 2500),
        transform: { content: s.prompt.slice(0, 60), x: 540, y: 1500, font: 'Inter', color: '#ffffff' },
        orderIdx: order,
      })
    }
    cursor += durMs
    order += 1
    clipCount += 1
  }
  return { projectId: p.id, clipCount }
}

// ─── draft_content.json generator ────────────────────────────────────

/**
 * Generate CapCut's draft_content.json. The format is reverse-engineered
 * from community work — minimal-viable shape that CapCut opens cleanly:
 *   canvas_config, fps, duration, materials (videos/audios/texts),
 *   tracks (one per kind).
 */
export async function draftContentJson(workspaceId: string, projectId: string): Promise<Record<string, unknown> | null> {
  const r = await projectGet(workspaceId, projectId)
  if (!r) return null
  const { project, clips } = r

  const videoMaterials: Array<Record<string, unknown>> = []
  const audioMaterials: Array<Record<string, unknown>> = []
  const textMaterials:  Array<Record<string, unknown>> = []
  const imageMaterials: Array<Record<string, unknown>> = []

  const matIdByClipId = new Map<string, string>()

  for (const c of clips) {
    const mid = uuidv7()
    matIdByClipId.set(c.id, mid)
    const base = { id: mid, type: c.kind, path: c.assetUrl ?? '' }
    if (c.kind === 'video' || c.kind === 'image') {
      ;(c.kind === 'video' ? videoMaterials : imageMaterials).push({
        ...base,
        width: project.width,
        height: project.height,
        duration: c.durationMs * 1000,                     // CapCut uses microseconds
        material_name: `clip_${c.orderIdx}`,
      })
    } else if (c.kind === 'audio') {
      audioMaterials.push({ ...base, duration: c.durationMs * 1000, material_name: `audio_${c.orderIdx}` })
    } else if (c.kind === 'text') {
      const tform = (c.transform ?? {}) as { content?: string; color?: string; font?: string }
      textMaterials.push({
        id: mid, type: 'text',
        content: tform.content ?? '',
        font: tform.font ?? 'Source Han Sans CN',
        text_color: tform.color ?? '#ffffffff',
        material_name: `text_${c.orderIdx}`,
      })
    }
  }

  // Group clips by track and emit one CapCut track per (track_idx).
  const tracksByIdx = new Map<number, Array<typeof capcutClip.$inferSelect>>()
  for (const c of clips) {
    if (!tracksByIdx.has(c.trackIdx)) tracksByIdx.set(c.trackIdx, [])
    tracksByIdx.get(c.trackIdx)!.push(c)
  }
  const tracks: Array<Record<string, unknown>> = []
  for (const [idx, list] of [...tracksByIdx.entries()].sort((a, b) => a[0] - b[0])) {
    const kind = list[0]?.kind ?? 'video'
    const ccType = kind === 'audio' ? 'audio' : kind === 'text' ? 'text' : 'video'
    tracks.push({
      id: uuidv7(),
      type: ccType,
      attribute: 0,
      flag: 0,
      track_index: idx,
      segments: list.map(c => ({
        id: uuidv7(),
        material_id: matIdByClipId.get(c.id),
        source_timerange: { start: c.sourceStartMs * 1000, duration: c.durationMs * 1000 },
        target_timerange: { start: c.startMs * 1000,       duration: c.durationMs * 1000 },
        speed:            1,
        volume:           ccType === 'audio' ? 1 : 0,
        visible:          true,
        cartoon:          false,
        clip:             { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
      })),
    })
  }

  return {
    canvas_config: { background: { color: '#00000000', image: '', type: 'none' }, height: project.height, width: project.width },
    color_space: 0,
    config: { adjust_max_index: 1, attachment_info: [], combination_max_index: 1, export_range: null, extract_audio_last_index: 1, lyrics_recognition_id: '', lyrics_sync: true, lyrics_taskinfo: [], maintrack_adsorb: true, material_save_mode: 0, multi_language_current: 'none', multi_language_list: [], multi_language_main: 'none', multi_language_mode: 'none', original_sound_last_index: 1, record_audio_last_index: 1, sticker_max_index: 1, subtitle_keywords_config: null, subtitle_recognition_id: '', subtitle_sync: true, subtitle_taskinfo: [], system_font_list: [], video_mute: false, zoom_info_params: null },
    cover: project.coverUrl ?? '',
    create_time: Math.floor(project.createdAt / 1000),
    duration: project.durationMs * 1000,
    extra_info: null,
    fps: project.fps,
    free_render_index_mode_on: false,
    group_container: null,
    id: project.id,
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: { app_id: 359, app_source: 'lv', app_version: '5.5.0', device_id: 'novan', hard_disk_id: '', mac_address: '', os: 'windows', os_version: '10' },
    materials: {
      audio_balances: [], audio_effects: [], audio_fades: [], audio_track_indexes: [],
      audios: audioMaterials,
      beats: [],
      canvases: [{ album_image: '', blur: 0.0, color: '', id: uuidv7(), image: '', image_id: '', image_name: '', source_platform: 0, team_id: '', type: 'canvas_color' }],
      chromas: [], color_curves: [],
      common_mask: [], digital_humans: [], drafts: [],
      effects: [], flowers: [], green_screens: [],
      handwrites: [], hsl: [],
      images: imageMaterials,
      log_color_wheels: [], loudnesses: [], manual_deformations: [], material_animations: [], masks: [], placeholder_infos: [], plugin_effect: [], primary_color_wheels: [],
      realtime_denoises: [], shapes: [], smart_crops: [], smart_relights: [],
      sound_channel_mappings: [],
      speeds: [{ curve_speed: null, id: uuidv7(), mode: 0, speed: 1.0, type: 'speed' }],
      stickers: [],
      tail_leaders: [],
      text_templates: [],
      texts: textMaterials,
      time_marks: [],
      transitions: [],
      video_effects: [],
      video_trackings: [],
      videos: videoMaterials,
      vocal_beautifys: [], vocal_separations: [],
    },
    mutable_config: null,
    name: project.name,
    new_version: '110.0.0',
    platform: { app_id: 359, app_source: 'lv', app_version: '5.5.0', device_id: 'novan', hard_disk_id: '', mac_address: '', os: 'windows', os_version: '10' },
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks,
    update_time: Math.floor(Date.now() / 1000),
    version: 360000,
  }
}

/**
 * Generate a PowerShell driver that installs the project into CapCut's
 * drafts folder. Operator just opens CapCut → project appears.
 */
export function importScriptPs1(projectId: string, projectName: string, baseUrl: string): string {
  const safeName = projectName.replace(/[^a-zA-Z0-9 _.-]/g, '_').slice(0, 80)
  return `# Novan → CapCut import driver
# Project: ${safeName}  ID: ${projectId}
# Generated: ${new Date().toISOString()}

param(
    [string]$DraftsRoot = "$env:LOCALAPPDATA\\CapCut\\User Data\\Projects\\com.lveditor.draft",
    [string]$WorkDir    = "$env:USERPROFILE\\Novan\\CapCut\\${projectId}"
)

$ErrorActionPreference = 'Stop'
$projectId = "${projectId}"
$baseUrl = "${baseUrl}"

if (-not (Test-Path $DraftsRoot)) { New-Item -ItemType Directory -Force -Path $DraftsRoot | Out-Null }
if (-not (Test-Path $WorkDir))    { New-Item -ItemType Directory -Force -Path $WorkDir    | Out-Null }
$projectDir = Join-Path $DraftsRoot $projectId
if (-not (Test-Path $projectDir)) { New-Item -ItemType Directory -Force -Path $projectDir | Out-Null }

Write-Host "[Novan] Downloading draft_content.json"
$draftJson = Invoke-RestMethod -Uri "$baseUrl/draft_content.json" -UseBasicParsing
$draftPath = Join-Path $projectDir "draft_content.json"
$draftJson | ConvertTo-Json -Depth 100 -Compress | Out-File -FilePath $draftPath -Encoding utf8

# Download each material asset to the project folder + rewrite paths to local.
Write-Host "[Novan] Downloading assets"
$materials = @()
$materials += $draftJson.materials.videos
$materials += $draftJson.materials.audios
$materials += $draftJson.materials.images

foreach ($m in $materials) {
    if (-not $m.path -or $m.path -eq "") { continue }
    $url = $m.path
    $fileName = [System.IO.Path]::GetFileName($url.Split('?')[0])
    if (-not $fileName) { $fileName = "$($m.id).bin" }
    $localPath = Join-Path $projectDir $fileName
    if (-not (Test-Path $localPath)) {
        Write-Host "  -> $($m.material_name)"
        Invoke-WebRequest -Uri $url -OutFile $localPath -UseBasicParsing
    }
    $m.path = $localPath
}

# Write the rewritten draft back.
$draftJson | ConvertTo-Json -Depth 100 -Compress | Out-File -FilePath $draftPath -Encoding utf8

# Write the meta_info.json that CapCut looks for on draft listing.
$metaInfo = @{
    cloud_package_completed_time = ""
    draft_cloud_completed = ""
    draft_cloud_modified_time = 0
    draft_cloud_purchase_info = ""
    draft_cloud_template_id = ""
    draft_cloud_tutorial_info = ""
    draft_cloud_videocut_purchase_info = ""
    draft_cover = "draft_cover.jpg"
    draft_deeplink_url = ""
    draft_enterprise_info = @{ draft_enterprise_extra = ""; draft_enterprise_id = ""; draft_enterprise_name = ""; enterprise_material = @() }
    draft_fold_path = $projectDir
    draft_id = $projectId
    draft_is_ai_packaging_used = $false
    draft_is_ai_shorts = $false
    draft_is_ai_translate = $false
    draft_is_article_video_draft = $false
    draft_is_from_deeplink = "false"
    draft_is_invisible = $false
    draft_materials = @(@{ type = 0; value = @() })
    draft_materials_copied_info = @()
    draft_name = "${safeName}"
    draft_new_version = ""
    draft_removable_storage_device = "DISK"
    draft_root_path = $DraftsRoot
    draft_segment_extra_info = @()
    draft_timeline_materials_size_ = 0
    draft_type = ""
    tm_draft_cloud_completed = ""
    tm_draft_cloud_modified = 0
    tm_draft_create = [int64](Get-Date -UFormat %s) * 1000000
    tm_draft_modified = [int64](Get-Date -UFormat %s) * 1000000
    tm_draft_removed = 0
    tm_duration = $draftJson.duration
}
$metaInfo | ConvertTo-Json -Depth 100 -Compress | Out-File -FilePath (Join-Path $projectDir "draft_meta_info.json") -Encoding utf8

Write-Host "[Novan] CapCut project installed."
Write-Host "       Open CapCut — '${safeName}' will appear in your drafts list."
`
}
