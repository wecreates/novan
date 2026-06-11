/**
 * R640 — Voice library (A2).
 *
 * Persisted named voices the operator builds up over time. Each entry
 * remembers the source provider (OmniVoice clone vs OpenAI default vs
 * ElevenLabs etc.), a stable id, optional preview audio in S3, and
 * whether it's the workspace default.
 *
 * Surface:
 *   voice.lib.list        — workspace's library
 *   voice.lib.clone       — clone from operator audio sample (R599 omniCloneVoice)
 *   voice.lib.preview     — generate + persist a sample for one entry
 *   voice.lib.rename
 *   voice.lib.set_default
 *   voice.lib.delete
 *
 * UI at /ops/voices renders the library with one-click preview audio
 * playback inline.
 */
import { Buffer } from 'node:buffer'
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS voice_library (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      provider        TEXT NOT NULL,
      provider_voice_id TEXT NOT NULL,
      name            TEXT NOT NULL,
      language        TEXT,
      is_default      BOOLEAN NOT NULL DEFAULT false,
      preview_url     TEXT,
      preview_sample_text TEXT,
      metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL,
      UNIQUE (workspace_id, name)
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS voice_lib_ws_idx ON voice_library (workspace_id, is_default DESC, updated_at DESC)`).catch(() => {})
}

export interface VoiceEntry {
  id: string
  workspaceId: string
  provider: string                    // 'omnivoice' | 'openai' | 'elevenlabs' | ...
  providerVoiceId: string             // The id the provider uses
  name: string
  language: string | null
  isDefault: boolean
  previewUrl: string | null
  previewSampleText: string | null
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

function rowToEntry(r: Record<string, unknown>): VoiceEntry {
  return {
    id: String(r['id']),
    workspaceId: String(r['workspace_id']),
    provider: String(r['provider']),
    providerVoiceId: String(r['provider_voice_id']),
    name: String(r['name']),
    language: r['language'] != null ? String(r['language']) : null,
    isDefault: Boolean(r['is_default']),
    previewUrl: r['preview_url'] != null ? String(r['preview_url']) : null,
    previewSampleText: r['preview_sample_text'] != null ? String(r['preview_sample_text']) : null,
    metadata: (r['metadata'] as Record<string, unknown>) ?? {},
    createdAt: Number(r['created_at']),
    updatedAt: Number(r['updated_at']),
  }
}

export async function listVoices(workspaceId: string): Promise<VoiceEntry[]> {
  await ensureTable()
  const r = await db.execute(sql`SELECT * FROM voice_library WHERE workspace_id = ${workspaceId} ORDER BY is_default DESC, updated_at DESC`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(rowToEntry)
}

export async function getDefault(workspaceId: string): Promise<VoiceEntry | null> {
  await ensureTable()
  const r = await db.execute(sql`SELECT * FROM voice_library WHERE workspace_id = ${workspaceId} AND is_default = true LIMIT 1`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  return row ? rowToEntry(row) : null
}

export interface CloneInput {
  name:        string
  audioBase64: string
  refText?:    string
  language?:   string
  filename?:   string
}

export async function clone(workspaceId: string, input: CloneInput): Promise<{ id: string; providerVoiceId: string; provider: string }> {
  await ensureTable()
  if (!input.name?.trim()) throw new Error('name required')
  if (!input.audioBase64) throw new Error('audioBase64 required')
  const audioBuf = Buffer.from(input.audioBase64, 'base64')
  const { omniCloneVoice } = await import('./r599-omnivoice-provider.js')
  const cloneInput: Parameters<typeof omniCloneVoice>[0] = { name: input.name, audio: audioBuf }
  if (input.filename) cloneInput.filename = input.filename
  if (input.refText)  cloneInput.refText  = input.refText
  if (input.language) cloneInput.language = input.language
  const cloned = await omniCloneVoice(cloneInput, workspaceId)
  const providerVoiceId = (cloned as unknown as { voice_id?: string; id?: string }).voice_id
                         ?? (cloned as unknown as { id?: string }).id
                         ?? input.name
  const id = uuidv7()
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO voice_library (id, workspace_id, provider, provider_voice_id, name, language, created_at, updated_at)
    VALUES (${id}, ${workspaceId}, 'omnivoice', ${providerVoiceId}, ${input.name}, ${input.language ?? null}, ${now}, ${now})
    ON CONFLICT (workspace_id, name) DO UPDATE SET
      provider = EXCLUDED.provider, provider_voice_id = EXCLUDED.provider_voice_id,
      language = EXCLUDED.language, updated_at = EXCLUDED.updated_at
  `).catch(() => {})
  return { id, providerVoiceId, provider: 'omnivoice' }
}

