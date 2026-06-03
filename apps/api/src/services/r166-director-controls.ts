/**
 * R166 — Director controls (Higgsfield-inspired Cinema Studio for Novan).
 *
 * Layers cinema-grade camera + motion + character-lock controls onto the
 * R160 PAI video loop. A DirectorProfile bundles:
 *   - virtual camera body (Arri/RED/Sony/iPhone/etc.)
 *   - lens kit + focal length + aperture + shutter
 *   - up to 3 stacked motion presets (push-in + orbit + dolly etc.)
 *   - color grade + named vibe
 *
 * CharacterLock provides reference images + appearance seed so the same
 * character appears across runs.
 *
 * composePrompt() takes a raw shot prompt and produces a provider-tuned
 * augmented prompt that frontier video models honor.
 */
import { db } from '../db/client.js'
import {
  directorProfile, characterLock, directorRunBinding, videoPaiRun,
} from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Registries ──────────────────────────────────────────────────────

export const CAMERA_BODIES: Record<string, { label: string; descriptor: string }> = {
  arri_alexa_35:   { label: 'Arri Alexa 35',     descriptor: 'shot on Arri Alexa 35, cinematic dynamic range, 4.6K sensor look, filmic highlight rolloff' },
  red_komodo:      { label: 'RED Komodo 6K',     descriptor: 'shot on RED Komodo, crisp 6K detail, REDcode, deep contrast' },
  sony_fx3:        { label: 'Sony FX3',          descriptor: 'shot on Sony FX3, S-Cinetone color science, full-frame low-light' },
  canon_c70:       { label: 'Canon C70',         descriptor: 'shot on Canon C70, Canon Log 3, organic skin tones, super-35 sensor' },
  blackmagic_6k:   { label: 'Blackmagic 6K Pro', descriptor: 'shot on Blackmagic 6K Pro, BRAW color depth, indie cinema feel' },
  iphone_15_pro:   { label: 'iPhone 15 Pro',     descriptor: 'shot on iPhone 15 Pro ProRes, modern smartphone look, slight wide-angle distortion' },
  vintage_16mm:    { label: 'Vintage 16mm film', descriptor: 'shot on 16mm film, organic grain, faded color, gentle gate weave' },
  super_8:         { label: 'Super 8',           descriptor: 'shot on Super 8 film, heavy grain, muted color, nostalgic warm tint' },
  imax_70mm:       { label: 'IMAX 70mm',         descriptor: 'shot on IMAX 70mm, massive resolution, epic depth, blockbuster scale' },
  drone_dji:       { label: 'DJI Mavic 3 Pro',   descriptor: 'shot from a DJI Mavic 3 Pro, smooth aerial, slight wide field of view' },
}

export const LENS_KITS: Record<string, { label: string; descriptor: string }> = {
  zeiss_supreme_50:  { label: 'Zeiss Supreme Prime 50mm',  descriptor: 'Zeiss Supreme Prime lens, natural perspective, creamy bokeh' },
  cooke_anamorphic:  { label: 'Cooke Anamorphic /i 40mm',  descriptor: 'Cooke anamorphic lens, oval bokeh, blue horizontal lens flares, 2.39:1 squeeze' },
  canon_24_70:       { label: 'Canon RF 24-70 f/2.8',      descriptor: 'Canon RF 24-70 zoom, versatile framing' },
  sigma_18mm:        { label: 'Sigma 18mm wide',           descriptor: 'wide 18mm lens, dramatic perspective, slight barrel distortion' },
  helios_44_2:       { label: 'Helios 44-2 58mm vintage',  descriptor: 'vintage Helios 44-2, swirly bokeh, lens character, soft warm rendering' },
  macro_100:         { label: 'Macro 100mm',               descriptor: 'macro 100mm, extreme close detail, razor-thin focus plane' },
  fisheye_8mm:       { label: 'Fisheye 8mm',               descriptor: 'fisheye 8mm, dramatic curved distortion, GoPro-style wide' },
}

