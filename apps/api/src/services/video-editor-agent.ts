/**
 * video-editor-agent.ts — the brain's video-editing conductor.
 *
 * Three layers:
 *
 *   1. editOne({brief, format, outPath, originalFootage?})
 *      Full single-video pipeline: plan beats → gather assets (scraper +
 *      optional supplied originals) → drive CapCut → export master.
 *
 *   2. massProduce({prompts, format, outDir, concurrency})
 *      Mass-production: queues N briefs and runs them with bounded
 *      parallelism. Long-form takes ~10-25 min each; shorts ~3-6 min.
 *      Designed for "give me 20 videos by tonight" runs.
 *
 *   3. planBeats(brief, format)
 *      LLM-driven beat planning. Returns a structured shot list the
 *      asset scraper can target with precise keywords per beat.
 *
 * The "brain as conductor" model: this module owns video production
 * end-to-end. It uses streamChat for planning, video-asset-scraper for
 * sourcing, capcut-controller for assembly. The result is a mastered
 * file ready to publish.
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'

// ─── Types ─────────────────────────────────────────────────────────────
export type VideoFormat = 'long' | 'short' | 'square'

export interface EditOneInput {
  brief:           string
  outPath:         string
  format?:         VideoFormat           // default 'long'
  originalFootage?: string[]              // operator-supplied local paths
  workspaceId?:    string
  scrapeMix?:      { video?: number; image?: number; music?: number }
  /** Cancel token (production-log.newCancelToken()) for mid-flight abort. */
  cancelToken?:    string
  /** Auto-generate thumbnail on completion. Default true. */
  autoThumbnail?:  boolean
  /** Auto-apply color grade preset. Default 'cinematic' for long-form,
   *  'punchy' for short, 'clean' for square. Pass null to skip. */
  colorGrade?:     'cinematic' | 'vlog' | 'vintage' | 'moody' | 'clean' | 'warm' | 'cold' | 'teal-orange' | 'bw' | 'punchy' | null
  /** Fall back to AI b-roll (Runway/Luma/Replicate) when scraper returns
   *  fewer than `minAssets` items. Default 3. Set 0 to disable. */
  minAssets?:      number
}

export interface EditOneResult {
  ok: boolean
  outPath?:        string
  thumbnailPath?:  string
  productionLogId?: string
  format:          VideoFormat
  beats?:          Beat[]
  assetCount:      number
  steps:           string[]
  cancelled?:      boolean
  error?:          string
  startedAt:       number
  finishedAt?:     number
}

export interface Beat {
  index:     number
  durationS: number
  caption?:  string                       // on-screen text
  voiceover?: string                      // narration line
  visualHint: string                      // what should be on-screen
  searchQuery: string                     // scraper input
}