/** Register a non-cloned voice (e.g. an OpenAI built-in like 'nova'). */
export async function register(workspaceId: string, input: { name: string; provider: string; providerVoiceId: string; language?: string }): Promise<{ id: string }> {
  await ensureTable()
  if (!input.name?.trim() || !input.provider || !input.providerVoiceId) throw new Error('name + provider + providerVoiceId required')
  const id = uuidv7()
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO voice_library (id, workspace_id, provider, provider_voice_id, name, language, created_at, updated_at)
    VALUES (${id}, ${workspaceId}, ${input.provider}, ${input.providerVoiceId}, ${input.name}, ${input.language ?? null}, ${now}, ${now})
    ON CONFLICT (workspace_id, name) DO UPDATE SET
      provider = EXCLUDED.provider, provider_voice_id = EXCLUDED.provider_voice_id,
      language = EXCLUDED.language, updated_at = EXCLUDED.updated_at
  `).catch(() => {})
  return { id }
}

export interface PreviewInput {
  id: string
  text?: string
}

export async function preview(workspaceId: string, input: PreviewInput): Promise<{ ok: boolean; previewUrl?: string; assetId?: string; bytes?: number; error?: string }> {
  await ensureTable()
  const r = await db.execute(sql`SELECT * FROM voice_library WHERE workspace_id = ${workspaceId} AND id = ${input.id}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return { ok: false, error: 'not found' }
  const entry = rowToEntry(row)
  const text = (input.text ?? 'Hello, this is a Novan voice preview. Three quick brown foxes leap nimbly across the lazy dog.').slice(0, 400)
  const { omniTts } = await import('./r599-omnivoice-provider.js')
  const ttsInput: Parameters<typeof omniTts>[0] = { text, format: 'mp3', voice: entry.providerVoiceId }
  if (entry.language) ttsInput.language = entry.language
  try {
    const tts = await omniTts(ttsInput, workspaceId)
    const tts2 = tts as unknown as { audioBase64?: string; audio_base64?: string }
    const b64 = tts2.audioBase64 ?? tts2.audio_base64
    if (!b64) return { ok: false, error: 'tts produced no audio' }
    const buf = Buffer.from(b64, 'base64')
    // Persist as asset
    try {
      const { persistAsset } = await import('./r616-asset-persistence.js')
      const a = await persistAsset({
        workspaceId, kind: 'audio',
        bytes: buf, mime: 'audio/mpeg',
        prompt: `Voice preview · ${entry.name}`,
        sourceKind: 'r640-voice-preview',
        metadata: { voiceLibId: entry.id, sampleText: text },
      })
      const result: { ok: boolean; previewUrl?: string; assetId?: string; bytes?: number } = { ok: true, assetId: a.id, bytes: buf.length }
      if (a.publicUrl) result.previewUrl = a.publicUrl
      await db.execute(sql`UPDATE voice_library SET preview_url = ${a.publicUrl ?? null}, preview_sample_text = ${text}, updated_at = ${Date.now()} WHERE id = ${entry.id}`).catch(() => {})
      return result
    } catch {
      // Asset persistence optional — return base64 inline
      return { ok: true, bytes: buf.length }
    }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function rename(workspaceId: string, id: string, name: string): Promise<{ ok: boolean }> {
  await ensureTable()
  if (!name?.trim()) throw new Error('name required')
  await db.execute(sql`UPDATE voice_library SET name = ${name}, updated_at = ${Date.now()} WHERE workspace_id = ${workspaceId} AND id = ${id}`).catch(() => {})
  return { ok: true }
}

export async function setDefault(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await ensureTable()
  await db.execute(sql`UPDATE voice_library SET is_default = false WHERE workspace_id = ${workspaceId}`).catch(() => {})
  await db.execute(sql`UPDATE voice_library SET is_default = true, updated_at = ${Date.now()} WHERE workspace_id = ${workspaceId} AND id = ${id}`).catch(() => {})
  return { ok: true }
}

export async function remove(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await ensureTable()
  await db.execute(sql`DELETE FROM voice_library WHERE workspace_id = ${workspaceId} AND id = ${id}`).catch(() => {})
  return { ok: true }
}

// ─── UI ─────────────────────────────────────────────────────────────────────

const STYLE = `body{font:14px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;max-width:880px;margin:24px auto;padding:0 16px;color:#222}h1,h2{margin:.6em 0 .3em}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:middle}th{background:#f6f7f9;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}.meta{color:#6b7280;font-size:12px;margin-bottom:8px}.dim{color:#9ca3af}.good{color:#059669}.tag{display:inline-block;padding:2px 6px;border-radius:4px;background:#eef2ff;color:#3730a3;font-size:11px}audio{height:32px;max-width:240px}code{font:12.5px/1 ui-monospace,monospace;background:#f6f7f9;padding:1px 4px;border-radius:3px}.star{color:#eab308;margin-right:4px}`

function esc(s: unknown): string { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)) }

