/**
 * R184 — Physical bridges: Home Assistant + Workshop fab + Wearable biometrics.
 *
 * Home Assistant: POST /api/services/{domain}/{service} via long-lived token.
 * OctoPrint: /api/files/local/{path} → /api/job (start/cancel/status).
 * Bambu Lab: same OctoPrint-like shape via Bambu cloud API.
 * Tesla: official Fleet API for vehicle commands (climate, lock; no purchases).
 * Biometric: webhook ingestion + brain ops to insert manually.
 *
 * Token is stored in secrets_vault; revealed only at action time with audit.
 */
import { db } from '../db/client.js'
import {
  physicalEndpoint, physicalActionLog, biometricEvent,
} from '../db/schema.js'
import { and, eq, desc, sql, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const SUPPORTED_KINDS = ['home_assistant', 'octoprint', 'bambu', 'linuxcnc', 'tesla'] as const

export interface EndpointInput {
  kind:    typeof SUPPORTED_KINDS[number]
  label:   string
  baseUrl: string
  token?:  string                       // long-lived access token
  metadata?: Record<string, unknown>
}

export async function endpointRegister(workspaceId: string, input: EndpointInput): Promise<{ id: string }> {
  if (!(SUPPORTED_KINDS as readonly string[]).includes(input.kind)) throw new Error('unsupported physical kind')
  if (!input.label || !input.baseUrl) throw new Error('label + baseUrl required')
  let vaultSecretId: string | null = null
  if (input.token) {
    const { storeSecret } = await import('./secrets-vault.js')
    vaultSecretId = await storeSecret({
      workspaceId, name: `physical_token:${input.kind}:${input.label}`,
      provider: input.kind, value: input.token, createdBy: 'r184-physical',
    } as Parameters<typeof storeSecret>[0])
  }
  const id = uuidv7()
  await db.insert(physicalEndpoint).values({
    id, workspaceId,
    kind: input.kind, label: input.label.slice(0, 200),
    baseUrl: input.baseUrl.replace(/\/$/, ''),
    ...(vaultSecretId ? { vaultSecretId } : {}),
    metadata: input.metadata ?? {},
    status: 'active', createdAt: Date.now(),
  })
  return { id }
}

export async function endpointList(workspaceId: string, opts: { kind?: string } = {}): Promise<Array<Omit<typeof physicalEndpoint.$inferSelect, 'vaultSecretId'>>> {
  const filters = [eq(physicalEndpoint.workspaceId, workspaceId), eq(physicalEndpoint.status, 'active')]
  if (opts.kind) filters.push(eq(physicalEndpoint.kind, opts.kind))
  const rows = await db.select().from(physicalEndpoint).where(and(...filters)).orderBy(desc(physicalEndpoint.createdAt))
  return rows.map(r => { const { vaultSecretId: _v, ...rest } = r; void _v; return rest })
}

async function tokenOf(endpoint: typeof physicalEndpoint.$inferSelect, reason: string): Promise<string | null> {
  if (!endpoint.vaultSecretId) return null
  const { revealSecret } = await import('./secrets-vault.js')
  return revealSecret(endpoint.vaultSecretId, 'system:r184-physical', reason)
}

async function logAction(workspaceId: string, endpointId: string, kind: string, payload: Record<string, unknown>, fn: () => Promise<{ result: Record<string, unknown>; success: boolean }>): Promise<{ logId: string; success: boolean; result: Record<string, unknown>; error?: string }> {
  const logId = uuidv7()
  const startedAt = Date.now()
  await db.insert(physicalActionLog).values({ id: logId, workspaceId, endpointId, kind, payload, startedAt })
  try {
    const r = await fn()
    await db.update(physicalActionLog).set({ result: r.result, success: r.success, endedAt: Date.now() }).where(eq(physicalActionLog.id, logId))
    return { logId, success: r.success, result: r.result }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400)
    await db.update(physicalActionLog).set({ error: msg, endedAt: Date.now() }).where(eq(physicalActionLog.id, logId))
    return { logId, success: false, result: {}, error: msg }
  }
}

// ─── Home Assistant ──────────────────────────────────────────────────

