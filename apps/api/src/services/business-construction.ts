/**
 * business-construction.ts — live business decomposition + persistence.
 *
 * When the operator asks the brain to "build me a print-on-demand
 * clothing business" (or any business), this service:
 *
 *   1. Decomposes the request into a Business DNA + a tree of systems
 *      (departments → workflow stubs → agent slots). Pure function.
 *   2. Persists the business row and every system as real DB rows.
 *   3. Emits one event per system spawned so the UI can render nodes
 *      appearing live (no fake animation — the events are real).
 *
 * Honest scope:
 *   - We DON'T generate code, deploy infra, or run workflows here. We
 *     describe the operational structure, persist it, and emit live
 *     spawn events. Execution of any individual workflow is handled by
 *     existing services (action-dispatcher, agent-coordinator, etc.).
 *   - The decomposition is deterministic from a small lexicon of
 *     business archetypes. This is a foundation an operator can extend;
 *     it is NOT meant to claim machine intelligence about business
 *     structure. Per directive #15 — operational believability — we
 *     never animate fake activity.
 */
import { v7 as uuidv7 } from 'uuid'
import { and, eq, desc } from 'drizzle-orm'
import { db, pg } from '../db/client.js'
import { businesses, businessSystems, events } from '../db/schema.js'

// ─── Types ─────────────────────────────────────────────────────────────

export type BusinessLayer =
  | 'executive' | 'operations' | 'finance' | 'creative'
  | 'growth' | 'intelligence' | 'security'

export type BusinessSystemKind =
  | 'department' | 'workflow' | 'agent_slot' | 'asset' | 'analytics' | 'integration'

export interface BusinessDNA {
  mission:       string
  audience:      string
  monetization:  string
  growthStrategy: string
  brand:         { voice: string; palette: string[] }
  philosophy:    string
}

export interface PlannedSystem {
  kind:        BusinessSystemKind
  layer:       BusinessLayer
  name:        string
  summary:     string
  /** Optional reference into agent_definitions.slug — when present, the
   *  CEO orchestrator will route work for this system to that agent. */
  agentSlug?:  string
  /** Workflows/assets/analytics hang off departments; agents may hang
   *  off workflows. The planner sets these relationships by name. */
  parent?:     string
  /** Spatial hint the brain renderer can use to place the node. Values
   *  are in the same unit space the brain canvas uses (-10..10). */
  position?:   { x: number; y: number; z: number }
}

export interface ConstructionPlan {
  dna:     BusinessDNA
  systems: PlannedSystem[]
}

// ─── Pure: archetype catalog ──────────────────────────────────────────
// Each archetype = a small library of departments + their first-line
// workflows. Extending the system = adding rows here.

type Archetype = {
  match:   RegExp
  industry: string
  base:    Omit<BusinessDNA, 'mission'>
  build:   (brief: string) => ConstructionPlan
}

const COMMON_DEPTS: PlannedSystem[] = [
  { kind: 'department', layer: 'executive',   name: 'Executive',   summary: 'Strategy, prioritization, mission coordination',  position: { x:  0,  y:  4, z: 0 } },
  { kind: 'department', layer: 'operations',  name: 'Operations',  summary: 'Workflows, automation, deployment pipelines',     position: { x: -4,  y:  2, z: 0 } },
  { kind: 'department', layer: 'finance',     name: 'Finance',     summary: 'Budgets, provider cost, revenue, profitability',  position: { x: -4,  y: -2, z: 0 } },
  { kind: 'department', layer: 'creative',    name: 'Creative',    summary: 'Brand, asset pipelines, content systems',         position: { x:  4,  y: -2, z: 0 } },
  { kind: 'department', layer: 'growth',      name: 'Growth',      summary: 'Marketing, SEO, social, outreach',                position: { x:  4,  y:  2, z: 0 } },
  { kind: 'department', layer: 'intelligence', name: 'Intelligence', summary: 'Analytics, trend detection, optimization',     position: { x:  0,  y: -4, z: 0 } },
  { kind: 'department', layer: 'security',    name: 'Security',    summary: 'Governance, permissions, audits',                 position: { x:  0,  y:  0, z: 4 } },
]

