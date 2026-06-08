/**
 * R146.334 — Brand DBA Propagator (closes brand.dba_propagation gap from R333)
 *
 * Source of truth: workspace_memory.brand.dba.primary (locked at importance
 * 97 during R332, value = "CYZOR CREATIONS").
 *
 * On any change to the DBA, fan out to every connected platform's brand
 * fields. Privacy-gated — never touches public address fields, only name-
 * like fields where the DBA legitimately belongs.
 *
 * Connected surfaces (read from connector_credentials):
 *   - tiktok_shop:  shop name, brand display name
 *   - printful:     store name (per-store)
 *   - inprnt:       artist name
 *   - shopify:      shop name (when applicable)
 *
 * For each platform: this function returns a plan of fields-to-update;
 * the platform-specific browser-driver or API client executes. Idempotent.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { ok, blocked, blockedByCapability, type StructuredOutcome } from './r334-honest-blocker-reporter.js'

export interface PropagationPlanItem {
  platform:        string
  field:           string
  currentValue?:   string
  proposedValue:   string
  changeNeeded:    boolean
  reason:          string
}

export interface PropagationPlan {
  dba:             string
  workspaceId:     string
  totalItems:      number
  changesNeeded:   number
  items:           PropagationPlanItem[]
}

const BRAND_FIELDS_BY_PLATFORM: Record<string, string[]> = {
  tiktok_shop: ['shop_display_name', 'brand_name'],
  printful:    ['store_name'],                                  // per-store
  inprnt:      ['artist_name', 'shop_handle'],
  shopify:     ['shop_name'],
  etsy:        ['shop_name'],
  amazon:      ['display_name'],
  ebay:        ['store_name'],
}

export async function loadCurrentDba(workspaceId: string): Promise<string | null> {
  try {
    const rows = await db.execute(sql`
      SELECT value FROM workspace_memory
      WHERE workspace_id = ${workspaceId} AND key = 'brand.dba.primary'
      LIMIT 1
    `) as unknown as Array<{ value: string }>
    if (rows[0]) {
      // Extract just the DBA name from the rich memory text
      const m = rows[0].value.match(/^([A-Z][A-Z0-9 &.\-']+?)\s+—/)
      return m?.[1] ?? rows[0].value.slice(0, 60)
    }
    return null
  } catch {
    return null
  }
}

async function loadConnectedPlatforms(workspaceId: string): Promise<string[]> {
  try {
    const rows = await db.execute(sql`
      SELECT DISTINCT connector_id FROM connector_credentials
      WHERE workspace_id = ${workspaceId} AND status = 'active'
    `) as unknown as Array<{ connector_id: string }>
    return rows.map(r => r.connector_id)
  } catch {
    return []
  }
}

export async function planPropagation(workspaceId: string): Promise<StructuredOutcome<PropagationPlan>> {
  const dba = await loadCurrentDba(workspaceId)
  if (!dba) {
    return blocked({
      blockerClass:           'evidence_insufficient',
      reason:                 'No brand.dba.primary memory found for workspace',
      evidence:               `workspace=${workspaceId}, query=workspace_memory.brand.dba.primary`,
      suggestedUnblockAction: 'Set DBA via: INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at) VALUES (...) — see R332 example',
    })
  }

  const platforms = await loadConnectedPlatforms(workspaceId)
  if (platforms.length === 0) {
    return ok({
      dba, workspaceId, totalItems: 0, changesNeeded: 0, items: [],
    }, 'No connected platforms — nothing to propagate.')
  }

  const items: PropagationPlanItem[] = []
  for (const platform of platforms) {
    const fields = BRAND_FIELDS_BY_PLATFORM[platform]
    if (!fields) continue
    for (const field of fields) {
      // Without browser-driver execution we can't know current values yet —
      // mark all as changeNeeded:true and let the executor verify-then-update.
      items.push({
        platform,
        field,
        proposedValue: dba,
        changeNeeded:  true,
        reason:        `${platform}.${field} should match brand.dba.primary`,
      })
    }
  }

  return ok({
    dba, workspaceId,
    totalItems: items.length,
    changesNeeded: items.filter(i => i.changeNeeded).length,
    items,
  }, `Planned ${items.length} propagation targets across ${platforms.length} connected platforms.`)
}

/**
 * Execute is gated behind capability.platform.tiktok_shop_onboard etc. —
 * we have the plan + safety gate but the per-platform browser-driver executors
 * are still partial. Returns a blocked outcome that names what's missing.
 */
export async function executePropagation(workspaceId: string): Promise<StructuredOutcome<unknown>> {
  const plan = await planPropagation(workspaceId)
  if (plan.blocked) return plan
  if (!plan.ok) return plan
  return blockedByCapability(
    'platform.tiktok_shop_onboard',
    `Plan generated (${plan.data.totalItems} field updates across ${plan.data.items.length} platforms) — ` +
    `executor requires browser-driver per platform. Plan: ${JSON.stringify(plan.data.items.slice(0, 3))}...`,
  )
}
