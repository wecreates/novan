/**
 * rbac.ts — Role-based access control.
 *
 * Roles: owner | admin | member | viewer
 * Permissions: granular strings checked per-action.
 * Every denied attempt creates a security_audits row.
 */
import { db }              from '../db/client.js'
import { permissions, securityAudits, events } from '../db/schema.js'
import { eq, and }         from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'

export type Role = 'owner' | 'admin' | 'member' | 'viewer'

/** Built-in permission strings. Custom grants extend these per-user. */
export const PERMISSIONS = {
  // Workspace
  WORKSPACE_VIEW:       'workspace.view',
  WORKSPACE_EDIT:       'workspace.edit',
  WORKSPACE_DELETE:     'workspace.delete',
  // Members
  MEMBERS_INVITE:       'members.invite',
  MEMBERS_REMOVE:       'members.remove',
  ROLES_ASSIGN:         'roles.assign',
  // Billing
  BILLING_VIEW:         'billing.view',
  BILLING_MANAGE:       'billing.manage',
  PLAN_CHANGE:          'plan.change',
  // Runtime
  WORKFLOW_RUN:         'workflow.run',
  WORKFLOW_PAUSE:       'workflow.pause',
  AGENT_CONTROL:        'agent.control',
  REPLAY_TRIGGER:       'replay.trigger',
  ROLLBACK_TRIGGER:     'rollback.trigger',
  // Deployment
  DEPLOY_TRIGGER:       'deploy.trigger',
  LAUNCH_OVERRIDE:      'launch.override',
  // Patches
  PATCH_APPROVE:        'patch.approve',
  PATCH_DISPATCH:       'patch.dispatch',
  // Secrets
  SECRET_READ_REDACTED: 'secret.read_redacted',
  SECRET_REVEAL:        'secret.reveal',
  SECRET_ROTATE:        'secret.rotate',
  SECRET_DELETE:        'secret.delete',
  // Compliance
  AUDIT_EXPORT:         'audit.export',
  AUDIT_VIEW:           'audit.view',
} as const

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS]

// ─── Role → default permissions map ───────────────────────────────────────────

const ROLE_DEFAULTS: Record<Role, Permission[]> = {
  owner: Object.values(PERMISSIONS),  // all
  admin: [
    PERMISSIONS.WORKSPACE_VIEW, PERMISSIONS.WORKSPACE_EDIT,
    PERMISSIONS.MEMBERS_INVITE, PERMISSIONS.MEMBERS_REMOVE, PERMISSIONS.ROLES_ASSIGN,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.WORKFLOW_RUN, PERMISSIONS.WORKFLOW_PAUSE, PERMISSIONS.AGENT_CONTROL,
    PERMISSIONS.REPLAY_TRIGGER, PERMISSIONS.ROLLBACK_TRIGGER,
    PERMISSIONS.PATCH_APPROVE, PERMISSIONS.PATCH_DISPATCH,
    PERMISSIONS.SECRET_READ_REDACTED, PERMISSIONS.SECRET_ROTATE,
    PERMISSIONS.AUDIT_EXPORT, PERMISSIONS.AUDIT_VIEW,
  ],
  member: [
    PERMISSIONS.WORKSPACE_VIEW,
    PERMISSIONS.WORKFLOW_RUN,
    PERMISSIONS.SECRET_READ_REDACTED,
    PERMISSIONS.AUDIT_VIEW,
  ],
  viewer: [
    PERMISSIONS.WORKSPACE_VIEW,
    PERMISSIONS.AUDIT_VIEW,
  ],
}

/** Actions that ALWAYS require explicit RBAC even for owner — high-impact gate */
export const PROTECTED_ACTIONS: ReadonlySet<Permission> = new Set<Permission>([
  PERMISSIONS.WORKSPACE_DELETE,
  PERMISSIONS.BILLING_MANAGE, PERMISSIONS.PLAN_CHANGE,
  PERMISSIONS.DEPLOY_TRIGGER, PERMISSIONS.LAUNCH_OVERRIDE,
  PERMISSIONS.SECRET_REVEAL, PERMISSIONS.SECRET_ROTATE, PERMISSIONS.SECRET_DELETE,
  PERMISSIONS.ROLLBACK_TRIGGER,
  PERMISSIONS.AUDIT_EXPORT,
])