export const MOTION_PRESETS: Record<string, string> = {
  push_in:       'slow push-in toward subject',
  pull_out:      'slow pull-out revealing wider environment',
  orbit_cw:      'smooth clockwise orbit around subject',
  orbit_ccw:     'smooth counter-clockwise orbit around subject',
  dolly_left:    'horizontal dolly slide to the left',
  dolly_right:   'horizontal dolly slide to the right',
  crane_up:      'crane move rising vertically',
  crane_down:    'crane move descending vertically',
  whip_pan:      'fast whip-pan motion',
  tracking:      'tracking move following subject at consistent distance',
  fpv_sweep:     'aggressive FPV drone sweep through scene',
  handheld:      'organic handheld camera, slight natural shake',
  static:        'locked-off tripod, no camera movement',
  bullet_time:   'bullet-time 360° rotation around frozen subject',
  snorricam:     'snorricam rig attached to subject, subject stays fixed in frame',
  zoom_in:       'optical zoom-in tightening on subject',
  zoom_out:      'optical zoom-out',
  tilt_up:       'vertical tilt up',
  tilt_down:     'vertical tilt down',
  rack_focus:    'rack focus from foreground to background',
  jib_arc:       'sweeping jib arc',
  steadicam:     'fluid steadicam follow',
  dutch_tilt:    'gradual dutch-tilt rotation',
}

export const COLOR_GRADES: Record<string, string> = {
  natural:        'neutral natural color grade',
  teal_orange:    'teal-and-orange Hollywood blockbuster grade',
  bleach_bypass:  'bleach-bypass desaturated high-contrast grade',
  warm_sunset:    'warm golden-hour grade, amber highlights',
  cool_blue:      'cool blue tone, moody shadows',
  high_contrast:  'crushed-black high-contrast indie grade',
  pastel:         'soft pastel grade, lifted shadows',
  noir_bw:        'rich black-and-white, deep contrast',
  s_log_flat:     'flat S-Log style, ungraded look',
}

export const VIBES: Record<string, string> = {
  handheld_doc:        'gritty handheld documentary feel, real-world authenticity',
  glossy_commercial:   'polished commercial aesthetic, perfect lighting, brand-ready',
  a24_indie:           'A24 indie film aesthetic, naturalistic, intimate framing',
  music_video:         'kinetic music-video energy, bold cuts, dynamic motion',
  youtuber_vlog:       'YouTuber vlog feel, casual, direct-to-camera energy',
  cinematic_short:     'short-film cinematic seriousness, considered composition',
  high_fashion:        'high-fashion editorial, stark contrast, bold styling',
  retro_80s:           '80s retro aesthetic, neon palette, VHS softness',
  product_hero:        'product-hero shot, controlled lighting, premium feel',
}

// ─── CRUD ────────────────────────────────────────────────────────────

export interface ProfileInput {
  name:         string
  cameraBody?:  string
  lens?:        string
  focalMm?:     number
  aperture?:    number
  shutterDeg?:  number
  motions?:     string[]
  colorGrade?:  string
  vibe?:        string
  notes?:       string
  businessId?:  string
}

function validateKeys(input: ProfileInput): void {
  if (input.cameraBody && !CAMERA_BODIES[input.cameraBody]) throw new Error(`unknown cameraBody ${input.cameraBody}`)
  if (input.lens && !LENS_KITS[input.lens]) throw new Error(`unknown lens ${input.lens}`)
  if (input.colorGrade && !COLOR_GRADES[input.colorGrade]) throw new Error(`unknown colorGrade ${input.colorGrade}`)
  if (input.vibe && !VIBES[input.vibe]) throw new Error(`unknown vibe ${input.vibe}`)
  if (input.motions) {
    if (input.motions.length > 3) throw new Error('max 3 stacked motions (Higgsfield rule)')
    for (const m of input.motions) if (!MOTION_PRESETS[m]) throw new Error(`unknown motion ${m}`)
  }
}

export async function profileCreate(workspaceId: string, input: ProfileInput): Promise<{ id: string }> {
  validateKeys(input)
  if (!input.name) throw new Error('name required')
  const id = uuidv7()
  await db.insert(directorProfile).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    name: input.name.slice(0, 120),
    cameraBody: input.cameraBody ?? 'arri_alexa_35',
    lens: input.lens ?? 'zeiss_supreme_50',
    focalMm: input.focalMm ?? 50,
    aperture: input.aperture ?? 2.8,
    shutterDeg: input.shutterDeg ?? 180,
    motions: input.motions ?? ['push_in'],
    colorGrade: input.colorGrade ?? 'natural',
    ...(input.vibe ? { vibe: input.vibe } : {}),
    ...(input.notes ? { notes: input.notes.slice(0, 2000) } : {}),
    status: 'active',
    createdAt: Date.now(),
  })
  return { id }
}