// ─── Beat planning (LLM) ───────────────────────────────────────────────
export async function planBeats(brief: string, format: VideoFormat = 'long', workspaceId = 'default'): Promise<Beat[]> {
  const total = format === 'long' ? 600 : format === 'short' ? 45 : 60
  const beatCount = format === 'long' ? 18 : format === 'short' ? 7 : 9

  const sys = `You are a senior video editor planning a ${format === 'long' ? 'long-form (8-12 min)' : format === 'short' ? 'short-form vertical (30-60s)' : 'square social (45-90s)'} video.

Output STRICT JSON only — an array of ${beatCount} beats covering the full duration (~${total} seconds total). Each beat:
{
  "index": <1-based>,
  "durationS": <seconds, 3-30>,
  "caption": "<short on-screen text, 4-9 words>",
  "voiceover": "<one narration sentence>",
  "visualHint": "<what footage should be on-screen — concrete visual>",
  "searchQuery": "<2-4 keywords the asset scraper will search for>"
}

Pacing: open with a hook (≤4s), build tension, deliver value, close with CTA. Vary shot length to avoid monotony. No fluff beats. Return only the JSON array.`

  try {
    const { streamChat } = await import('./chat-providers.js')
    let raw = ''
    for await (const chunk of streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Brief:\n${brief}` },
    ])) {
      if (chunk.delta) raw += chunk.delta
    }
    const m = raw.match(/\[[\s\S]*\]/)
    if (!m) return []
    const parsed = JSON.parse(m[0]) as Beat[]
    return parsed.slice(0, beatCount).map((b, i) => ({
      index: b.index ?? i + 1,
      durationS: Math.max(2, Math.min(60, Number(b.durationS) || 5)),
      caption: String(b.caption ?? '').slice(0, 80),
      voiceover: String(b.voiceover ?? ''),
      visualHint: String(b.visualHint ?? ''),
      searchQuery: String(b.searchQuery ?? '').trim() || (b.visualHint ?? '').split(/\s+/).slice(0, 3).join(' '),
    }))
  } catch { return [] }
}

// ─── editOne ───────────────────────────────────────────────────────────
export async function editOne(input: EditOneInput): Promise<EditOneResult> {
  const startedAt = Date.now()
  const steps: string[] = []
  const format = input.format ?? 'long'

  // Production log + cancel token
  const { record, complete: logComplete, isCancelled, newCancelToken, clearCancelToken } = await import('./production-log.js')
  const cancelToken = input.cancelToken ?? newCancelToken()
  const cancelCheck = () => isCancelled(cancelToken)
  const logId = await record({
    workspaceId: input.workspaceId ?? 'default',
    kind: 'video',
    status: 'started',
    brief: input.brief,
    meta: { format, cancelToken },
  })

  try {
    if (cancelCheck()) {
      await logComplete(logId, { status: 'cancelled', durationMs: Date.now() - startedAt })
      return { ok: false, format, assetCount: 0, steps: ['cancelled before start'], cancelled: true, productionLogId: logId, startedAt, finishedAt: Date.now() }
    }

    // 1. Plan beats
    steps.push('planning beats…')
    const beats = await planBeats(input.brief, format, input.workspaceId ?? 'default')

    // 2. Gather assets — per-beat search queries (parallel) + optional originals
    steps.push(`gathering assets across ${beats.length || 'fallback'} beats…`)
    const { findAssets } = await import('./video-asset-scraper.js')
    const queries = beats.length > 0
      ? Array.from(new Set(beats.map(b => b.searchQuery).filter(Boolean)))
      : [input.brief.split(/\s+/).slice(0, 4).join(' ')]
    const mix = input.scrapeMix ?? (format === 'short' ? { video: 8, image: 2, music: 1 } : { video: 12, image: 6, music: 2 })
    const orientation = format === 'short' ? 'portrait' : format === 'square' ? 'square' : 'landscape'
    const found = await findAssets({ brief: input.brief, mix, orientation, queries })
    steps.push(`scraped ${found.assets.length} assets in ${found.durationMs}ms across ${found.queriesUsed.length} queries`)

    // 3. Combine with originals + AI b-roll fallback if too few assets
    const originals = (input.originalFootage ?? []).filter(p => existsSync(p)).map(p => ({
      path: p,
      role: 'main' as const,
    }))
    const allAssets: Array<{ path: string; role?: 'main' | 'broll' | 'music' | 'voiceover' | 'overlay' }> = []
    for (const o of originals) allAssets.push(o)
    for (const a of found.assets) {
      const entry: { path: string; role?: 'main' | 'broll' | 'music' | 'voiceover' | 'overlay' } = { path: a.path }
      if (a.role) entry.role = a.role
      allAssets.push(entry)
    }

    // AI b-roll fallback — when the scraper couldn't find enough, fill
    // the gap with Runway/Luma/Replicate generation. Driven by the beat
    // visualHints so each generated clip matches a specific shot need.
    const minAssets = input.minAssets ?? 3
    if (allAssets.length < minAssets && beats.length > 0 && !cancelCheck()) {
      const need = minAssets - allAssets.length
      steps.push(`scraper short ${allAssets.length}/${minAssets} — generating ${need} AI b-roll clips…`)
      try {
        const { generateBatch } = await import('./ai-broll-generator.js')
        const aspect = format === 'short' ? '9:16' : format === 'square' ? '1:1' : '16:9'
        const promptsForAi = beats.slice(0, need).map(b => ({
          prompt: b.visualHint || b.searchQuery,
          durationSec: Math.max(4, Math.min(10, b.durationS)),
          aspectRatio: aspect as '16:9' | '9:16' | '1:1',
        }))
        const aiResults = await generateBatch(promptsForAi)
        for (const r of aiResults) {
          if (r.ok && r.path) {
            allAssets.push({ path: r.path, role: 'broll' })
            steps.push(`+ ai-broll: ${r.provider}`)
          }
        }
      } catch (e) { steps.push(`ai-broll fallback skipped: ${(e as Error).message}`) }
    }

    if (allAssets.length === 0) {
      await logComplete(logId, { status: 'failed', error: 'no assets gathered', durationMs: Date.now() - startedAt })
      clearCancelToken(cancelToken)
      return { ok: false, format, assetCount: 0, productionLogId: logId, steps: [...steps, 'no usable assets'], error: 'no assets gathered', startedAt, finishedAt: Date.now() }
    }
    if (cancelCheck()) {
      await logComplete(logId, { status: 'cancelled', durationMs: Date.now() - startedAt })
      clearCancelToken(cancelToken)
      return { ok: false, format, assetCount: allAssets.length, productionLogId: logId, steps, cancelled: true, startedAt, finishedAt: Date.now() }
    }

    // 4. Drive CapCut
    steps.push(`assembling in CapCut (${allAssets.length} assets)…`)
    const { assemble } = await import('./capcut-controller.js')
    const result = await assemble({
      brief: input.brief,
      assets: allAssets,
      outPath: input.outPath,
      format: format === 'square' ? 'short' : format,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    })
    steps.push(...result.steps)

    if (!result.ok) {
      await logComplete(logId, { status: 'failed', error: result.error ?? 'capcut assemble failed', durationMs: Date.now() - startedAt })
      clearCancelToken(cancelToken)
      const out: EditOneResult = {
        ok: false, format, beats, assetCount: allAssets.length,
        productionLogId: logId,
        steps, error: result.error ?? 'capcut assemble failed', startedAt, finishedAt: Date.now(),
      }
      return out
    }

    let finalPath = result.outPath ?? input.outPath

    // 5. Narration (TTS) if beats include voiceover lines — synthesize +
    //    mux onto the video at -6 dB under the existing audio.
    const voiceoverLines = beats.map(b => b.voiceover).filter((s): s is string => !!s && s.trim().length > 0)
    if (voiceoverLines.length > 0) {
      try {
        steps.push(`synthesizing ${voiceoverLines.length} voiceover beats…`)
        const { synthesizeBeats } = await import('./voiceover-service.js')
        const vo = await synthesizeBeats(voiceoverLines, { style: format === 'short' ? 'energetic' : 'narrator' })
        if (vo.ok && vo.path) {
          // Extract the existing music track from the video, then use
          // sidechain compression to duck it under the voice — much
          // cleaner than the static volume=0.35 mix.
          const { spawn } = await import('node:child_process')
          const { duckMusicUnderVoice, replaceVideoAudio } = await import('./audio-ducking.js')
          const ffmpeg = process.env['FFMPEG_BIN'] ?? 'ffmpeg'
          // Step A: extract original music track
          const musicTmp = finalPath.replace(/(\.[^.]+)$/, '.mus.aac')
          const extractOk = await new Promise<boolean>((resolve) => {
            const p = spawn(ffmpeg, ['-y', '-i', finalPath, '-vn', '-c:a', 'aac', '-b:a', '192k', musicTmp], { windowsHide: true })
            p.on('close', (c) => resolve(c === 0 && existsSync(musicTmp)))
            p.on('error', () => resolve(false))
          })
          if (extractOk) {
            // Step B: duck music under voice (sidechaincompress, -10 dB)
            const duckedAudio = finalPath.replace(/(\.[^.]+)$/, '.ducked.aac')
            const duck = await duckMusicUnderVoice(musicTmp, vo.path, duckedAudio, {
              reductionDb: -10, attackMs: 80, releaseMs: 400, ratio: 8,
            })
            if (duck.ok) {
              // Step C: mux ducked audio onto video
              const muxedPath = finalPath.replace(/(\.[^.]+)$/, '.vo$1')
              const mux = await replaceVideoAudio(finalPath, duckedAudio, muxedPath)
              if (mux.ok) { finalPath = muxedPath; steps.push('voiceover ducked + mixed (sidechain comp)') }
            }
          }
        }
      } catch (e) { steps.push(`voiceover skipped: ${(e as Error).message}`) }
    }

    // 6. Captions — short-form always gets word-level burn-in, long-form
    //    only gets a sidecar SRT (creators usually want manual review).
    if (format === 'short' || format === 'square') {
      try {
        steps.push('burning captions…')
        const { transcribeToSrt, burnCaptions } = await import('./caption-service.js')
        const tr = await transcribeToSrt(finalPath, { wordLevel: true })
        if (tr.ok && tr.srtPath) {
          const capOut = finalPath.replace(/(\.[^.]+)$/, '.cap$1')
          const burn = await burnCaptions(finalPath, tr.srtPath, capOut, { fontSize: 24, bottomMargin: 600, outlineWidth: 4 })
          if (burn.ok) { finalPath = capOut; steps.push('captions burned in') }
        }
      } catch (e) { steps.push(`captions skipped: ${(e as Error).message}`) }
    }

    // 7. Brand kit (intro + logo + outro) if configured for workspace
    if (input.workspaceId) {
      try {
        const { loadKit, applyBrandKit } = await import('./brand-kit.js')
        const kit = await loadKit(input.workspaceId)
        if (kit) {
          steps.push('applying brand kit…')
          const brandedOut = finalPath.replace(/(\.[^.]+)$/, '.branded$1')
          const ap = await applyBrandKit(input.workspaceId, finalPath, brandedOut)
          if (ap.ok) { finalPath = brandedOut; steps.push('brand kit applied') }
        }
      } catch (e) { steps.push(`brand kit skipped: ${(e as Error).message}`) }
    }

    // 8. Color grade — auto-apply a tasteful baseline preset unless
    //    operator opted out (input.colorGrade === null). Long → cinematic,
    //    short → punchy, square → clean. Operator can override.
    const colorPreset = input.colorGrade === undefined
      ? (format === 'short' ? 'punchy' : format === 'square' ? 'clean' : 'cinematic')
      : input.colorGrade
    if (colorPreset) {
      try {
        const { applyGrade } = await import('./color-grading.js')
        const gradedOut = finalPath.replace(/(\.[^.]+)$/, '.graded$1')
        const cg = await applyGrade(finalPath, gradedOut, colorPreset)
        if (cg.ok) { finalPath = gradedOut; steps.push(`color grade applied: ${colorPreset}`) }
      } catch (e) { steps.push(`color grade skipped: ${(e as Error).message}`) }
    }

    // 9. Auto-generate thumbnail (frame-pick + title overlay)
    let thumbnailPath: string | undefined
    if (input.autoThumbnail !== false) {
      try {
        const { generateThumbnail } = await import('./thumbnail-generator.js')
        const titleHint = beats[0]?.caption ?? input.brief.split(/\s+/).slice(0, 4).join(' ')
        const t = await generateThumbnail({
          brief: input.brief,
          videoPath: finalPath,
          title: titleHint,
          format: format === 'short' || format === 'square' ? 'portrait' : 'landscape',
          strategy: 'auto',
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        })
        if (t.ok && t.path) { thumbnailPath = t.path; steps.push(`thumbnail: ${t.strategy}`) }
      } catch (e) { steps.push(`thumbnail skipped: ${(e as Error).message}`) }
    }

    // Realism gate — refuse to claim completion if the output file
    // doesn't actually exist + is non-empty. Catches "ok=true but no
    // real artifact" silent failures.
    try {
      const { verifyFileExists } = await import('./realism-verifier.js')
      const v = verifyFileExists(finalPath)
      if (!v.real) {
        await logComplete(logId, { status: 'failed', error: `realism-gate: ${v.gaps.join('; ')}`, durationMs: Date.now() - startedAt })
        clearCancelToken(cancelToken)
        return {
          ok: false, format, beats, assetCount: allAssets.length,
          productionLogId: logId, steps: [...steps, 'realism-gate failed: claimed completion without real output'],
          error: `realism-gate: ${v.gaps.join('; ')}`,
          startedAt, finishedAt: Date.now(),
        }
      }
    } catch { /* verifier failure shouldn't kill the op */ }

    // Log completion + clear cancel token
    await logComplete(logId, {
      status: 'completed', outputPath: finalPath,
      meta: { thumbnailPath, colorPreset, assetCount: allAssets.length },
      durationMs: Date.now() - startedAt,
    })
    clearCancelToken(cancelToken)

    return {
      ok: true,
      format,
      beats,
      assetCount: allAssets.length,
      steps,
      outPath: finalPath,
      productionLogId: logId,
      ...(thumbnailPath ? { thumbnailPath } : {}),
      startedAt, finishedAt: Date.now(),
    }
  } catch (e) {
    await logComplete(logId, { status: 'failed', error: (e as Error).message, durationMs: Date.now() - startedAt })
    clearCancelToken(cancelToken)
    return { ok: false, format, assetCount: 0, productionLogId: logId, steps, error: (e as Error).message, startedAt, finishedAt: Date.now() }
  }
}

// ─── Mass production ───────────────────────────────────────────────────
export interface MassProduceInput {
  /** One brief per video. Each becomes a separate edit. */
  prompts:       string[]
  format?:       VideoFormat
  outDir:        string
  /** Max simultaneous edits. CapCut can only run one project at a time,
   *  so concurrency >1 here means asset-scraping happens in parallel
   *  while CapCut serially assembles each. Default 1. */
  concurrency?:  number
  workspaceId?:  string
  /** Cancellation token from production-log.newCancelToken(). Operator
   *  calls production-log.cancel(id) to abort mid-run. */
  cancelToken?:  string
}

export interface MassProduceResult {
  ok: boolean
  total:      number
  succeeded:  number
  failed:     number
  cancelled:  boolean
  cancelToken?: string
  results:    EditOneResult[]
  durationMs: number
}

export async function massProduce(input: MassProduceInput): Promise<MassProduceResult> {
  const t0 = Date.now()
  const format = input.format ?? 'short'
  const concurrency = Math.max(1, Math.min(4, input.concurrency ?? 1))
  const results: EditOneResult[] = []

  // Production log + cancel token
  const { record, complete: logComplete, isCancelled, newCancelToken, clearCancelToken } = await import('./production-log.js')
  const cancelToken = input.cancelToken ?? newCancelToken()
  const runId = await record({
    workspaceId: input.workspaceId ?? 'default',
    kind: 'mass-produce',
    status: 'started',
    meta: { format, total: input.prompts.length, concurrency, cancelToken },
  })
  let wasCancelled = false

  // Pre-scrape assets for ALL prompts in parallel (the slow part is
  // network + downloads, which IS parallel-safe). CapCut assembly runs
  // serially since it's a single GUI process.
  const { findAssets } = await import('./video-asset-scraper.js')
  const orientation = format === 'short' ? 'portrait' : format === 'square' ? 'square' : 'landscape'
  const scrapes = await Promise.all(input.prompts.map(async (p) => {
    const queries = (await planBeats(p, format, input.workspaceId ?? 'default')).map(b => b.searchQuery).filter(Boolean)
    return findAssets({
      brief: p,
      mix: format === 'short' ? { video: 8, image: 2, music: 1 } : { video: 12, image: 6, music: 2 },
      orientation,
      queries: queries.length > 0 ? queries : undefined as unknown as string[],
    })
  }))

  // Worker pool for the CapCut assembly stage
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      if (isCancelled(cancelToken)) { wasCancelled = true; return }
      const idx = cursor++
      if (idx >= input.prompts.length) return
      const brief = input.prompts[idx]!
      const outPath = join(input.outDir, `mass-${format}-${idx.toString().padStart(3, '0')}-${Date.now().toString(36)}.mp4`)
      const editInput: EditOneInput = { brief, outPath, format }
      if (input.workspaceId) editInput.workspaceId = input.workspaceId
      const scrape = scrapes[idx]
      if (scrape && scrape.assets.length > 0) {
        editInput.originalFootage = scrape.assets.map(a => a.path)
        editInput.scrapeMix = { video: 0, image: 0, music: 0 }
      }
      const r = await editOne(editInput)
      results[idx] = r
      await record({
        workspaceId: input.workspaceId ?? 'default',
        kind: 'video', status: r.ok ? 'completed' : 'failed',
        brief, ...(r.outPath ? { outputPath: r.outPath } : {}),
        meta: { runId, idx, format },
        ...(r.error ? { error: r.error } : {}),
      })
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  const succeeded = results.filter(r => r?.ok).length
  const durationMs = Date.now() - t0
  await logComplete(runId, {
    status: wasCancelled ? 'cancelled' : (succeeded > 0 ? 'completed' : 'failed'),
    meta: { succeeded, failed: input.prompts.length - succeeded, total: input.prompts.length },
    durationMs,
  })
  clearCancelToken(cancelToken)
  return {
    ok: succeeded > 0 && !wasCancelled,
    total: input.prompts.length, succeeded, failed: input.prompts.length - succeeded,
    cancelled: wasCancelled, cancelToken,
    results, durationMs,
  }
}