// ─── Audit helper ─────────────────────────────────────────────────────────────

async function audit(
  workspaceId: string | null, userId: string | null, eventType: string,
  severity: 'info' | 'warning' | 'critical', resource: string,
  action: string, outcome: 'allowed' | 'denied' | 'recorded',
  context: Record<string, unknown> = {},
) {
  await db.insert(securityAudits).values({
    id: uuidv7(),
    workspaceId, userId,
    eventType, severity, resource, action, outcome,
    context, immutable: true,
    ipAddress: null, userAgent: null,
    createdAt: Date.now(),
  }).catch(() => null)
  if (outcome === 'denied') {
    await db.insert(events).values({
      id: uuidv7(), type: 'security.permission_denied',
      workspaceId: workspaceId ?? 'global',
      payload: { userId, resource, action, ...context },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'rbac', version: 1, createdAt: Date.now(),
    }).catch(() => null)
  }
}

// ─── Permission grant management ──────────────────────────────────────────────

export async function grantRole(
  userId: string, workspaceId: string, role: Role,
  grantedBy: string, extraGrants: Permission[] = [],
): Promise<void> {
  const now = Date.now()
  const existing = await db.select().from(permissions)
    .where(and(eq(permissions.userId, userId), eq(permissions.workspaceId, workspaceId))).limit(1)

  const grants = [...new Set([...ROLE_DEFAULTS[role], ...extraGrants])] as string[]

  if (existing[0]) {
    await db.update(permissions).set({
      role, grants, grantedBy, updatedAt: now,
    }).where(eq(permissions.id, existing[0].id))
  } else {
    await db.insert(permissions).values({
      id: uuidv7(), userId, workspaceId, role,
      grants, grantedBy, createdAt: now, updatedAt: now,
    })
  }

  await audit(workspaceId, grantedBy, 'permission_denied', 'info',
    `user:${userId}`, `grant_role:${role}`, 'recorded', { grants })
}

export async function revokeRole(userId: string, workspaceId: string, revokedBy: string): Promise<void> {
  await db.delete(permissions).where(and(
    eq(permissions.userId, userId), eq(permissions.workspaceId, workspaceId),
  ))
  await audit(workspaceId, revokedBy, 'permission_denied', 'warning',
    `user:${userId}`, 'revoke_role', 'recorded', {})
}

// ─── Permission check ─────────────────────────────────────────────────────────

export interface AuthorizeResult {
  allowed: boolean
  reason?: string
  role?:   Role
}

export async function authorize(
  userId: string, workspaceId: string, permission: Permission,
  context: Record<string, unknown> = {},
): Promise<AuthorizeResult> {
  const rows = await db.select().from(permissions)
    .where(and(eq(permissions.userId, userId), eq(permissions.workspaceId, workspaceId))).limit(1)
  const p = rows[0]

  if (!p) {
    await audit(workspaceId, userId, 'permission_denied', 'warning',
      `workspace:${workspaceId}`, permission, 'denied',
      { ...context, reason: 'no permission record' })
    return { allowed: false, reason: 'No permission record for this user/workspace' }
  }

  const granted = (p.grants as string[]).includes(permission as string)
  if (!granted) {
    await audit(workspaceId, userId, 'permission_denied', 'warning',
      `workspace:${workspaceId}`, permission, 'denied',
      { ...context, role: p.role })
    return { allowed: false, reason: `Role '${p.role}' lacks permission '${permission}'`, role: p.role as Role }
  }

  return { allowed: true, role: p.role as Role }
}

/** Helper that returns or throws */
export async function authorizeOrThrow(
  userId: string, workspaceId: string, permission: Permission,
): Promise<Role> {
  const r = await authorize(userId, workspaceId, permission)
  if (!r.allowed) throw new Error(`Permission denied: ${r.reason}`)
  return r.role!
}

export async function listMembers(workspaceId: string) {
  return db.select().from(permissions).where(eq(permissions.workspaceId, workspaceId))
}
