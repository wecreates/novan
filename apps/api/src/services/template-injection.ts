/**
 * template-injection.ts — Reads the workspace's applied business
 * template (R121 BO14) and biases chat context with the template's
 * suggested playbooks + revenue target.
 *
 * Called from `novan-chat.ts` alongside the existing
 * `composeReferenceBlock`. Result is a small prefix block (≤ 800
 * tokens) that nudges the model toward sector-appropriate guidance
 * before the generic playbook reference is appended.
 *
 * No-op when no template has been applied (older workspaces that
 * pre-date R121 just get the legacy generic chat injection).
 */

const TEMPLATE_CACHE = new Map<string, { block: string; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60_000

/** Resolve which template was applied + return a compact injection block. */
export async function templateInjectionBlock(workspaceId: string): Promise<string> {
  if (!workspaceId) return ''
  const cached = TEMPLATE_CACHE.get(workspaceId)
  if (cached && cached.expiresAt > Date.now()) return cached.block

  let templateKey = ''
  let targetMonthly = 10_000
  let suggestedPlaybooks: string[] = []
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { and, eq, desc } = await import('drizzle-orm')
    const rows = await db.select({ payload: events.payload })
      .from(events)
      .where(and(
        eq(events.workspaceId, workspaceId),
        eq(events.type, 'workspace.template_applied'),
      ))
      .orderBy(desc(events.createdAt))
      .limit(1)
      .catch(() => [])
    if (rows.length === 0) {
      TEMPLATE_CACHE.set(workspaceId, { block: '', expiresAt: Date.now() + CACHE_TTL_MS })
      return ''
    }
    const p = rows[0]!.payload as {
      templateKey?: string; targetMonthlyUsd?: number; suggestedPlaybooks?: string[]
    }
    templateKey = p.templateKey ?? ''
    targetMonthly = Number(p.targetMonthlyUsd) || 10_000
    suggestedPlaybooks = Array.isArray(p.suggestedPlaybooks) ? p.suggestedPlaybooks : []
  } catch { return '' }

  if (!templateKey) {
    TEMPLATE_CACHE.set(workspaceId, { block: '', expiresAt: Date.now() + CACHE_TTL_MS })
    return ''
  }

  const lines = [
    `[workspace template: ${templateKey} — revenue target $${targetMonthly.toLocaleString()}/mo per the $10k floor]`,
  ]
  if (suggestedPlaybooks.length > 0) {
    lines.push(`Prioritized playbooks for this sector: ${suggestedPlaybooks.join(', ')}.`)
  }
  lines.push('Bias guidance toward this sector when applicable; defer to operator-stated intent when it diverges.')
  const block = lines.join('\n')

  TEMPLATE_CACHE.set(workspaceId, { block, expiresAt: Date.now() + CACHE_TTL_MS })
  return block
}

/** Test-only: clear cache. */
export function _clearTemplateInjectionCache(): void {
  TEMPLATE_CACHE.clear()
}
