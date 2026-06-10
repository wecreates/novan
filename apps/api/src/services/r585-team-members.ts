/**
 * R585 — Team members + role-based ACL.
 *
 * Operator goal: "massive teams on some business projects" — multiple
 * humans collaborating on Novan with scoped permissions.
 *
 * Roles (most → least power):
 *   - owner       — workspace creator. Cannot be revoked. Full power.
 *   - admin       — add/remove team members, change roles, all ops on all businesses
 *   - manager     — all ops on assigned businesses (business_id), cannot manage team
 *   - operator    — execute approved tasks on assigned businesses; cannot change kill_switch / budget
 *   - va          — virtual assistant: can run low-risk ops, all writes require approval
 *   - accountant  — read-only access + revenue.* + finance.* + tax.* ops
 *   - viewer      — read-only dashboard
 *
 * Scoping:
 *   - business_id NULL on team_members row = role applies to ALL businesses
 *   - business_id set = role applies only to that business
 *
 * Enforcement:
 *   - canMemberRunOp(member, opName, opRisk) returns boolean
 *   - Brain-task dispatch wraps this check (next round of wiring)
 *
 * Invites:
 *   - Email-based invite tokens, 7-day expiry
 *   - Accept flow records accepted_at + last_active_at
 */
import { sql } from 'drizzle-orm'
import { createHash, randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

export type TeamRole = 'owner' | 'admin' | 'manager' | 'operator' | 'va' | 'accountant' | 'viewer'

const VALID_ROLES: ReadonlyArray<TeamRole> = ['owner', 'admin', 'manager', 'operator', 'va', 'accountant', 'viewer']

async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS team_members (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      business_id     TEXT,                        -- NULL = all businesses
      email           TEXT NOT NULL,
      role            TEXT NOT NULL,
      invited_at      BIGINT NOT NULL,
      accepted_at     BIGINT,
      last_active_at  BIGINT,
      revoked_at      BIGINT,
      added_by        TEXT                          -- email of granting admin/owner
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS team_members_ws_email_idx ON team_members (workspace_id, lower(email)) WHERE revoked_at IS NULL`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS team_members_ws_biz_idx   ON team_members (workspace_id, business_id) WHERE revoked_at IS NULL`).catch(() => {})

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS team_invites (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      business_id     TEXT,
      email           TEXT NOT NULL,
      role            TEXT NOT NULL,
      token_hash      TEXT NOT NULL,                -- SHA256(token) — token only shown once
      expires_at      BIGINT NOT NULL,
      created_at      BIGINT NOT NULL,
      accepted_at     BIGINT,
      cancelled_at    BIGINT,
      invited_by      TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS team_invites_ws_idx ON team_invites (workspace_id) WHERE accepted_at IS NULL AND cancelled_at IS NULL`).catch(() => {})
}

export interface TeamMember {
  id:             string
  workspaceId:    string
  businessId:     string | null
  email:          string
  role:           TeamRole
  invitedAt:      number
  acceptedAt:     number | null
  lastActiveAt:   number | null
}

// ─── Member management ─────────────────────────────────────────────────────

export async function listMembers(workspaceId: string, businessId?: string | null): Promise<TeamMember[]> {
  await ensureTables()
  try {
    const r = businessId !== undefined
      ? await db.execute(sql`
          SELECT id, workspace_id, business_id, email, role, invited_at, accepted_at, last_active_at
          FROM team_members
          WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
            AND (business_id IS NULL OR business_id = ${businessId})
          ORDER BY invited_at ASC
        `)
      : await db.execute(sql`
          SELECT id, workspace_id, business_id, email, role, invited_at, accepted_at, last_active_at
          FROM team_members
          WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
          ORDER BY invited_at ASC
        `)
    return (r as unknown as Array<{
      id: string; workspace_id: string; business_id: string | null; email: string; role: TeamRole;
      invited_at: number; accepted_at: number | null; last_active_at: number | null;
    }>).map(x => ({
      id: x.id, workspaceId: x.workspace_id, businessId: x.business_id, email: x.email, role: x.role,
      invitedAt: Number(x.invited_at),
      acceptedAt: x.accepted_at === null ? null : Number(x.accepted_at),
      lastActiveAt: x.last_active_at === null ? null : Number(x.last_active_at),
    }))
  } catch { return [] }
}

export async function findMemberByEmail(workspaceId: string, email: string, businessId?: string | null): Promise<TeamMember | null> {
  await ensureTables()
  const lower = email.trim().toLowerCase()
  try {
    const r = await db.execute(sql`
      SELECT id, workspace_id, business_id, email, role, invited_at, accepted_at, last_active_at
      FROM team_members
      WHERE workspace_id = ${workspaceId} AND revoked_at IS NULL
        AND lower(email) = ${lower}
        AND (business_id IS NULL OR business_id = ${businessId ?? null})
      ORDER BY (business_id IS NULL) ASC      -- prefer biz-specific over wildcard
      LIMIT 1
    `)
    const row = (r as unknown as Array<{ id: string; workspace_id: string; business_id: string | null; email: string; role: TeamRole; invited_at: number; accepted_at: number | null; last_active_at: number | null }>)[0]
    if (!row) return null
    return {
      id: row.id, workspaceId: row.workspace_id, businessId: row.business_id, email: row.email, role: row.role,
      invitedAt: Number(row.invited_at),
      acceptedAt: row.accepted_at === null ? null : Number(row.accepted_at),
      lastActiveAt: row.last_active_at === null ? null : Number(row.last_active_at),
    }
  } catch { return null }
}

export async function setRole(workspaceId: string, memberId: string, role: TeamRole): Promise<{ ok: boolean; reason?: string }> {
  await ensureTables()
  if (!VALID_ROLES.includes(role)) return { ok: false, reason: `invalid role (allowed: ${VALID_ROLES.join('|')})` }
  if (role === 'owner') return { ok: false, reason: 'cannot promote to owner via setRole; ownership is workspace-level' }
  try {
    const r = await db.execute(sql`
      UPDATE team_members SET role = ${role}
      WHERE id = ${memberId} AND workspace_id = ${workspaceId} AND revoked_at IS NULL
        AND role != 'owner'
      RETURNING id
    `)
    const a = r as unknown as Array<unknown>
    return Array.isArray(a) && a.length > 0 ? { ok: true } : { ok: false, reason: 'member not found or is owner' }
  } catch (e) { return { ok: false, reason: (e as Error).message.slice(0, 80) } }
}

export async function revokeMember(workspaceId: string, memberId: string): Promise<{ ok: boolean; reason?: string }> {
  await ensureTables()
  try {
    const r = await db.execute(sql`
      UPDATE team_members SET revoked_at = ${Date.now()}
      WHERE id = ${memberId} AND workspace_id = ${workspaceId} AND revoked_at IS NULL AND role != 'owner'
      RETURNING id
    `)
    const a = r as unknown as Array<unknown>
    return Array.isArray(a) && a.length > 0 ? { ok: true } : { ok: false, reason: 'member not found or is owner' }
  } catch (e) { return { ok: false, reason: (e as Error).message.slice(0, 80) } }
}

export async function touchMemberActivity(workspaceId: string, email: string): Promise<void> {
  await ensureTables()
  try {
    await db.execute(sql`
      UPDATE team_members SET last_active_at = ${Date.now()}
      WHERE workspace_id = ${workspaceId} AND lower(email) = ${email.toLowerCase()} AND revoked_at IS NULL
    `)
  } catch { /* tolerated */ }
}

// ─── Invites ───────────────────────────────────────────────────────────────

export interface InviteResult {
  ok:        boolean
  inviteId?: string
  token?:    string                 // shown ONCE; SHA256 stored
  reason?:   string
}

export async function createInvite(workspaceId: string, email: string, role: TeamRole, businessId: string | null, invitedBy: string): Promise<InviteResult> {
  await ensureTables()
  if (!VALID_ROLES.includes(role)) return { ok: false, reason: `invalid role (allowed: ${VALID_ROLES.join('|')})` }
  if (role === 'owner') return { ok: false, reason: 'cannot invite as owner' }
  if (!email || !email.includes('@')) return { ok: false, reason: 'invalid email' }
  const token = randomBytes(24).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const id = uuidv7()
  const now = Date.now()
  const expiresAt = now + 7 * 24 * 60 * 60_000
  try {
    await db.execute(sql`
      INSERT INTO team_invites (id, workspace_id, business_id, email, role, token_hash, expires_at, created_at, invited_by)
      VALUES (${id}, ${workspaceId}, ${businessId}, ${email.trim().toLowerCase()}, ${role}, ${tokenHash}, ${expiresAt}, ${now}, ${invitedBy})
    `)
    return { ok: true, inviteId: id, token }
  } catch (e) { return { ok: false, reason: (e as Error).message.slice(0, 80) } }
}

export async function listInvites(workspaceId: string): Promise<Array<{ id: string; email: string; role: TeamRole; businessId: string | null; expiresAt: number; createdAt: number; invitedBy: string | null }>> {
  await ensureTables()
  try {
    const r = await db.execute(sql`
      SELECT id, email, role, business_id, expires_at, created_at, invited_by
      FROM team_invites
      WHERE workspace_id = ${workspaceId} AND accepted_at IS NULL AND cancelled_at IS NULL
        AND expires_at > ${Date.now()}
      ORDER BY created_at DESC LIMIT 50
    `)
    return (r as unknown as Array<{ id: string; email: string; role: TeamRole; business_id: string | null; expires_at: number; created_at: number; invited_by: string | null }>).map(x => ({
      id: x.id, email: x.email, role: x.role, businessId: x.business_id,
      expiresAt: Number(x.expires_at), createdAt: Number(x.created_at), invitedBy: x.invited_by,
    }))
  } catch { return [] }
}

export async function acceptInvite(workspaceId: string, token: string): Promise<{ ok: boolean; reason?: string; memberId?: string }> {
  await ensureTables()
  const tokenHash = createHash('sha256').update(token).digest('hex')
  try {
    const r = await db.execute(sql`
      SELECT id, business_id, email, role FROM team_invites
      WHERE workspace_id = ${workspaceId} AND token_hash = ${tokenHash}
        AND accepted_at IS NULL AND cancelled_at IS NULL AND expires_at > ${Date.now()}
      LIMIT 1
    `)
    const row = (r as unknown as Array<{ id: string; business_id: string | null; email: string; role: TeamRole }>)[0]
    if (!row) return { ok: false, reason: 'invite invalid, expired, or already used' }
    const memberId = uuidv7()
    const now = Date.now()
    await db.execute(sql`
      INSERT INTO team_members (id, workspace_id, business_id, email, role, invited_at, accepted_at, last_active_at)
      VALUES (${memberId}, ${workspaceId}, ${row.business_id}, ${row.email}, ${row.role}, ${now}, ${now}, ${now})
    `)
    await db.execute(sql`UPDATE team_invites SET accepted_at = ${now} WHERE id = ${row.id}`)
    return { ok: true, memberId }
  } catch (e) { return { ok: false, reason: (e as Error).message.slice(0, 80) } }
}

export async function cancelInvite(workspaceId: string, inviteId: string): Promise<{ ok: boolean }> {
  await ensureTables()
  try {
    await db.execute(sql`UPDATE team_invites SET cancelled_at = ${Date.now()} WHERE id = ${inviteId} AND workspace_id = ${workspaceId}`)
    return { ok: true }
  } catch { return { ok: false } }
}

// ─── Access control ────────────────────────────────────────────────────────

/** Whether a role can run an op of given risk + (optionally) within a specific business scope. */
export function canRoleRunRisk(role: TeamRole, risk: 'low' | 'medium' | 'high'): boolean {
  if (role === 'owner' || role === 'admin') return true
  if (role === 'manager') return risk !== 'high'                  // managers need explicit approval for high
  if (role === 'operator') return risk === 'low'                  // operators auto-run only low risk
  if (role === 'va') return risk === 'low'
  if (role === 'accountant') return risk === 'low'                // accountant gates finance reads/writes via op-name allowlist (next R)
  if (role === 'viewer') return false                              // viewer cannot run any mutation
  return false
}

/** Member-aware variant. Verifies member exists + role allows the op. */
export async function canMemberRunOp(workspaceId: string, email: string, opName: string, opRisk: 'low' | 'medium' | 'high', businessId?: string | null): Promise<{ allowed: boolean; reason?: string }> {
  const m = await findMemberByEmail(workspaceId, email, businessId ?? null)
  if (!m) return { allowed: false, reason: 'not a team member of this workspace' }
  if (m.acceptedAt === null) return { allowed: false, reason: 'invite not yet accepted' }
  if (m.businessId !== null && businessId !== undefined && m.businessId !== businessId) {
    return { allowed: false, reason: `role scoped to a different business` }
  }
  if (!canRoleRunRisk(m.role, opRisk)) {
    return { allowed: false, reason: `role '${m.role}' cannot run ${opRisk}-risk op '${opName}'` }
  }
  await touchMemberActivity(workspaceId, email)
  return { allowed: true }
}
