/**
 * R185 — Tier B Jarvis-gap features (compact data layer + APIs):
 *
 *   FRIDAY-style companion — lighter sibling AI persona for offline/quick tasks
 *   Predictive multi-modal scan — classify any incoming signal
 *   Tactical Monte-Carlo sim — "what if I pause X" scenario analysis
 *   AR/XR portal — saved A-Frame/WebXR scenes served at /xr/:ws/:scene
 *   Vehicle telematics — Tesla/Geotab read-only via R184 endpoint kind=tesla
 */
import { db } from '../db/client.js'
import {
  companionSession, signalClassification, tacticalSimRun, xrScene,
  podStore, podProduct, managedAccount, customerScore, businessPrompts,
  physicalEndpoint,
} from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Companion AI ────────────────────────────────────────────────────

export interface CompanionInput { name: string; basePersona?: 'friday_like' | 'jarvis_like' | 'novan'; modelTier?: 'light' | 'balanced' }

export async function companionCreate(workspaceId: string, input: CompanionInput): Promise<{ id: string; personaId: string }> {
  if (!input.name) throw new Error('name required')
  const { personaUpsert } = await import('./r182-voice-layer.js')
  const persona = await personaUpsert(workspaceId, { name: input.name, preset: input.basePersona ?? 'friday_like' })
  const id = uuidv7()
  await db.insert(companionSession).values({
    id, workspaceId,
    name: input.name.slice(0, 80),
    personaId: persona.id,
    modelTier: input.modelTier ?? 'light',
    status: 'active', createdAt: Date.now(),
  }).onConflictDoUpdate({
    target: [companionSession.workspaceId, companionSession.name],
    set: { personaId: persona.id, modelTier: input.modelTier ?? 'light', status: 'active' },
  })
  return { id, personaId: persona.id }
}

export async function companionList(workspaceId: string): Promise<Array<typeof companionSession.$inferSelect>> {
  return db.select().from(companionSession)
    .where(and(eq(companionSession.workspaceId, workspaceId), eq(companionSession.status, 'active')))
    .orderBy(desc(companionSession.createdAt))
}

// ─── Predictive multi-modal signal scan ──────────────────────────────

const PHISH_RX = /(urgent|verify|password|click here|update your|account suspended|gift card|wire transfer|bitcoin address|hacked|locked out)/i
const SPAM_RX  = /(make money fast|buy followers|seo expert|10x your|guaranteed roi|crypto signals|investment opportunity|dm me now|increase sales)/i
const URGENT_RX = /(asap|deadline|emergency|production down|breach|breaking|urgent reply|by EOD|by today)/i
const OPPORTUNITY_RX = /(partnership|sponsorship|collab|brand deal|paid promo|press inquiry|interview|feature|whitelist|invest)/i

export interface ClassifyInput { source: 'email' | 'dm' | 'comment' | 'call' | 'sms'; content: string; externalRef?: string }

