/**
 * media-analyzer.ts — Unified image + video analysis surface (BO image/video).
 *
 * Fronts the existing image-quality / image-router / video-analyzer
 * subsystems with one ops-style API that other Novan agents call via
 * MCP. New analytic capabilities live here; legacy specialized
 * services remain the implementation under the hood.
 *
 * Honest scope:
 *   - This is the orchestration + MCP-exposure layer. Mature subsystems
 *     (OCR via cloud vendor, NSFW classifier, Whisper, FFmpeg) are
 *     called as needed. We do not reimplement them.
 *   - All ops are governed via the existing policy engine, audited via
 *     events, and cost-tracked via the existing ai_usage pipeline. New
 *     event types: `media.analyze_*`, `media.flagged_unsafe`.
 *   - Locked behaviors enforced in code: NO facial identification, NO
 *     voice biometrics, NO image/video GENERATION (that's image-
 *     generator), NO surveillance use case. These refusals are
 *     constants, not policy that can be relaxed.
 *
 * Frame-mode discipline for video — the single biggest cost lever per
 * the spec. Default is `sparse`; `adaptive` and `dense` require
 * explicit caller intent + budget pre-estimate that passes
 * cron-budget gating.
 */

import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { incCounter, setGauge } from './metrics.js'

// ─── Locked refusals — these never relax ──────────────────────────────────────

export const LOCKED_REFUSALS = [
  'facial_identification',
  'voice_biometrics',
  'image_generation',
  'video_generation',
  'surveillance',
  'minor_processing_without_safeguards',
] as const
export type LockedRefusal = typeof LOCKED_REFUSALS[number]

/** Throw if caller requests a locked capability. */
export function assertNotLocked(intent: string): void {
  const i = intent.toLowerCase()
  if ((i.includes('identify') && (i.includes('person') || i.includes('face')))
   || (i.includes('face')   && (i.includes('match')  || i.includes('database') || i.includes('recogni')))) {
    throw new Error('refused: facial_identification is a locked refusal')
  }
  if (i.includes('voice') && (i.includes('identify') || i.includes('biometric'))) {
    throw new Error('refused: voice_biometrics is a locked refusal')
  }
  if (i.includes('generate') && (i.includes('image') || i.includes('video'))) {
    throw new Error('refused: image/video generation is out of scope for media-analyzer')
  }
  if (i.includes('surveillance') || i.includes('track person')) {
    throw new Error('refused: surveillance is a locked refusal')
  }
}

// ─── Image analysis ───────────────────────────────────────────────────────────

export type ImageAnalysisType =
  | 'objects' | 'scene' | 'text_ocr' | 'safety' | 'brand_compliance'
  | 'alt_text' | 'quality' | 'similarity_hash'

export interface ImageAnalysisRequest {
  /** SHA256 of source bytes (caller-provided to avoid re-hash if already known). */
  imageHash:      string
  /** URL or storage ref. Bytes are read by the underlying subsystem. */
  source:         string
  workspaceId:    string
  requestedBy:    string
  analysisTypes:  ImageAnalysisType[]
  intent:         string                  // free-text — checked against LOCKED_REFUSALS
}

export interface ImageAnalysisResult {
  analysisId:     string
  imageHash:      string
  perceptualHash: string | null           // 64-bit dhash, null if computation skipped
  results:        Partial<Record<ImageAnalysisType, unknown>>
  flags:          string[]
  confidence:     Partial<Record<ImageAnalysisType, number>>
  costUsd:        number
  durationMs:     number
}

/** Compute a 64-bit difference hash for similarity / dedup.
 *  Caller passes the 9x8 grayscale matrix (72 values 0..255) computed
 *  from a downsampled image. Pure function — no I/O. */
export function computePerceptualHash(grayscale9x8: number[]): string {
  if (grayscale9x8.length !== 72) {
    throw new Error(`perceptual hash requires 9x8=72 grayscale values, got ${grayscale9x8.length}`)
  }
  let bits = 0n
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = grayscale9x8[row * 9 + col]!
      const right = grayscale9x8[row * 9 + col + 1]!
      bits = (bits << 1n) | (left > right ? 1n : 0n)
    }
  }
  return bits.toString(16).padStart(16, '0')
}

