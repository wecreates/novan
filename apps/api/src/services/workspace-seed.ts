/**
 * workspace-seed.ts — First-install hook per SPEC §18.16.
 *
 * Called from the workspace-creation flow (POST /api/v1/workspaces)
 * so a brand-new workspace inherits Novan's baseline on day one
 * rather than waiting for the operator to discover the seed ops.
 *
 * Honest scope:
 *   - Idempotent — re-running on an already-seeded workspace is a no-op
 *     (the underlying seedChatEvals + policy default already skip
 *     existing rows). Safe to call multiple times.
 *   - Fire-and-forget at the route layer: the workspace is created
 *     synchronously; the seed runs in the background so a failure in
 *     one seed step doesn't fail the workspace creation.
 *   - What's NOT seeded here: business records, channel attachments,
 *     OAuth connections, scheduled production. Those are operator-
 *     decisions and live in the operator's onboarding flow, not
 *     workspace creation.
 */
import { v7 as uuidv7 } from 'uuid'

export interface SeedResult {
  workspaceId:        string
  evalsSetsCreated:   number
  evalCasesCreated:   number
  evalsSkipped:       string[]
  templateApplied:    string | null
  errors:             string[]
}

export async function seedWorkspaceOnFirstInstall(
  workspaceId: string,
  templateKey?: string,
): Promise<SeedResult> {
  const errors: string[] = []
  let evalsSetsCreated = 0
  let evalCasesCreated = 0
  let evalsSkipped: string[] = []
  let templateApplied: string | null = null

  // 0. Business template application (BO14). Defaults to 'generic'.
  try {
    const { applyTemplateToWorkspace } = await import('./business-templates.js')
    const key = (templateKey ?? 'generic')
    const out = await applyTemplateToWorkspace(workspaceId, key as never)
    templateApplied = out.applied
  } catch (e) {
    errors.push(`template: ${(e as Error).message}`)
  }

  // 1. Chat eval seeds (golden / regression / safety / honesty).
  try {
    const { seedChatEvals } = await import('./eval-seed-chat.js')
    const out = await seedChatEvals(workspaceId)
    evalsSetsCreated = out.setsCreated
    evalCasesCreated = out.casesCreated
    evalsSkipped     = out.skipped
  } catch (e) {
    errors.push(`evals: ${(e as Error).message}`)
  }

  // 2. Emit baseline event so the operator can verify in the timeline
  //    that the seed actually ran on this workspace.
  const { db } = await import('../db/client.js')
  const { events } = await import('../db/schema.js')
  await db.insert(events).values({
    id: uuidv7(), type: 'workspace.seeded', workspaceId,
    payload: {
      evalsSetsCreated, evalCasesCreated, evalsSkipped, templateApplied, errors,
      seededAt: Date.now(),
    },
    traceId: uuidv7(), correlationId: workspaceId, causationId: null,
    source: 'workspace-seed', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[workspace-seed]', e.message); return null })

  return {
    workspaceId,
    evalsSetsCreated,
    evalCasesCreated,
    evalsSkipped,
    templateApplied,
    errors,
  }
}

/** Operator-facing: check whether a workspace has been seeded. Returns
 *  the most recent workspace.seeded event if present. */
export async function getSeedStatus(workspaceId: string): Promise<{
  seeded:     boolean
  seededAt?:  number
  result?:    SeedResult
}> {
  const { db } = await import('../db/client.js')
  const { events: _events } = await import('../db/schema.js')
  const { and, eq, desc } = await import('drizzle-orm')
  const rows = await db.select({ payload: _events.payload, createdAt: _events.createdAt })
    .from(_events)
    .where(and(eq(_events.workspaceId, workspaceId), eq(_events.type, 'workspace.seeded')))
    .orderBy(desc(_events.createdAt))
    .limit(1)
    .catch(() => [])
  if (rows.length === 0) return { seeded: false }
  const p = rows[0]!.payload as Partial<SeedResult> & { seededAt?: number }
  return {
    seeded:   true,
    ...(p.seededAt ? { seededAt: p.seededAt } : { seededAt: Number(rows[0]!.createdAt) }),
    result: {
      workspaceId,
      evalsSetsCreated: p.evalsSetsCreated ?? 0,
      evalCasesCreated: p.evalCasesCreated ?? 0,
      evalsSkipped:     p.evalsSkipped     ?? [],
      templateApplied:  p.templateApplied  ?? null,
      errors:           p.errors           ?? [],
    },
  }
}