export async function homeCallService(workspaceId: string, opts: { endpointId: string; domain: string; service: string; data?: Record<string, unknown> }): Promise<{ logId: string; success: boolean; result: Record<string, unknown>; error?: string }> {
  const [ep] = await db.select().from(physicalEndpoint)
    .where(and(eq(physicalEndpoint.workspaceId, workspaceId), eq(physicalEndpoint.id, opts.endpointId), eq(physicalEndpoint.kind, 'home_assistant'))).limit(1)
  if (!ep) return { logId: '', success: false, result: {}, error: 'endpoint not found' }
  return logAction(workspaceId, ep.id, `home.${opts.domain}.${opts.service}`, opts.data ?? {}, async () => {
    const token = await tokenOf(ep, `home_assistant call ${opts.domain}.${opts.service}`)
    if (!token) throw new Error('no token in vault')
    const res = await fetch(`${ep.baseUrl}/api/services/${encodeURIComponent(opts.domain)}/${encodeURIComponent(opts.service)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.data ?? {}),
    })
    const result = await res.json().catch(() => ({})) as Record<string, unknown>
    return { result, success: res.ok }
  })
}

export async function homeState(workspaceId: string, opts: { endpointId: string; entityId?: string }): Promise<{ ok: boolean; state?: unknown; error?: string }> {
  const [ep] = await db.select().from(physicalEndpoint)
    .where(and(eq(physicalEndpoint.workspaceId, workspaceId), eq(physicalEndpoint.id, opts.endpointId), eq(physicalEndpoint.kind, 'home_assistant'))).limit(1)
  if (!ep) return { ok: false, error: 'endpoint not found' }
  const token = await tokenOf(ep, 'home_assistant state read')
  if (!token) return { ok: false, error: 'no token' }
  const url = opts.entityId
    ? `${ep.baseUrl}/api/states/${encodeURIComponent(opts.entityId)}`
    : `${ep.baseUrl}/api/states`
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } })
  if (!res.ok) return { ok: false, error: `http_${res.status}` }
  await db.update(physicalEndpoint).set({ lastSeenAt: Date.now() }).where(eq(physicalEndpoint.id, ep.id))
  return { ok: true, state: await res.json() }
}

// ─── OctoPrint / Bambu ───────────────────────────────────────────────

export async function printStart(workspaceId: string, opts: { endpointId: string; filePath: string }): Promise<{ logId: string; success: boolean; result: Record<string, unknown>; error?: string }> {
  const [ep] = await db.select().from(physicalEndpoint)
    .where(and(eq(physicalEndpoint.workspaceId, workspaceId), eq(physicalEndpoint.id, opts.endpointId), sql`${physicalEndpoint.kind} IN ('octoprint','bambu')`)).limit(1)
  if (!ep) return { logId: '', success: false, result: {}, error: 'endpoint not found' }
  return logAction(workspaceId, ep.id, 'print.start', { filePath: opts.filePath }, async () => {
    const token = await tokenOf(ep, `start print job ${opts.filePath}`)
    if (!token) throw new Error('no token in vault')
    // OctoPrint: POST /api/files/local/{filename} { command: 'select', print: true }
    const url = ep.kind === 'octoprint'
      ? `${ep.baseUrl}/api/files/local/${encodeURIComponent(opts.filePath)}`
      : `${ep.baseUrl}/api/v1/print/start`
    const res = await fetch(url, {
      method: 'POST',
      headers: ep.kind === 'octoprint'
        ? { 'X-Api-Key': token, 'Content-Type': 'application/json' }
        : { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(ep.kind === 'octoprint' ? { command: 'select', print: true } : { file: opts.filePath }),
    })
    const result = await res.json().catch(() => ({})) as Record<string, unknown>
    return { result, success: res.ok }
  })
}

export async function printStatus(workspaceId: string, endpointId: string): Promise<{ ok: boolean; status?: unknown; error?: string }> {
  const [ep] = await db.select().from(physicalEndpoint)
    .where(and(eq(physicalEndpoint.workspaceId, workspaceId), eq(physicalEndpoint.id, endpointId), sql`${physicalEndpoint.kind} IN ('octoprint','bambu')`)).limit(1)
  if (!ep) return { ok: false, error: 'endpoint not found' }
  const token = await tokenOf(ep, 'print job status read')
  if (!token) return { ok: false, error: 'no token' }
  const url = ep.kind === 'octoprint' ? `${ep.baseUrl}/api/job` : `${ep.baseUrl}/api/v1/print/status`
  const res = await fetch(url, { headers: ep.kind === 'octoprint' ? { 'X-Api-Key': token } : { 'Authorization': `Bearer ${token}` } })
  if (!res.ok) return { ok: false, error: `http_${res.status}` }
  await db.update(physicalEndpoint).set({ lastSeenAt: Date.now() }).where(eq(physicalEndpoint.id, ep.id))
  return { ok: true, status: await res.json() }
}

export async function printCancel(workspaceId: string, endpointId: string): Promise<{ logId: string; success: boolean; result: Record<string, unknown>; error?: string }> {
  const [ep] = await db.select().from(physicalEndpoint)
    .where(and(eq(physicalEndpoint.workspaceId, workspaceId), eq(physicalEndpoint.id, endpointId), sql`${physicalEndpoint.kind} IN ('octoprint','bambu')`)).limit(1)
  if (!ep) return { logId: '', success: false, result: {}, error: 'endpoint not found' }
  return logAction(workspaceId, ep.id, 'print.cancel', {}, async () => {
    const token = await tokenOf(ep, 'cancel print job')
    if (!token) throw new Error('no token')
    const url = ep.kind === 'octoprint' ? `${ep.baseUrl}/api/job` : `${ep.baseUrl}/api/v1/print/cancel`
    const res = await fetch(url, {
      method: 'POST',
      headers: ep.kind === 'octoprint' ? { 'X-Api-Key': token, 'Content-Type': 'application/json' } : { 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(ep.kind === 'octoprint' ? { command: 'cancel' } : {}),
    })
    return { result: { status: res.status }, success: res.ok }
  })
}

// ─── Biometrics ──────────────────────────────────────────────────────

const VALID_BIO_KINDS = ['steps', 'heart_rate', 'hrv', 'sleep', 'workout', 'stress', 'spo2', 'temp', 'weight', 'calories', 'distance'] as const
const VALID_BIO_SOURCES = ['apple_health', 'garmin', 'fitbit', 'whoop', 'oura', 'manual'] as const

export interface BioIngestInput {
  source:     typeof VALID_BIO_SOURCES[number]
  kind:       typeof VALID_BIO_KINDS[number]
  value:      Record<string, unknown>
  unit?:      string
  recordedAt?: number
  userId?:    string
}

export async function bioIngest(workspaceId: string, input: BioIngestInput | BioIngestInput[]): Promise<{ inserted: number }> {
  const arr = Array.isArray(input) ? input : [input]
  const now = Date.now()
  let inserted = 0
  for (const e of arr) {
    if (!(VALID_BIO_KINDS as readonly string[]).includes(e.kind)) continue
    if (!(VALID_BIO_SOURCES as readonly string[]).includes(e.source)) continue
    await db.insert(biometricEvent).values({
      id: uuidv7(), workspaceId,
      ...(e.userId ? { userId: e.userId } : {}),
      source: e.source, kind: e.kind, value: e.value,
      ...(e.unit ? { unit: e.unit } : {}),
      recordedAt: e.recordedAt ?? now, createdAt: now,
    })
    inserted += 1
  }
  return { inserted }
}

export async function bioList(workspaceId: string, opts: { kind?: string; source?: string; sinceDays?: number; limit?: number } = {}): Promise<Array<typeof biometricEvent.$inferSelect>> {
  const since = Date.now() - (opts.sinceDays ?? 30) * 86_400_000
  const filters = [eq(biometricEvent.workspaceId, workspaceId), gte(biometricEvent.recordedAt, since)]
  if (opts.kind)   filters.push(eq(biometricEvent.kind, opts.kind))
  if (opts.source) filters.push(eq(biometricEvent.source, opts.source))
  return db.select().from(biometricEvent).where(and(...filters)).orderBy(desc(biometricEvent.recordedAt)).limit(Math.min(opts.limit ?? 100, 1000))
}

export async function bioSummary(workspaceId: string, opts: { kind: string; sinceDays?: number } = { kind: 'heart_rate' }): Promise<{ kind: string; n: number; avg: number | null; min: number | null; max: number | null }> {
  const since = Date.now() - (opts.sinceDays ?? 7) * 86_400_000
  const rows = await db.select().from(biometricEvent)
    .where(and(eq(biometricEvent.workspaceId, workspaceId), eq(biometricEvent.kind, opts.kind), gte(biometricEvent.recordedAt, since)))
    .limit(5000)
  if (rows.length === 0) return { kind: opts.kind, n: 0, avg: null, min: null, max: null }
  const nums: number[] = []
  for (const r of rows) {
    const v = (r.value as { value?: number; bpm?: number; count?: number; minutes?: number })
    const n = v.value ?? v.bpm ?? v.count ?? v.minutes
    if (typeof n === 'number') nums.push(n)
  }
  if (nums.length === 0) return { kind: opts.kind, n: rows.length, avg: null, min: null, max: null }
  return {
    kind: opts.kind, n: rows.length,
    avg: nums.reduce((a, b) => a + b, 0) / nums.length,
    min: Math.min(...nums), max: Math.max(...nums),
  }
}