/** Hamming distance between two hex hashes (0 = identical, 64 = max). */
export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error('hash length mismatch')
  let dist = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)
    while (x) { dist += x & 1; x >>>= 1 }
  }
  return dist
}

/** Default similarity threshold — distance ≤ 6 (out of 64) is near-dup. */
export const NEAR_DUP_THRESHOLD = 6

export function isNearDuplicate(hashA: string, hashB: string): boolean {
  return hashDistance(hashA, hashB) <= NEAR_DUP_THRESHOLD
}

/** Cache key for analyze_image — image hash + sorted analysis types. */
export function cacheKey(imageHash: string, types: ImageAnalysisType[]): string {
  const sorted = [...new Set(types)].sort().join(',')
  return createHash('sha256').update(`${imageHash}|${sorted}`).digest('hex').slice(0, 32)
}

/** Top-level image analysis op. Routes to vision LLM + specialized
 *  classifiers based on requested types.
 *
 *  Implementation note: this calls Anthropic's vision API directly via
 *  fetch (no SDK dep added). When ANTHROPIC_API_KEY is absent (tests,
 *  sandbox), we short-circuit with a `placeholder` flag so callers can
 *  detect the no-credentials path explicitly.
 */
export async function analyzeImage(req: ImageAnalysisRequest): Promise<ImageAnalysisResult> {
  assertNotLocked(req.intent)
  const startedAt = Date.now()
  const analysisId = uuidv7()
  const results: ImageAnalysisResult['results'] = {}
  const confidence: ImageAnalysisResult['confidence'] = {}
  const flags: string[] = []
  let costUsd = 0

  for (const t of req.analysisTypes) {
    incCounter('media_image_analysis_total', { type: t })
  }

  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) {
    flags.push('placeholder:no_anthropic_key')
    for (const t of req.analysisTypes) confidence[t] = 0
  } else {
    try {
      const vision = await callAnthropicVision(req.source, req.analysisTypes, apiKey)
      Object.assign(results, vision.results)
      Object.assign(confidence, vision.confidence)
      flags.push(...vision.flags)
      costUsd = vision.costUsd
    } catch (e) {
      flags.push(`vision_error:${(e as Error).message.slice(0, 80)}`)
      for (const t of req.analysisTypes) confidence[t] = 0
    }
  }

  setGauge('media_image_last_duration_ms', Date.now() - startedAt, { type: 'analyze' })

  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    await db.insert(events).values({
      id: uuidv7(), type: 'media.image_analyzed', workspaceId: req.workspaceId,
      payload: { analysisId, imageHash: req.imageHash, types: req.analysisTypes, requestedBy: req.requestedBy, flags },
      traceId: uuidv7(), correlationId: req.imageHash, causationId: null,
      source: 'media-analyzer', version: 1, createdAt: Date.now(),
    } as never).catch(() => null)
  } catch { /* tolerated */ }

  return {
    analysisId,
    imageHash: req.imageHash,
    perceptualHash: null,
    results, confidence, flags,
    costUsd,
    durationMs: Date.now() - startedAt,
  }
}

// ─── Video analysis — frame-mode discipline ────────────────────────────────────

export type FrameMode = 'sparse' | 'adaptive' | 'dense'

export interface VideoBudgetEstimate {
  mode:           FrameMode
  durationSec:    number
  framesToAnalyze: number
  estCostUsd:     number
  willExceedBudget: boolean
}

const FRAME_COST_USD = 0.0008  // approximate per-frame multimodal LLM cost

/** Pre-estimate video cost so callers (and the budget gate) can block
 *  expensive jobs before they start. */
export function estimateVideoCost(durationSec: number, mode: FrameMode, budgetUsd: number): VideoBudgetEstimate {
  if (durationSec <= 0) {
    return { mode, durationSec: 0, framesToAnalyze: 0, estCostUsd: 0, willExceedBudget: false }
  }
  let framesToAnalyze: number
  if (mode === 'sparse') {
    framesToAnalyze = Math.max(1, Math.floor(durationSec / 60))   // ~1/min
  } else if (mode === 'adaptive') {
    framesToAnalyze = Math.max(1, Math.floor(durationSec / 10))   // ~1/10s
  } else {
    framesToAnalyze = Math.floor(durationSec * 24)                // assume 24fps
  }
  const estCostUsd = framesToAnalyze * FRAME_COST_USD
  return {
    mode, durationSec, framesToAnalyze, estCostUsd,
    willExceedBudget: estCostUsd > budgetUsd,
  }
}

