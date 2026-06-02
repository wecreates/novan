/**
 * ai-video-studio.ts — R146.94 — AI Video Generator.
 *
 * Novan does not BE a frontier model (Sora, Veo, Runway own that). Novan
 * orchestrates them into long-form output the frontier tools can't produce
 * on their own:
 *   - episodes (10-30min) with consistent character/scene continuity
 *   - series (multiple episodes with persistent character bible)
 *   - films / movies (multi-act structure with synthesised cast, score,
 *     editorial cuts)
 *
 * The orchestration layer is what makes Novan competitive: scriptwriting →
 * shot list → per-shot generation (route to best frontier model per shot) →
 * inter-shot continuity (IP-Adapter / ref-image conditioning) → music →
 * voice-over with character voice cloning → editorial assembly → captions →
 * thumbnail → analytics-driven iteration.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, desc, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Types ─────────────────────────────────────────────────────────────────

export type VideoFormat = 'short' | 'long' | 'episode' | 'series-episode' | 'film-act' | 'feature-film'

export interface Character {
  id:                string
  name:              string
  description:       string             // visual + personality
  referenceImageUrls: string[]
  voiceCloneRef?:    string             // ElevenLabs voice id or sample url
  appearsInScenes:   string[]           // scene ids
}

export interface Scene {
  id:           string
  setting:      string                  // visual location/time
  referenceImageUrls: string[]
  cameraStyle?: 'wide' | 'mid' | 'close-up' | 'mixed'
}

export interface Shot {
  id:           string
  sceneId:      string
  beatIndex:    number                  // order within scene
  durationSec:  number
  prompt:       string
  charactersInShot: string[]            // character ids
  cameraMove?:  'static' | 'pan' | 'dolly' | 'crane' | 'tracking'
  preferredProvider?: 'sora' | 'veo' | 'runway' | 'kling' | 'luma' | 'auto'
}

export interface Episode {
  id:           string
  workspaceId:  string
  seriesId?:    string
  title:        string
  logline:      string
  format:       VideoFormat
  targetMinutes: number
  characters:   Character[]
  scenes:       Scene[]
  shots:        Shot[]
  script:       string                  // full text
  status:       'planning' | 'generating' | 'assembling' | 'mastering' | 'released' | 'failed'
  createdAt:    number
  updatedAt:    number
}

// ─── 1. Story planning (logline → outline → script) ────────────────────────

export async function planEpisode(input: { workspaceId: string; seriesId?: string; logline: string; targetMinutes: number; format: VideoFormat; tone?: string; characters?: Array<Pick<Character, 'name' | 'description' | 'voiceCloneRef'>> }): Promise<{ id: string; outline: string; act_structure: Array<{ act: number; durationMin: number; beats: string[] }> }> {
  const id = uuidv7()
  const beatsPerAct = input.targetMinutes >= 20 ? 6 : 3
  const acts = input.targetMinutes >= 60 ? 5 : input.targetMinutes >= 20 ? 3 : 2
  const act_structure = Array.from({ length: acts }, (_, a) => ({
    act: a + 1,
    durationMin: Math.round((input.targetMinutes / acts) * 10) / 10,
    beats: Array.from({ length: beatsPerAct }, (_, b) => `Act ${a + 1} beat ${b + 1}: ${beatPattern(a, acts, b)}`),
  }))
  const outline = `${input.format.toUpperCase()} — "${input.logline.slice(0, 200)}". ${input.targetMinutes} min, ${acts} acts × ~${beatsPerAct} beats. Tone: ${input.tone ?? 'neutral'}. Characters: ${(input.characters ?? []).map(c => c.name).join(', ') || 'unspecified'}.`
  await persistEpisodeStub({ id, workspaceId: input.workspaceId, ...(input.seriesId ? { seriesId: input.seriesId } : {}), title: input.logline.slice(0, 100), logline: input.logline.slice(0, 500), format: input.format, targetMinutes: input.targetMinutes, characters: (input.characters ?? []).map(c => ({ id: uuidv7(), name: c.name, description: c.description, referenceImageUrls: [], ...(c.voiceCloneRef ? { voiceCloneRef: c.voiceCloneRef } : {}), appearsInScenes: [] })), scenes: [], shots: [], script: outline, status: 'planning', createdAt: Date.now(), updatedAt: Date.now() })
  return { id, outline, act_structure }
}

function beatPattern(actIdx: number, totalActs: number, beatIdx: number): string {
  // Universal story beats — Snyder/Field hybrid
  if (totalActs === 5) {
    const patterns = [
      ['cold open', 'inciting incident', 'first plot point'],
      ['rising stakes', 'first pinch', 'midpoint'],
      ['accelerating complications', 'darkest moment', 'plan'],
      ['climax build', 'climax', 'fallout'],
      ['resolution', 'denouement', 'tag'],
    ]
    return patterns[actIdx]?.[beatIdx] ?? `act${actIdx + 1} beat${beatIdx + 1}`
  }
  if (totalActs === 3) {
    const patterns = [
      ['hook', 'inciting incident', 'first act break'],
      ['fun & games', 'midpoint', 'all-is-lost'],
      ['act three break', 'climax', 'denouement'],
    ]
    return patterns[actIdx]?.[beatIdx] ?? `act${actIdx + 1} beat${beatIdx + 1}`
  }
  return ['cold open', 'main', 'payoff'][beatIdx] ?? `beat${beatIdx + 1}`
}

// ─── 2. Shot list generation ────────────────────────────────────────────────

export async function generateShotList(input: { workspaceId: string; episodeId: string; script: string; targetMinutes: number; preferredCamera?: 'static' | 'mixed' | 'cinematic' }): Promise<{ shots: Shot[]; totalShots: number; estimatedGenerationMinutes: number }> {
  // Heuristic: 1 shot per 4-8 seconds of long-form, 1 per 1-2s for shorts
  const sec = input.targetMinutes * 60
  const secPerShot = input.targetMinutes < 1 ? 1.5 : input.targetMinutes < 5 ? 4 : 6
  const count = Math.max(3, Math.round(sec / secPerShot))
  const lines = input.script.split(/\n+/).filter(l => l.trim().length > 10)
  const shots: Shot[] = Array.from({ length: count }, (_, i) => ({
    id:                uuidv7(),
    sceneId:           'scene-default',
    beatIndex:         i,
    durationSec:       secPerShot,
    prompt:            (lines[i % Math.max(1, lines.length)] ?? `Shot ${i + 1}`).slice(0, 500),
    charactersInShot:  [],
    cameraMove:        input.preferredCamera === 'cinematic' ? (i % 3 === 0 ? 'dolly' : i % 3 === 1 ? 'tracking' : 'static') : 'static',
    preferredProvider: 'auto',
  }))
  await db.insert(events).values({
    id: uuidv7(), type: 'video_studio.shot_list_generated', workspaceId: input.workspaceId,
    payload: { episodeId: input.episodeId, totalShots: count, secPerShot, totalSec: sec },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'ai-video-studio', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  // Generation estimate: assume 30s gen + 10s polish per shot at parallel-2 concurrency
  const estimatedGenerationMinutes = Math.ceil((count * 40) / 2 / 60)
  return { shots, totalShots: count, estimatedGenerationMinutes }
}

// ─── 3. Per-shot provider routing ─────────────────────────────────────────

/** R146.104 — huggingface=free-tier serverless video. Auto-selected when no
 *  paid video keys are present. Quality is below Kling/Runway/Sora but cost
 *  is $0 within HF free tier. */