export async function profileList(workspaceId: string): Promise<Array<typeof directorProfile.$inferSelect>> {
  return db.select().from(directorProfile)
    .where(and(eq(directorProfile.workspaceId, workspaceId), eq(directorProfile.status, 'active')))
    .orderBy(desc(directorProfile.createdAt))
    .limit(200)
}

export async function profileGet(workspaceId: string, id: string): Promise<typeof directorProfile.$inferSelect | null> {
  const [p] = await db.select().from(directorProfile)
    .where(and(eq(directorProfile.workspaceId, workspaceId), eq(directorProfile.id, id)))
    .limit(1)
  return p ?? null
}

export interface CharacterInput {
  name:           string
  description:    string
  referenceUrls?: string[]
  appearanceSeed?: number
  voiceId?:       string
  businessId?:    string
}

export async function characterLockCreate(workspaceId: string, input: CharacterInput): Promise<{ id: string }> {
  if (!input.name || !input.description) throw new Error('name + description required')
  const id = uuidv7()
  await db.insert(characterLock).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    name: input.name.slice(0, 80),
    description: input.description.slice(0, 1500),
    referenceUrls: input.referenceUrls ?? [],
    ...(input.appearanceSeed !== undefined ? { appearanceSeed: input.appearanceSeed } : {}),
    ...(input.voiceId ? { voiceId: input.voiceId } : {}),
    status: 'active',
    createdAt: Date.now(),
  })
  return { id }
}

export async function characterList(workspaceId: string): Promise<Array<typeof characterLock.$inferSelect>> {
  return db.select().from(characterLock)
    .where(and(eq(characterLock.workspaceId, workspaceId), eq(characterLock.status, 'active')))
    .orderBy(desc(characterLock.createdAt))
    .limit(200)
}

// ─── Prompt composition ──────────────────────────────────────────────

export interface ComposeInput {
  shotPrompt:  string
  profile:    typeof directorProfile.$inferSelect
  characters?: Array<typeof characterLock.$inferSelect>
  durationSec?: number
}

/**
 * Produce a frontier-model-ready augmented prompt clause set. Order is
 * deliberate: subject → motion → camera → lens → grade → vibe →
 * character locks → continuity.
 */
export function composePrompt(input: ComposeInput): { prompt: string; referenceUrls: string[]; seed?: number } {
  const p = input.profile
  const camera = CAMERA_BODIES[p.cameraBody]?.descriptor ?? p.cameraBody
  const lens   = LENS_KITS[p.lens]?.descriptor ?? p.lens
  const grade  = COLOR_GRADES[p.colorGrade] ?? p.colorGrade
  const vibe   = p.vibe ? VIBES[p.vibe] : undefined
  const motionDescriptors = (p.motions ?? []).map(m => MOTION_PRESETS[m]).filter(Boolean)

  const parts: string[] = [input.shotPrompt.trim()]
  if (motionDescriptors.length > 0) {
    parts.push(`Camera motion: ${motionDescriptors.join(' combined with ')}.`)
  }
  parts.push(`Lensing: ${camera}, ${lens} at ${p.focalMm}mm, f/${p.aperture}, shutter ${p.shutterDeg}°.`)
  parts.push(`Grade: ${grade}.`)
  if (vibe) parts.push(`Vibe: ${vibe}.`)

  // Character locks.
  const referenceUrls: string[] = []
  if (input.characters && input.characters.length > 0) {
    const charLines = input.characters.map(c => `${c.name}: ${c.description}`)
    parts.push(`Characters present: ${charLines.join(' | ')}.`)
    for (const c of input.characters) referenceUrls.push(...(c.referenceUrls ?? []))
  }

  if (input.durationSec) parts.push(`Duration: ${input.durationSec}s.`)
  parts.push(`Maintain continuity with prior shot.`)

  const seed = input.characters?.find(c => c.appearanceSeed != null)?.appearanceSeed ?? null
  return {
    prompt: parts.join(' '),
    referenceUrls,
    ...(seed != null ? { seed } : {}),
  }
}

// ─── Binding to PAI runs ─────────────────────────────────────────────