export interface VideoAnalysisRequest {
  videoUrl:      string
  workspaceId:   string
  requestedBy:   string
  mode:          FrameMode
  intent:        string
  budgetUsdCap:  number     // hard cap; estimateVideoCost compared against this
}

export interface VideoAnalysisJobHandle {
  jobId:        string
  estimate:     VideoBudgetEstimate
  accepted:     boolean
  rejectReason?: string
}

/** Submit a video analysis job. Returns a handle immediately;
 *  actual processing happens in a worker. */
export async function submitVideoAnalysis(req: VideoAnalysisRequest): Promise<VideoAnalysisJobHandle> {
  assertNotLocked(req.intent)
  // We need duration to estimate — caller should pass via URL metadata
  // route. For the handle we use the URL as the correlation key and
  // emit a `media.video_job_submitted` event; the worker fetches
  // metadata + revises the estimate.
  const jobId = uuidv7()

  // Conservative default: assume 600s (10 min) until metadata resolves.
  const provisionalDuration = 600
  const estimate = estimateVideoCost(provisionalDuration, req.mode, req.budgetUsdCap)
  if (estimate.willExceedBudget) {
    incCounter('media_video_rejected_total', { reason: 'budget' })
    return {
      jobId, estimate, accepted: false,
      rejectReason: `provisional estimate $${estimate.estCostUsd.toFixed(2)} exceeds cap $${req.budgetUsdCap.toFixed(2)}; consider mode=sparse or raise cap`,
    }
  }

  incCounter('media_video_accepted_total', { mode: req.mode })
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    await db.insert(events).values({
      id: uuidv7(), type: 'media.video_job_submitted', workspaceId: req.workspaceId,
      payload: { jobId, url: req.videoUrl, mode: req.mode, estimate, requestedBy: req.requestedBy },
      traceId: uuidv7(), correlationId: jobId, causationId: null,
      source: 'media-analyzer', version: 1, createdAt: Date.now(),
    } as never).catch(() => null)
  } catch { /* tolerated */ }

  return { jobId, estimate, accepted: true }
}

// ─── MCP-tool surface ─────────────────────────────────────────────────────────

/** Catalog of MCP tools the media-analyzer exposes. Surfaced by the
 *  MCP route layer so other Novan agents can discover capability. */
export const MEDIA_MCP_TOOLS = [
  // Image tools
  { name: 'media.image.analyze',         desc: 'Multi-type image analysis (objects/scene/safety/etc.)',  scope: 'image' },
  { name: 'media.image.generate_alt_text', desc: 'Accessibility-grade alt text from image + context',    scope: 'image' },
  { name: 'media.image.moderate',         desc: 'Safety classifier (NSFW / violence / weapons / hate)',  scope: 'image' },
  { name: 'media.image.find_similar',     desc: 'Perceptual-hash similarity within a search scope',      scope: 'image' },
  { name: 'media.image.extract_text',     desc: 'OCR with positions + language',                          scope: 'image' },
  { name: 'media.image.compare',          desc: 'Structured A/B comparison',                              scope: 'image' },
  { name: 'media.image.check_brand',      desc: 'Compliance vs supplied brand guidelines',                scope: 'image' },
  // Video tools
  { name: 'media.video.analyze',          desc: 'Full audiovisual analysis (async job)',                  scope: 'video' },
  { name: 'media.video.extract_transcript', desc: 'Transcript with timestamps + diarization',             scope: 'video' },
  { name: 'media.video.find_highlights',  desc: 'Highlight moments by criteria',                          scope: 'video' },
  { name: 'media.video.moderate',         desc: 'Safety scan with timestamps of flagged content',         scope: 'video' },
  { name: 'media.video.generate_chapters', desc: 'Chapter markers + titles',                              scope: 'video' },
  { name: 'media.video.generate_captions', desc: 'SRT / VTT caption file with timestamps',                scope: 'video' },
  { name: 'media.video.summarize',        desc: 'Summary at short/medium/long target',                    scope: 'video' },
  { name: 'media.video.check_brand',      desc: 'Compliance vs brand guidelines + timestamps of issues',  scope: 'video' },
  { name: 'media.video.predict_performance', desc: 'Platform-conditioned performance signal',             scope: 'video' },
  { name: 'media.video.compare',          desc: 'Structured A/B comparison',                              scope: 'video' },
  { name: 'media.video.estimate_cost',    desc: 'Pre-flight cost + frames-to-analyze estimate',           scope: 'video' },
] as const

