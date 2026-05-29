/**
 * voice-shortcuts.ts — operator-defined phrase → command expansions.
 *
 *   "daily scan"      → "summarize today"
 *   "open security"   → "zoom into security"
 *   "safe audit"      → "start safe audit"
 *   "lock it down"    → "lock voice actions"
 *
 * The /command route looks up shortcuts BEFORE wake gating and intent
 * parsing — if a phrase matches, the expansion replaces the transcript so
 * the rest of the pipeline (wake, conversation, policy) behaves identically.
 *
 * Matching is:
 *   - case-insensitive
 *   - whole-phrase only (longest configured phrase first to avoid
 *     prefix shadowing)
 *   - workspace-scoped; user_id is optional (null = workspace-wide)
 *
 * Editable + deletable per the directive.
 */
import { db } from '../db/client.js'
import { voiceShortcuts } from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface ShortcutRow {
  id: string; workspaceId: string; userId: string | null
  phrase: string; expansion: string; description: string | null
  useCount: number; lastUsedAt: number | null; enabled: boolean
}

export interface ShortcutInput {
  workspaceId: string; userId?: string | null
  phrase: string; expansion: string; description?: string
  enabled?: boolean
}

export async function listShortcuts(workspaceId: string, userId?: string): Promise<ShortcutRow[]> {
  const rows = await db.select().from(voiceShortcuts)
    .where(eq(voiceShortcuts.workspaceId, workspaceId))
    .orderBy(desc(voiceShortcuts.useCount)).limit(500).catch(() => [])
  return rows
    .filter(r => userId ? (r.userId === userId || r.userId === null) : true)
    .map(r => ({
      id: r.id, workspaceId: r.workspaceId, userId: r.userId,
      phrase: r.phrase, expansion: r.expansion, description: r.description,
      useCount: r.useCount, lastUsedAt: r.lastUsedAt, enabled: r.enabled,
    }))
}

export async function upsertShortcut(input: ShortcutInput): Promise<ShortcutRow> {
  if (!input.phrase.trim() || !input.expansion.trim()) throw new Error('phrase + expansion required')
  if (input.phrase.length > 80) throw new Error('phrase too long (max 80 chars)')
  if (input.expansion.length > 400) throw new Error('expansion too long (max 400 chars)')

  const phrase = input.phrase.trim().toLowerCase()
  const existing = await db.select().from(voiceShortcuts)
    .where(and(
      eq(voiceShortcuts.workspaceId, input.workspaceId),
      eq(voiceShortcuts.phrase, phrase),
    ))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[voice-shortcuts]', e.message); return null })
  const now = Date.now()

  if (existing) {
    await db.update(voiceShortcuts).set({
      expansion:   input.expansion.trim(),
      description: input.description ?? existing.description,
      enabled:     input.enabled ?? existing.enabled,
      updatedAt:   now,
    }).where(eq(voiceShortcuts.id, existing.id))
    return { ...existing, expansion: input.expansion.trim(), description: input.description ?? existing.description, enabled: input.enabled ?? existing.enabled }
  }
  const id = uuidv7()
  await db.insert(voiceShortcuts).values({
    id, workspaceId: input.workspaceId, userId: input.userId ?? null,
    phrase, expansion: input.expansion.trim(),
    description: input.description ?? null,
    enabled: input.enabled ?? true,
    createdAt: now, updatedAt: now,
  })
  return {
    id, workspaceId: input.workspaceId, userId: input.userId ?? null,
    phrase, expansion: input.expansion.trim(),
    description: input.description ?? null,
    useCount: 0, lastUsedAt: null, enabled: input.enabled ?? true,
  }
}

export async function deleteShortcut(id: string, workspaceId: string): Promise<void> {
  await db.delete(voiceShortcuts).where(and(eq(voiceShortcuts.id, id), eq(voiceShortcuts.workspaceId, workspaceId))).catch((e: Error) => { console.error('[voice-shortcuts]', e.message); return null })
}

/**
 * Pure: expand a transcript against a shortcut list. Returns the
 * expansion text + matched row when a phrase fully matches the
 * trimmed lowercase transcript; otherwise returns null.
 *
 * Whole-phrase match avoids accidentally rewriting random utterances
 * that happen to contain a shortcut keyword.
 */
export function expandTranscript(text: string, shortcuts: ReadonlyArray<{ phrase: string; expansion: string; enabled: boolean; id: string }>): { id: string; expansion: string; phrase: string } | null {
  const t = text.trim().toLowerCase().replace(/[.?!,]+$/g, '')
  if (!t) return null
  // Longest phrase first so "open security grid" beats "open security"
  const ordered = [...shortcuts]
    .filter(s => s.enabled && s.phrase)
    .sort((a, b) => b.phrase.length - a.phrase.length)
  for (const s of ordered) {
    const phrase = s.phrase.trim().toLowerCase()
    if (phrase && (t === phrase || t.startsWith(phrase + ' '))) {
      // If the operator added trailing words ("daily scan now"), keep them
      const trailing = t.slice(phrase.length).trim()
      const expansion = trailing ? `${s.expansion} ${trailing}` : s.expansion
      return { id: s.id, expansion, phrase: s.phrase }
    }
  }
  return null
}

/** Increment use count and last_used_at — best-effort, non-blocking. */
export async function recordShortcutUse(id: string): Promise<void> {
  await db.update(voiceShortcuts).set({
    useCount: sql`${voiceShortcuts.useCount} + 1`,
    lastUsedAt: Date.now(),
  }).where(eq(voiceShortcuts.id, id)).catch((e: Error) => { console.error('[voice-shortcuts]', e.message); return null })
}