function hasAnyPaidVideoKey(): boolean {
  return Boolean(
    process.env['RUNWAY_API_KEY']  ||
    process.env['FAL_KEY']         ||
    process.env['LUMA_API_KEY']    ||
    process.env['OPENAI_API_KEY']  ||  // Sora
    process.env['GCP_ACCESS_TOKEN']    // Veo
  )
}

export function routeShotToProvider(shot: Shot): { primary: string; fallbacks: string[]; rationale: string } {
  // R146.106 — operator-forced free-only mode: every shot goes through the
  // free realistic pipeline (Pollinations Flux → SVD img2vid → optional
  // upscale). No paid provider gets called regardless of keys present.
  if (process.env['VIDEO_FREE_ONLY'] === '1') {
    return { primary: 'free-realistic', fallbacks: ['huggingface'], rationale: 'VIDEO_FREE_ONLY=1 — free realistic pipeline (Pollinations Flux → SVD img2vid)' }
  }
  if (shot.preferredProvider && shot.preferredProvider !== 'auto') {
    return { primary: shot.preferredProvider, fallbacks: ['runway', 'luma', 'huggingface'], rationale: 'explicit preference' }
  }
  // R146.104 — no paid keys → free realistic pipeline first, raw HF as fallback
  if (!hasAnyPaidVideoKey()) {
    return { primary: 'free-realistic', fallbacks: ['huggingface'], rationale: 'no paid video keys present → free realistic pipeline' }
  }
  // Character-heavy shots → Veo-3 (best continuity); long static shots → Sora; cinematic motion → Runway
  if (shot.charactersInShot.length >= 1 && shot.durationSec >= 4) return { primary: 'veo', fallbacks: ['runway', 'kling', 'free-realistic', 'huggingface'], rationale: 'character + duration → Veo for continuity' }
  if (shot.cameraMove === 'dolly' || shot.cameraMove === 'tracking') return { primary: 'runway', fallbacks: ['luma', 'sora', 'free-realistic', 'huggingface'], rationale: 'cinematic motion' }
  if (shot.durationSec >= 8) return { primary: 'sora', fallbacks: ['veo', 'kling', 'free-realistic', 'huggingface'], rationale: 'long-duration generation' }
  return { primary: 'kling', fallbacks: ['luma', 'runway', 'free-realistic', 'huggingface'], rationale: 'fast + cheap default for short generic shots' }
}

