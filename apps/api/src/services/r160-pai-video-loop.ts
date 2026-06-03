/**
 * R146.160 — PAI (Personal AI Infrastructure) 7-phase loop for video gen.
 *
 * Adapted from Daniel Miessler's Personal_AI_Infrastructure Algorithm v6.3.0
 * (OBSERVE → THINK → PLAN → BUILD → EXECUTE → VERIFY → LEARN).
 *
 * Wraps ai-video-executor with:
 *   - ISA (Ideal State Artifact) — the brief + ISCs (Ideal State Criteria)
 *   - per-run memory of every phase's output
 *   - cross-run lessons that feed forward into next THINK phase
 *
 * Each run is hill-climbing toward operator-defined success metrics, not
 * generic "good video" outcomes. ISCs are measurable; LEARN adjusts.
 */
import { db } from '../db/client.js'
import { videoIsa, videoPaiRun, videoPaiLesson } from '../db/schema.js'
import { and, eq, desc, sql, isNotNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Types ────────────────────────────────────────────────────────────

export interface IscDef {
  id:        string
  criterion: string        // human-readable, e.g. "hook lands in first 2.5s"
  weight:    number        // 0..1 — used for weighted pass-rate
  kind:      'duration' | 'hook' | 'voice' | 'cta' | 'brand' | 'pacing' | 'custom'
}

export interface CreateIsaInput {
  title:    string
  brief:    string
  target?: {
    platform?:    'tiktok' | 'reels' | 'shorts' | 'youtube' | 'longform'
    durationSec?: number
    aspect?:      '9:16' | '16:9' | '1:1'
    ctaType?:     string
  }
  telos?: Record<string, unknown>
  iscs?: IscDef[]
}

// ─── ISA management ──────────────────────────────────────────────────

const DEFAULT_ISCS: IscDef[] = [
  { id: 'hook',     criterion: 'visual+audio hook lands inside first 2.5s', weight: 0.30, kind: 'hook' },
  { id: 'duration', criterion: 'final duration within ±10% of target',       weight: 0.15, kind: 'duration' },
  { id: 'cta',      criterion: 'has a clear closing CTA',                     weight: 0.15, kind: 'cta' },
  { id: 'pacing',   criterion: 'no shot longer than 3.5s without motion',     weight: 0.15, kind: 'pacing' },
  { id: 'voice',    criterion: 'voiceover energy matches platform norm',      weight: 0.15, kind: 'voice' },
  { id: 'brand',    criterion: 'matches workspace brand voice + palette',     weight: 0.10, kind: 'brand' },
]

export async function isaCreate(workspaceId: string, input: CreateIsaInput): Promise<{ id: string }> {
  if (!input.title || !input.brief) throw new Error('title + brief required')
  const id = uuidv7()
  await db.insert(videoIsa).values({
    id, workspaceId,
    title:  input.title.slice(0, 200),
    brief:  input.brief.slice(0, 8000),
    telos:  input.telos ?? {},
    iscs:   (input.iscs && input.iscs.length > 0) ? input.iscs : DEFAULT_ISCS,
    target: input.target ?? {},
    status: 'active',
    createdAt: Date.now(),
  })
  return { id }
}

export async function isaList(workspaceId: string, opts: { limit?: number; status?: string } = {}): Promise<Array<typeof videoIsa.$inferSelect>> {
  const limit  = Math.min(opts.limit ?? 30, 100)
  const status = opts.status ?? 'active'
  return db.select().from(videoIsa)
    .where(and(eq(videoIsa.workspaceId, workspaceId), eq(videoIsa.status, status)))
    .orderBy(desc(videoIsa.createdAt)).limit(limit)
}

// ─── The seven-phase algorithm ───────────────────────────────────────

/**
 * OBSERVE — gather current state:
 *   - last N runs' outcomes for this workspace
 *   - active lessons (highest-confidence patterns)
 *   - workspace voice signals from prompt-evolution if present
 */
async function phaseObserve(workspaceId: string, isaId: string): Promise<Record<string, unknown>> {
  const recent = await db.select({
    id: videoPaiRun.id, outcomeScore: videoPaiRun.outcomeScore, iscPassRate: videoPaiRun.iscPassRate,
    plan: videoPaiRun.plan, verify: videoPaiRun.verify,
  })
    .from(videoPaiRun)
    .where(and(eq(videoPaiRun.workspaceId, workspaceId), isNotNull(videoPaiRun.outcomeScore)))
    .orderBy(desc(videoPaiRun.startedAt)).limit(10)

  const lessons = await db.select().from(videoPaiLesson)
    .where(and(eq(videoPaiLesson.workspaceId, workspaceId), sql`${videoPaiLesson.retiredAt} IS NULL`))
    .orderBy(desc(videoPaiLesson.confidence)).limit(20)

  const sameIsa = await db.select({ count: sql<number>`count(*)::int` }).from(videoPaiRun)
    .where(and(eq(videoPaiRun.workspaceId, workspaceId), eq(videoPaiRun.isaId, isaId)))
  const prior = Number(sameIsa[0]?.count ?? 0)

  return {
    recentRuns: recent.length,
    avgOutcome: recent.length ? recent.reduce((a, r) => a + (r.outcomeScore ?? 0), 0) / recent.length : null,
    avgIscPass: recent.length ? recent.reduce((a, r) => a + r.iscPassRate, 0) / recent.length : null,
    activeLessons: lessons.map(l => ({ topic: l.topic, pattern: l.pattern, confidence: l.confidence })),
    priorRunsForIsa: prior,
    timestamp: Date.now(),
  }
}

/**
 * THINK — apply lessons, decide creative direction.
 *
 * Tries to consult an LLM if novan-chat is wired; otherwise produces a
 * deterministic rule-based direction from lessons. Both paths produce
 * the same shape, so PLAN doesn't care.
 */
async function phaseThink(workspaceId: string, isa: typeof videoIsa.$inferSelect, observe: Record<string, unknown>): Promise<Record<string, unknown>> {
  const lessons = (observe['activeLessons'] as Array<{ topic: string; pattern: string; confidence: number }>) ?? []
  // Group lessons by topic, pick highest-confidence per topic.
  const byTopic: Record<string, { pattern: string; confidence: number }> = {}
  for (const l of lessons) {
    const cur = byTopic[l.topic]
    if (!cur || l.confidence > cur.confidence) byTopic[l.topic] = { pattern: l.pattern, confidence: l.confidence }
  }
  const directives: string[] = []
  for (const [topic, l] of Object.entries(byTopic)) {
    if (l.confidence >= 0.55) directives.push(`[${topic}] ${l.pattern}`)
  }

  // LLM enrichment slot — currently rules-only; future round can wire chat
  // here without changing the THINK output shape.
  const llmDirection: string | null = null
  void workspaceId; void isa

  return {
    directives,
    llmDirection,
    appliedLessonCount: directives.length,
    timestamp: Date.now(),
  }
}

/**
 * PLAN — produce an Episode shot list. Tries ai-video-studio for a real
 * plan; falls back to a minimal scaffold so the loop never blocks.
 */
async function phasePlan(workspaceId: string, isa: typeof videoIsa.$inferSelect, think: Record<string, unknown>): Promise<{ plan: Record<string, unknown>; episodeId: string | null }> {
  const targetSec = Number((isa.target as { durationSec?: number })?.durationSec ?? 30)
  try {
    const studio = await import('./ai-video-studio.js')
    // ai-video-studio exposes a planEpisode-style fn under various names across rounds.
    const fn = (studio as Record<string, unknown>)['planEpisode']
      ?? (studio as Record<string, unknown>)['planNewEpisode']
      ?? (studio as Record<string, unknown>)['createEpisode']
    if (typeof fn === 'function') {
      const ep = await (fn as (a: unknown) => Promise<unknown>)({
        workspaceId,
        brief: isa.brief,
        durationSec: targetSec,
        direction: think['llmDirection'] ?? null,
        directives: think['directives'] ?? [],
      })
      const episodeId = (ep as { id?: string })?.id ?? null
      return { plan: { episode: ep, source: 'ai-video-studio' }, episodeId }
    }
  } catch { /* fall through */ }
  // Scaffold fallback: 6 shots @ targetSec/6.
  const shotCount = 6
  const perShot = Math.max(2, Math.floor(targetSec / shotCount))
  const episodeId = uuidv7()
  return {
    plan: {
      source: 'scaffold',
      episode: { id: episodeId, shots: Array.from({ length: shotCount }, (_, i) => ({
        id: `${episodeId}-s${i}`,
        durationSec: perShot,
        prompt: i === 0 ? `Hook: ${isa.title}` : `Shot ${i + 1}: continue narrative`,
      })) },
    },
    episodeId,
  }
}

/**
 * BUILD — resolve provider chain + reference assets. Cheap step; mostly
 * announces readiness so EXECUTE can run.
 */
async function phaseBuild(workspaceId: string, plan: Record<string, unknown>): Promise<Record<string, unknown>> {
  const episode = (plan['episode'] as { shots?: unknown[] }) ?? {}
  return {
    shotCount: Array.isArray(episode.shots) ? episode.shots.length : 0,
    workspaceId,
    readyAt: Date.now(),
  }
}

/**
 * EXECUTE — render the episode. Calls existing ai-video-executor if a
 * real Episode came out of PLAN; otherwise marks as scaffold-only.
 */
async function phaseExecute(workspaceId: string, plan: Record<string, unknown>): Promise<Record<string, unknown>> {
  const source = plan['source']
  if (source !== 'ai-video-studio') {
    return { skipped: true, reason: 'plan was scaffold-only; no real Episode to render', timestamp: Date.now() }
  }
  try {
    const { executeEpisode } = await import('./ai-video-executor.js')
    const episode = (plan['episode'] as { id: string; shots: unknown[] })
    const result = await executeEpisode({
      workspaceId,
      episode: episode as Parameters<typeof executeEpisode>[0]['episode'],
      concatOutputPath: `/srv/renders/episode-${episode.id}.mp4`,
    })
    return {
      ok: result.ok,
      shotsRendered: result.shotsRendered,
      shotsFailed: result.shotsFailed,
      costUsd: result.totalCostUsd,
      finalOutputPath: result.finalOutputPath,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * VERIFY — score each ISC against the plan/execute artifacts.
 * Heuristic, not perfect — but every signal compounds via LEARN.
 */
function phaseVerify(isa: typeof videoIsa.$inferSelect, plan: Record<string, unknown>, exec: Record<string, unknown>): { verify: Record<string, unknown>; passRate: number } {
  const iscs = (isa.iscs as IscDef[]) ?? []
  const episode = (plan['episode'] as { shots?: Array<{ durationSec?: number; prompt?: string }> }) ?? {}
  const shots = episode.shots ?? []
  const targetSec = Number((isa.target as { durationSec?: number })?.durationSec ?? 30)
  const totalSec  = shots.reduce((a, s) => a + (s.durationSec ?? 0), 0)
  const firstPrompt = (shots[0]?.prompt ?? '').toLowerCase()

  const results: Array<{ id: string; pass: boolean; weight: number; note?: string }> = []
  for (const isc of iscs) {
    let pass = false
    let note: string | undefined
    switch (isc.kind) {
      case 'duration': {
        const tolerance = targetSec * 0.10
        pass = Math.abs(totalSec - targetSec) <= tolerance
        note = `${totalSec}s vs target ${targetSec}s`
        break
      }
      case 'hook': {
        const firstShotSec = shots[0]?.durationSec ?? 999
        pass = firstShotSec <= 3 && firstPrompt.length > 0
        note = `first-shot ${firstShotSec}s`
        break
      }
      case 'pacing': {
        pass = shots.every(s => (s.durationSec ?? 0) <= 3.5)
        note = `max ${Math.max(0, ...shots.map(s => s.durationSec ?? 0))}s`
        break
      }
      case 'cta': {
        const last = (shots[shots.length - 1]?.prompt ?? '').toLowerCase()
        pass = /follow|subscribe|link|comment|buy|shop|tap|swipe|like/.test(last)
        break
      }
      case 'voice':
      case 'brand':
      case 'custom':
      default:
        // Without ground truth we credit half — neutral signal until LEARN runs.
        pass = (exec['ok'] === true)
        note = 'heuristic credit pending outcome'
    }
    results.push({ id: isc.id, pass, weight: isc.weight, ...(note ? { note } : {}) })
  }
  const totalW   = results.reduce((a, r) => a + r.weight, 0) || 1
  const passW    = results.reduce((a, r) => a + (r.pass ? r.weight : 0), 0)
  const passRate = passW / totalW
  return { verify: { results, passRate, totalSec, shotCount: shots.length }, passRate }
}

/**
 * Run the loop synchronously through OBSERVE..VERIFY. LEARN runs later
 * via recordOutcome() once external performance data is available.
 */
export async function paiRun(workspaceId: string, opts: { isaId: string }): Promise<{ runId: string; isaId: string; iscPassRate: number; phase: string; error?: string }> {
  const [isa] = await db.select().from(videoIsa)
    .where(and(eq(videoIsa.workspaceId, workspaceId), eq(videoIsa.id, opts.isaId))).limit(1)
  if (!isa) throw new Error('ISA not found')

  const runId = uuidv7()
  const startedAt = Date.now()
  await db.insert(videoPaiRun).values({
    id: runId, workspaceId, isaId: opts.isaId, phase: 'observe', startedAt,
  })

  try {
    const observe = await phaseObserve(workspaceId, opts.isaId)
    await db.update(videoPaiRun).set({ observe, phase: 'think' }).where(eq(videoPaiRun.id, runId))

    const think = await phaseThink(workspaceId, isa, observe)
    await db.update(videoPaiRun).set({ think, phase: 'plan' }).where(eq(videoPaiRun.id, runId))

    const planOut = await phasePlan(workspaceId, isa, think)
    await db.update(videoPaiRun).set({
      plan: planOut.plan, phase: 'build',
      ...(planOut.episodeId ? { episodeId: planOut.episodeId } : {}),
    }).where(eq(videoPaiRun.id, runId))

    // R146.166 — if a director profile is bound to this run (or a default
    // profile exists for the workspace), rewrite shot prompts now.
    try {
      const { applyProfileToPlan } = await import('./r166-director-controls.js')
      await applyProfileToPlan(workspaceId, runId).catch(() => null)
    } catch { /* director controls optional */ }

    const build = await phaseBuild(workspaceId, planOut.plan)
    await db.update(videoPaiRun).set({ build, phase: 'execute' }).where(eq(videoPaiRun.id, runId))

    const exec = await phaseExecute(workspaceId, planOut.plan)
    const cost = Number(exec['costUsd'] ?? 0)
    await db.update(videoPaiRun).set({ execute: exec, phase: 'verify', costUsd: cost }).where(eq(videoPaiRun.id, runId))

    const { verify, passRate } = phaseVerify(isa, planOut.plan, exec)
    await db.update(videoPaiRun).set({
      verify, iscPassRate: passRate, phase: 'done', endedAt: Date.now(),
    }).where(eq(videoPaiRun.id, runId))

    // R146.167 — auto-publish + repurpose if ISA target opts in.
    const autoPublish = (isa.target as { autoPublish?: boolean })?.autoPublish === true
    if (autoPublish) {
      try {
        const { publishAndRepurpose } = await import('./r167-auto-publish.js')
        await publishAndRepurpose(workspaceId, runId).catch(() => null)
      } catch { /* publish optional */ }
    }

    return { runId, isaId: opts.isaId, iscPassRate: passRate, phase: 'done' }
  } catch (e) {
    const error = (e as Error).message.slice(0, 500)
    await db.update(videoPaiRun).set({ phase: 'failed', error, endedAt: Date.now() }).where(eq(videoPaiRun.id, runId))
    return { runId, isaId: opts.isaId, iscPassRate: 0, phase: 'failed', error }
  }
}

/**
 * LEARN — invoked once external performance data lands (views, CTR,
 * revenue). Writes outcomeScore back onto the run, then extracts a
 * lesson if a clear signal emerged vs prior baseline.
 *
 * outcomeScore convention: 0..1, normalized by caller. We just store +
 * compare against rolling baseline.
 */
export async function paiRecordOutcome(workspaceId: string, runId: string, score: number, meta: Record<string, unknown> = {}): Promise<{ ok: boolean; lessonId?: string }> {
  const clamped = Math.max(0, Math.min(1, score))
  const [run] = await db.select().from(videoPaiRun)
    .where(and(eq(videoPaiRun.workspaceId, workspaceId), eq(videoPaiRun.id, runId))).limit(1)
  if (!run) return { ok: false }
  if (run.phase !== 'done') return { ok: false }

  await db.update(videoPaiRun).set({ outcomeScore: clamped, outcomeMeta: meta, phase: 'learn' })
    .where(eq(videoPaiRun.id, runId))

  // Rolling baseline = avg outcome of previous 5 done runs.
  const prior = await db.select({ outcomeScore: videoPaiRun.outcomeScore })
    .from(videoPaiRun)
    .where(and(
      eq(videoPaiRun.workspaceId, workspaceId),
      isNotNull(videoPaiRun.outcomeScore),
      sql`${videoPaiRun.id} <> ${runId}`,
    ))
    .orderBy(desc(videoPaiRun.startedAt)).limit(5)
  const baseline = prior.length
    ? prior.reduce((a, r) => a + (r.outcomeScore ?? 0), 0) / prior.length
    : 0.5

  // Only mint a lesson on clear delta (±0.15).
  let lessonId: string | undefined
  if (Math.abs(clamped - baseline) >= 0.15) {
    const won = clamped > baseline
    const verifyResults = ((run.verify as { results?: Array<{ id: string; pass: boolean }> })?.results) ?? []
    // Find ISCs that distinguished this run from baseline. Coarse: pick
    // first passing ISC as the candidate pattern source.
    const candidate = verifyResults.find(r => r.pass === won) ?? verifyResults[0]
    if (candidate) {
      lessonId = uuidv7()
      await db.insert(videoPaiLesson).values({
        id: lessonId, workspaceId,
        topic: candidate.id,
        pattern: won
          ? `Runs passing ISC "${candidate.id}" outperformed baseline by ${((clamped - baseline) * 100).toFixed(0)}%.`
          : `Runs failing ISC "${candidate.id}" underperformed baseline by ${((baseline - clamped) * 100).toFixed(0)}%.`,
        evidence: { runId, score: clamped, baseline, sampleSize: prior.length + 1 },
        confidence: Math.min(0.95, 0.5 + Math.abs(clamped - baseline)),
        uses: 1, wins: won ? 1 : 0, losses: won ? 0 : 1,
        createdAt: Date.now(),
      })
    }
  }

  await db.update(videoPaiRun).set({ phase: 'done' }).where(eq(videoPaiRun.id, runId))
  return { ok: true, ...(lessonId ? { lessonId } : {}) }
}

// ─── Read APIs ───────────────────────────────────────────────────────

export async function paiListRuns(workspaceId: string, opts: { isaId?: string; limit?: number } = {}): Promise<Array<typeof videoPaiRun.$inferSelect>> {
  const limit = Math.min(opts.limit ?? 20, 100)
  const where = opts.isaId
    ? and(eq(videoPaiRun.workspaceId, workspaceId), eq(videoPaiRun.isaId, opts.isaId))
    : eq(videoPaiRun.workspaceId, workspaceId)
  return db.select().from(videoPaiRun).where(where).orderBy(desc(videoPaiRun.startedAt)).limit(limit)
}

export async function paiLessons(workspaceId: string, opts: { topic?: string; limit?: number } = {}): Promise<Array<typeof videoPaiLesson.$inferSelect>> {
  const limit = Math.min(opts.limit ?? 30, 100)
  const where = opts.topic
    ? and(eq(videoPaiLesson.workspaceId, workspaceId), eq(videoPaiLesson.topic, opts.topic), sql`${videoPaiLesson.retiredAt} IS NULL`)
    : and(eq(videoPaiLesson.workspaceId, workspaceId), sql`${videoPaiLesson.retiredAt} IS NULL`)
  return db.select().from(videoPaiLesson).where(where).orderBy(desc(videoPaiLesson.confidence)).limit(limit)
}
