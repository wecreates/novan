/**
 * R146.325 — auth-first workspaceId helper.
 *
 * Routes that take a workspace_id from body/query were duplicating this
 * 4-line snippet in eng-agents, learning, platform-status, recap. Extracted
 * here so future routes use one canonical helper.
 *
 * Behaviour: prefer the JWT claim (set by auth plugin onto req.workspaceId).
 * Fall back to caller-supplied value only when there's no auth context
 * (the no-auth dev path that ENFORCE_GLOBAL_AUTH=false enables).
 */
export function wsOf(req: unknown, fallback?: string): string {
  const auth = (req as { workspaceId?: string }).workspaceId
  if (auth) return auth
  return fallback ?? 'default'
}