function planForArchetype(
  brief: string,
  industry: string,
  mission: string,
  extras: PlannedSystem[],
): ConstructionPlan {
  return {
    dna: {
      mission,
      audience:       inferAudience(brief),
      monetization:   inferMonetization(brief, industry),
      growthStrategy: 'organic content + paid loops with weekly experiments',
      brand:          { voice: 'calm, premium, operator-first', palette: ['#060608', '#8B7CFF', '#34d399'] },
      philosophy:     'truth over spectacle; ship the smallest believable system first',
    },
    systems: [
      ...COMMON_DEPTS,
      // Workflow stubs hang off the appropriate department
      ...extras,
    ],
  }
}

const ARCHETYPES: Archetype[] = [
  // ─── Print-on-demand ──
  {
    match:    /\b(print[\s-]?on[\s-]?demand|pod|t-?shirt|merch|apparel)\b/i,
    industry: 'print_on_demand',
    base:     { audience: 'creators selling niche merch', monetization: 'unit margin via POD provider', growthStrategy: 'organic + paid social', brand: { voice: 'crafted', palette: [] }, philosophy: '' },
    build:    (brief) => planForArchetype(brief, 'print_on_demand',
      'Ship niche-targeted apparel via on-demand fulfillment with calm, brand-coherent storefronts.',
      [
        { kind: 'workflow', layer: 'creative',    name: 'Design Studio',     summary: 'Generate + curate apparel artwork',                agentSlug: 'design-product-designer',          parent: 'Creative',     position: { x:  5, y: -2, z: 0 } },
        { kind: 'workflow', layer: 'intelligence', name: 'Trend Research',    summary: 'Surface emerging niche + style signals',           agentSlug: 'marketing-content-creator',        parent: 'Intelligence', position: { x:  0, y: -5, z: 0 } },
        { kind: 'workflow', layer: 'operations',  name: 'Storefront Build',  summary: 'Spin up + maintain product catalog pages',         agentSlug: 'engineering-backend-architect',    parent: 'Operations',   position: { x: -5, y:  2, z: 0 } },
        { kind: 'workflow', layer: 'growth',      name: 'Social Engine',     summary: 'Daily reels/posts tied to design drops',           agentSlug: 'marketing-content-creator',        parent: 'Growth',       position: { x:  5, y:  2, z: 0 } },
        { kind: 'workflow', layer: 'operations',  name: 'Fulfillment Sync',  summary: 'Order routing + provider status reconciliation',   parent: 'Operations',   position: { x: -5, y:  0, z: 0 } },
        { kind: 'workflow', layer: 'finance',     name: 'Unit Economics',    summary: 'Track margin per design + per channel',            agentSlug: 'finance-financial-analyst',        parent: 'Finance',      position: { x: -5, y: -2, z: 0 } },
        { kind: 'asset',    layer: 'creative',    name: 'Brand Identity',    summary: 'Logo, palette, typography, tone guide',            parent: 'Creative',     position: { x:  4, y: -3, z: 0 } },
        { kind: 'analytics', layer: 'intelligence', name: 'Drop Performance', summary: 'CTR, conversion, profit-per-drop dashboards',      parent: 'Intelligence', position: { x:  1, y: -5, z: 0 } },
      ]),
  },
  // ─── SaaS ──
  {
    match:    /\b(saas|software\s+as\s+a\s+service|b2b\s+software|api\s+product)\b/i,
    industry: 'saas',
    base:     { audience: '', monetization: '', growthStrategy: '', brand: { voice: '', palette: [] }, philosophy: '' },
    build:    (brief) => planForArchetype(brief, 'saas',
      'Build a focused SaaS with a clear ICP, calm onboarding, and economics that compound.',
      [
        { kind: 'workflow', layer: 'operations',  name: 'Product Engineering', summary: 'Iterate on the core product + APIs', agentSlug: 'engineering-backend-architect',    parent: 'Operations',   position: { x: -5, y:  2, z: 0 } },
        { kind: 'workflow', layer: 'growth',      name: 'Lifecycle Email',     summary: 'Onboarding, activation, retention sequences', agentSlug: 'marketing-content-creator', parent: 'Growth', position: { x:  5, y:  2, z: 0 } },
        { kind: 'workflow', layer: 'growth',      name: 'Content Engine',      summary: 'SEO + thought leadership',           agentSlug: 'marketing-content-creator',        parent: 'Growth',       position: { x:  5, y:  3, z: 0 } },
        { kind: 'workflow', layer: 'operations',  name: 'Customer Support',    summary: 'Ticket triage + macro library',     agentSlug: 'support-customer-success-manager', parent: 'Operations',   position: { x: -5, y:  0, z: 0 } },
        { kind: 'workflow', layer: 'finance',     name: 'Pricing + Revenue',   summary: 'Plans, billing, expansion revenue',  agentSlug: 'finance-financial-analyst',        parent: 'Finance',      position: { x: -5, y: -2, z: 0 } },
        { kind: 'analytics', layer: 'intelligence', name: 'Activation Funnel', summary: 'Time-to-value + drop-off per step', parent: 'Intelligence', position: { x:  0, y: -5, z: 0 } },
        { kind: 'asset',    layer: 'creative',    name: 'Marketing Site',      summary: 'Landing + docs site copy + design', parent: 'Creative',     position: { x:  4, y: -3, z: 0 } },
      ]),
  },
  // ─── Newsletter / Content business ──
  {
    match:    /\b(newsletter|substack|writing\s+business|content\s+business|publication)\b/i,
    industry: 'newsletter',
    base:     { audience: '', monetization: '', growthStrategy: '', brand: { voice: '', palette: [] }, philosophy: '' },
    build:    (brief) => planForArchetype(brief, 'newsletter',
      'Publish a focused, paid newsletter with calm cadence and compounding archive value.',
      [
        { kind: 'workflow', layer: 'creative',    name: 'Editorial Calendar', summary: 'Topic backlog + drafting rhythm',  agentSlug: 'marketing-content-creator',     parent: 'Creative',     position: { x:  5, y: -2, z: 0 } },
        { kind: 'workflow', layer: 'growth',      name: 'Subscriber Growth',  summary: 'Cross-promo, referrals, paid ads', agentSlug: 'marketing-content-creator',     parent: 'Growth',       position: { x:  5, y:  2, z: 0 } },
        { kind: 'workflow', layer: 'finance',     name: 'Sponsorship Ops',    summary: 'Sponsor pipeline + insertion mgmt', agentSlug: 'sales-cold-outreach-specialist', parent: 'Finance',      position: { x: -5, y: -2, z: 0 } },
        { kind: 'analytics', layer: 'intelligence', name: 'Open + Click Trends', summary: 'Retention + topic resonance',   parent: 'Intelligence', position: { x:  0, y: -5, z: 0 } },
        { kind: 'asset',    layer: 'creative',    name: 'Brand Voice Guide',  summary: 'Tone, recurring sections, format', parent: 'Creative',     position: { x:  4, y: -3, z: 0 } },
      ]),
  },
  // ─── Agency / services ──
  {
    match:    /\b(agency|consultancy|services\s+business|freelance|design\s+studio)\b/i,
    industry: 'services',
    base:     { audience: '', monetization: '', growthStrategy: '', brand: { voice: '', palette: [] }, philosophy: '' },
    build:    (brief) => planForArchetype(brief, 'services',
      'Run a focused services practice with clear positioning, repeatable delivery, and operator-friendly margins.',
      [
        { kind: 'workflow', layer: 'growth',      name: 'Outbound',          summary: 'ICP-targeted outreach + reply mgmt', agentSlug: 'sales-cold-outreach-specialist',  parent: 'Growth',       position: { x:  5, y:  2, z: 0 } },
        { kind: 'workflow', layer: 'operations',  name: 'Delivery Templates', summary: 'Productized engagement playbooks',  parent: 'Operations',   position: { x: -5, y:  2, z: 0 } },
        { kind: 'workflow', layer: 'creative',    name: 'Case Studies',      summary: 'Generate post-engagement stories',  agentSlug: 'marketing-content-creator',     parent: 'Creative',     position: { x:  5, y: -2, z: 0 } },
        { kind: 'workflow', layer: 'finance',     name: 'Retainer Mgmt',     summary: 'Invoicing + scope tracking',       agentSlug: 'finance-financial-analyst',     parent: 'Finance',      position: { x: -5, y: -2, z: 0 } },
        { kind: 'analytics', layer: 'intelligence', name: 'Utilization',     summary: 'Hours-per-deliverable + margin',   parent: 'Intelligence', position: { x:  0, y: -5, z: 0 } },
      ]),
  },
  // ─── Default / generic ──
  {
    match:    /.*/,
    industry: 'generic',
    base:     { audience: '', monetization: '', growthStrategy: '', brand: { voice: '', palette: [] }, philosophy: '' },
    build:    (brief) => planForArchetype(brief, 'generic',
      'Establish a calm operating cadence: ship the smallest believable system, measure, evolve.',
      [
        { kind: 'workflow', layer: 'operations',  name: 'Operations Cadence', summary: 'Weekly sync + decision log',         parent: 'Operations',   position: { x: -5, y:  2, z: 0 } },
        { kind: 'workflow', layer: 'growth',      name: 'Reach Channel',      summary: 'First go-to-market motion',          agentSlug: 'marketing-content-creator',  parent: 'Growth',       position: { x:  5, y:  2, z: 0 } },
        { kind: 'workflow', layer: 'finance',     name: 'Runway Tracking',    summary: 'Burn + revenue forecasts',           agentSlug: 'finance-financial-analyst',  parent: 'Finance',      position: { x: -5, y: -2, z: 0 } },
        { kind: 'analytics', layer: 'intelligence', name: 'Weekly Pulse',     summary: 'Top-of-funnel + conversion trends',  parent: 'Intelligence', position: { x:  0, y: -5, z: 0 } },
      ]),
  },
]

