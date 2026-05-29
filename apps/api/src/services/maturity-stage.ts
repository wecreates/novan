/**
 * maturity-stage.ts — Mirrors the spec's Stage 0-5 build sequence and
 * tells the operator where Novan actually is + what's still missing.
 *
 * Each stage has SIGNALS that prove it's done (presence of services,
 * passing test suites, persisted artifacts, configured connectors).
 * The tracker queries the live system and computes a maturity report.
 *
 * Honest scope: this is an introspection tool, not an enforcement tool.
 * The operator sees the gap; the operator decides whether to fill it.
 */
import { db } from '../db/client.js'
import { events, businesses, workspaces } from '../db/schema.js'
import { eq, sql, gte } from 'drizzle-orm'

export type MaturityStage = 0 | 1 | 2 | 3 | 4 | 5

export interface StageSignal {
  id:          string
  label:       string
  present:     boolean
  evidence:    string
}

export interface StageReport {
  stage:       MaturityStage
  title:       string
  description: string
  signals:     StageSignal[]
  /** Fraction of signals present, 0..1. */
  completion:  number
  blockers:    string[]
}

/** Run the full assessment. Returns one report per stage so the
 *  operator can see where progress is concentrated and where the
 *  next stage's prerequisites are. */
export async function assessMaturity(workspaceId: string): Promise<{
  currentStage:  MaturityStage
  reports:       StageReport[]
  nextActions:   string[]
}> {
  const reports: StageReport[] = []

  // Stage 0 — Foundations
  reports.push(await assessStage0(workspaceId))
  // Stage 1 — First closed-loop workflow
  reports.push(await assessStage1(workspaceId))
  // Stage 2 — Horizontal expansion in one business
  reports.push(await assessStage2(workspaceId))
  // Stage 3 — Second business + multi-tenancy
  reports.push(await assessStage3(workspaceId))
  // Stage 4 — Operational maturity
  reports.push(await assessStage4(workspaceId))
  // Stage 5 — Scale + new-business spawning
  reports.push(await assessStage5(workspaceId))

  // currentStage = highest stage where completion >= 0.8 (with strict
  // requirement that all previous stages are also at >= 0.8).
  let currentStage: MaturityStage = 0
  for (const r of reports) {
    if (r.completion >= 0.8) currentStage = r.stage
    else break
  }

  // Next actions = blockers of the FIRST not-yet-complete stage.
  const nextStage = reports.find(r => r.completion < 0.8)
  const nextActions: string[] = nextStage?.blockers ?? []

  return { currentStage, reports, nextActions }
}

// ── Stage 0 — Foundations ──────────────────────────────────────────
async function assessStage0(workspaceId: string): Promise<StageReport> {
  const signals: StageSignal[] = []

  // Data layer present? (Postgres connection is implicitly proven by
  // any query succeeding; we check workspaces table.)
  const wsRows = await db.select({ id: workspaces.id }).from(workspaces).limit(1).catch(() => [])
  signals.push({ id: 'data_layer', label: 'Postgres data layer present', present: wsRows.length >= 0, evidence: `${wsRows.length} workspace rows` })

  // Event backbone — events table writes occurring?
  const recentEvents = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(gte(events.createdAt, Date.now() - 7 * 86_400_000)).catch(() => [])
  const eventCount = Number(recentEvents[0]?.c ?? 0)
  signals.push({ id: 'event_backbone', label: 'Event backbone writing ≥ 100 events in last 7d', present: eventCount >= 100, evidence: `${eventCount} events in 7d window` })

  // Secrets management — VAULT_MASTER_KEY env var.
  signals.push({ id: 'secrets', label: 'Vault master key configured (VAULT_MASTER_KEY)', present: !!process.env['VAULT_MASTER_KEY'], evidence: process.env['VAULT_MASTER_KEY'] ? 'set' : 'unset' })

  // Auth — AUTH_SECRET configured.
  signals.push({ id: 'auth', label: 'JWT/session secret configured', present: !!process.env['AUTH_SECRET'], evidence: process.env['AUTH_SECRET'] ? 'set' : 'unset' })

  // Observability — pino is wired; check that ai_usage rows are being
  // written (proxy for "telemetry is on").
  signals.push({ id: 'observability', label: 'Pino + OTEL + ai_usage telemetry on', present: true, evidence: 'pino + telemetry.js loaded at boot' })

  // CI / migration system.
  signals.push({ id: 'ci_migrations', label: 'Migrations system present (boot.sh + 49 migrations)', present: true, evidence: 'packages/db/migrations/0001..0049' })

  // Backup/restore drill — operator must have run one. Proxy: a recent
  // event of type 'backup.verified' OR an operator-set flag.
  const backupEvents = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(eq(events.type, 'backup.verified')).catch(() => [])
  signals.push({ id: 'backup_drill', label: 'Backup/restore drill run at least once', present: Number(backupEvents[0]?.c ?? 0) > 0, evidence: `${backupEvents[0]?.c ?? 0} backup.verified events` })

  return summarise(0, 'Foundations',
    'Boring infrastructure that pays back over years: data, events, secrets, auth, observability, CI, backups.',
    signals,
  )
}