// ─── 4. Continuity layer ─────────────────────────────────────────────────

export interface ContinuityPlan {
  characterBible: Array<{ characterId: string; referenceImages: string[]; conditioningTokens: string[] }>
  sceneBible:     Array<{ sceneId: string; referenceImages: string[]; lighting: string; palette: string[] }>
  perShot:        Array<{ shotId: string; refImages: string[]; seedAnchor: string; prevShotEndFrame?: string }>
}

export function buildContinuityPlan(input: { episode: Pick<Episode, 'characters' | 'scenes' | 'shots'> }): ContinuityPlan {
  const characterBible = input.episode.characters.map(c => ({
    characterId:        c.id,
    referenceImages:    c.referenceImageUrls.slice(0, 5),
    conditioningTokens: [`character:${c.id}`, `face-ref:${c.referenceImageUrls[0] ?? 'none'}`],
  }))
  const sceneBible = input.episode.scenes.map(s => ({
    sceneId:         s.id,
    referenceImages: s.referenceImageUrls.slice(0, 5),
    lighting:        'consistent across shots',
    palette:         ['inferred'],
  }))
  const perShot = input.episode.shots.map((sh, i) => {
    const out: { shotId: string; refImages: string[]; seedAnchor: string; prevShotEndFrame?: string } = {
      shotId:     sh.id,
      refImages:  input.episode.scenes.find(s => s.id === sh.sceneId)?.referenceImageUrls ?? [],
      seedAnchor: `episode-${input.episode.shots[0]?.id ?? 'x'}-shot-${i}`,
    }
    if (i > 0) out.prevShotEndFrame = `shot-${input.episode.shots[i - 1]!.id}-last-frame`
    return out
  })
  return { characterBible, sceneBible, perShot }
}

// ─── 5. Editorial assembly (cut list + transitions) ───────────────────────