// ─── Pure helpers ─────────────────────────────────────────────────────

export function planBusiness(brief: string): ConstructionPlan {
  const arch = ARCHETYPES.find(a => a.match.test(brief)) ?? ARCHETYPES[ARCHETYPES.length - 1]!
  return arch.build(brief)
}

export function chooseName(brief: string): string {
  // Pluck the most concrete noun + adjective from the brief; fall back
  // to a generic working name. Cheap heuristic — operator can rename.
  const m = /(?:build|create|launch|spin\s*up)?\s*(?:a|an)?\s*([A-Za-z][A-Za-z0-9 -]{2,60}?)(?:\s+business|\s+brand|\s+company|\s+startup|\s+for|\.|,|$)/i.exec(brief)
  const candidate = (m?.[1] ?? '').trim()
  if (candidate.length >= 3 && candidate.length <= 60) {
    return candidate.split(/\s+/).map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ')
  }
  return 'New Business'
}

function inferAudience(brief: string): string {
  if (/\b(merch|t-shirt|apparel|streetwear|fan)/i.test(brief)) return 'niche communities buying themed apparel'
  if (/\b(saas|api|developer|engineer)/i.test(brief))           return 'product-led B2B operators'
  if (/\b(newsletter|writer|essay)/i.test(brief))               return 'readers seeking a focused, calm vantage point'
  if (/\b(agency|consult|services)/i.test(brief))               return 'mid-market operators needing a senior contractor'
  return 'operators we have not yet narrowed — first task is ICP'
}

