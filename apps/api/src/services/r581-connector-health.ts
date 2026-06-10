/**
 * R581 — Unified connector health registry.
 *
 * Operator goal: every connector visible in one place with last-success
 * timestamps + auth status. Today connector status is fragmented across
 * R506 platform_sessions, R509 image_provider_health, ad-hoc env-var
 * presence checks. R581 unifies into a single connector_health table that
 * any connector can write to + a single dashboard surface that reads it.
 *
 * Schema:
 *   connector_health(connector_id, workspace_id, business_id NULL,
 *                    last_ok_at, last_fail_at, consecutive_fails,
 *                    last_error, configured, kind)
 *
 * connector_id is the canonical id (e.g. 'gumroad', 'tiktok_shop',
 * 'postmark', 'replicate', 'redbubble'). Each connector module is
 * responsible for calling recordConnectorOk/recordConnectorFail when it
 * tries something. Reads aggregate into operator-friendly status.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS connector_health (
      connector_id      TEXT NOT NULL,
      workspace_id      TEXT NOT NULL,
      business_id       TEXT,                       -- NULL = workspace-level
      kind              TEXT NOT NULL,              -- 'pod_platform'|'payment'|'email'|'image_gen'|'storage'|'analytics'
      configured        BOOLEAN NOT NULL DEFAULT false,
      last_ok_at        BIGINT,
      last_fail_at      BIGINT,
      consecutive_fails INT NOT NULL DEFAULT 0,
      last_error        TEXT,
      updated_at        BIGINT NOT NULL,
      PRIMARY KEY (connector_id, workspace_id, COALESCE(business_id, ''))
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS connector_health_ws_idx ON connector_health (workspace_id, kind, updated_at DESC)`).catch(() => {})
}

export interface ConnectorHealth {
  connectorId:       string
  workspaceId:       string
  businessId:        string | null
  kind:              string
  configured:        boolean
  lastOkAt:          number | null
  lastFailAt:        number | null
  consecutiveFails:  number
  lastError:         string | null
  updatedAt:         number
}

const KNOWN_CONNECTORS: Array<{ id: string; kind: string; envChecks: string[] }> = [
  // POD platforms
  { id: 'gumroad',          kind: 'pod_platform', envChecks: ['GUMROAD_WEBHOOK_TOKEN'] },
  { id: 'tiktok_shop',      kind: 'pod_platform', envChecks: ['TIKTOK_WEBHOOK_TOKEN'] },
  { id: 'inprnt',           kind: 'pod_platform', envChecks: [] },
  { id: 'fine_art_america', kind: 'pod_platform', envChecks: [] },
  { id: 'redbubble',        kind: 'pod_platform', envChecks: [] },
  { id: 'etsy',             kind: 'pod_platform', envChecks: ['ETSY_API_KEY'] },
  { id: 'zazzle',           kind: 'pod_platform', envChecks: [] },
  { id: 'spreadshirt',      kind: 'pod_platform', envChecks: [] },
  { id: 'teepublic',        kind: 'pod_platform', envChecks: [] },
  { id: 'displate',         kind: 'pod_platform', envChecks: [] },
  { id: 'threadless',       kind: 'pod_platform', envChecks: [] },
  { id: 'printful',         kind: 'pod_platform', envChecks: ['PRINTFUL_API_KEY'] },
  // Image-gen providers
  { id: 'replicate',        kind: 'image_gen',    envChecks: ['REPLICATE_API_TOKEN'] },
  { id: 'fal',              kind: 'image_gen',    envChecks: ['FAL_KEY', 'FAL_API_KEY'] },
  { id: 'openai',           kind: 'image_gen',    envChecks: ['OPENAI_API_KEY'] },
  { id: 'stability',        kind: 'image_gen',    envChecks: ['STABILITY_API_KEY'] },
  { id: 'huggingface',      kind: 'image_gen',    envChecks: ['HF_TOKEN'] },
  { id: 'cloudflare_ai',    kind: 'image_gen',    envChecks: ['CF_API_TOKEN'] },
  // Email
  { id: 'postmark',         kind: 'email',        envChecks: ['POSTMARK_SERVER_TOKEN'] },
  // Storage
  { id: 'offsite_s3',       kind: 'storage',      envChecks: ['NOVAN_OFFSITE_S3_ENDPOINT', 'NOVAN_OFFSITE_S3_ACCESS_KEY'] },
  // Push
  { id: 'web_push_vapid',   kind: 'analytics',    envChecks: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] },
]

function isConfiguredViaEnv(connectorId: string): boolean {
  const k = KNOWN_CONNECTORS.find(c => c.id === connectorId)
  if (!k || k.envChecks.length === 0) return false
  // ALL listed env vars must be present (use OR list by allowing alt names — fal has two)
  for (const envKey of k.envChecks) {
    if (process.env[envKey]) return true
  }
  return false
}

export async function recordConnectorOk(workspaceId: string, connectorId: string, businessId?: string | null): Promise<void> {
  await ensureTable()
  const meta = KNOWN_CONNECTORS.find(c => c.id === connectorId)
  const kind = meta?.kind ?? 'unknown'
  const configured = isConfiguredViaEnv(connectorId)
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO connector_health (connector_id, workspace_id, business_id, kind, configured, last_ok_at, consecutive_fails, updated_at)
    VALUES (${connectorId}, ${workspaceId}, ${businessId ?? null}, ${kind}, ${configured}, ${now}, 0, ${now})
    ON CONFLICT (connector_id, workspace_id, COALESCE(business_id, '')) DO UPDATE SET
      last_ok_at        = EXCLUDED.last_ok_at,
      consecutive_fails = 0,
      last_error        = NULL,
      configured        = EXCLUDED.configured,
      updated_at        = EXCLUDED.updated_at
  `).catch(() => {/* tolerated */})
}