/**
 * Bind a DirectorProfile + character locks to a PAI run. After binding,
 * the PAI EXECUTE phase (R160) can call applyProfileToPlan to rewrite
 * shot prompts with composed cinema specs.
 */
export async function bindToRun(workspaceId: string, opts: { runId: string; profileId: string; characterIds?: string[] }): Promise<{ ok: boolean }> {
  const profile = await profileGet(workspaceId, opts.profileId)
  if (!profile) return { ok: false }
  const [run] = await db.select({ id: videoPaiRun.id }).from(videoPaiRun)
    .where(and(eq(videoPaiRun.workspaceId, workspaceId), eq(videoPaiRun.id, opts.runId))).limit(1)
  if (!run) return { ok: false }
  await db.insert(directorRunBinding).values({
    id: uuidv7(), workspaceId,
    runId: opts.runId, profileId: opts.profileId,
    characterIds: opts.characterIds ?? [],
    boundAt: Date.now(),
  }).onConflictDoUpdate({
    target: [directorRunBinding.runId],
    set: { profileId: opts.profileId, characterIds: opts.characterIds ?? [], boundAt: Date.now() },
  })
  return { ok: true }
}

/**
 * Apply the bound profile to a PAI run's plan: rewrites every shot's
 * prompt via composePrompt, attaches referenceUrls, and persists the
 * augmented plan back onto the run.
 */
export async function applyProfileToPlan(workspaceId: string, runId: string): Promise<{ ok: boolean; shotsRewritten: number; profileName?: string }> {
  const [binding] = await db.select().from(directorRunBinding).where(eq(directorRunBinding.runId, runId)).limit(1)
  if (!binding) return { ok: false, shotsRewritten: 0 }
  const profile = await profileGet(workspaceId, binding.profileId)
  if (!profile) return { ok: false, shotsRewritten: 0 }

  const characters = binding.characterIds.length > 0
    ? await db.select().from(characterLock)
        .where(and(eq(characterLock.workspaceId, workspaceId), sql`${characterLock.id} = ANY(${binding.characterIds as unknown as string[]}::text[])`))
        .limit(20)
    : []

  const [run] = await db.select().from(videoPaiRun)
    .where(and(eq(videoPaiRun.workspaceId, workspaceId), eq(videoPaiRun.id, runId))).limit(1)
  if (!run) return { ok: false, shotsRewritten: 0 }

  const plan = (run.plan ?? {}) as { episode?: { shots?: Array<{ id: string; prompt?: string; durationSec?: number; referenceUrls?: string[]; seed?: number }> } }
  const shots = plan.episode?.shots ?? []
  let rewritten = 0
  for (const s of shots) {
    const original = s.prompt ?? ''
    if (!original) continue
    const composed = composePrompt({
      shotPrompt: original,
      profile,
      characters,
      ...(s.durationSec ? { durationSec: s.durationSec } : {}),
    })
    s.prompt = composed.prompt
    if (composed.referenceUrls.length > 0) {
      s.referenceUrls = [...(s.referenceUrls ?? []), ...composed.referenceUrls]
    }
    if (composed.seed !== undefined && s.seed === undefined) s.seed = composed.seed
    rewritten += 1
  }
  await db.update(videoPaiRun).set({ plan: plan as Record<string, unknown> }).where(eq(videoPaiRun.id, runId))
  return { ok: true, shotsRewritten: rewritten, profileName: profile.name }
}

// ─── Registry exports for /presets brain op ─────────────────────────

export function presetsList(): {
  cameraBodies: Array<{ key: string; label: string }>
  lenses:       Array<{ key: string; label: string }>
  motions:      Array<{ key: string; label: string }>
  colorGrades:  Array<{ key: string; label: string }>
  vibes:        Array<{ key: string; label: string }>
} {
  return {
    cameraBodies: Object.entries(CAMERA_BODIES).map(([key, v]) => ({ key, label: v.label })),
    lenses:       Object.entries(LENS_KITS).map(([key, v]) => ({ key, label: v.label })),
    motions:      Object.entries(MOTION_PRESETS).map(([key, label]) => ({ key, label })),
    colorGrades:  Object.entries(COLOR_GRADES).map(([key, label]) => ({ key, label })),
    vibes:        Object.entries(VIBES).map(([key, label]) => ({ key, label })),
  }
}
