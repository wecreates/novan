/**
 * brand-kit.ts — reusable brand assets for mass-produced content.
 *
 * Stores operator-defined logos / intro stinger / outro stinger /
 * color palette / fonts per workspace, then applies them as overlays
 * during the final ffmpeg post-process so every produced video carries
 * a consistent brand look.
 *
 * The brand kit is persisted as JSON in tmpdir (or BRAND_KIT_DIR env);
 * for prod-scale this could move to the DB but file-based keeps the
 * surface tiny and survives restarts.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const KIT_DIR = process.env['BRAND_KIT_DIR'] ?? join(tmpdir(), 'novan-brand-kits')
if (!existsSync(KIT_DIR)) mkdirSync(KIT_DIR, { recursive: true })

const FFMPEG = process.env['FFMPEG_BIN'] ?? 'ffmpeg'

export interface BrandKit {
  workspaceId:   string
  logoPath?:     string          // PNG with transparency
  logoPosition?: 'tl' | 'tr' | 'bl' | 'br'   // default tr
  logoOpacity?:  number          // 0–1, default 0.85
  introPath?:    string          // mp4 stinger, ≤5s recommended
  outroPath?:    string          // mp4 stinger
  primaryColor?: string          // hex, used for caption box / lower-third
  fontName?:     string          // for captions (must be installed on the host)
  callToAction?: string          // text appended to outro
}

/** Sanitize workspaceId into a filesystem-safe slug. Without this, a
 *  workspace id like `../../../etc/passwd` would escape KIT_DIR entirely.
 *  We restrict to a small alphabet that's safe on every supported OS. */
function safeSlug(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '_')
  if (cleaned.length === 0 || cleaned.length > 80) {
    throw new Error(`brand-kit: invalid workspaceId: ${id.slice(0, 32)}…`)
  }
  return cleaned
}

function kitPath(workspaceId: string): string { return join(KIT_DIR, `${safeSlug(workspaceId)}.json`) }

export async function loadKit(workspaceId: string): Promise<BrandKit | null> {
  const p = kitPath(workspaceId)
  if (!existsSync(p)) return null
  try { return JSON.parse(await readFile(p, 'utf8')) as BrandKit } catch { return null }
}

export async function saveKit(kit: BrandKit): Promise<{ ok: boolean }> {
  await writeFile(kitPath(kit.workspaceId), JSON.stringify(kit, null, 2), 'utf8')
  return { ok: true }
}

async function runFfmpeg(args: string[], timeoutMs = 30 * 60_000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = ''
    let proc
    try { proc = spawn(FFMPEG, args, { windowsHide: true }) }
    catch (e) { resolve({ ok: false, stderr: (e as Error).message }); return }
    const t = setTimeout(() => proc!.kill('SIGTERM'), timeoutMs)
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    proc.on('close', (c) => { clearTimeout(t); resolve({ ok: c === 0, stderr }) })
    proc.on('error', (e) => { clearTimeout(t); resolve({ ok: false, stderr: e.message }) })
  })
}

/**
 * Apply brand kit to a video: prepend intro + append outro + overlay
 * logo throughout. All via ffmpeg concat + overlay filter — single pass.
 */
export async function applyBrandKit(workspaceId: string, inputVideo: string, outputVideo: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(inputVideo)) return { ok: false, error: 'input not found' }
  const kit = await loadKit(workspaceId)
  if (!kit) return { ok: false, error: 'no brand kit configured for workspace' }

  // Step 1: optionally concat intro + main + outro
  let concatPath = inputVideo
  if (kit.introPath || kit.outroPath) {
    const parts: string[] = []
    if (kit.introPath && existsSync(kit.introPath)) parts.push(kit.introPath)
    parts.push(inputVideo)
    if (kit.outroPath && existsSync(kit.outroPath)) parts.push(kit.outroPath)
    if (parts.length > 1) {
      const listPath = join(KIT_DIR, `concat-${Date.now().toString(36)}.txt`)
      await writeFile(listPath, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
      const concatOut = join(KIT_DIR, `concat-${Date.now().toString(36)}.mp4`)
      // Re-encode for concat safety (intro/outro/main may differ in codec)
      const r = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', concatOut])
      if (!r.ok) return { ok: false, error: `concat: ${r.stderr.slice(0, 300)}` }
      concatPath = concatOut
    }
  }

  // Step 2: logo overlay (if configured)
  if (kit.logoPath && existsSync(kit.logoPath)) {
    const pos = kit.logoPosition ?? 'tr'
    const xy = pos === 'tl' ? '20:20' : pos === 'tr' ? 'main_w-overlay_w-20:20' : pos === 'bl' ? '20:main_h-overlay_h-20' : 'main_w-overlay_w-20:main_h-overlay_h-20'
    const opacity = kit.logoOpacity ?? 0.85
    const filter = `[1:v]format=rgba,colorchannelmixer=aa=${opacity}[lg];[0:v][lg]overlay=${xy}`
    const r = await runFfmpeg(['-y', '-i', concatPath, '-i', kit.logoPath, '-filter_complex', filter, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'copy', outputVideo])
    if (!r.ok) return { ok: false, error: `overlay: ${r.stderr.slice(0, 300)}` }
    return { ok: true }
  }

  // No logo — just copy the concatenated result
  if (concatPath !== inputVideo) {
    const r = await runFfmpeg(['-y', '-i', concatPath, '-c', 'copy', outputVideo])
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.slice(0, 300) }
  }
  // Brand kit had nothing actionable — copy through
  const r = await runFfmpeg(['-y', '-i', inputVideo, '-c', 'copy', outputVideo])
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.slice(0, 300) }
}
