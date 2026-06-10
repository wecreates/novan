/**
 * R571 — Brand-voice / style-guide LLM enforcement.
 *
 * Persistent operator brand profile that gets injected into every LLM gen
 * call (titles, descriptions, push notifications, emails, lessons). Anthropic
 * can't know an operator's voice because their products are stateless across
 * sessions; Novan has the memory + the ops to enforce on every output.
 *
 * Three layers:
 *   1. PROFILE — tone, persona, banned phrases, required phrases, audience
 *      keywords, style guide, examples. Stored in brand_profile table.
 *   2. INJECTION — buildBrandSystemPrompt() returns a system-prompt fragment
 *      that any LLM call can prepend.
 *   3. VALIDATION — validateAgainstBrand() scans an LLM output for banned
 *      phrases / missing required phrases and returns violations.
 *
 * Operator sets brand once. Every downstream gen call inherits.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS brand_profile (
      workspace_id      TEXT PRIMARY KEY,
      brand_name        TEXT,
      tone              TEXT,         -- 'professional' | 'playful' | 'minimalist' | etc — free text
      persona           TEXT,         -- one-paragraph who-we-are
      audience          TEXT,         -- one-paragraph who-we-serve
      style_guide       TEXT,         -- multi-paragraph rules
      banned_phrases    JSONB DEFAULT '[]'::jsonb,    -- string[]
      required_phrases  JSONB DEFAULT '[]'::jsonb,    -- string[] - at least one must appear
      example_outputs   JSONB DEFAULT '[]'::jsonb,    -- string[] - few-shot exemplars
      updated_at        BIGINT NOT NULL
    )
  `).catch(() => {})
}

export interface BrandProfile {
  brandName?:       string
  tone?:            string
  persona?:         string
  audience?:        string
  styleGuide?:      string
  bannedPhrases:    string[]
  requiredPhrases:  string[]
  exampleOutputs:   string[]
}

const EMPTY: BrandProfile = { bannedPhrases: [], requiredPhrases: [], exampleOutputs: [] }

export async function getBrandProfile(workspaceId: string): Promise<BrandProfile> {
  await ensureTable()
  try {
    const r = await db.execute(sql`
      SELECT brand_name, tone, persona, audience, style_guide,
             banned_phrases, required_phrases, example_outputs
      FROM brand_profile WHERE workspace_id = ${workspaceId}
    `)
    const row = (r as unknown as Array<{
      brand_name: string | null; tone: string | null; persona: string | null;
      audience: string | null; style_guide: string | null;
      banned_phrases: string[] | null; required_phrases: string[] | null;
      example_outputs: string[] | null;
    }>)[0]
    if (!row) return EMPTY
    return {
      brandName:       row.brand_name ?? undefined,
      tone:            row.tone ?? undefined,
      persona:         row.persona ?? undefined,
      audience:        row.audience ?? undefined,
      styleGuide:      row.style_guide ?? undefined,
      bannedPhrases:   Array.isArray(row.banned_phrases) ? row.banned_phrases : [],
      requiredPhrases: Array.isArray(row.required_phrases) ? row.required_phrases : [],
      exampleOutputs:  Array.isArray(row.example_outputs) ? row.example_outputs : [],
    }
  } catch { return EMPTY }
}

export interface BrandUpdate extends Partial<Omit<BrandProfile, 'bannedPhrases' | 'requiredPhrases' | 'exampleOutputs'>> {
  bannedPhrases?:   string[]
  requiredPhrases?: string[]
  exampleOutputs?:  string[]
}

export async function setBrandProfile(workspaceId: string, patch: BrandUpdate): Promise<{ ok: boolean }> {
  await ensureTable()
  const current = await getBrandProfile(workspaceId)
  const merged = {
    brandName:       patch.brandName       ?? current.brandName,
    tone:            patch.tone            ?? current.tone,
    persona:         patch.persona         ?? current.persona,
    audience:        patch.audience        ?? current.audience,
    styleGuide:      patch.styleGuide      ?? current.styleGuide,
    bannedPhrases:   patch.bannedPhrases   ?? current.bannedPhrases,
    requiredPhrases: patch.requiredPhrases ?? current.requiredPhrases,
    exampleOutputs:  patch.exampleOutputs  ?? current.exampleOutputs,
  }
  try {
    await db.execute(sql`
      INSERT INTO brand_profile (workspace_id, brand_name, tone, persona, audience, style_guide,
                                 banned_phrases, required_phrases, example_outputs, updated_at)
      VALUES (${workspaceId}, ${merged.brandName ?? null}, ${merged.tone ?? null},
              ${merged.persona ?? null}, ${merged.audience ?? null}, ${merged.styleGuide ?? null},
              ${JSON.stringify(merged.bannedPhrases)}::jsonb,
              ${JSON.stringify(merged.requiredPhrases)}::jsonb,
              ${JSON.stringify(merged.exampleOutputs)}::jsonb,
              ${Date.now()})
      ON CONFLICT (workspace_id) DO UPDATE SET
        brand_name       = EXCLUDED.brand_name,
        tone             = EXCLUDED.tone,
        persona          = EXCLUDED.persona,
        audience         = EXCLUDED.audience,
        style_guide      = EXCLUDED.style_guide,
        banned_phrases   = EXCLUDED.banned_phrases,
        required_phrases = EXCLUDED.required_phrases,
        example_outputs  = EXCLUDED.example_outputs,
        updated_at       = EXCLUDED.updated_at
    `)
    return { ok: true }
  } catch { return { ok: false } }
}

/** Builds a system-prompt fragment to prepend to any LLM call so outputs
 *  adhere to the operator's brand. Returns empty string if no profile set. */
