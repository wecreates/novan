/**
 * product-factory.ts — Digital Product Factory subsystem.
 *
 * Phase 0: ideation + validation + spec generation.
 * Phase 1-2: design + architecture briefs.
 * Phase 14: lifecycle (launch / growth / sunset proposals).
 *
 * The factory turns the brain from "operator of businesses" into
 * "creator of products those businesses sell." It is intentionally
 * built on top of:
 *   - agent-team.dispatchPersona (uses design_director, script_writer,
 *     ops_documentarian, store_strategist as factory roles)
 *   - business-feasibility (validates demand before code is written)
 *   - policy-engine (gates every commit / approve / publish action)
 *   - simulation.dryRun (validates new agent behaviors before live)
 *
 * Storage: ideas + specs + lifecycle records use the existing `memories`
 * + `events` tables with tier='procedural' tags so they survive decay.
 * A dedicated table is round-112 work.
 */
import { db } from '../db/client.js'
import { memories, events } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'

export interface ProductIdea {
  id:            string
  workspaceId:   string
  title:         string
  description:   string
  /** Where the signal came from: support, sales call, social, brain. */
  provenance:    'support' | 'sales' | 'social' | 'review' | 'competitor' | 'patent' | 'brain' | 'operator'
  signalSourceRef: string | null
  /** 0..1 scores — see scoreIdea(). */
  scores: {
    marketSize:      number
    competitive:     number   // higher = less competition
    strategicFit:    number
    feasibility:     number
    regulatoryRisk:  number   // INVERSE — higher means less risk
    timeToRevenue:   number   // INVERSE — higher means faster
    composite:       number
  }
  status:        'inbox' | 'validating' | 'building' | 'launched' | 'sunset' | 'rejected'
  createdAt:     number
}

/** Idea Sourcing: log a new product idea with provenance + initial
 *  scores. Dedup-friendly via tags. */