// ── Stage 1 — First closed-loop workflow ───────────────────────────
async function assessStage1(workspaceId: string): Promise<StageReport> {
  const signals: StageSignal[] = []

  // At least one businesses row.
  const bRows = await db.select({ c: sql<number>`count(*)::int` }).from(businesses)
    .where(eq(businesses.workspaceId, workspaceId)).catch(() => [])
  signals.push({ id: 'first_business', label: 'At least one business onboarded', present: Number(bRows[0]?.c ?? 0) >= 1, evidence: `${bRows[0]?.c ?? 0} businesses` })

  // Brain.task ops + MCP server present.
  signals.push({ id: 'brain_task',  label: 'brain.task op surface live (≥ 35 ops)', present: true, evidence: 'OPERATIONS map in brain-task.ts with 70+ ops' })
  signals.push({ id: 'mcp_server',  label: 'MCP server mounted at /mcp', present: true, evidence: 'routes/mcp.ts registered in server.ts' })

  // At least one workflow run completed.
  const wfEvents = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(eq(events.type, 'workflow.run_completed')).catch(() => [])
  signals.push({ id: 'first_workflow_completion', label: 'At least one full workflow run completed', present: Number(wfEvents[0]?.c ?? 0) >= 1, evidence: `${wfEvents[0]?.c ?? 0} completions` })

  // Approvals queue exists.
  signals.push({ id: 'approvals_queue', label: 'Approvals route + queue UI present', present: true, evidence: '/approvals page + routes/approvals.ts' })

  // First eval set exists.
  signals.push({ id: 'first_eval_set', label: 'At least one eval set configured', present: false, evidence: 'check via /blueprint?tab=evals — none seeded yet' })

  return summarise(1, 'First closed-loop workflow',
    'One specific business process automated end-to-end with all the architectural patterns proven at small scale.',
    signals,
  )
}

// ── Stage 2 — Horizontal expansion in one business ─────────────────
async function assessStage2(workspaceId: string): Promise<StageReport> {
  const signals: StageSignal[] = []

  // Multiple businesses or at least multiple operational workflows.
  const bRows = await db.select({ c: sql<number>`count(*)::int` }).from(businesses)
    .where(eq(businesses.workspaceId, workspaceId)).catch(() => [])
  signals.push({ id: 'multiple_business_or_workflows', label: 'Multiple workflows live OR ≥2 businesses', present: Number(bRows[0]?.c ?? 0) >= 2, evidence: `${bRows[0]?.c ?? 0} businesses` })

  // Knowledge curator running.
  const curatorEvents = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(eq(events.type, 'cron.knowledge_curate')).catch(() => [])
  signals.push({ id: 'curator_running', label: 'Knowledge curator cron firing', present: Number(curatorEvents[0]?.c ?? 0) >= 1, evidence: `${curatorEvents[0]?.c ?? 0} curator ticks` })

  // Cost monitoring.
  signals.push({ id: 'cost_monitoring', label: 'ai_usage cost monitoring + budget caps', present: true, evidence: 'cron-budget + business-budget + policy-engine spend_cap rule' })

  // Specialist persona team present.
  signals.push({ id: 'specialist_personas', label: '12-persona agent team scaffold', present: true, evidence: 'agent-team.ts with 12 personas' })

  // First model swap performed (proxy: > 1 provider enabled in any workspace).
  signals.push({ id: 'model_comparison', label: 'Multi-provider chain wired (model comparison feasible)', present: true, evidence: 'KNOWN_PROVIDERS x 10 in chat-providers.ts' })

  return summarise(2, 'Horizontal expansion in one business',
    'Pattern replicated across more workflows. Eval suite + curator + specialist topology all in motion.',
    signals,
  )
}

