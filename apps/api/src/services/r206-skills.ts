/**
 * R146.206 — Skills registry. Anthropic-style capability bundles:
 * (name + description + when_to_use + instructions). The chat-providers
 * system prompt advertises name+description only; the full instructions
 * load on demand when matched. Each skill tracks uses + wins so we can
 * score them (R55 prompt-evolution analog).
 */
import { db } from '../db/client.js'
import { operatorSkills } from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface SkillInput {
  name:         string
  description:  string
  whenToUse?:   string
  instructions: string
}

export async function skillCreate(workspaceId: string, input: SkillInput): Promise<{ id: string; created: boolean }> {
  const now = Date.now()
  const id = uuidv7()
  await db.insert(operatorSkills).values({
    id, workspaceId, name: input.name, description: input.description,
    whenToUse: input.whenToUse ?? null, instructions: input.instructions,
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [operatorSkills.workspaceId, operatorSkills.name],
    set: { description: input.description, whenToUse: input.whenToUse ?? null,
           instructions: input.instructions, version: sql`${operatorSkills.version} + 1`, updatedAt: now },
  })
  const [row] = await db.select({ id: operatorSkills.id, createdAt: operatorSkills.createdAt }).from(operatorSkills)
    .where(and(eq(operatorSkills.workspaceId, workspaceId), eq(operatorSkills.name, input.name))).limit(1)
  return { id: row?.id ?? id, created: row?.createdAt === now }
}

export async function skillList(workspaceId: string): Promise<Array<{ id: string; name: string; description: string; whenToUse: string | null; version: number; uses: number; wins: number }>> {
  return db.select({
    id: operatorSkills.id, name: operatorSkills.name, description: operatorSkills.description,
    whenToUse: operatorSkills.whenToUse, version: operatorSkills.version, uses: operatorSkills.uses, wins: operatorSkills.wins,
  }).from(operatorSkills).where(eq(operatorSkills.workspaceId, workspaceId)).orderBy(desc(operatorSkills.uses))
}

export async function skillLoad(workspaceId: string, name: string): Promise<{ id: string; instructions: string } | null> {
  const [row] = await db.select({ id: operatorSkills.id, instructions: operatorSkills.instructions }).from(operatorSkills)
    .where(and(eq(operatorSkills.workspaceId, workspaceId), eq(operatorSkills.name, name))).limit(1)
  if (!row) return null
  await db.update(operatorSkills).set({ uses: sql`${operatorSkills.uses} + 1` })
    .where(eq(operatorSkills.id, row.id))
  return row
}

export async function skillScore(workspaceId: string, name: string, won: boolean): Promise<void> {
  await db.update(operatorSkills)
    .set({ wins: won ? sql`${operatorSkills.wins} + 1` : operatorSkills.wins, updatedAt: Date.now() })
    .where(and(eq(operatorSkills.workspaceId, workspaceId), eq(operatorSkills.name, name)))
}

export async function skillSearch(workspaceId: string, query: string, limit = 5): Promise<Array<{ name: string; description: string }>> {
  const q = `%${query.toLowerCase()}%`
  return db.select({ name: operatorSkills.name, description: operatorSkills.description }).from(operatorSkills)
    .where(and(
      eq(operatorSkills.workspaceId, workspaceId),
      sql`(LOWER(${operatorSkills.name}) LIKE ${q} OR LOWER(${operatorSkills.description}) LIKE ${q} OR LOWER(COALESCE(${operatorSkills.whenToUse}, '')) LIKE ${q})`,
    ))
    .orderBy(desc(operatorSkills.uses))
    .limit(limit)
}

/** Used by chat-providers to advertise available operatorSkills to the model. */
export async function operatorSkillsAdvertisement(workspaceId: string, maxBytes = 2000): Promise<string> {
  const rows = await skillList(workspaceId)
  if (rows.length === 0) return ''
  const lines: string[] = ['Available operatorSkills (call skill.load{name} for full instructions):']
  let used = 0
  for (const r of rows) {
    const line = `• ${r.name} — ${r.description}${r.whenToUse ? ` (when: ${r.whenToUse})` : ''}`
    if (used + line.length > maxBytes) break
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}
