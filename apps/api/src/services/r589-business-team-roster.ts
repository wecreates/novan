/**
 * R589 — Per-business team roster (composes R580 + R585).
 *
 * Question this answers: "Show me everyone with access to business X and
 * what they can do." Today R585 returns members for the workspace, but
 * doesn't show effective access per-business (workspace-wide members
 * have access to ALL businesses; business-scoped members only their one).
 *
 * Output: per-business roster grouped by role, with "inherited from
 * workspace" vs "scoped to this business" markers.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface BusinessRosterEntry {
  memberId:       string
  email:          string
  role:           string
  acceptedAt:     number | null
  lastActiveAt:   number | null
  scope:          'workspace' | 'business'      // workspace = applies to all biz; business = scoped to this one
}

export interface BusinessRoster {
  businessId:     string
  businessName:   string
  members:        BusinessRosterEntry[]
  byRole:         Record<string, number>
}

export async function rosterForBusiness(workspaceId: string, businessId: string): Promise<BusinessRoster | null> {
  // Look up business name
  let businessName = ''
  try {
    const r = await db.execute(sql`SELECT name FROM businesses WHERE workspace_id = ${workspaceId} AND id = ${businessId} LIMIT 1`)
    const row = (r as unknown as Array<{ name: string }>)[0]
    if (!row) return null
    businessName = row.name
  } catch { return null }

  let members: BusinessRosterEntry[] = []
  try {
    const r = await db.execute(sql`
      SELECT id, email, role, business_id, accepted_at, last_active_at
      FROM team_members
      WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
        AND (business_id IS NULL OR business_id = ${businessId})
      ORDER BY (business_id IS NULL) ASC, role ASC      -- biz-scoped first, then wildcard
    `)
    members = (r as unknown as Array<{
      id: string; email: string; role: string; business_id: string | null;
      accepted_at: number | null; last_active_at: number | null;
    }>).map(x => ({
      memberId:     x.id,
      email:        x.email,
      role:         x.role,
      acceptedAt:   x.accepted_at === null ? null : Number(x.accepted_at),
      lastActiveAt: x.last_active_at === null ? null : Number(x.last_active_at),
      scope:        x.business_id === null ? 'workspace' : 'business',
    }))
  } catch { return null }

  const byRole: Record<string, number> = {}
  for (const m of members) byRole[m.role] = (byRole[m.role] ?? 0) + 1

  return { businessId, businessName, members, byRole }
}

export async function allBusinessRosters(workspaceId: string): Promise<BusinessRoster[]> {
  let businesses: Array<{ id: string }> = []
  try {
    const r = await db.execute(sql`SELECT id FROM businesses WHERE workspace_id = ${workspaceId} ORDER BY created_at ASC`)
    businesses = r as unknown as typeof businesses
  } catch { return [] }
  const out: BusinessRoster[] = []
  for (const b of businesses) {
    const roster = await rosterForBusiness(workspaceId, b.id)
    if (roster) out.push(roster)
  }
  return out
}
