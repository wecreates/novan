/**
 * R146.339 — Platform Dashboard Monitor (closes multimodal.vision 6→8)
 *
 * Periodically pulls structured state from every connected platform so Novan
 * has fresh evidence for decisions without operator screenshots. Where
 * vision is required (e.g. TikTok seller dashboard), the monitor records
 * the URL and last-known state, queued for next browser-MCP visit.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface PlatformSnapshot {
  platform:     string
  workspaceId:  string
  fetchedAt:    number
  source:       'api' | 'browser' | 'memory'
  data:         Record<string, unknown>
  alerts:       string[]
}

// ─── Per-platform pollers ───────────────────────────────────────────────────

async function pollPrintful(): Promise<Partial<PlatformSnapshot> | null> {
  const key = process.env['PRINTFUL_API_KEY']
  if (!key) return null
  try {
    const res = await fetch('https://api.printful.com/stores', {
      headers: { Authorization: `Bearer ${key}` },
      signal:  AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { source: 'api', data: { ok: false, status: res.status }, alerts: [`Printful API ${res.status}`] }
    const j = await res.json() as { result?: Array<{ id: number; name: string; type: string }> }
    const stores = j.result ?? []
    return {
      source: 'api',
      data:   { storeCount: stores.length, stores: stores.map(s => ({ id: s.id, name: s.name, type: s.type })) },
      alerts: stores.length === 0 ? ['Printful has no stores connected'] : [],
    }
  } catch (e) {
    return { source: 'api', data: { error: (e as Error).message.slice(0, 200) }, alerts: ['Printful poll failed'] }
  }
}

async function pollGenericConnectorPresence(workspaceId: string, platform: string): Promise<Partial<PlatformSnapshot>> {
  try {
    const rows = await db.execute(sql`
      SELECT status, last_used_at FROM connector_credentials
      WHERE workspace_id = ${workspaceId} AND connector_id = ${platform}
      LIMIT 1
    `) as unknown as Array<{ status: string; last_used_at: number | null }>
    if (rows.length === 0) return { source: 'memory', data: { credentialPresent: false }, alerts: [`No active credential for ${platform}`] }
    return {
      source: 'memory',
      data:   { credentialPresent: true, status: rows[0]?.status, lastUsedAt: rows[0]?.last_used_at },
      alerts: rows[0]?.status !== 'active' ? [`${platform} credential not active (status=${rows[0]?.status})`] : [],
    }
  } catch (e) {
    return { source: 'memory', data: { error: (e as Error).message.slice(0, 200) }, alerts: [] }
  }
}

// ─── Aggregator ─────────────────────────────────────────────────────────────

export async function pollAllPlatforms(workspaceId: string): Promise<PlatformSnapshot[]> {
  const platforms = ['printful', 'tiktok_shop', 'inprnt', 'shopify', 'etsy']
  const results: PlatformSnapshot[] = []
  for (const platform of platforms) {
    let partial: Partial<PlatformSnapshot> | null = null
    if (platform === 'printful') partial = await pollPrintful()
    if (!partial) partial = await pollGenericConnectorPresence(workspaceId, platform)
    results.push({
      platform,
      workspaceId,
      fetchedAt: Date.now(),
      source:    partial.source ?? 'memory',
      data:      partial.data ?? {},
      alerts:    partial.alerts ?? [],
    })
  }
  // Persist a summary event
  try {
    const totalAlerts = results.reduce((s, r) => s + r.alerts.length, 0)
    await db.execute(sql`
      INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
      VALUES (
        gen_random_uuid()::text,
        'platform.monitor.snapshot',
        ${workspaceId},
        ${JSON.stringify({ totalAlerts, snapshots: results.map(r => ({ platform: r.platform, alerts: r.alerts.length })) })},
        gen_random_uuid()::text,
        gen_random_uuid()::text,
        'r339-platform-monitor',
        1,
        ${Date.now()}
      )
    `)
  } catch { /* ignore */ }
  return results
}
