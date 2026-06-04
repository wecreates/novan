/**
 * R167 — Auto-publish pipeline + auto-repurpose after publish.
 *
 * Closes the loop:
 *   PAI run done → bandit-pick caption per platform → one socialPost
 *   row per active platform (draft, awaiting human approval at the
 *   connector layer) → fire R163 repurpose pack from the source brief.
 */
import { db } from '../db/client.js'
import {
  publishPlan, socialPosts, videoPaiRun, videoIsa, connectorAccounts,
} from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const SUPPORTED_PLATFORMS = ['youtube', 'tiktok', 'instagram', 'x'] as const

export interface PublishFromRunInput {
  runId:        string
  platforms?:   string[]   // defaults to active connectors
  scheduledAt?: number
}

export async function publishFromRun(workspaceId: string, input: PublishFromRunInput): Promise<{ ok: boolean; planId?: string; postIds?: string[]; error?: string }> {
  const [run] = await db.select().from(videoPaiRun)
    .where(and(eq(videoPaiRun.workspaceId, workspaceId), eq(videoPaiRun.id, input.runId))).limit(1)
  if (!run) return { ok: false, error: 'run not found' }
  if (run.phase !== 'done') return { ok: false, error: `run phase=${run.phase}, must be done` }

  const [isa] = await db.select().from(videoIsa)
    .where(and(eq(videoIsa.workspaceId, workspaceId), eq(videoIsa.id, run.isaId))).limit(1)
  if (!isa) return { ok: false, error: 'isa not found' }

  // Resolve platforms: caller's list, or every active connector that supports posting.
  let platforms = (input.platforms ?? []).filter(p => (SUPPORTED_PLATFORMS as readonly string[]).includes(p))
  if (platforms.length === 0) {
    const accts = await db.select({ connectorId: connectorAccounts.connectorId })
      .from(connectorAccounts)
      .where(and(eq(connectorAccounts.workspaceId, workspaceId), eq(connectorAccounts.status, 'active')))
    platforms = [...new Set(accts.map(a => a.connectorId).filter(id => (SUPPORTED_PLATFORMS as readonly string[]).includes(id)))]
  }
  if (platforms.length === 0) return { ok: false, error: 'no active platforms to publish to' }

  // Resolve final asset path from EXECUTE phase output.
  const exec = (run.execute ?? {}) as { finalOutputPath?: string; ok?: boolean }
  const assetPath = exec.finalOutputPath
  const assetPaths = assetPath ? [assetPath] : []

  // Bandit-picked caption per platform (one bandit per platform).
  const { banditPick } = await import('./r164-funnel-cro.js')
  const postIds: string[] = []
  const planId = uuidv7()

  await db.insert(publishPlan).values({
    id: planId, workspaceId,
    ...(isa.target && typeof (isa.target as { businessId?: string }).businessId === 'string'
      ? { businessId: (isa.target as { businessId?: string }).businessId as string } : {}),
    runId: input.runId,
    sourceKind: 'pai_run',
    platforms, assetPaths,
    ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
    status: 'draft',
    createdAt: Date.now(),
  }).onConflictDoUpdate({
    target: [publishPlan.runId],
    set: { platforms, assetPaths, status: 'draft', error: null },
  })

  // R146.190 — Resolve an actual managed account per platform instead
  // of falling back to the literal string 'default:<platform>'. This
  // makes posts attachable to the real account they'll publish from.
  const { managedAccount } = await import('../db/schema.js')
  const accountByPlatform = new Map<string, string>()
  try {
    const accts = await db.select({ id: managedAccount.id, handle: managedAccount.handle, platform: managedAccount.platform })
      .from(managedAccount)
      .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.status, 'active')))
    for (const a of accts) if (!accountByPlatform.has(a.platform)) accountByPlatform.set(a.platform, a.id)
  } catch { /* no accounts yet; fall through with anonymous ref */ }

  for (const platform of platforms) {
    const accountRef = accountByPlatform.get(platform) ?? `unbound:${platform}`
    try {
      // Per-platform caption variants from R163 (if a pack exists for this run).
      const captionVariants = await draftCaptionsFor(isa.title, isa.brief, platform)
      const pickName = `caption:${platform}:${input.runId.slice(0, 8)}`
      const pick = await banditPick(workspaceId, { name: pickName, variantLabels: captionVariants.map((_, i) => String(i)) })
      const idx = Number(pick.variant)
      const caption = captionVariants[idx] ?? captionVariants[0] ?? isa.title

      const postId = uuidv7()
      await db.insert(socialPosts).values({
        id: postId, workspaceId, platform,
        accountRef,
        body: caption.slice(0, 4000),
        assetRefs: assetPaths,
        ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
        status: input.scheduledAt ? 'scheduled' : 'draft',
        engagement: {},
        blockReasons: accountRef.startsWith('unbound:') ? ['no_active_account_for_platform'] : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      postIds.push(postId)
    } catch (e) {
      // Per-platform failure doesn't abort the plan.
      await db.insert(socialPosts).values({
        id: uuidv7(), workspaceId, platform,
        accountRef,
        body: isa.title.slice(0, 4000),
        assetRefs: assetPaths,
        status: 'failed',
        engagement: {},
        blockReasons: [`auto_publish_error: ${(e as Error).message.slice(0, 200)}`],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }).catch(() => null)
    }
  }

  await db.update(publishPlan).set({
    socialPostIds: postIds,
    status: input.scheduledAt ? 'scheduled' : 'draft',
  }).where(eq(publishPlan.id, planId))

  return { ok: postIds.length > 0, planId, postIds }
}

/**
 * Draft 3 platform-tuned caption variants. Rules-based; later swappable
 * for LLM polish. Output is what feeds the bandit.
 */
async function draftCaptionsFor(title: string, brief: string, platform: string): Promise<string[]> {
  const headline = title.slice(0, 80)
  const firstLine = brief.split(/[.\n]/)[0]?.slice(0, 140) ?? ''
  const tags = {
    youtube:   '\n\nSubscribe for more.',
    tiktok:    '\n\n#fyp #foryou',
    instagram: '\n\n.\n.\n.\n#reels',
    x:         '',
  }[platform] ?? ''

  return [
    `${headline}${tags}`,
    `${firstLine}${tags}`,
    `${headline}\n\n${firstLine}${tags}`,
  ].map(c => c.slice(0, platform === 'x' ? 280 : 2200))
}

/**
 * After a PAI run publishes, mint a R163 repurpose pack from the
 * source brief so the same content lands as 7 platform variants.
 */
export async function autoRepurposeFromRun(workspaceId: string, runId: string): Promise<{ ok: boolean; packId?: string; variantCount?: number; error?: string }> {
  const [run] = await db.select().from(videoPaiRun)
    .where(and(eq(videoPaiRun.workspaceId, workspaceId), eq(videoPaiRun.id, runId))).limit(1)
  if (!run) return { ok: false, error: 'run not found' }
  const [isa] = await db.select().from(videoIsa)
    .where(and(eq(videoIsa.workspaceId, workspaceId), eq(videoIsa.id, run.isaId))).limit(1)
  if (!isa) return { ok: false, error: 'isa not found' }

  const { repurposeCreate } = await import('./r163-volume-engines.js')
  const sourceBody = isa.brief.length >= 80 ? isa.brief : `${isa.title}. ${isa.brief}. More on this soon.`
  const r = await repurposeCreate(workspaceId, {
    sourceBody, title: isa.title, sourceKind: 'video_transcript', sourceRef: `pai_run:${runId}`,
  })
  await db.update(publishPlan).set({ repurposePackId: r.packId }).where(eq(publishPlan.runId, runId)).catch(() => null)
  return { ok: true, packId: r.packId, variantCount: r.variantCount }
}

/**
 * Convenience: run publish + repurpose in one call. Used by R160 PAI's
 * post-done hook when ISA target.autoPublish === true.
 */
export async function publishAndRepurpose(workspaceId: string, runId: string, opts: { platforms?: string[]; scheduledAt?: number } = {}): Promise<{ ok: boolean; planId?: string; packId?: string; error?: string }> {
  const pub = await publishFromRun(workspaceId, { runId, ...(opts.platforms ? { platforms: opts.platforms } : {}), ...(opts.scheduledAt ? { scheduledAt: opts.scheduledAt } : {}) })
  if (!pub.ok) return { ok: false, ...(pub.error ? { error: pub.error } : {}) }
  const rep = await autoRepurposeFromRun(workspaceId, runId)
  return { ok: true, ...(pub.planId ? { planId: pub.planId } : {}), ...(rep.packId ? { packId: rep.packId } : {}) }
}

export async function publishPlanList(workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<typeof publishPlan.$inferSelect>> {
  const filters = [eq(publishPlan.workspaceId, workspaceId)]
  if (opts.status) filters.push(eq(publishPlan.status, opts.status))
  return db.select().from(publishPlan).where(and(...filters)).orderBy(desc(publishPlan.createdAt)).limit(Math.min(opts.limit ?? 30, 200))
}

void sql