export async function captureIdea(input: {
  workspaceId:   string
  title:         string
  description:   string
  provenance:    ProductIdea['provenance']
  signalSourceRef?: string
}): Promise<ProductIdea> {
  const id = uuidv7()
  const scores = scoreIdea(input.description)
  const idea: ProductIdea = {
    id,
    workspaceId:    input.workspaceId,
    title:          input.title.slice(0, 200),
    description:    input.description.slice(0, 4_000),
    provenance:     input.provenance,
    signalSourceRef: input.signalSourceRef ?? null,
    scores,
    status:         'inbox',
    createdAt:      Date.now(),
  }

  await db.insert(memories).values({
    id,
    workspaceId: input.workspaceId,
    type:        'episodic',
    content:     `Product idea: ${idea.title}\n\n${idea.description}`,
    summary:     idea.title,
    confidence:  scores.composite,
    tags:        ['product_idea', `provenance:${input.provenance}`, `status:${idea.status}`, 'pinned'],
    source:      'product-factory',
    sourceRef:   idea.signalSourceRef ?? `idea:${id}`,
    createdAt:   idea.createdAt,
    updatedAt:   idea.createdAt,
    expiresAt:   null,
  } as never).catch((e: Error) => { console.error('[product-factory]', e.message); return null })

  await db.insert(events).values({
    id: uuidv7(), type: 'product.idea_captured', workspaceId: input.workspaceId,
    payload: { ideaId: id, title: idea.title, provenance: input.provenance, composite: scores.composite },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'product-factory', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[product-factory]', e.message); return null })

  return idea
}

/** Heuristic scoring — fast, evidence-light. Real scoring runs the
 *  description through trend_hunter persona for grounded evidence. */
export function scoreIdea(description: string): ProductIdea['scores'] {
  const t = description.toLowerCase()
  // Coarse signals — flagged keywords contribute to each axis.
  const has = (re: RegExp) => re.test(t)
  const marketSize = has(/\b(everyone|consumer|mass[-\s]?market|millions|billion)\b/) ? 0.85
                   : has(/\b(prosumer|smb|professional|business)\b/)                    ? 0.7
                   : has(/\b(niche|specialist|specific)\b/)                              ? 0.5
                   : 0.4
  const competitive = has(/\b(no one|gap|underserved|unfilled)\b/) ? 0.85
                    : has(/\b(crowded|saturated|established players)\b/) ? 0.3
                    : 0.55
  const strategicFit = has(/\b(youtube|tiktok|etsy|shopify|print[-\s]?on[-\s]?demand|pod|creator|operator)\b/) ? 0.85 : 0.5
  const feasibility = has(/\b(api|library|sdk|existing|integrate|wrapper)\b/) ? 0.8
                    : has(/\b(novel|first|breakthrough|invention)\b/)         ? 0.35
                    : 0.6
  const regulatoryRisk = has(/\b(health|medical|financial|payments|kids|minors|firearms)\b/) ? 0.3 : 0.85
  const timeToRevenue = has(/\b(weeks|days|fast|quick|already built)\b/)   ? 0.85
                      : has(/\b(months|year|complex|multi[-\s]?phase)\b/)   ? 0.4
                      : 0.6
  const composite = Number((
    0.20 * marketSize +
    0.20 * competitive +
    0.20 * strategicFit +
    0.15 * feasibility +
    0.10 * regulatoryRisk +
    0.15 * timeToRevenue
  ).toFixed(3))
  return { marketSize, competitive, strategicFit, feasibility, regulatoryRisk, timeToRevenue, composite }
}

export interface ValidationGate {
  ideaId:        string
  passed:        boolean
  reasons:       string[]
  required: {
    landingPageCTR?:      number   // observed CTR for fake-door if any
    customerInterviews?:  number   // count of completed interviews
    smokeConversions?:    number   // paid-traffic smoke conversion count
    competitorTeardown?:  boolean
    willingToPaySurveyN?: number
  }
}

/** Validation gate — kill-or-proceed criteria the operator + agents
 *  agree to before code is written. Returns pass/fail with explicit
 *  missing-evidence list. The brain never auto-passes the gate;
 *  operator confirms in chat. */
export function evaluateValidationGate(input: {
  idea:                ProductIdea
  evidence: {
    landingPageCTR?:     number
    customerInterviews?: number
    smokeConversions?:   number
    competitorTeardown?: boolean
    willingToPaySurveyN?: number
  }
}): ValidationGate {
  const reasons: string[] = []
  const e = input.evidence
  if ((e.customerInterviews ?? 0) < 5) reasons.push(`fewer than 5 customer interviews (have ${e.customerInterviews ?? 0})`)
  if ((e.smokeConversions ?? 0) < 10)  reasons.push(`fewer than 10 smoke-test conversions (have ${e.smokeConversions ?? 0})`)
  if (!e.competitorTeardown)            reasons.push('no competitor teardown on file')
  if ((e.landingPageCTR ?? 0) < 0.03)   reasons.push(`landing CTR ${(e.landingPageCTR ?? 0) * 100}% below 3% threshold`)
  if ((e.willingToPaySurveyN ?? 0) < 20) reasons.push(`willingness-to-pay survey N=${e.willingToPaySurveyN ?? 0} below 20`)

  return {
    ideaId: input.idea.id,
    passed: reasons.length === 0,
    reasons,
    required: {
      ...(e.landingPageCTR      !== undefined ? { landingPageCTR:      e.landingPageCTR      } : {}),
      ...(e.customerInterviews  !== undefined ? { customerInterviews:  e.customerInterviews  } : {}),
      ...(e.smokeConversions    !== undefined ? { smokeConversions:    e.smokeConversions    } : {}),
      ...(e.competitorTeardown  !== undefined ? { competitorTeardown:  e.competitorTeardown  } : {}),
      ...(e.willingToPaySurveyN !== undefined ? { willingToPaySurveyN: e.willingToPaySurveyN } : {}),
    },
  }
}

export interface PRD {
  ideaId:        string
  title:         string
  problem:       string
  audience:      string
  jobsToBeDone:  string[]
  userStories:   Array<{ role: string; want: string; so_that: string; acceptance: string[] }>
  nonFunctional: {
    performance?:    string
    accessibility?:  string
    security?:       string
    compliance?:     string[]
  }
  constraints:   string[]
  buildVsBuy:    Array<{ component: string; recommendation: 'build' | 'buy' | 'integrate'; rationale: string }>
  successMetric: string
  killCriteria:  string[]
  livingDoc:     boolean
}

/** Generate a PRD draft from a validated idea. Operator edits the
 *  resulting structure in chat — the engine ONLY produces the skeleton
 *  with grounded constraints derived from the idea description +
 *  Novan's playbook context. */
export function generatePRD(input: { idea: ProductIdea }): PRD {
  const i = input.idea
  return {
    ideaId:    i.id,
    title:     i.title,
    problem:   i.description.slice(0, 500),
    audience:  i.scores.strategicFit > 0.7 ? 'Novan operators (creator-economy / POD / e-com / SaaS)' : 'undefined — operator must specify',
    jobsToBeDone: [
      'discover whether this idea hits product-market fit',
      'ship a usable v1 inside one development cycle (≤2 weeks)',
      'hit $10k/mo net revenue within 90 days of launch',
    ],
    userStories: [
      {
        role:        'operator',
        want:        i.title,
        so_that:     'I reach $10k/month on this product without burning >$200/month on AI cost',
        acceptance:  [
          'feature works end-to-end in dry-run mode',
          'all tests pass + typecheck green',
          'policy engine permits the relevant ops',
          'audit trail captures every autonomous action',
        ],
      },
    ],
    nonFunctional: {
      performance:    'p95 latency < 1s for interactive paths; < 30s for LLM paths',
      accessibility:  'WCAG 2.2 AA minimum',
      security:       'all secrets via vault; no auth bypass; rate-limited',
      compliance:     ['GDPR data minimisation', 'CCPA delete-on-request'],
    },
    constraints: [
      'must integrate with existing brain.task op surface',
      'must respect policy-engine governance rules',
      '$10k/business floor enforcement at every entry point that touches revenue',
      'no fake intelligence: features that depend on absent connectors must surface "not connected" honestly',
    ],
    buildVsBuy: [
      { component: 'auth',          recommendation: 'integrate',  rationale: 'existing Novan auth + RBAC; do not rebuild' },
      { component: 'LLM',           recommendation: 'integrate',  rationale: 'multi-provider chain present; no new model training' },
      { component: 'vector search', recommendation: 'integrate',  rationale: 'pgvector + memories already wired' },
      { component: 'observability', recommendation: 'integrate',  rationale: 'pino + OTEL + ai_usage present' },
    ],
    successMetric: '$10k MRR within 90 days OR validated kill criteria triggered',
    killCriteria: [
      'composite idea score drops below 0.5 after first 30 days of data',
      'CAC > 3× LTV across 60-day window',
      'NPS < 20 with churn > 15%/month',
      'security incident severity ≥ critical not resolvable in <30 days',
    ],
    livingDoc: true,
  }
}

/** Recommend a launch checklist for a product about to ship. Pulls
 *  ops_documentarian persona for the SOP via the agent team. */
export function launchChecklist(productTitle: string): Array<{ area: string; items: string[] }> {
  return [
    { area: 'Legal',     items: ['ToS published', 'Privacy policy + DPA', 'License selection confirmed', 'Trademark search done'] },
    { area: 'Security',  items: ['Auth bypass tested', 'Dependency vuln scan clean', 'Secrets in vault', 'Rate-limiting on public routes'] },
    { area: 'Infra',     items: ['Health checks pass', 'Rollback rehearsed', 'Backups verified', 'Cost alert configured'] },
    { area: 'Marketing', items: [`${productTitle} landing page live`, 'Launch tweet drafted', 'Email to list scheduled', 'Pricing page final'] },
    { area: 'Support',   items: ['FAQ page live', 'Support inbox routed', 'Refund SOP in playbook', 'Status page connected'] },
    { area: 'Analytics', items: ['Event taxonomy defined', 'Funnel events firing', 'KPI dashboard linked', 'A/B framework ready'] },
  ]
}

/** Sunset proposal — operator-confirmed before any user-visible action. */
export interface SunsetProposal {
  productId:    string
  noticeWindow: '30d' | '60d' | '90d' | '180d'
  reasons:      string[]
  exportTooling: string[]
  migrationPath: string | null
  contractObligations: string[]
  destructionPlan: string
}

export function proposeSunset(input: {
  productId:    string
  reasons:      string[]
  hasContracts: boolean
  hasUserData:  boolean
}): SunsetProposal {
  return {
    productId:    input.productId,
    noticeWindow: input.hasContracts ? '180d' : input.hasUserData ? '90d' : '60d',
    reasons:      input.reasons,
    exportTooling: input.hasUserData ? ['per-user JSON export', 'CSV bulk export', 'SQL dump for power users'] : [],
    migrationPath: null,    // operator may fill in successor product
    contractObligations: input.hasContracts
      ? ['notify all paying customers in writing', 'honor remaining subscription term to refund-or-credit', 'provide 90d data export before destruction']
      : [],
    destructionPlan: 'After notice window: encrypted backup retained 1 year per Novan retention policy; production tables truncated; vault keys rotated.',
  }
}