export function planAssembly(input: { shots: Shot[]; pacing?: 'slow' | 'medium' | 'fast'; musicMood?: string }): {
  cutList: Array<{ shotId: string; inSec: number; outSec: number; transition: 'cut' | 'fade' | 'dissolve' | 'whip-pan' }>
  totalDurationSec: number
  musicPrompt: string
} {
  const pacing = input.pacing ?? 'medium'
  const cutList: Array<{ shotId: string; inSec: number; outSec: number; transition: 'cut' | 'fade' | 'dissolve' | 'whip-pan' }> = []
  let t = 0
  for (let i = 0; i < input.shots.length; i++) {
    const s = input.shots[i]!
    const transition: 'cut' | 'fade' | 'dissolve' | 'whip-pan' = pacing === 'fast'
      ? (i % 5 === 0 ? 'whip-pan' : 'cut')
      : pacing === 'slow'
        ? (i === 0 ? 'fade' : i % 3 === 0 ? 'dissolve' : 'cut')
        : 'cut'
    cutList.push({ shotId: s.id, inSec: t, outSec: t + s.durationSec, transition })
    t += s.durationSec
  }
  const musicPrompt = `${pacing} pacing instrumental score, ${input.musicMood ?? 'neutral cinematic'}, full duration ${Math.round(t)}s`
  return { cutList, totalDurationSec: t, musicPrompt }
}

// ─── 6. Series management (persist character bible across episodes) ────

export async function createSeries(input: { workspaceId: string; title: string; logline: string; targetEpisodes: number; genre?: string }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(events).values({
    id: uuidv7(), type: 'video_studio.series_created', workspaceId: input.workspaceId,
    payload: { id, title: input.title.slice(0, 100), logline: input.logline.slice(0, 500), targetEpisodes: input.targetEpisodes, genre: input.genre ?? 'drama', status: 'planning' },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'ai-video-studio', version: 1, createdAt: Date.now(),
  })
  return { id }
}

export async function listEpisodesInSeries(workspaceId: string, seriesId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'video_studio.episode_persisted')))
    .orderBy(desc(events.createdAt)).limit(200)
  return rows.map(r => r.payload as Record<string, unknown>).filter(p => p['seriesId'] === seriesId)
}

// ─── 7. Films / feature length ─────────────────────────────────────────

export async function planFeatureFilm(input: { workspaceId: string; logline: string; targetMinutes: number; genre?: string }): Promise<{ filmId: string; acts: Array<{ act: number; minutes: number; storyFunction: string }>; recommendedSubBudgets: { writingMin: number; generationHours: number; editorialHours: number } }> {
  const filmId = uuidv7()
  const minutes = Math.max(30, Math.min(180, input.targetMinutes))
  const acts: Array<{ act: number; minutes: number; storyFunction: string }> = [
    { act: 1, minutes: Math.round(minutes * 0.25), storyFunction: 'setup — establish world, characters, problem' },
    { act: 2, minutes: Math.round(minutes * 0.50), storyFunction: 'confrontation — escalating obstacles, midpoint reversal' },
    { act: 3, minutes: Math.round(minutes * 0.25), storyFunction: 'resolution — climax + falling action' },
  ]
  const recommendedSubBudgets = {
    writingMin:       Math.round(minutes * 4),     // 4 min writing per min final
    generationHours:  Math.round(minutes * 0.5),    // 30 min generation per final min
    editorialHours:   Math.round(minutes * 0.25),   // 15 min editorial per final min
  }
  await db.insert(events).values({
    id: uuidv7(), type: 'video_studio.feature_planned', workspaceId: input.workspaceId,
    payload: { filmId, logline: input.logline.slice(0, 500), minutes, genre: input.genre ?? 'drama' },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'ai-video-studio', version: 1, createdAt: Date.now(),
  })
  return { filmId, acts, recommendedSubBudgets }
}

// ─── Internal persistence ─────────────────────────────────────────────

async function persistEpisodeStub(ep: Episode): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type: 'video_studio.episode_persisted', workspaceId: ep.workspaceId,
    payload: { id: ep.id, ...(ep.seriesId ? { seriesId: ep.seriesId } : {}), title: ep.title, format: ep.format, targetMinutes: ep.targetMinutes, status: ep.status, characterCount: ep.characters.length },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'ai-video-studio', version: 1, createdAt: ep.createdAt,
  }).catch(() => null)
}