export async function signalClassify(workspaceId: string, input: ClassifyInput): Promise<{ id: string; kind: string; score: number; evidence: Record<string, unknown> }> {
  if (!input.content) throw new Error('content required')
  const c = input.content
  const evidence: Record<string, unknown> = {}
  let kind = 'normal'
  let score = 0

  // Stack ranking — first strong match wins, ties broken by score.
  const phishHits  = (c.match(PHISH_RX) ?? []).length + (/.+@.+\..+/.test(c) ? 0 : 0)
  const spamHits   = (c.match(SPAM_RX) ?? []).length
  const urgentHits = (c.match(URGENT_RX) ?? []).length
  const oppHits    = (c.match(OPPORTUNITY_RX) ?? []).length
  const cleanLen   = c.replace(/\s+/g, ' ').length
  const linkCount  = (c.match(/https?:\/\//gi) ?? []).length
  const allCaps    = c.split(/\s+/).filter(w => w.length >= 4 && w === w.toUpperCase()).length

  evidence['phishHits'] = phishHits
  evidence['spamHits'] = spamHits
  evidence['urgentHits'] = urgentHits
  evidence['opportunityHits'] = oppHits
  evidence['linkCount'] = linkCount
  evidence['allCapsWords'] = allCaps

  // Phish: links + phish words + suspicious capping
  if (phishHits >= 2 || (phishHits >= 1 && linkCount >= 1) || (linkCount >= 2 && allCaps >= 2)) {
    kind = 'phish'
    score = Math.min(0.95, 0.4 + phishHits * 0.15 + linkCount * 0.1)
  } else if (spamHits >= 2 || (spamHits >= 1 && linkCount >= 1 && cleanLen < 200)) {
    kind = 'spam'
    score = Math.min(0.9, 0.3 + spamHits * 0.15)
  } else if (oppHits >= 2 || (oppHits >= 1 && cleanLen >= 100)) {
    kind = 'opportunity'
    score = Math.min(0.85, 0.4 + oppHits * 0.15)
  } else if (urgentHits >= 1) {
    kind = 'urgent'
    score = Math.min(0.8, 0.3 + urgentHits * 0.2)
  }

  const id = uuidv7()
  await db.insert(signalClassification).values({
    id, workspaceId,
    source: input.source,
    ...(input.externalRef ? { externalRef: input.externalRef } : {}),
    contentExcerpt: c.slice(0, 600),
    kind, score, evidence, classifiedAt: Date.now(),
  })
  return { id, kind, score, evidence }
}

export async function signalList(workspaceId: string, opts: { kind?: string; limit?: number } = {}): Promise<Array<typeof signalClassification.$inferSelect>> {
  const filters = [eq(signalClassification.workspaceId, workspaceId)]
  if (opts.kind) filters.push(eq(signalClassification.kind, opts.kind))
  return db.select().from(signalClassification).where(and(...filters)).orderBy(desc(signalClassification.classifiedAt)).limit(Math.min(opts.limit ?? 50, 500))
}

// ─── Tactical Monte-Carlo simulation ─────────────────────────────────

interface ScenarioInput {
  scenario:      string                          // free-form label
  assumptions:   Record<string, number>          // e.g. { posts_per_day: 5, conversion: 0.025, aov_cents: 2500 }
  trials?:       number
  variance?:     Record<string, number>          // per-key stddev (defaults to 30% of mean)
  durationDays?: number
}

function gaussian(mean: number, std: number): number {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export async function tacticalSim(workspaceId: string, input: ScenarioInput): Promise<{ id: string; scenario: string; p10: number; p50: number; p90: number; mean: number; trials: number }> {
  if (!input.scenario || !input.assumptions) throw new Error('scenario + assumptions required')
  const N = Math.max(100, Math.min(input.trials ?? 1000, 10_000))
  const days = Math.max(1, input.durationDays ?? 30)
  const results: number[] = []

  for (let i = 0; i < N; i++) {
    let dayRev = 0
    for (const [k, mean] of Object.entries(input.assumptions)) {
      const std = (input.variance?.[k]) ?? Math.abs(mean) * 0.3
      const sample = Math.max(0, gaussian(mean, std))
      dayRev = dayRev === 0 ? sample : dayRev * sample
    }
    results.push(dayRev * days)
  }
  results.sort((a, b) => a - b)
  const p = (q: number) => results[Math.min(results.length - 1, Math.floor(q * results.length))] ?? 0
  const mean = results.reduce((a, b) => a + b, 0) / results.length

  const id = uuidv7()
  await db.insert(tacticalSimRun).values({
    id, workspaceId,
    scenario: input.scenario.slice(0, 200),
    assumptions: input.assumptions,
    trials: N,
    results: { p10: p(0.1), p50: p(0.5), p90: p(0.9), mean, durationDays: days },
    ranAt: Date.now(),
  })
  return { id, scenario: input.scenario, p10: p(0.1), p50: p(0.5), p90: p(0.9), mean, trials: N }
}

/**
 * Convenience: build a scenario from CURRENT portfolio metrics for a
 * "what-if" comparison (e.g., what if I pause this account).
 */
export async function tacticalWhatIf(workspaceId: string, opts: { scenarioLabel: string; pauseAccountId?: string; durationDays?: number }): Promise<{ id: string; baselineP50: number; scenarioP50: number; deltaP50: number; trials: number }> {
  const accts = await db.select().from(managedAccount)
    .where(and(eq(managedAccount.workspaceId, workspaceId), eq(managedAccount.status, 'active')))
  const baselineAssumptions: Record<string, number> = {
    posts_per_day: accts.length * 3,
    sessions_per_post: 25,
    purchase_rate: 0.022,
    aov_cents: 2500,
  }
  const days = opts.durationDays ?? 30
  const base = await tacticalSim(workspaceId, { scenario: `${opts.scenarioLabel} (baseline)`, assumptions: baselineAssumptions, durationDays: days })
  const scenarioAssumptions = { ...baselineAssumptions }
  if (opts.pauseAccountId) scenarioAssumptions['posts_per_day'] = Math.max(0, scenarioAssumptions['posts_per_day']! - 3)
  const sim = await tacticalSim(workspaceId, { scenario: opts.scenarioLabel, assumptions: scenarioAssumptions, durationDays: days })
  return {
    id: sim.id,
    baselineP50: base.p50,
    scenarioP50: sim.p50,
    deltaP50: sim.p50 - base.p50,
    trials: sim.trials,
  }
}

// ─── XR scene store ─────────────────────────────────────────────────

export interface XrSceneInput { name: string; sceneJson: Record<string, unknown>; arEnabled?: boolean; vrEnabled?: boolean }

export async function xrSceneSave(workspaceId: string, input: XrSceneInput): Promise<{ id: string }> {
  if (!input.name) throw new Error('name required')
  const now = Date.now()
  const id = uuidv7()
  await db.insert(xrScene).values({
    id, workspaceId,
    name: input.name.slice(0, 100),
    sceneJson: input.sceneJson,
    arEnabled: input.arEnabled ?? true,
    vrEnabled: input.vrEnabled ?? true,
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [xrScene.workspaceId, xrScene.name],
    set: { sceneJson: input.sceneJson, arEnabled: input.arEnabled ?? true, vrEnabled: input.vrEnabled ?? true, updatedAt: now },
  })
  const [r] = await db.select({ id: xrScene.id }).from(xrScene)
    .where(and(eq(xrScene.workspaceId, workspaceId), eq(xrScene.name, input.name))).limit(1)
  return { id: r?.id ?? id }
}

export async function xrSceneGet(workspaceId: string, name: string): Promise<typeof xrScene.$inferSelect | null> {
  const [r] = await db.select().from(xrScene)
    .where(and(eq(xrScene.workspaceId, workspaceId), eq(xrScene.name, name))).limit(1)
  return r ?? null
}

/**
 * Serve a saved scene as an A-Frame HTML page that works in WebXR
 * (Quest 3 / Vision Pro / desktop browsers). The scene_json is rendered
 * as <a-entity> children with attributes mapped 1:1.
 */
export function renderXrHtml(scene: typeof xrScene.$inferSelect): string {
  const entities = (scene.sceneJson as { entities?: Array<Record<string, string>> }).entities ?? []
  const entityHtml = entities.map(e => {
    const tag = e['_tag'] ?? 'a-entity'
    const attrs = Object.entries(e).filter(([k]) => k !== '_tag').map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ')
    return `<${tag} ${attrs}></${tag}>`
  }).join('\n')
  const arBtn = scene.arEnabled ? 'ar-mode-ui: enabled: true' : ''
  const vrBtn = scene.vrEnabled ? '' : 'vr-mode-ui="enabled: false"'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${scene.name}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://aframe.io/releases/1.5.0/aframe.min.js"></script>
</head><body style="margin:0">
<a-scene background="color: #050510" ${vrBtn} ${arBtn}>
<a-entity light="type: ambient; intensity: 0.6"></a-entity>
<a-entity light="type: directional; intensity: 0.9" position="2 4 1"></a-entity>
<a-entity camera look-controls wasd-controls position="0 1.6 3"></a-entity>
${entityHtml}
</a-scene></body></html>`
}

/**
 * Auto-build a scene from current portfolio state — used for default /xr/:ws/dashboard.
 */
export async function xrAutoDashboard(workspaceId: string): Promise<typeof xrScene.$inferSelect> {
  const stores = await db.select({ brandName: podStore.brandName }).from(podStore)
    .where(and(eq(podStore.workspaceId, workspaceId), eq(podStore.status, 'active'))).limit(8)
  const [revRow] = await db.select({ rev: sql<number>`coalesce(sum(${podProduct.revenueCents}), 0)::int` })
    .from(podProduct).where(eq(podProduct.workspaceId, workspaceId))
  const [whales] = await db.select({ n: sql<number>`count(*)::int` })
    .from(customerScore).where(and(eq(customerScore.workspaceId, workspaceId), sql`${customerScore.decile} >= 9`))

  const entities: Array<Record<string, string>> = [
    { _tag: 'a-text', value: `Novan Portfolio`, position: '0 3 -3', align: 'center', color: '#fff', width: '8' },
    { _tag: 'a-text', value: `$${((revRow?.rev ?? 0) / 100).toFixed(0)} total revenue`, position: '0 2.4 -3', align: 'center', color: '#9af', width: '6' },
    { _tag: 'a-text', value: `${Number(whales?.n ?? 0)} whales · ${stores.length} stores`, position: '0 2 -3', align: 'center', color: '#fa9', width: '5' },
  ]
  stores.forEach((s, i) => {
    const angle = (i / Math.max(stores.length, 1)) * Math.PI * 2
    const x = Math.cos(angle) * 2, z = Math.sin(angle) * 2 - 3
    entities.push({ _tag: 'a-box', position: `${x.toFixed(2)} 1 ${z.toFixed(2)}`, color: '#3b82f6', width: '0.4', height: '0.4', depth: '0.4' })
    entities.push({ _tag: 'a-text', value: s.brandName.slice(0, 16), position: `${x.toFixed(2)} 1.5 ${z.toFixed(2)}`, align: 'center', color: '#fff', width: '3' })
  })

  const saved = await xrSceneSave(workspaceId, { name: 'dashboard', sceneJson: { entities }, arEnabled: true, vrEnabled: true })
  void saved
  return (await xrSceneGet(workspaceId, 'dashboard'))!
}

// ─── Vehicle telematics ──────────────────────────────────────────────

export async function vehicleStatus(workspaceId: string, endpointId: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const [ep] = await db.select().from(physicalEndpoint)
    .where(and(eq(physicalEndpoint.workspaceId, workspaceId), eq(physicalEndpoint.id, endpointId), eq(physicalEndpoint.kind, 'tesla'))).limit(1)
  if (!ep) return { ok: false, error: 'tesla endpoint not found' }
  if (!ep.vaultSecretId) return { ok: false, error: 'no token' }
  const { revealSecret } = await import('./secrets-vault.js')
  const token = await revealSecret(ep.vaultSecretId, 'system:r185-vehicle', 'read vehicle status')
  if (!token) return { ok: false, error: 'token unavailable' }
  const vehicleId = (ep.metadata as { vehicleId?: string })?.vehicleId
  if (!vehicleId) return { ok: false, error: 'metadata.vehicleId required' }
  try {
    const res = await fetch(`${ep.baseUrl}/api/1/vehicles/${encodeURIComponent(vehicleId)}/vehicle_data`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!res.ok) return { ok: false, error: `http_${res.status}` }
    return { ok: true, data: await res.json() }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

void businessPrompts
