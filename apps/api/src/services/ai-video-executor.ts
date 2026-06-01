/**
 * ai-video-executor.ts — R146.96 — orchestrate plan → render → assemble.
 *
 * Bridges ai-video-studio (planning) with ai-video-providers (frontier
 * model rendering) and video-editor-agent (CapCut editorial). One end-to-end
 * pipeline from an Episode plan to a rendered MP4 file.
 *
 * Pipeline:
 *   1. For each Shot in episode.shots:
 *      a. Compute provider chain via routeShotToProvider()
 *      b. Build RenderRequest with continuity conditioning (ref images +
 *         prev-shot end frame from continuity plan)
 *      c. Render via primary, fall through to fallbacks
 *      d. Download the resulting video to local /tmp
 *      e. Emit progress event
 *   2. Generate music via existing music-studio if requested
 *   3. Generate voice-over via existing voiceover-service if script present
 *   4. Hand assembly to video-editor-agent or do a simple ffmpeg concat
 *   5. Apply captions + brand kit if configured
 *   6. Emit completion event with final MP4 path
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'
import { routeShotToProvider, buildContinuityPlan, planAssembly, type Episode, type Shot } from './ai-video-studio.js'
import { renderShotWithFallback, type RenderResult } from './ai-video-providers.js'

export interface ExecuteEpisodeInput {
  workspaceId:    string
  episode:        Episode
  parallelShots?: number             // default 2 — frontier models throttle hard
  concatOutputPath: string           // /srv/renders/episode-<id>.mp4
  generateMusic?: { prompt: string; durationSec?: number }
  generateVoiceover?: { text: string; voice?: string; style?: 'neutral' | 'narrator' | 'energetic' | 'calm' | 'authoritative' }
  burnCaptions?:  boolean
  applyBrandKit?: boolean
}

export interface ExecuteEpisodeResult {
  ok:               boolean
  episodeId:        string
  shotsRendered:    number
  shotsFailed:      number
  totalCostUsd:     number
  totalLatencyMs:   number
  finalOutputPath?: string
  shotResults:      Array<{ shotId: string; ok: boolean; provider: string; localPath?: string; costUsd: number; latencyMs: number; error?: string; providerChain: string[] }>
  musicPath?:       string
  voiceoverPath?:   string
  captionsPath?:    string
  error?:           string
}

export async function executeEpisode(input: ExecuteEpisodeInput): Promise<ExecuteEpisodeResult> {
  const t0 = Date.now()
  const continuity = buildContinuityPlan({ episode: input.episode })
  const cuts = planAssembly({ shots: input.episode.shots })

  await emit(input.workspaceId, 'aiVideo.execution.started', {
    episodeId: input.episode.id, shotCount: input.episode.shots.length, totalSec: cuts.totalDurationSec,
  })

  // Render shots. R146.100 — must be sequential when continuity matters
  // because each shot's first frame is conditioned on the PREVIOUS shot's
  // last frame. Operator can override with parallelShots > 1 to skip
  // continuity (faster but worse character/scene consistency).
  const parallel = Math.max(1, Math.min(4, input.parallelShots ?? 1))
  const shotResults: ExecuteEpisodeResult['shotResults'] = []
  const queue = [...input.episode.shots]
  let totalCostUsd = 0
  // R146.100 — last-frame URLs by shot id, populated as we go.
  const lastFrameByShotId: Map<string, string> = new Map()

  const runShot = async (shot: Shot): Promise<void> => {
    const routing = routeShotToProvider(shot)
    const ccShot = continuity.perShot.find(p => p.shotId === shot.id)
    const refs: string[] = []
    if (ccShot?.refImages?.length) refs.push(...ccShot.refImages.slice(0, 3))
    // Character refs in this shot
    for (const charId of shot.charactersInShot) {
      const charBibleEntry = continuity.characterBible.find(c => c.characterId === charId)
      if (charBibleEntry) refs.push(...charBibleEntry.referenceImages.slice(0, 2))
    }
    // R146.100 — resolve prev-shot end frame. The continuity plan refers to
    // it by symbolic anchor; here we look up the actual URL/path from the
    // already-rendered prev shot. Without parallel=1, this won't always be
    // available (shots may render out of order); in that case we fall back
    // to the character/scene ref images for continuity conditioning.
    const shotIdx = input.episode.shots.findIndex(s => s.id === shot.id)
    const prevShotId = shotIdx > 0 ? input.episode.shots[shotIdx - 1]?.id : undefined
    const prevShotEndFrame = prevShotId ? lastFrameByShotId.get(prevShotId) : undefined
    const req = {
      prompt:           shot.prompt,
      durationSec:      shot.durationSec,
      aspectRatio:      '16:9' as const,
      referenceImages:  refs.slice(0, 4),
      workspaceId:      input.workspaceId,
      ...(shot.cameraMove ? { cameraMove: shot.cameraMove } : {}),
      ...(prevShotEndFrame ? { prevShotEndFrame } : {}),
      ...(ccShot?.seedAnchor ? { seed: hashStr(ccShot.seedAnchor) } : {}),
    }
    const r = await renderShotWithFallback(
      routing.primary as 'runway' | 'veo' | 'sora' | 'kling' | 'luma',
      routing.fallbacks as Array<'runway' | 'veo' | 'sora' | 'kling' | 'luma'>,
      req,
    )
    totalCostUsd += r.costUsd
    let localPath: string | undefined
    if (r.ok && r.videoUrl) {
      try {
        const tag = `${input.episode.id}-${shot.id}`
        localPath = await downloadToLocal(r.videoUrl, tag)
        // R146.100 — extract last frame for next-shot continuity. We point
        // the lastFrameByShotId map at the source URL (most provider APIs
        // can accept the same URL again as image-conditioning); the
        // executor's `prevShotEndFrame` then threads that into the next
        // shot's RenderRequest. ffmpeg frame-extraction is the followup
        // optimization for cases where mid/end frames matter more than
        // the first frame.
        if (r.videoUrl) lastFrameByShotId.set(shot.id, r.videoUrl)
      } catch (e) {
        await emit(input.workspaceId, 'aiVideo.shot.download_failed', { shotId: shot.id, error: (e as Error).message })
      }
    }
    shotResults.push({
      shotId:        shot.id,
      ok:            r.ok && !!localPath,
      provider:      r.provider,
      ...(localPath ? { localPath } : {}),
      costUsd:       r.costUsd,
      latencyMs:     r.latencyMs,
      ...(r.error ? { error: r.error } : {}),
      providerChain: r.providerChain,
    })
    await emit(input.workspaceId, r.ok ? 'aiVideo.shot.rendered' : 'aiVideo.shot.failed', {
      shotId: shot.id, provider: r.provider, ok: r.ok, costUsd: r.costUsd, error: r.error,
    })
  }

  // Bounded concurrency runner
  const workers: Array<Promise<void>> = []
  for (let i = 0; i < parallel; i++) {
    workers.push((async () => {
      while (queue.length) {
        const s = queue.shift()
        if (!s) break
        await runShot(s)
      }
    })())
  }
  await Promise.all(workers)

  const failed = shotResults.filter(r => !r.ok).length
  const succeeded = shotResults.length - failed

  // Optional: music + voiceover in parallel
  let musicPath: string | undefined
  let voiceoverPath: string | undefined
  await Promise.all([
    (async () => {
      if (input.generateMusic) {
        try {
          const { generateMusic } = await import('./music-studio.js')
          const m = await generateMusic({
            prompt:      input.generateMusic.prompt,
            duration:    input.generateMusic.durationSec ?? cuts.totalDurationSec,
            quality:     'studio',
            workspaceId: input.workspaceId,
          })
          if ((m as { audioPath?: string })?.audioPath) musicPath = (m as { audioPath: string }).audioPath
        } catch (e) { await emit(input.workspaceId, 'aiVideo.music.failed', { error: (e as Error).message }) }
      }
    })(),
    (async () => {
      if (input.generateVoiceover) {
        try {
          const { synthesize } = await import('./voiceover-service.js')
          const v = await synthesize({
            text:        input.generateVoiceover.text,
            workspaceId: input.workspaceId,
            ...(input.generateVoiceover.voice ? { voice: input.generateVoiceover.voice } : {}),
            ...(input.generateVoiceover.style ? { style: input.generateVoiceover.style } : {}),
          })
          const out  = (v as { outPath?: string } | undefined)?.outPath
          const audio = (v as { audioPath?: string } | undefined)?.audioPath
          if (typeof out  === 'string') voiceoverPath = out
          else if (typeof audio === 'string') voiceoverPath = audio
        } catch (e) { await emit(input.workspaceId, 'aiVideo.voiceover.failed', { error: (e as Error).message }) }
      }
    })(),
  ])

  // Assembly: ffmpeg concat of the rendered shots in order
  let finalOutputPath: string | undefined
  if (succeeded > 0) {
    try {
      const concatArgs: { orderedLocalPaths: string[]; outputPath: string; musicPath?: string; voiceoverPath?: string } = {
        orderedLocalPaths: input.episode.shots.map(s => shotResults.find(r => r.shotId === s.id)?.localPath).filter((p): p is string => !!p),
        outputPath:        input.concatOutputPath,
      }
      if (musicPath)     concatArgs.musicPath     = musicPath
      if (voiceoverPath) concatArgs.voiceoverPath = voiceoverPath
      finalOutputPath = await concatShots(concatArgs)
    } catch (e) {
      await emit(input.workspaceId, 'aiVideo.assembly.failed', { error: (e as Error).message })
    }
  }

  // Captions
  let captionsPath: string | undefined
  if (finalOutputPath && input.burnCaptions) {
    try {
      const { transcribeToSrt, burnCaptions } = await import('./caption-service.js')
      const srt = await transcribeToSrt(finalOutputPath)
      if ((srt as { srtPath?: string })?.srtPath) {
        const captioned = finalOutputPath.replace(/\.mp4$/i, '_captioned.mp4')
        await burnCaptions(finalOutputPath, (srt as { srtPath: string }).srtPath, captioned)
        captionsPath = captioned
        finalOutputPath = captioned
      }
    } catch (e) { await emit(input.workspaceId, 'aiVideo.captions.failed', { error: (e as Error).message }) }
  }

  // Brand kit
  if (finalOutputPath && input.applyBrandKit) {
    try {
      const { applyBrandKit } = await import('./brand-kit.js')
      const branded = finalOutputPath.replace(/\.mp4$/i, '_branded.mp4')
      await applyBrandKit(input.workspaceId, finalOutputPath, branded)
      finalOutputPath = branded
    } catch (e) { await emit(input.workspaceId, 'aiVideo.brandkit.failed', { error: (e as Error).message }) }
  }

  const totalLatencyMs = Date.now() - t0
  await emit(input.workspaceId, 'aiVideo.execution.completed', {
    episodeId:    input.episode.id,
    shotsRendered: succeeded,
    shotsFailed:   failed,
    totalCostUsd,
    totalLatencyMs,
    finalOutputPath,
  })

  const result: ExecuteEpisodeResult = {
    ok:            succeeded > 0 && !!finalOutputPath,
    episodeId:     input.episode.id,
    shotsRendered: succeeded,
    shotsFailed:   failed,
    totalCostUsd,
    totalLatencyMs,
    shotResults,
  }
  if (finalOutputPath) result.finalOutputPath = finalOutputPath
  if (musicPath)       result.musicPath       = musicPath
  if (voiceoverPath)   result.voiceoverPath   = voiceoverPath
  if (captionsPath)    result.captionsPath    = captionsPath
  if (succeeded === 0) result.error           = 'all-shots-failed'
  return result
}

// ─── Helpers ────────────────────────────────────────────────────────────

function hashStr(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return Math.abs(h) % 2_147_483_647
}

async function downloadToLocal(url: string, tag: string): Promise<string> {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const outDir = join(tmpdir(), 'novan-shots')
  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, `${tag.replace(/[^a-z0-9-]/gi, '_')}.mp4`)
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`download ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(outPath, buf)
  return outPath
}

async function concatShots(input: { orderedLocalPaths: string[]; outputPath: string; musicPath?: string; voiceoverPath?: string }): Promise<string> {
  if (input.orderedLocalPaths.length === 0) throw new Error('no shots to concat')
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawn } = await import('node:child_process')
  await mkdir(dirname(input.outputPath), { recursive: true }).catch(() => null)
  const listPath = join(tmpdir(), `novan-concat-${Date.now()}.txt`)
  const listBody = input.orderedLocalPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
  await writeFile(listPath, listBody)
  // ffmpeg concat protocol
  const args: string[] = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath]
  if (input.musicPath)      args.push('-i', input.musicPath)
  if (input.voiceoverPath)  args.push('-i', input.voiceoverPath)
  // Map: video from concat, audio mix of music (ducked) + voiceover
  if (input.musicPath && input.voiceoverPath) {
    args.push('-filter_complex', '[1:a]volume=0.25[m];[m][2:a]amix=inputs=2:duration=longest[a]', '-map', '0:v', '-map', '[a]')
  } else if (input.musicPath || input.voiceoverPath) {
    args.push('-map', '0:v', '-map', '1:a')
  } else {
    args.push('-c', 'copy')
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', input.outputPath)
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args)
    let stderr = ''
    p.stderr.on('data', d => { stderr += d.toString() })
    p.on('close', code => {
      if (code === 0) resolve(input.outputPath)
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`))
    })
    p.on('error', err => reject(err))
  })
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'ai-video-executor', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// Surface RenderResult type for downstream consumers
export type { RenderResult }