export async function buildBrandSystemPrompt(workspaceId: string): Promise<string> {
  const p = await getBrandProfile(workspaceId)
  if (!p.brandName && !p.tone && !p.persona && !p.styleGuide &&
      p.bannedPhrases.length === 0 && p.requiredPhrases.length === 0) return ''
  const parts: string[] = ['BRAND VOICE (enforce on every output):']
  if (p.brandName)  parts.push(`Brand: ${p.brandName}`)
  if (p.tone)       parts.push(`Tone: ${p.tone}`)
  if (p.persona)    parts.push(`Persona: ${p.persona}`)
  if (p.audience)   parts.push(`Audience: ${p.audience}`)
  if (p.styleGuide) parts.push(`Style guide:\n${p.styleGuide}`)
  if (p.bannedPhrases.length > 0) {
    parts.push(`NEVER use these phrases: ${p.bannedPhrases.map(b => `"${b}"`).join(', ')}`)
  }
  if (p.requiredPhrases.length > 0) {
    parts.push(`Try to include at least one of: ${p.requiredPhrases.map(b => `"${b}"`).join(', ')}`)
  }
  if (p.exampleOutputs.length > 0) {
    parts.push(`Examples of outputs that match this voice:\n${p.exampleOutputs.slice(0, 3).map((e, i) => `  ${i + 1}. ${e}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

export interface BrandViolation {
  type:     'banned_phrase_used' | 'no_required_phrase'
  detail:   string
}

/** Scans an LLM output for brand violations. Doesn't throw — returns list. */
export async function validateAgainstBrand(workspaceId: string, output: string): Promise<BrandViolation[]> {
  const p = await getBrandProfile(workspaceId)
  const violations: BrandViolation[] = []
  const lower = output.toLowerCase()
  for (const b of p.bannedPhrases) {
    if (b && lower.includes(b.toLowerCase())) {
      violations.push({ type: 'banned_phrase_used', detail: `used banned phrase "${b}"` })
    }
  }
  if (p.requiredPhrases.length > 0) {
    const hasOne = p.requiredPhrases.some(r => r && lower.includes(r.toLowerCase()))
    if (!hasOne) {
      violations.push({ type: 'no_required_phrase', detail: `no required-phrase appeared (allowed: ${p.requiredPhrases.slice(0, 5).join(', ')})` })
    }
  }
  return violations
}