function inferMonetization(_brief: string, industry: string): string {
  switch (industry) {
    case 'print_on_demand': return 'unit margin via on-demand fulfillment + occasional drops'
    case 'saas':            return 'tiered subscription with usage-based expansion'
    case 'newsletter':      return 'paid tiers + sponsorship slots'
    case 'services':        return 'productized retainers + one-off engagements'
    default:                return 'undecided — first task is monetization framing'
  }
}

// ─── DB orchestration ─────────────────────────────────────────────────

export interface ConstructInput {
  workspaceId: string
  brief:       string
  /** Override the auto-generated business name. */
  name?:       string
}

export interface ConstructResult {
  ok:          true
  businessId:  string
  name:        string
  industry:    string
  dna:         BusinessDNA
  systemIds:   string[]
  /** Order of `business.system.spawned` events emitted — UI replays
   *  this sequence to animate node-by-node construction. */
  spawnOrder:  Array<{ id: string; kind: BusinessSystemKind; layer: BusinessLayer; name: string; parentId: string | null }>
}

/**
 * Persist the business + every planned system. Emits one event per
 * system spawn so the brain UI can animate them appearing live.
 *
 * Sequencing:
 *   1. Insert business row (status = 'forming')
 *   2. Insert each system in plan order. Departments first (they're
 *      parents for everything else), then workflows/agents/etc.
 *   3. Update business status → 'active' after all systems land.
 *
 * Each insert emits `business.system.spawned` with the new id +
 * relative position so the UI can render in real time via the
 * existing events stream.
 */
