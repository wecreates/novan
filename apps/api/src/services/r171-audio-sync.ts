/**
 * R171 — Audio sync layer: lip-sync + ambient foley + script narration.
 *
 * Backends:
 *   - Lip-sync: Sieve API (sync-1.7) — best price/quality for short clips
 *   - SFX/Foley: ElevenLabs Sound Effects API
 *   - TTS: voiceover-service (existing infra: ElevenLabs / PlayHT)
 *
 * Keys resolved from secrets_vault by name:
 *   sieve_api_key, elevenlabs_api_key
 *
 * Every job is recorded in audio_sync_job so the operator can see cost +
 * status + retry. Failures are non-fatal — they don't abort the pipeline.
 */
import { db } from '../db/client.js'
import { audioSyncJob, secretsVault } from '../db/schema.js'
import { and, eq, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Key resolution ──────────────────────────────────────────────────

async function vaultKey(workspaceId: string, name: string, reason: string): Promise<string | null> {
  const [row] = await db.select({ id: secretsVault.id }).from(secretsVault)
    .where(and(eq(secretsVault.workspaceId, workspaceId), eq(secretsVault.name, name))).limit(1)
  if (!row) return null
  try {
    const { revealSecret } = await import('./secrets-vault.js')
    return await revealSecret(row.id, 'system:r171-audio-sync', reason)
  } catch { return null }
}

// ─── Lip-sync (Sieve) ────────────────────────────────────────────────

export async function lipSyncToVideo(workspaceId: string, opts: {
  videoUrl: string; audioUrl: string; runId?: string; shotId?: string
}): Promise<{ ok: boolean; jobId?: string; outputUrl?: string; cost?: number; error?: string }> {
  const id = uuidv7()
  await db.insert(audioSyncJob).values({
    id, workspaceId,
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.shotId ? { shotId: opts.shotId } : {}),
    kind: 'lip_sync',
    inputVideo: opts.videoUrl, inputAudio: opts.audioUrl,
    provider: 'sieve',
    status: 'running', createdAt: Date.now(),
  })

  const key = await vaultKey(workspaceId, 'sieve_api_key', 'lip-sync a rendered shot')
  if (!key) {
    await db.update(audioSyncJob).set({ status: 'failed', error: 'no sieve_api_key in vault', endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
    return { ok: false, jobId: id, error: 'no sieve_api_key in vault' }
  }

  try {
    // Sieve API: push job → poll. Free-form endpoint shape because Sieve
    // versions change; both the trigger + poll go through the same key.
    const trigger = await fetch('https://mango.sievedata.com/v2/push', {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        function: 'sieve/lipsync',
        inputs: { file: opts.videoUrl, audio: opts.audioUrl, enhance: 'default' },
      }),
    })
    const triggerData = await trigger.json().catch(() => ({})) as { id?: string; error?: string }
    if (!trigger.ok || !triggerData.id) {
      await db.update(audioSyncJob).set({ status: 'failed', error: `sieve push failed: ${triggerData.error ?? trigger.status}`, endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
      return { ok: false, jobId: id, error: `sieve push failed (${trigger.status})` }
    }

    // Poll up to 5 min.
    const jobId = triggerData.id
    let attempt = 0
    while (attempt < 60) {
      await new Promise(r => setTimeout(r, 5000))
      const poll = await fetch(`https://mango.sievedata.com/v2/jobs/${encodeURIComponent(jobId)}`, {
        headers: { 'X-API-Key': key },
      })
      const data = await poll.json().catch(() => ({})) as { status?: string; outputs?: Array<{ data?: { url?: string } }> }
      if (data.status === 'finished') {
        const url = data.outputs?.[0]?.data?.url
        if (url) {
          await db.update(audioSyncJob).set({ status: 'done', outputPath: url, costUsd: 0.20, endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
          return { ok: true, jobId: id, outputUrl: url, cost: 0.20 }
        }
      }
      if (data.status === 'error' || data.status === 'failed') {
        await db.update(audioSyncJob).set({ status: 'failed', error: 'sieve job failed', endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
        return { ok: false, jobId: id, error: 'sieve job failed' }
      }
      attempt += 1
    }
    await db.update(audioSyncJob).set({ status: 'failed', error: 'sieve timeout', endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
    return { ok: false, jobId: id, error: 'sieve timeout' }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400)
    await db.update(audioSyncJob).set({ status: 'failed', error: msg, endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
    return { ok: false, jobId: id, error: msg }
  }
}

// ─── Foley / ambient SFX (ElevenLabs) ────────────────────────────────

export async function foleyForScene(workspaceId: string, opts: {
  sceneDesc: string; durationSec?: number; runId?: string; shotId?: string
}): Promise<{ ok: boolean; jobId?: string; outputUrl?: string; cost?: number; error?: string }> {
  const id = uuidv7()
  const duration = Math.max(1, Math.min(opts.durationSec ?? 6, 22))
  await db.insert(audioSyncJob).values({
    id, workspaceId,
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.shotId ? { shotId: opts.shotId } : {}),
    kind: 'foley',
    sceneDesc: opts.sceneDesc.slice(0, 1000),
    provider: 'elevenlabs_sfx',
    status: 'running', createdAt: Date.now(),
  })

  const key = await vaultKey(workspaceId, 'elevenlabs_api_key', 'generate ambient foley for a scene')
  if (!key) {
    await db.update(audioSyncJob).set({ status: 'failed', error: 'no elevenlabs_api_key in vault', endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
    return { ok: false, jobId: id, error: 'no elevenlabs_api_key in vault' }
  }

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: opts.sceneDesc, duration_seconds: duration, prompt_influence: 0.6,
      }),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      await db.update(audioSyncJob).set({ status: 'failed', error: `elevenlabs_sfx ${res.status}: ${errText.slice(0, 200)}`, endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
      return { ok: false, jobId: id, error: `elevenlabs_sfx ${res.status}` }
    }
    // Returns audio/mpeg. Save under /tmp and return path.
    const buf = Buffer.from(await res.arrayBuffer())
    const path = `/tmp/foley-${id}.mp3`
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, buf)
    await db.update(audioSyncJob).set({ status: 'done', outputPath: path, costUsd: 0.05, endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
    return { ok: true, jobId: id, outputUrl: `file://${path}`, cost: 0.05 }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400)
    await db.update(audioSyncJob).set({ status: 'failed', error: msg, endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
    return { ok: false, jobId: id, error: msg }
  }
}

// ─── Narrate + sync chain ────────────────────────────────────────────

/**
 * Voiceover the script via existing voiceover-service then lip-sync the
 * result onto the rendered video. End-to-end "speak this line and sync
 * the mouth movements" in one call.
 */
export async function narrateAndSync(workspaceId: string, opts: {
  videoUrl: string; script: string; voice?: string; runId?: string; shotId?: string
}): Promise<{ ok: boolean; jobId?: string; outputUrl?: string; cost?: number; error?: string }> {
  const id = uuidv7()
  await db.insert(audioSyncJob).values({
    id, workspaceId,
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.shotId ? { shotId: opts.shotId } : {}),
    kind: 'narrate_sync',
    inputVideo: opts.videoUrl,
    scriptText: opts.script.slice(0, 4000),
    status: 'running', createdAt: Date.now(),
  })

  try {
    // Step 1 — generate voiceover via existing service.
    const vo = await import('./voiceover-service.js')
    const generateVoiceover = (vo as Record<string, unknown>)['generateVoiceover']
      ?? (vo as Record<string, unknown>)['generate']
      ?? (vo as Record<string, unknown>)['synthesize']
    if (typeof generateVoiceover !== 'function') {
      await db.update(audioSyncJob).set({ status: 'failed', error: 'voiceover-service missing generate fn', endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
      return { ok: false, jobId: id, error: 'voiceover-service missing generate fn' }
    }
    const voResult = await (generateVoiceover as (a: unknown) => Promise<unknown>)({
      workspaceId, text: opts.script, voice: opts.voice ?? 'narrator',
    })
    const audioUrl = (voResult as { audioUrl?: string; localPath?: string; url?: string })?.audioUrl
      ?? (voResult as { audioUrl?: string; localPath?: string; url?: string })?.localPath
      ?? (voResult as { audioUrl?: string; localPath?: string; url?: string })?.url
    if (!audioUrl) {
      await db.update(audioSyncJob).set({ status: 'failed', error: 'voiceover returned no url', endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
      return { ok: false, jobId: id, error: 'voiceover returned no url' }
    }

    // Step 2 — lip-sync the rendered video onto the voiceover.
    const sync = await lipSyncToVideo(workspaceId, { videoUrl: opts.videoUrl, audioUrl })
    if (!sync.ok) {
      await db.update(audioSyncJob).set({ status: 'failed', error: sync.error ?? 'lip-sync failed', endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
      return { ok: false, jobId: id, error: sync.error ?? 'lip-sync failed' }
    }
    await db.update(audioSyncJob).set({ status: 'done', outputPath: sync.outputUrl ?? null, costUsd: 0.25, endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
    return { ok: true, jobId: id, ...(sync.outputUrl ? { outputUrl: sync.outputUrl } : {}), cost: 0.25 }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400)
    await db.update(audioSyncJob).set({ status: 'failed', error: msg, endedAt: Date.now() }).where(eq(audioSyncJob.id, id))
    return { ok: false, jobId: id, error: msg }
  }
}

// ─── Reads ───────────────────────────────────────────────────────────

export async function audioJobsList(workspaceId: string, opts: { runId?: string; status?: string; limit?: number } = {}): Promise<Array<typeof audioSyncJob.$inferSelect>> {
  const filters = [eq(audioSyncJob.workspaceId, workspaceId)]
  if (opts.runId) filters.push(eq(audioSyncJob.runId, opts.runId))
  if (opts.status) filters.push(eq(audioSyncJob.status, opts.status))
  return db.select().from(audioSyncJob).where(and(...filters)).orderBy(desc(audioSyncJob.createdAt)).limit(Math.min(opts.limit ?? 30, 200))
}