export async function recordConnectorFail(workspaceId: string, connectorId: string, errorMessage: string, businessId?: string | null): Promise<void> {
  await ensureTable()
  const meta = KNOWN_CONNECTORS.find(c => c.id === connectorId)
  const kind = meta?.kind ?? 'unknown'
  const configured = isConfiguredViaEnv(connectorId)
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO connector_health (connector_id, workspace_id, business_id, kind, configured, last_fail_at, consecutive_fails, last_error, updated_at)
    VALUES (${connectorId}, ${workspaceId}, ${businessId ?? null}, ${kind}, ${configured}, ${now}, 1, ${errorMessage.slice(0, 500)}, ${now})
    ON CONFLICT (connector_id, workspace_id, COALESCE(business_id, '')) DO UPDATE SET
      last_fail_at      = EXCLUDED.last_fail_at,
      consecutive_fails = connector_health.consecutive_fails + 1,
      last_error        = EXCLUDED.last_error,
      configured        = EXCLUDED.configured,
      updated_at        = EXCLUDED.updated_at
  `).catch(() => {/* tolerated */})
}

export async function connectorRegistry(workspaceId: string): Promise<Array<ConnectorHealth & { knownConnector: boolean }>> {
  await ensureTable()
  let observed: ConnectorHealth[] = []
  try {
    const r = await db.execute(sql`
      SELECT connector_id, workspace_id, business_id, kind, configured,
             last_ok_at, last_fail_at, consecutive_fails, last_error, updated_at
      FROM connector_health WHERE workspace_id = ${workspaceId}
      ORDER BY consecutive_fails DESC, COALESCE(last_ok_at, 0) DESC
    `)
    observed = (r as unknown as Array<{
      connector_id: string; workspace_id: string; business_id: string | null;
      kind: string; configured: boolean;
      last_ok_at: number | null; last_fail_at: number | null;
      consecutive_fails: number; last_error: string | null; updated_at: number;
    }>).map(x => ({
      connectorId: x.connector_id, workspaceId: x.workspace_id, businessId: x.business_id,
      kind: x.kind, configured: x.configured,
      lastOkAt: x.last_ok_at === null ? null : Number(x.last_ok_at),
      lastFailAt: x.last_fail_at === null ? null : Number(x.last_fail_at),
      consecutiveFails: Number(x.consecutive_fails),
      lastError: x.last_error,
      updatedAt: Number(x.updated_at),
    }))
  } catch { /* fall through */ }
  const observedIds = new Set(observed.map(o => o.connectorId))
  // Synthesize untouched known connectors as "configured-but-never-used"
  const out: Array<ConnectorHealth & { knownConnector: boolean }> = observed.map(o => ({ ...o, knownConnector: KNOWN_CONNECTORS.some(k => k.id === o.connectorId) }))
  for (const k of KNOWN_CONNECTORS) {
    if (observedIds.has(k.id)) continue
    out.push({
      connectorId: k.id, workspaceId, businessId: null,
      kind: k.kind, configured: isConfiguredViaEnv(k.id),
      lastOkAt: null, lastFailAt: null, consecutiveFails: 0,
      lastError: null, updatedAt: 0, knownConnector: true,
    })
  }
  return out
}

export async function connectorSummary(workspaceId: string): Promise<{
  total: number;
  configured: number;
  healthy: number;
  unhealthy: number;
  byKind: Record<string, { total: number; healthy: number }>;
}> {
  const reg = await connectorRegistry(workspaceId)
  const byKind: Record<string, { total: number; healthy: number }> = {}
  let configured = 0, healthy = 0, unhealthy = 0
  for (const c of reg) {
    if (c.configured) configured++
    const isHealthy = c.consecutiveFails === 0 && (c.lastOkAt ?? 0) > 0
    if (isHealthy) healthy++
    else if (c.consecutiveFails > 0) unhealthy++
    byKind[c.kind] = byKind[c.kind] ?? { total: 0, healthy: 0 }
    byKind[c.kind]!.total++
    if (isHealthy) byKind[c.kind]!.healthy++
  }
  return { total: reg.length, configured, healthy, unhealthy, byKind }
}