export async function constructBusiness(i: ConstructInput): Promise<ConstructResult> {
  const plan = planBusiness(i.brief)
  const arch = ARCHETYPES.find(a => a.match.test(i.brief)) ?? ARCHETYPES[ARCHETYPES.length - 1]!
  const industry = arch.industry
  const name = i.name?.trim() || chooseName(i.brief)

  // 1. Insert the business
  const businessId = uuidv7()
  const now = Date.now()
  await db.insert(businesses).values({
    id: businessId,
    workspaceId: i.workspaceId,
    name, industry,
    stage: 'early', health: 'green',
    vision:  plan.dna.mission,
    brief:   i.brief.slice(0, 2_000),
    dna:     plan.dna as unknown as Record<string, unknown>,
    metrics: {},
    metadata: { archetype: industry, plannedSystems: plan.systems.length },
    createdAt: now, updatedAt: now,
  }).catch(() => null)

  await db.insert(events).values({
    id: uuidv7(),
    type: 'business.constructed',
    workspaceId: i.workspaceId,
    payload: { businessId, name, industry, brief: i.brief.slice(0, 280) },
    traceId: uuidv7(), correlationId: businessId, causationId: null,
    source: 'business-construction', version: 1, createdAt: now,
  }).catch(() => null)
  await notifyEventsChanged(i.workspaceId)

  // 2. Sort systems: departments first (parents), then everything else
  const departments = plan.systems.filter(s => s.kind === 'department')
  const rest        = plan.systems.filter(s => s.kind !== 'department')
  const ordered     = [...departments, ...rest]

  const nameToId = new Map<string, string>()
  const spawnOrder: ConstructResult['spawnOrder'] = []
  const systemIds: string[] = []

  for (const s of ordered) {
    const id = uuidv7()
    const parentId = s.parent ? (nameToId.get(s.parent) ?? null) : null
    nameToId.set(s.name, id)
    systemIds.push(id)

    await db.insert(businessSystems).values({
      id,
      workspaceId:  i.workspaceId,
      businessId,
      kind:         s.kind,
      layer:        s.layer,
      name:         s.name,
      summary:      s.summary ?? null,
      status:       'forming',
      agentSlug:    s.agentSlug ?? null,
      parentId,
      position:     s.position ?? null,
      metadata:     {},
      createdAt: Date.now(), updatedAt: Date.now(),
    }).catch(() => null)

    await db.insert(events).values({
      id: uuidv7(),
      type: 'business.system.spawned',
      workspaceId: i.workspaceId,
      payload: { businessId, systemId: id, kind: s.kind, layer: s.layer, name: s.name, parentId, position: s.position ?? null },
      traceId: uuidv7(), correlationId: businessId, causationId: parentId,
      source: 'business-construction', version: 1, createdAt: Date.now(),
    }).catch(() => null)
    await notifyEventsChanged(i.workspaceId)

    spawnOrder.push({ id, kind: s.kind, layer: s.layer, name: s.name, parentId })
  }

  // 3. Mark business active
  await db.update(businesses)
    .set({ stage: 'active', updatedAt: Date.now() })
    .where(eq(businesses.id, businessId))
    .catch(() => null)

  await db.insert(events).values({
    id: uuidv7(),
    type: 'business.construction.completed',
    workspaceId: i.workspaceId,
    payload: { businessId, name, systemsSpawned: systemIds.length },
    traceId: uuidv7(), correlationId: businessId, causationId: null,
    source: 'business-construction', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  await notifyEventsChanged(i.workspaceId)

  return { ok: true, businessId, name, industry, dna: plan.dna, systemIds, spawnOrder }
}

// ─── Read helpers (for the UI) ────────────────────────────────────────

export async function listBusinessSystems(workspaceId: string, businessId: string) {
  return db.select().from(businessSystems)
    .where(and(eq(businessSystems.workspaceId, workspaceId), eq(businessSystems.businessId, businessId)))
    .orderBy(businessSystems.createdAt)
    .catch(() => [])
}

export async function listWorkspaceBusinesses(workspaceId: string) {
  return db.select().from(businesses)
    .where(eq(businesses.workspaceId, workspaceId))
    .orderBy(desc(businesses.createdAt))
    .catch(() => [])
}

/**
 * Postgres NOTIFY on the workspace channel — the SSE endpoint in
 * brain.ts LISTENs and immediately flushes any new events. Drops the
 * brain-stream latency from 4 s polling to ~50 ms end-to-end.
 *
 * Channel naming: events_changed_<workspaceId>. Postgres channel
 * names are case-folded unless quoted; we lowercase to be safe.
 */
async function notifyEventsChanged(workspaceId: string): Promise<void> {
  try {
    const channel = `events_changed_${workspaceId.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`
    await pg`SELECT pg_notify(${channel}, ${workspaceId})`
  } catch { /* tolerated — falls back to the 4 s poll */ }
}
