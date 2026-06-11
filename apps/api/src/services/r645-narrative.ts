/**
 * R645b — Narrative engine (Fable-class creative writing).
 *
 *   narrative.story_outline   3-act structure from a one-line premise
 *   narrative.scene_write     prose for one scene of a stored outline
 *   narrative.character_bible detailed character profile
 *   narrative.style_transfer  rewrite text in a target author/style
 *   narrative.story_iterate   diff-edit an existing story (R644c pattern)
 *   narrative.list / get / delete
 *
 * Stories are stored in generated_stories. Each scene update bumps version.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import type { ChatMsg } from './chat-providers.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS generated_stories (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title        TEXT NOT NULL,
      premise      TEXT NOT NULL,
      outline      JSONB NOT NULL DEFAULT '{}'::jsonb,
      scenes       JSONB NOT NULL DEFAULT '[]'::jsonb,
      characters   JSONB NOT NULL DEFAULT '[]'::jsonb,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS gen_stories_ws_idx ON generated_stories (workspace_id, updated_at DESC)`).catch(() => {})
}

async function llmJson<T>(workspaceId: string, msgs: ChatMsg[], label: string): Promise<{ data: T; tokens: number; costUsd: number }> {
  const { streamChat } = await import('./chat-providers.js')
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
  final = next.value
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = (fenced?.[1] ?? raw).trim()
  const m = candidate.match(/\{[\s\S]*\}/)
  if (!m) throw new Error(`${label}: LLM did not return JSON`)
  try { return { data: JSON.parse(m[0]) as T, tokens: final.tokens, costUsd: final.costUsd } }
  catch (e) { throw new Error(`${label}: JSON parse — ${(e as Error).message}`) }
}

async function llmText(workspaceId: string, msgs: ChatMsg[]): Promise<{ text: string; tokens: number; costUsd: number }> {
  const { streamChat } = await import('./chat-providers.js')
  let text = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) text += next.value.delta
  final = next.value
  return { text: text.trim(), tokens: final.tokens, costUsd: final.costUsd }
}

// ─── Outline ────────────────────────────────────────────────────────────────

export interface Outline {
  title:    string
  logline:  string
  genre:    string
  acts: Array<{
    act:      number          // 1..3
    summary:  string
    beats:    Array<{ beat: string; pageRange?: string }>
  }>
  themes:   string[]
  tone:     string
}

export interface OutlineResult {
  storyId: string
  outline: Outline
  tokens:  number
  costUsd: number
}

export async function storyOutline(workspaceId: string, input: { premise: string; genre?: string; tone?: string }): Promise<OutlineResult> {
  await ensureTable()
  if (!input.premise?.trim()) throw new Error('premise required')
  const system = 'You are a story architect. Output strict JSON: { "title": string, "logline": string, "genre": string, "acts": [{ "act": 1|2|3, "summary": string, "beats": [{ "beat": string }] }], "themes": string[], "tone": string }. 3 acts, 4-6 beats per act. No markdown, no commentary.'
  const user = `Premise: ${input.premise}\n${input.genre ? `Genre: ${input.genre}\n` : ''}${input.tone ? `Tone: ${input.tone}\n` : ''}`
  const { data, tokens, costUsd } = await llmJson<Outline>(workspaceId, [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ], 'story_outline')

  const id = uuidv7()
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO generated_stories (id, workspace_id, title, premise, outline, created_at, updated_at)
    VALUES (${id}, ${workspaceId}, ${data.title ?? 'Untitled'}, ${input.premise}, ${JSON.stringify(data)}::jsonb, ${now}, ${now})
  `).catch(() => {})
  return { storyId: id, outline: data, tokens, costUsd }
}

// ─── Scene write ────────────────────────────────────────────────────────────

export interface Scene {
  act:       number
  beat:      number
  heading:   string         // EXT. OPENING ESTABLISHING — DAY
  prose:     string
  wordCount: number
  createdAt: number
}

export interface SceneResult {
  storyId:    string
  sceneIndex: number
  scene:      Scene
  tokens:     number
  costUsd:    number
}

export async function sceneWrite(workspaceId: string, input: { storyId: string; act: number; beat: number; pov?: string; targetWords?: number }): Promise<SceneResult> {
  await ensureTable()
  const r = await db.execute(sql`SELECT outline, scenes, characters FROM generated_stories WHERE workspace_id = ${workspaceId} AND id = ${input.storyId}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) throw new Error('story not found')
  const outline   = row['outline']   as Outline
  const scenes    = (row['scenes']     as Scene[]) ?? []
  const characters = (row['characters'] as Array<{ name: string; bio: string }>) ?? []

  const act = outline.acts?.find(a => a.act === input.act)
  if (!act) throw new Error(`act ${input.act} not in outline`)
  const beat = act.beats?.[input.beat - 1]
  if (!beat) throw new Error(`beat ${input.beat} not in act ${input.act}`)

  const targetWords = Math.max(150, Math.min(2000, input.targetWords ?? 600))
  const prevScenes = scenes.slice(-2).map(s => `[Act ${s.act}, Beat ${s.beat}] ${s.heading}\n${s.prose.slice(0, 400)}…`).join('\n\n')
  const charBlock = characters.length > 0 ? `Characters:\n${characters.map(c => `${c.name}: ${c.bio.slice(0, 200)}`).join('\n')}\n` : ''
  const system = `You are a screenwriter/novelist. Write ONE scene as prose (third-person past tense unless POV demands otherwise). Open with a slugline-style heading. Target ${targetWords} words ±15%. Stay in tone "${outline.tone}". Output two parts separated by a single line "---":\n1) The heading line (INT./EXT. LOCATION — DAY/NIGHT)\n2) The prose.\nNo markdown fences. No commentary.`
  const user = `Story: ${outline.title}\nLogline: ${outline.logline}\nGenre: ${outline.genre}\n${charBlock}\nWrite Act ${act.act}, Beat ${input.beat} — "${beat.beat}".${input.pov ? `\nPOV: ${input.pov}` : ''}\n${prevScenes ? `\nRecent scenes for continuity:\n${prevScenes}` : ''}`

  const { text, tokens, costUsd } = await llmText(workspaceId, [{ role: 'system', content: system }, { role: 'user', content: user }])
  const parts = text.split(/^---\s*$/m)
  const heading = (parts[0] ?? '').trim().split('\n')[0] ?? `ACT ${act.act} — BEAT ${input.beat}`
  const prose = (parts[1] ?? text).trim()

  const scene: Scene = {
    act:       input.act,
    beat:      input.beat,
    heading,
    prose,
    wordCount: prose.split(/\s+/).filter(Boolean).length,
    createdAt: Date.now(),
  }
  scenes.push(scene)
  await db.execute(sql`UPDATE generated_stories SET scenes = ${JSON.stringify(scenes)}::jsonb, version = version + 1, updated_at = ${Date.now()} WHERE id = ${input.storyId} AND workspace_id = ${workspaceId}`).catch(() => {})

  return { storyId: input.storyId, sceneIndex: scenes.length - 1, scene, tokens, costUsd }
}

// ─── Character bible ───────────────────────────────────────────────────────

export interface Character {
  name:        string
  role:        string
  archetype:   string
  bio:         string             // 200-400 word backstory
  voice:       string             // how they sound when speaking
  goal:        string
  flaw:        string
  arc:         string             // their transformation through the story
}

export async function characterBible(workspaceId: string, input: { storyId?: string; name: string; context: string }): Promise<{ character: Character; tokens: number; costUsd: number }> {
  await ensureTable()
  if (!input.name?.trim()) throw new Error('name required')
  const system = 'You are a character developer. Output strict JSON: { "name": string, "role": "protagonist"|"antagonist"|"mentor"|"ally"|"foil"|"supporting", "archetype": string, "bio": string (200-400 words), "voice": string (one sentence on speech patterns), "goal": string, "flaw": string, "arc": string }. No markdown.'
  const user = `Character name: ${input.name}\nContext (story / role / situation): ${input.context.slice(0, 4000)}`
  const { data, tokens, costUsd } = await llmJson<Character>(workspaceId, [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ], 'character_bible')

  if (input.storyId) {
    const r = await db.execute(sql`SELECT characters FROM generated_stories WHERE workspace_id = ${workspaceId} AND id = ${input.storyId}`).catch(() => [] as unknown[])
    const row = (r as Array<Record<string, unknown>>)[0]
    if (row) {
      const cur = (row['characters'] as Character[]) ?? []
      const next = cur.filter(c => c.name !== data.name).concat([data])
      await db.execute(sql`UPDATE generated_stories SET characters = ${JSON.stringify(next)}::jsonb, updated_at = ${Date.now()} WHERE id = ${input.storyId} AND workspace_id = ${workspaceId}`).catch(() => {})
    }
  }
  return { character: data, tokens, costUsd }
}

// ─── Style transfer ────────────────────────────────────────────────────────

export interface StyleTransferInput {
  text:    string
  target:  string         // e.g. 'Cormac McCarthy', 'noir 1940s', 'Pratchett wry'
  preserve?: 'plot' | 'all'    // default: preserve plot only
}

export async function styleTransfer(workspaceId: string, input: StyleTransferInput): Promise<{ rewritten: string; tokens: number; costUsd: number }> {
  if (!input.text?.trim()) throw new Error('text required')
  if (!input.target?.trim()) throw new Error('target style required')
  const system = `You rewrite prose in a target style while preserving ${input.preserve === 'all' ? 'every plot point AND character voice AND dialogue beat verbatim where possible' : 'the plot exactly. Reword sentences fully.'} Output ONLY the rewritten prose. No commentary, no fences.`
  const user = `Target style: ${input.target}\n\nOriginal:\n${input.text.slice(0, 12000)}`
  const r = await llmText(workspaceId, [{ role: 'system', content: system }, { role: 'user', content: user }])
  return { rewritten: r.text, tokens: r.tokens, costUsd: r.costUsd }
}

// ─── Story iterate ─────────────────────────────────────────────────────────

export interface StoryIterateInput {
  storyId: string
  prompt:  string
}

export async function storyIterate(workspaceId: string, input: StoryIterateInput): Promise<{ storyId: string; version: number; summary: string; tokens: number; costUsd: number }> {
  await ensureTable()
  const r = await db.execute(sql`SELECT outline, scenes, characters, version FROM generated_stories WHERE workspace_id = ${workspaceId} AND id = ${input.storyId}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) throw new Error('story not found')

  const state = {
    outline:    row['outline']    as Outline,
    scenes:     row['scenes']     as Scene[],
    characters: row['characters'] as Character[],
  }
  const system = 'You revise a story. Output strict JSON: { "outline": Outline?, "scenes": Scene[]?, "characters": Character[]?, "summary": string }. Include only fields you changed. The "summary" is one paragraph describing the revision. No markdown.'
  const user = `Current state:\n${JSON.stringify(state).slice(0, 30000)}\n\nRevision instruction:\n${input.prompt}`
  const { data, tokens, costUsd } = await llmJson<{ outline?: Outline; scenes?: Scene[]; characters?: Character[]; summary?: string }>(workspaceId, [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ], 'story_iterate')

  if (data.outline)    state.outline    = data.outline
  if (data.scenes)     state.scenes     = data.scenes
  if (data.characters) state.characters = data.characters

  const upd = await db.execute(sql`
    UPDATE generated_stories
    SET outline = ${JSON.stringify(state.outline)}::jsonb,
        scenes = ${JSON.stringify(state.scenes)}::jsonb,
        characters = ${JSON.stringify(state.characters)}::jsonb,
        version = version + 1, updated_at = ${Date.now()}
    WHERE id = ${input.storyId} AND workspace_id = ${workspaceId}
    RETURNING version
  `).catch(() => [] as unknown[])
  const v = ((upd as Array<Record<string, unknown>>)[0]?.['version']) ?? Number(row['version']) + 1
  return { storyId: input.storyId, version: Number(v), summary: data.summary ?? '', tokens, costUsd }
}

// ─── List / get / delete ───────────────────────────────────────────────────

export async function listStories(workspaceId: string, limit = 30): Promise<Array<{ id: string; title: string; premise: string; version: number; sceneCount: number; updatedAt: number }>> {
  await ensureTable()
  const r = await db.execute(sql`SELECT id, title, premise, version, scenes, updated_at FROM generated_stories WHERE workspace_id = ${workspaceId} ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(100, limit))}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    id:         String(row['id']),
    title:      String(row['title']),
    premise:    String(row['premise']),
    version:    Number(row['version']),
    sceneCount: ((row['scenes'] as Scene[]) ?? []).length,
    updatedAt:  Number(row['updated_at']),
  }))
}

export async function getStory(workspaceId: string, id: string): Promise<{ id: string; title: string; premise: string; outline: Outline; scenes: Scene[]; characters: Character[]; version: number } | null> {
  await ensureTable()
  const r = await db.execute(sql`SELECT * FROM generated_stories WHERE workspace_id = ${workspaceId} AND id = ${id}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return null
  return {
    id:         String(row['id']),
    title:      String(row['title']),
    premise:    String(row['premise']),
    outline:    (row['outline']    as Outline) ?? { title: '', logline: '', genre: '', acts: [], themes: [], tone: '' },
    scenes:     (row['scenes']     as Scene[]) ?? [],
    characters: (row['characters'] as Character[]) ?? [],
    version:    Number(row['version']),
  }
}

export async function deleteStory(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await ensureTable()
  await db.execute(sql`DELETE FROM generated_stories WHERE workspace_id = ${workspaceId} AND id = ${id}`).catch(() => {})
  return { ok: true }
}
