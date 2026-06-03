/**
 * R170 — Frontier video: Vibe Motion + Multi-shot character continuity +
 * Image-to-Video direct path. Higgsfield-style finishing touches.
 *
 * (a) vibeMotionDerive — mines top-scoring past PAI runs, extracts the
 *     dominant motion combinations, and mints a new DirectorProfile so
 *     future runs inherit the "look" that already works.
 *
 * (b) Multi-shot character continuity — already wired by patching
 *     ai-video-executor to pick up shot.referenceUrls from R166's
 *     applyProfileToPlan output. No extra surface needed here.
 *
 * (c) imageToVideo — single-shot direct render path bypassing episode
 *     planning. Operator hands in an image + motion preset; we build a
 *     minimal Episode of one shot and call executeEpisode.
 */
import { db } from '../db/client.js'
import {
  videoPaiRun, directorProfile, directorRunBinding,
} from '../db/schema.js'
import { and, eq, desc, sql, isNotNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { MOTION_PRESETS } from './r166-director-controls.js'

// ─── Vibe Motion derive ──────────────────────────────────────────────

/**
 * Look at the top-N PAI runs by outcomeScore. For each, fetch the
 * DirectorProfile that was bound to it. Aggregate motion frequency
 * across winners. Top-3 most-frequent become the new profile's motions
 * array. Camera body / lens / grade are taken from the single highest-
 * scoring run.
 */
export async function vibeMotionDerive(workspaceId: string, opts: { topN?: number; profileName?: string } = {}): Promise<{ ok: boolean; profileId?: string; topMotions: Array<{ key: string; uses: number }>; sampleSize: number; error?: string }> {
  const topN = Math.max(3, Math.min(opts.topN ?? 10, 50))

  // Top-scored done runs.
  const runs = await db.select({
    id: videoPaiRun.id, score: videoPaiRun.outcomeScore,
  })
    .from(videoPaiRun)
    .where(and(
      eq(videoPaiRun.workspaceId, workspaceId),
      eq(videoPaiRun.phase, 'done'),
      isNotNull(videoPaiRun.outcomeScore),
    ))
    .orderBy(desc(videoPaiRun.outcomeScore))
    .limit(topN)

  if (runs.length < 3) return { ok: false, topMotions: [], sampleSize: runs.length, error: 'need ≥3 scored runs to derive vibe' }

  // Resolve bindings → profiles.
  const runIds = runs.map(r => r.id)
  const bindings = await db.select().from(directorRunBinding)
    .where(sql`${directorRunBinding.runId} IN (${sql.join(runIds.map(id => sql`${id}`), sql`, `)})`)
  if (bindings.length === 0) return { ok: false, topMotions: [], sampleSize: runs.length, error: 'no director profiles bound to top runs' }

  const profiles = await db.select().from(directorProfile)
    .where(sql`${directorProfile.id} IN (${sql.join(bindings.map(b => sql`${b.profileId}`), sql`, `)})`)

  // Frequency-weight motions by the originating run's outcomeScore.
  const motionFreq = new Map<string, number>()
  const profileById = new Map(profiles.map(p => [p.id, p]))
  const bindingByRun = new Map(bindings.map(b => [b.runId, b]))
  let bestRun: { run: { id: string; score: number | null }; profile: typeof directorProfile.$inferSelect } | null = null

  for (const r of runs) {
    const b = bindingByRun.get(r.id); if (!b) continue
    const p = profileById.get(b.profileId); if (!p) continue
    const weight = Math.max(0.1, Number(r.score ?? 0.5))
    for (const m of (p.motions ?? [])) {
      motionFreq.set(m, (motionFreq.get(m) ?? 0) + weight)
    }
    if (!bestRun || (Number(r.score ?? 0) > Number(bestRun.run.score ?? 0))) {
      bestRun = { run: r, profile: p }
    }
  }

  const ranked = [...motionFreq.entries()]
    .filter(([k]) => MOTION_PRESETS[k])
    .sort((a, b) => b[1] - a[1])
    .map(([key, uses]) => ({ key, uses: Math.round(uses * 100) / 100 }))

  if (ranked.length === 0 || !bestRun) return { ok: false, topMotions: [], sampleSize: runs.length, error: 'no valid motion data' }

  const topMotions = ranked.slice(0, 3)
  const name = opts.profileName ?? `vibe-${new Date().toISOString().slice(0, 10)}-${runs.length}`

  const id = uuidv7()
  await db.insert(directorProfile).values({
    id, workspaceId,
    name,
    cameraBody: bestRun.profile.cameraBody,
    lens:       bestRun.profile.lens,
    focalMm:    bestRun.profile.focalMm,
    aperture:   bestRun.profile.aperture,
    shutterDeg: bestRun.profile.shutterDeg,
    motions:    topMotions.map(m => m.key),
    colorGrade: bestRun.profile.colorGrade,
    ...(bestRun.profile.vibe ? { vibe: bestRun.profile.vibe } : {}),
    notes: `Auto-derived from ${runs.length} top-scored runs. Source profile: ${bestRun.profile.name}`,
    status: 'active',
    createdAt: Date.now(),
  }).onConflictDoUpdate({
    target: [directorProfile.workspaceId, directorProfile.name],
    set: {
      motions: topMotions.map(m => m.key),
      notes: `Auto-derived from ${runs.length} top-scored runs. Source profile: ${bestRun.profile.name}`,
    },
  })
  return { ok: true, profileId: id, topMotions, sampleSize: runs.length }
}

// ─── Image-to-Video direct ──────────────────────────────────────────

export interface ImageToVideoInput {
  imageUrl:    string                        // first-frame conditioning
  prompt?:     string                        // what should happen in the clip
  motionPreset?: string                      // key from MOTION_PRESETS
  durationSec?: number                       // 2–10
  aspectRatio?: '16:9' | '9:16' | '1:1'
}

export async function imageToVideo(workspaceId: string, input: ImageToVideoInput): Promise<{ ok: boolean; localPath?: string; provider?: string; costUsd?: number; error?: string }> {
  if (!input.imageUrl) return { ok: false, error: 'imageUrl required' }
  const motion = (input.motionPreset && MOTION_PRESETS[input.motionPreset]) ?? MOTION_PRESETS['push_in']
  const duration = Math.max(2, Math.min(input.durationSec ?? 6, 10))
  const prompt = `${input.prompt ?? 'natural motion that brings this still scene to life'}. Camera motion: ${motion}.`

  try {
    const { renderShotWithFallback } = await import('./ai-video-providers.js')
    const r = await renderShotWithFallback(
      'veo',
      ['kling', 'runway', 'luma'],
      { prompt, durationSec: duration, aspectRatio: input.aspectRatio ?? '16:9', referenceImages: [input.imageUrl], workspaceId },
    )
    return {
      ok: r.ok,
      ...(r.videoUrl ? { localPath: r.videoUrl } : {}),
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
      ...(r.error ? { error: r.error } : {}),
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
