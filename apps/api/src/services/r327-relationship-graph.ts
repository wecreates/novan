/**
 * R146.327 (#3) — relationship graph.
 *
 * "Remind me what we agreed with Mike about pricing" — works because we
 * track entities + their connections + recent context. Closes the
 * memory.relationships partial gap from R326 brain-completeness.
 */
import { db } from '../db/client.js'
import { relationshipGraph } from '../db/schema.js'
import { and, eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type RelKind = 'person' | 'business' | 'vendor' | 'partner' | 'team' | 'other'

export interface RelationshipUpsert {
  workspaceId: string
  kind:        RelKind
  name:        string
  attrs?:      Record<string, unknown>
}

export async function relationshipUpsert(input: RelationshipUpsert): Promise<{ id: string; created: boolean }> {
  const now = Date.now()
  const [existing] = await db.select({ id: relationshipGraph.id })
    .from(relationshipGraph)
    .where(and(
      eq(relationshipGraph.workspaceId, input.workspaceId),
      sql`lower(${relationshipGraph.name}) = lower(${input.name})`,
      eq(relationshipGraph.kind, input.kind),
    ))
    .limit(1)
    .catch(() => [])
  if (existing) {
    await db.update(relationshipGraph)
      .set({
        attrs: { ...(input.attrs ?? {}) },
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(relationshipGraph.id, existing.id))
    return { id: existing.id, created: false }
  }
  const id = uuidv7()
  await db.insert(relationshipGraph).values({
    id, workspaceId: input.workspaceId, kind: input.kind, name: input.name,
    attrs: input.attrs ?? {}, links: [],
    lastSeenAt: now, createdAt: now, updatedAt: now,
  })
  return { id, created: true }
}

export async function relationshipLink(input: { workspaceId: string; aId: string; bId: string; rel: string }): Promise<void> {
  const [a] = await db.select().from(relationshipGraph).where(eq(relationshipGraph.id, input.aId)).limit(1).catch(() => [])
  if (!a || a.workspaceId !== input.workspaceId) throw new Error('source entity not in workspace')
  const links = (a.links ?? []) as Array<{ otherId: string; rel: string; since: number }>
  if (links.some(l => l.otherId === input.bId && l.rel === input.rel)) return
  links.push({ otherId: input.bId, rel: input.rel, since: Date.now() })
  await db.update(relationshipGraph).set({ links, updatedAt: Date.now() }).where(eq(relationshipGraph.id, input.aId))
}

export async function relationshipRecall(input: { workspaceId: string; query: string; limit?: number }): Promise<Array<{
  id: string; kind: RelKind; name: string; attrs: Record<string, unknown>;
  links: Array<{ otherId: string; rel: string; since: number }>; lastSeenAt: number | null
}>> {
  const lim = Math.min(Math.max(input.limit ?? 10, 1), 100)
  const rows = await db.select().from(relationshipGraph)
    .where(and(
      eq(relationshipGraph.workspaceId, input.workspaceId),
      sql`lower(${relationshipGraph.name}) LIKE ${'%' + input.query.toLowerCase() + '%'}`,
    ))
    .limit(lim)
    .catch(() => [])
  return rows.map(r => ({
    id: r.id, kind: r.kind as RelKind, name: r.name,
    attrs: (r.attrs ?? {}) as Record<string, unknown>,
    links: (r.links ?? []) as Array<{ otherId: string; rel: string; since: number }>,
    lastSeenAt: r.lastSeenAt,
  }))
}

/** Extract entities from a chat turn and upsert. Conservative — only fires
 *  on capitalized multi-word names mentioned with role keywords. */
const ENTITY_RX = /\b(?:my|our|the|with)\s+(vendor|client|partner|teammate|cofounder|advisor|investor)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\b/g

export async function extractAndPersist(workspaceId: string, text: string): Promise<{ upserted: number }> {
  let n = 0
  let m: RegExpExecArray | null
  while ((m = ENTITY_RX.exec(text)) !== null) {
    const roleWord = m[1]!.toLowerCase()
    const name     = m[2]!
    const kind: RelKind =
      roleWord === 'vendor'    ? 'vendor' :
      roleWord === 'client'    ? 'business' :
      roleWord === 'partner'   ? 'partner' :
      roleWord === 'investor'  ? 'business' :
      'person'
    await relationshipUpsert({ workspaceId, kind, name }).catch(() => null)
    n++
    if (n >= 8) break  // cap per turn
  }
  return { upserted: n }
}
