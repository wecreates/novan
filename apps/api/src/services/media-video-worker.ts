/**
 * media-video-worker.ts — Consumer for `media.video_job_submitted` events.
 *
 * Bridges the media-analyzer's job submission surface (R121) with the
 * existing `video-analyzer.ts` (R60 — YouTube/transcript/Gemini path).
 * No FFmpeg / Whisper / frame extraction here — that's external ops
 * work. This worker leans on existing capability:
 *
 *   - YouTube/Vimeo/direct URLs → existing `analyzeVideo()` handles
 *     metadata + transcript + optional Gemini visual summary
 *   - Base64 / file refs → flagged for operator (out of scope today)
 *
 * Runs as a cron tick that polls recent unfinished jobs. Idempotent —
 * a `media.video_analyzed` event for a given jobId marks it done.
 */

import { v7 as uuidv7 } from 'uuid'
import { incCounter } from './metrics.js'

interface PendingJob {
  jobId:       string
  url:         string
  mode:        'sparse' | 'adaptive' | 'dense'
  workspaceId: string
  requestedBy: string
  submittedAt: number
}

/** Walk recent media.video_job_submitted events; return jobs without a
 *  matching media.video_analyzed completion. */
async function pendingJobs(windowMs: number): Promise<PendingJob[]> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { gte, eq, sql, desc } = await import('drizzle-orm')
    const since = Date.now() - windowMs

    const submitted = await db.select({ payload: events.payload, createdAt: events.createdAt })
      .from(events)
      .where(sql`${events.type} = 'media.video_job_submitted' AND ${events.createdAt} >= ${since}`)
      .orderBy(desc(events.createdAt))
      .limit(50)
      .catch(() => [])

    const completed = await db.select({ payload: events.payload }).from(events)
      .where(sql`${events.type} = 'media.video_analyzed' AND ${events.createdAt} >= ${since}`)
      .limit(200)
      .catch(() => [])
    const doneIds = new Set(completed.map(r => (r.payload as { jobId?: string })?.jobId).filter(Boolean))

    const pending: PendingJob[] = []
    for (const row of submitted) {
      const p = row.payload as {
        jobId?: string; url?: string; mode?: PendingJob['mode']
        workspaceId?: string; requestedBy?: string
      }
      if (!p.jobId || !p.url || doneIds.has(p.jobId)) continue
      pending.push({
        jobId: p.jobId, url: p.url, mode: p.mode ?? 'sparse',
        workspaceId: p.workspaceId ?? '', requestedBy: p.requestedBy ?? 'agent',
        submittedAt: Number(row.createdAt),
      })
    }
    return pending
  } catch { return [] }
}

/** Process one pending job by delegating to the existing video-analyzer.
 *  Emits media.video_analyzed on success or media.video_failed on error. */
async function processJob(job: PendingJob): Promise<void> {
  incCounter('media_video_worker_started_total', { mode: job.mode })
  let analyzed: unknown = null
  let error: string | null = null
  try {
    // Only http(s) URLs are supported by the existing path. Base64/file
    // refs would need FFmpeg integration (out of scope this round).
    if (!job.url.startsWith('http')) {
      throw new Error('unsupported source — non-URL refs need FFmpeg integration')
    }
    const { analyzeVideo } = await import('./video-analyzer.js')
    analyzed = await analyzeVideo(job.url, '', job.workspaceId || 'default')
  } catch (e) { error = (e as Error).message.slice(0, 200) }

  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    await db.insert(events).values({
      id: uuidv7(),
      type: error ? 'media.video_failed' : 'media.video_analyzed',
      workspaceId: job.workspaceId || null,
      payload: error
        ? { jobId: job.jobId, url: job.url, error }
        : { jobId: job.jobId, url: job.url, analysis: analyzed },
      traceId: uuidv7(), correlationId: job.jobId, causationId: null,
      source: 'media-video-worker', version: 1, createdAt: Date.now(),
    } as never).catch((e: Error) => { console.error('[media-video-worker]', e.message); return null })
  } catch { /* tolerated */ }
  incCounter(error ? 'media_video_worker_failed_total' : 'media_video_worker_succeeded_total', { mode: job.mode })
}

/** Cron tick — pick up the oldest few pending jobs + process them.
 *  Concurrency cap = 3 per tick so a flood of submissions doesn't
 *  starve other ops or blow through the API budget. */
export async function runMediaVideoWorker(): Promise<{
  pending: number
  processed: number
}> {
  const all = await pendingJobs(60 * 60_000)  // last hour window
  const todo = all.slice(0, 3)
  for (const job of todo) await processJob(job)
  return { pending: all.length, processed: todo.length }
}