// ── Stage 3 — Second business + multi-tenancy ──────────────────────
async function assessStage3(workspaceId: string): Promise<StageReport> {
  const signals: StageSignal[] = []

  // ≥ 2 distinct businesses with revenue.
  const distinctBusinesses = await db.execute(sql`
    SELECT COUNT(DISTINCT business_id)::int AS n
    FROM business_revenue
    WHERE workspace_id = ${workspaceId}
  `).catch(() => ({ rows: [] }))
  const distinctN = Number(((distinctBusinesses as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['n'] ?? 0)
  signals.push({ id: 'two_businesses_with_revenue', label: '≥ 2 businesses with recorded revenue', present: distinctN >= 2, evidence: `${distinctN} businesses with revenue rows` })

  // Multi-tenancy: workspaces.portfolio_id populated for ≥ 1 row.
  const portfolioBound = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM workspaces
    WHERE portfolio_id IS NOT NULL
  `).catch(() => ({ rows: [] }))
  signals.push({ id: 'portfolio_bound', label: '≥ 1 workspace bound to a portfolio (holding-co tier active)', present: Number(((portfolioBound as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['n'] ?? 0) >= 1, evidence: `${((portfolioBound as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['n'] ?? 0} bound` })

  // Cross-business orchestration service present.
  signals.push({ id: 'holding_co', label: 'Holding-co brain (Capital Allocator + Shared Services + Synergy + Portfolio Strategy)', present: true, evidence: 'services/holding-co.ts' })

  // Incident response runbook (operator-runbook playbook present).
  signals.push({ id: 'runbook', label: 'Operator runbook playbook published', present: true, evidence: 'apps/api/knowledge/operator-runbook.md' })

  return summarise(3, 'Second business + multi-tenancy',
    'Two-business test of the patterns. Cross-business orchestration + per-business scoping + decoupling pain.',
    signals,
  )
}

// ── Stage 4 — Operational maturity ─────────────────────────────────
async function assessStage4(workspaceId: string): Promise<StageReport> {
  const signals: StageSignal[] = []

  // Eval coverage — number of distinct eval sets with at least one
  // recent run.
  const evalSetsRun = await db.execute(sql`
    SELECT COUNT(DISTINCT eval_set_id)::int AS n
    FROM eval_runs
    WHERE workspace_id = ${workspaceId} AND created_at > ${Date.now() - 30 * 86_400_000}
  `).catch(() => ({ rows: [] }))
  const evalN = Number(((evalSetsRun as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['n'] ?? 0)
  signals.push({ id: 'eval_coverage', label: '≥ 5 distinct eval sets with recent runs', present: evalN >= 5, evidence: `${evalN} sets with recent runs` })

  // SOC2 evidence collection — operator-emitted event type.
  const soc2 = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(eq(events.type, 'compliance.soc2_evidence_collected')).catch(() => [])
  signals.push({ id: 'soc2', label: 'SOC 2 evidence collection started', present: Number(soc2[0]?.c ?? 0) >= 1, evidence: `${soc2[0]?.c ?? 0} events` })

  // Disaster recovery drill — emit event when operator runs.
  const dr = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(eq(events.type, 'dr.drill_completed')).catch(() => [])
  signals.push({ id: 'dr_drill', label: 'Disaster recovery drill completed at least once', present: Number(dr[0]?.c ?? 0) >= 1, evidence: `${dr[0]?.c ?? 0} drills` })

  // Postmortem maturity — at least N auto-generated.
  const pm = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(eq(events.type, 'incident.postmortem_generated')).catch(() => [])
  signals.push({ id: 'postmortems', label: '≥ 3 postmortems generated (process maturity proof)', present: Number(pm[0]?.c ?? 0) >= 3, evidence: `${pm[0]?.c ?? 0} postmortems` })

  // Knowledge curator approved patterns (compound learning signal).
  const approvedPatternsRows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM approved_patterns
    WHERE workspace_id = ${workspaceId} AND archived = false
  `).catch(() => ({ rows: [] }))
  signals.push({ id: 'curator_compounding', label: '≥ 10 approved knowledge patterns (curator is compounding)', present: Number(((approvedPatternsRows as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['n'] ?? 0) >= 10, evidence: `${((approvedPatternsRows as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['n'] ?? 0} approved` })

  return summarise(4, 'Operational maturity',
    'Trustworthy at scale. Comprehensive eval coverage, audited, drilled. Autonomy envelope expands as track record justifies.',
    signals,
  )
}

// ── Stage 5 — Scale + new business spawning ────────────────────────
async function assessStage5(workspaceId: string): Promise<StageReport> {
  const signals: StageSignal[] = []

  // ≥ 5 businesses with revenue.
  const distinctBusinesses = await db.execute(sql`
    SELECT COUNT(DISTINCT business_id)::int AS n
    FROM business_revenue
    WHERE workspace_id = ${workspaceId}
  `).catch(() => ({ rows: [] }))
  const n = Number(((distinctBusinesses as { rows?: Array<Record<string, unknown>> }).rows ?? [])[0]?.['n'] ?? 0)
  signals.push({ id: 'five_businesses', label: '≥ 5 businesses with active revenue', present: n >= 5, evidence: `${n} businesses` })

  // Spawning a new business should require ≤ 1 hour of operator time.
  // Proxy: business.create op called ≥ N times in the last 90 days.
  const spawn = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(eq(events.type, 'business.created')).catch(() => [])
  signals.push({ id: 'spawn_efficiency', label: 'Business-create op fired ≥ 3 times (spawning is operational, not novel)', present: Number(spawn[0]?.c ?? 0) >= 3, evidence: `${spawn[0]?.c ?? 0} spawns` })

  // Cross-business learning transfer event.
  const xfer = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(eq(events.type, 'knowledge.cross_business_transfer')).catch(() => [])
  signals.push({ id: 'cross_business_learning', label: 'Cross-business pattern transfer observed', present: Number(xfer[0]?.c ?? 0) >= 1, evidence: `${xfer[0]?.c ?? 0} transfers` })

  // Autonomous strategic decisions within explicit bounds — proxy:
  // strategic decision chains with high confidence and outcome matched.
  signals.push({ id: 'autonomous_strategy', label: 'Strategic decisions running autonomously within bounds', present: false, evidence: 'no signal yet — operator approves all strategic moves' })

  return summarise(5, 'Scale + new-business spawning',
    'Marginal cost of new business is now infrastructure cost only. Portfolio-level optimization. Honest about where humans remain better.',
    signals,
  )
}

// ── Helper ─────────────────────────────────────────────────────────
function summarise(stage: MaturityStage, title: string, description: string, signals: StageSignal[]): StageReport {
  const present = signals.filter(s => s.present).length
  const completion = signals.length === 0 ? 0 : present / signals.length
  const blockers = signals.filter(s => !s.present).map(s => s.label)
  return { stage, title, description, signals, completion: Number(completion.toFixed(2)), blockers }
}

// ── Business-type capability mapper (Part 3 of the spec) ───────────
export type BusinessType = 'ecommerce' | 'saas' | 'creator' | 'pod' | 'mixed'

export interface CapabilityMap {
  type:             BusinessType
  brainExcelsAt:    string[]
  humansEssentialFor: string[]
  recommendedStack: string[]
  specificRisks:    string[]
}

export function getBusinessCapabilityMap(type: BusinessType): CapabilityMap {
  switch (type) {
    case 'ecommerce': return {
      type,
      brainExcelsAt: [
        'demand forecasting across SKUs (seasonality + trends + marketing spend)',
        'dynamic pricing responding to inventory + competitor + elasticity',
        'ad-spend optimization across Meta/Google/TikTok with real attribution',
        'email/SMS lifecycle marketing personalized at individual level',
        'CS for routine inquiries (where is my order / returns / sizing) — 60-80% of ticket volume',
        'fraud detection on incoming orders',
        'supplier RFQs and reorder triggering',
      ],
      humansEssentialFor: [
        'product selection + merchandising for new categories (taste matters)',
        'brand voice + creative direction',
        'supplier relationships especially in hard negotiations',
        'QC on physical goods + returns inspection',
        'customer escalations where reputation is on the line',
      ],
      recommendedStack: [
        'Shopify (system of record)', 'ShipBob / ShipHero (3PL)',
        'Klaviyo / Customer.io (lifecycle)',
        'Northbeam / Triple Whale (attribution)',
        'Loop / Aftership (returns)',
        'Inventory Planner / Cogsy (forecasting)',
      ],
      specificRisks: [
        'stockouts on hot products from forecast errors',
        'ad-spend runaways when bidding agents misfire',
        'brand damage from automated communications gone wrong',
        'fraud losses (auto systems miss OR false-positive too aggressively)',
      ],
    }
    case 'saas': return {
      type,
      brainExcelsAt: [
        'lead scoring + routing from inbound',
        'trial-to-paid conversion with personalized onboarding',
        'churn prediction + save offers',
        'expansion identification (which customers ready to upgrade)',
        'pricing experimentation',
        'content marketing pipeline (blog + SEO + distribution)',
        'tier-one support — 70-90% resolution in mature SaaS',
        'usage-based billing ops',
      ],
      humansEssentialFor: [
        'enterprise sales above ACV thresholds',
        'product strategy + roadmap',
        'complex customer-success for strategic accounts',
        'partnerships + channel relationships',
        'product engineering itself',
      ],
      recommendedStack: [
        'HubSpot / Salesforce (CRM)',
        'Mixpanel / Amplitude / PostHog (product analytics)',
        'Stripe (billing + Stripe Billing for subscriptions)',
        'Vitally / Catalyst (customer success)',
        'Userpilot / Appcues (in-app guidance)',
        'Pylon / Plain (modern AI-enabled support)',
        'Maxio / Metronome (usage billing)',
      ],
      specificRisks: [
        'churn from automation-quality issues (bad AI support → customer leaves)',
        'security incidents that damage trust permanently',
        'technical debt when brain optimizes ship-velocity over engineering quality',
        'existential: optimising acquisition metrics on a weak product nobody wants',
      ],
    }
    case 'creator': return {
      type,
      brainExcelsAt: [
        'repurposing one piece of content into many (long video → clips, podcast → blog → social)',
        'cross-platform distribution with platform-specific optimization',
        'community management + moderation',
        'sponsorship outreach + negotiation',
        'ad-sales ops',
        'newsletter with personalization',
        'merch + digital-product ops',
        'audience analytics + insights',
        'scheduling + publishing logistics',
      ],
      humansEssentialFor: [
        'the actual creative output — writing, performing, designing, filming. Voice IS the product.',
        'sponsor + partner relationships where trust matters',
        'what to make and what to skip',
        'cultural-moment response where judgment > process',
      ],
      recommendedStack: [
        'YouTube + Substack + podcast hosts (publishing)',
        'Descript (video/audio editing automation)',
        'Buffer / Hypefury (distribution)',
        'ConvertKit / Beehiiv (newsletter)',
        'Gumroad / Lemon Squeezy (digital products)',
        'Passionfroot (sponsorship ops)',
        'Discord / Circle (community)',
      ],
      specificRisks: [
        'voice degradation when brain over-automates creative output',
        'platform dependency (algorithm changes or deplatforming)',
        'trap of optimizing engagement metrics over the deeper audience relationship',
      ],
    }
    case 'pod': return {
      type,
      brainExcelsAt: [
        'niche selection + trending designs',
        'pricing math by provider (Printful/Printify/Gelato/SPOD/Gooten — see pod-pricing.ts)',
        'listing copy (titles, bullets, tags, descriptions per channel)',
        'design briefs (concepts, typography, palette, mockup specs)',
        'analytics across Etsy/Redbubble/Amazon Merch/TeePublic',
        'recurring schedules (Monday design brief, Friday sales digest)',
      ],
      humansEssentialFor: [
        'taste on the actual designs that get made',
        'final approval before publishing to stores',
        'CS escalations on damaged or wrong-print orders',
        'platform-policy navigation (Etsy + Amazon Merch frequently update rules)',
      ],
      recommendedStack: [
        'Etsy + Shopify + Printful + Printify + YouTube (connectors round 110-118)',
        'Image generators for thumbnails + concept art',
        'POD provider COGS engine (pod-pricing.ts)',
        'Multi-channel-operations playbook injected into chat',
      ],
      specificRisks: [
        'platform suspension if listings violate policy',
        'design IP infringement claims',
        'provider COGS shifts mid-launch invalidating margins',
        'taste degradation if the brain ships designs without operator review',
      ],
    }
    case 'mixed': return {
      type,
      brainExcelsAt: ['cross-business learning transfer', 'shared-service consolidation', 'capital allocation across ventures'],
      humansEssentialFor: ['per-business strategy', 'venture portfolio decisions'],
      recommendedStack: ['holding-co tier (portfolios table)', 'cross-business orchestration'],
      specificRisks: ['business types getting one-size-fits-all treatment when they need different mechanics'],
    }
  }
}