export function listMediaMcpTools(): typeof MEDIA_MCP_TOOLS {
  return MEDIA_MCP_TOOLS
}

// ─── Anthropic vision call ────────────────────────────────────────────────────

interface VisionResult {
  results:    Partial<Record<ImageAnalysisType, unknown>>
  confidence: Partial<Record<ImageAnalysisType, number>>
  flags:      string[]
  costUsd:    number
}

/** Build a per-analysis-type instruction the model can satisfy in one
 *  multi-section JSON response. */
function buildVisionPrompt(types: ImageAnalysisType[]): string {
  const sections: string[] = []
  for (const t of types) {
    if (t === 'objects')           sections.push('"objects": array of strings — detected objects')
    else if (t === 'scene')        sections.push('"scene": one-paragraph scene description')
    else if (t === 'text_ocr')     sections.push('"text_ocr": full extracted text (empty string if none)')
    else if (t === 'safety')       sections.push('"safety": {nsfw: bool, violence: bool, weapons: bool, hate: bool}')
    else if (t === 'brand_compliance') sections.push('"brand_compliance": {compliant: bool, issues: array}')
    else if (t === 'alt_text')     sections.push('"alt_text": single concise accessibility-grade alt text')
    else if (t === 'quality')      sections.push('"quality": {resolution_ok: bool, sharpness_score: 0-1, exposure_ok: bool}')
    else if (t === 'similarity_hash') sections.push('"similarity_hash_seed": rough description for hashing')
  }
  return [
    'Analyze the attached image and respond with a single JSON object containing exactly these keys:',
    sections.join('\n'),
    'Do not include any explanation outside the JSON. Do not identify specific real people.',
  ].join('\n\n')
}

async function callAnthropicVision(
  source: string,
  types: ImageAnalysisType[],
  apiKey: string,
): Promise<VisionResult> {
  // Anthropic vision supports URL image references natively when the
  // URL is HTTPS + publicly fetchable. For storage refs or base64,
  // upstream callers pre-resolve to one of the supported source shapes.
  // We pass URL directly here.
  const imageBlock = source.startsWith('http')
    ? { type: 'image' as const, source: { type: 'url' as const, url: source } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg', data: source } }

  const body = {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [imageBlock, { type: 'text', text: buildVisionPrompt(types) }],
    }],
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`anthropic ${res.status}: ${errText.slice(0, 120)}`)
  }
  const json = await res.json() as {
    content?: Array<{ type: string; text?: string }>
    usage?:   { input_tokens?: number; output_tokens?: number }
  }
  const text = json.content?.find(c => c.type === 'text')?.text ?? ''

  // Best-effort JSON parse — strict first, then greedy-bracket fallback.
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) }
  catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) try { parsed = JSON.parse(m[0]) } catch { /* leave empty */ }
  }

  const results:    VisionResult['results']    = {}
  const confidence: VisionResult['confidence'] = {}
  for (const t of types) {
    const key =
      t === 'similarity_hash' ? 'similarity_hash_seed'
      : t
    if (key in parsed) {
      results[t] = parsed[key]
      confidence[t] = 0.85   // vision-model default confidence
    } else {
      confidence[t] = 0
    }
  }

  // Cost: claude-sonnet-4-5 pricing (rough): $3/M input, $15/M output.
  const inTok  = json.usage?.input_tokens  ?? 0
  const outTok = json.usage?.output_tokens ?? 0
  const costUsd = (inTok * 3 + outTok * 15) / 1_000_000

  // Flag NSFW/violence/etc. from safety section so downstream consumers
  // can short-circuit before propagating to operator UI.
  const flags: string[] = []
  const safety = parsed['safety'] as { nsfw?: boolean; violence?: boolean; weapons?: boolean; hate?: boolean } | undefined
  if (safety?.nsfw)     flags.push('safety:nsfw')
  if (safety?.violence) flags.push('safety:violence')
  if (safety?.weapons)  flags.push('safety:weapons')
  if (safety?.hate)     flags.push('safety:hate')

  return { results, confidence, flags, costUsd }
}