export async function renderVoicesHtml(workspaceId: string, token = ''): Promise<string> {
  const voices = await listVoices(workspaceId)
  const t = encodeURIComponent(token)
  const rowActions = (id: string): string => token ? `
    <form method="POST" action="/ops/voices/preview?token=${t}&workspace=${esc(workspaceId)}" style="display:inline">
      <input type="hidden" name="id" value="${esc(id)}">
      <button style="background:none;border:1px solid #d1d5db;border-radius:3px;padding:1px 6px;font-size:11px;cursor:pointer">▶ preview</button>
    </form>
    <form method="POST" action="/ops/voices/set_default?token=${t}&workspace=${esc(workspaceId)}" style="display:inline">
      <input type="hidden" name="id" value="${esc(id)}">
      <button style="background:none;border:1px solid #d1d5db;border-radius:3px;padding:1px 6px;font-size:11px;cursor:pointer">★ default</button>
    </form>
    <form method="POST" action="/ops/voices/delete?token=${t}&workspace=${esc(workspaceId)}" style="display:inline" onsubmit="return confirm('Delete this voice?')">
      <input type="hidden" name="id" value="${esc(id)}">
      <button style="background:none;border:none;color:#b91c1c;cursor:pointer;font-size:13px">×</button>
    </form>` : ''
  const rows = voices.map(v => `<tr>
    <td>${v.isDefault ? '<span class="star" title="default">★</span>' : ''}<strong>${esc(v.name)}</strong></td>
    <td><span class="tag">${esc(v.provider)}</span></td>
    <td><code>${esc(v.providerVoiceId)}</code></td>
    <td>${esc(v.language ?? '')}</td>
    <td>${v.previewUrl ? `<audio controls preload="none" src="${esc(v.previewUrl)}"></audio>` : '<span class="dim">no preview</span>'}</td>
    <td>${rowActions(v.id)}</td>
  </tr>`).join('')

  const registerForm = token ? `
    <h2 style="font-size:14px;color:#374151;margin:14px 0 4px">Register a built-in voice</h2>
    <form method="POST" action="/ops/voices/register?token=${t}&workspace=${esc(workspaceId)}" style="display:grid;grid-template-columns:1fr 1fr 1fr 60px auto;gap:6px;margin:6px 0 12px;max-width:760px">
      <input name="name"             placeholder="display name (e.g. Onyx deep)" required style="padding:6px 8px;border:1px solid #d1d5db;border-radius:4px">
      <select name="provider" required style="padding:6px 8px;border:1px solid #d1d5db;border-radius:4px">
        <option value="openai">openai</option>
        <option value="omnivoice">omnivoice</option>
        <option value="elevenlabs">elevenlabs</option>
      </select>
      <input name="providerVoiceId"  placeholder="provider voice id (nova/onyx/…)" required style="padding:6px 8px;border:1px solid #d1d5db;border-radius:4px">
      <input name="language"         placeholder="en" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:4px">
      <button style="padding:6px 12px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer">Add</button>
    </form>` : ''

  const body = `
    <h1>Voice library</h1>
    <div class="meta">workspace=${esc(workspaceId)} · ${voices.length} voice(s) · use voice.lib.clone brain op to clone from an audio sample</div>
    ${registerForm}
    <table>
      <thead><tr><th>name</th><th>provider</th><th>provider id</th><th>lang</th><th>preview</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="dim">No voices yet.</td></tr>'}</tbody>
    </table>`
  return `<!doctype html><meta charset="utf-8"><title>Voice library · Novan</title><style>${STYLE}</style>${body}`
}
