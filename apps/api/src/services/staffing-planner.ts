/**
 * staffing-planner.ts — Maps Novan's maturity stage to recommended
 * staffing. Implements Part 2 of the spec.
 *
 * Returns:
 *   - the team composition appropriate for the current stage
 *   - which roles to hire next (with hiring profiles + red flags +
 *     green flags from the spec)
 *   - which roles are typically under-invested in
 *   - estimated burn at recommended composition
 *
 * Honest scope: This is a planning tool, not a recruiting system.
 * The operator hires; Novan tells the operator what shape the team
 * should be at the current stage and what to look for.
 */
import type { MaturityStage } from './maturity-stage.js'

export interface RoleSpec {
  title:           string
  count:           [number, number]    // min, max recommended
  primaryDuties:   string[]
  hiringProfile: {
    greenFlags:    string[]
    redFlags:      string[]
  }
  /** Approximate annual total comp range USD. Operator adjusts for region. */
  compRange:       [number, number]
  /** Why teams typically under-invest in this role. Empty if not under-invested. */
  underInvestmentReason?: string
}

const ROLES = {
  platform: {
    title: 'Platform / Infrastructure Engineer',
    count: [1, 2] as [number, number],
    primaryDuties: ['cloud foundation', 'IaC', 'observability', 'CI/CD', 'secrets management'],
    hiringProfile: {
      greenFlags: ['been burned before by skipping foundations + religious about doing them right', 'has shipped production systems and dealt with operational consequences'],
      redFlags:   ['wants to start with Kubernetes when serverless would do', 'wants to roll their own everything', 'no production scars'],
    },
    compRange: [180_000, 280_000] as [number, number],
  },
  security_generalist: {
    title: 'Security-Conscious Generalist',
    count: [1, 1] as [number, number],
    primaryDuties: ['secrets management', 'SSO', 'baseline compliance', 'security review of architecture'],
    hiringProfile: {
      greenFlags: ['treats security as first-class without being a blocker', 'comfortable across infra + app security'],
      redFlags:   ['compliance-checkbox mentality only', 'tries to lock down development velocity'],
    },
    compRange: [180_000, 260_000] as [number, number],
  },
  ai_ml_eng: {
    title: 'AI / ML Engineer with Production Experience',
    count: [1, 2] as [number, number],
    primaryDuties: ['agent layer', 'orchestration', 'evals', 'prompt management', 'model selection', 'cost optimization'],
    hiringProfile: {
      greenFlags: ['can articulate why evals matter more than benchmarks', 'shipped AI products to real users', 'comfortable with operational realities (cost, latency, drift)'],
      redFlags:   ['pure researcher with no production experience', 'pure SWE with only tutorial-level AI exposure', 'AI maximalist OR AI skeptic — both extremes are red flags'],
    },
    compRange: [220_000, 350_000] as [number, number],
  },
  product_owner: {
    title: 'Technical Product Person (per workflow → per business)',
    count: [1, 1] as [number, number],
    primaryDuties: ['owns workflow end-to-end', 'bridges business value + technical execution'],
    hiringProfile: {
      greenFlags: ['understands business AND engages seriously with engineering', 'often the founder in small ops or a strong PM-engineer hybrid'],
      redFlags:   ['pure PM with no technical depth', 'pure engineer with no business sense'],
    },
    compRange: [180_000, 280_000] as [number, number],
  },
  sre: {
    title: 'Dedicated SRE',
    count: [1, 2] as [number, number],
    primaryDuties: ['on-call rotation', 'incident response', 'runbooks', 'post-mortems', 'pushes back on non-operationally-ready releases'],
    hiringProfile: {
      greenFlags: ['strong opinions about toil reduction + operational maturity', 'pushes back on shipping not-ready things'],
      redFlags:   ['treats SRE as just devops with a different title'],
    },
    compRange: [200_000, 320_000] as [number, number],
  },
  domain_expert: {
    title: 'Domain Expert (contracted or hired)',
    count: [1, 1] as [number, number],
    primaryDuties: ['writes playbooks', 'reviews brain decisions', 'contributes to eval set'],
    hiringProfile: {
      greenFlags: ['10+ years in the specific business type (POD / e-commerce / SaaS / creator)', 'comfortable encoding tacit knowledge into structured form'],
      redFlags:   ['generic consultant', 'theoretical knowledge without hands-on operation'],
    },
    compRange: [120_000, 250_000] as [number, number],
  },
  security_dedicated: {
    title: 'Security Engineer (dedicated)',
    count: [1, 1] as [number, number],
    primaryDuties: ['SOC 2 / GDPR compliance', 'pen tests', 'bug bounty', 'security incidents', 'architectural security review'],
    hiringProfile: {
      greenFlags: ['has run compliance programs end-to-end', 'comfortable with pen testing + threat modeling'],
      redFlags:   ['compliance-only background without engineering depth'],
    },
    compRange: [220_000, 330_000] as [number, number],
  },
  data_eng: {
    title: 'Data Engineer',
    count: [1, 1] as [number, number],
    primaryDuties: ['warehouse', 'ETL', 'analytics infrastructure'],
    hiringProfile: {
      greenFlags: ['has owned warehouse migrations + dbt'],
      redFlags:   ['only used a warehouse, never built one'],
    },
    compRange: [180_000, 270_000] as [number, number],
  },
  ai_platform: {
    title: 'AI Platform Engineer',
    count: [1, 1] as [number, number],
    primaryDuties: ['model routing', 'eval infrastructure', 'prompt management system', 'AI cost monitoring'],
    hiringProfile: {
      greenFlags: ['has built AI-specific platform infra at production scale'],
      redFlags:   ['confuses this role with model-research'],
    },
    compRange: [220_000, 340_000] as [number, number],
  },
  frontend_ux: {
    title: 'Frontend / UX Engineer',
    count: [1, 2] as [number, number],
    primaryDuties: ['daily briefings UI', 'approval queues', 'dashboards', 'command interfaces'],
    hiringProfile: {
      greenFlags: ['can build operator-facing tools that humans actually want to use'],
      redFlags:   ['ships pixel-perfect designs but ignores workflow ergonomics'],
    },
    compRange: [180_000, 280_000] as [number, number],
    underInvestmentReason: 'often deferred until humans have bad tools for engaging with the brain — invest earlier than feels necessary',
  },
  eval_engineer: {
    title: 'Evaluation Engineer',
    count: [1, 1] as [number, number],
    primaryDuties: ['build + maintain eval sets', 'calibrate LLM-as-judge systems', 'validate brain behaviour'],
    hiringProfile: {
      greenFlags: ['treats evals as the most important quality artefact', 'has built golden + regression + synthetic + production layered eval sets'],
      redFlags:   ['thinks benchmarks are sufficient'],
    },
    compRange: [200_000, 300_000] as [number, number],
    underInvestmentReason: 'doesn\'t feel like building — most important quality role in the org; teams neglect it until quality silently regresses',
  },
  knowledge_manager: {
    title: 'Knowledge Manager',
    count: [1, 1] as [number, number],
    primaryDuties: ['curate entries', 'resolve conflicts', 'deprecate stale knowledge', 'identify coverage gaps'],
    hiringProfile: {
      greenFlags: ['strong technical writer with engineering literacy'],
      redFlags:   ['writers who don\'t understand systems OR engineers without writing skill'],
    },
    compRange: [150_000, 240_000] as [number, number],
    underInvestmentReason: 'most teams have no one in this role — knowledge base degrades into noise',
  },
  red_team: {
    title: 'Adversarial Tester / Red Team',
    count: [1, 1] as [number, number],
    primaryDuties: ['find prompt injections', 'edge cases', 'agent manipulations', 'governance bypasses'],
    hiringProfile: {
      greenFlags: ['adversarial mindset — actively tries to break things', 'background in security + AI'],
      redFlags:   ['defensive thinker who can\'t imagine attacking'],
    },
    compRange: [180_000, 320_000] as [number, number],
    underInvestmentReason: 'even small operations benefit from at least part-time adversarial thinking; teams skip this until something breaks',
  },
  ops_process: {
    title: 'Operations / Process Manager',
    count: [1, 1] as [number, number],
    primaryDuties: ['runbooks', 'on-call schedule', 'governance reviews', 'meta-operations of the brain itself'],
    hiringProfile: {
      greenFlags: ['organizational designer with technical literacy'],
      redFlags:   ['traditional PM with no operational depth'],
    },
    compRange: [150_000, 230_000] as [number, number],
    underInvestmentReason: 'as the brain handles more, its own meta-operations need management; this role is organizational, not engineering, and gets neglected',
  },
  per_business_owner: {
    title: 'Per-Business Product Owner',
    count: [1, 1] as [number, number],
    primaryDuties: ['live in business specifics', 'human-in-loop for important decisions', 'bridge to general brain capabilities'],
    hiringProfile: {
      greenFlags: ['domain expertise + technical literacy', 'comfortable being an operator + product person'],
      redFlags:   ['wants pure strategy without execution'],
    },
    compRange: [150_000, 250_000] as [number, number],
  },
} satisfies Record<string, RoleSpec>

export interface StagePlan {
  stage:                MaturityStage
  recommendedRoles:     Array<RoleSpec & { rationale: string }>
  estimatedAnnualBurn:  { min: number; max: number; midpoint: number }
  underInvestedRoles:   Array<{ title: string; reason: string }>
  notes:                string[]
}

export function planStaffing(currentStage: MaturityStage, businessCount = 1): StagePlan {
  let roleSet: Array<{ role: RoleSpec; rationale: string }> = []
  const notes: string[] = []

  if (currentStage <= 1) {
    // Stage 0-1: 3-5 people, all generalists w/ depth in one area
    roleSet = [
      { role: ROLES.platform,            rationale: 'most important early hire — foundations decide whether everything downstream is fragile' },
      { role: ROLES.security_generalist, rationale: 'security cannot slip from day one — not yet dedicated, but someone on the team owns it' },
      { role: ROLES.ai_ml_eng,           rationale: 'production experience matters more than research credentials at this stage' },
      { role: ROLES.product_owner,       rationale: 'owns first workflow end-to-end — often the founder in small ops' },
    ]
    notes.push('Generalists with depth — specialists fragment work at this scale')
    notes.push('Output: an environment in which automation can be built safely. No agents in production yet')
  } else if (currentStage === 2) {
    roleSet = [
      { role: ROLES.platform,            rationale: 'platform crew from Stage 0-1 continues' },
      { role: ROLES.security_generalist, rationale: 'continues until volume justifies a dedicated security engineer' },
      { role: ROLES.ai_ml_eng,           rationale: 'specialization begins — one focuses on agents/orchestration, one on evals/quality' },
      { role: ROLES.sre,                 rationale: 'system becoming operationally critical — own on-call, incident response, runbooks' },
      { role: ROLES.product_owner,       rationale: 'continues; may split into workflow + business owner if scope grows' },
      { role: ROLES.domain_expert,       rationale: 'brain without domain knowledge is generic and weak — often contracted at this stage' },
    ]
    notes.push('Cost monitoring becomes real — by now you\'re spending real money on model calls')
    notes.push('First significant model swap happens here — compare systematically, not just because of a blog post')
  } else if (currentStage === 3) {
    roleSet = [
      { role: ROLES.platform,             rationale: 'multi-tenancy + cross-business architecture demands platform depth' },
      { role: ROLES.security_dedicated,   rationale: 'enough surface area now to need full-time security' },
      { role: ROLES.ai_ml_eng,            rationale: 'two AI/ML engineers, roles forking — agent layer + eval layer' },
      { role: ROLES.sre,                  rationale: 'on-call rotation needs ≥ 2 humans for sustainable rotation' },
      { role: ROLES.data_eng,             rationale: 'warehouse + ETL + analytics infrastructure becomes substantial' },
      { role: ROLES.per_business_owner,   rationale: `one per business — currently ${businessCount} business(es)` },
      { role: ROLES.ai_platform,          rationale: 'AI layer becomes its own platform — model routing, eval infra, cost monitoring' },
      { role: ROLES.frontend_ux,          rationale: 'human interfaces become first-class — daily briefings, approval queues, dashboards' },
    ]
    notes.push('Discipline: keep business logic separated from platform code. Decoupling pain happens here')
    notes.push('Operational maturity tested — runbooks + on-call + incident response from Stage 0 get exercised')
  } else if (currentStage === 4) {
    roleSet = [
      { role: ROLES.platform,             rationale: 'platform investment per business amortizes here' },
      { role: ROLES.security_dedicated,   rationale: 'SOC 2 + GDPR + pen tests + bug bounty become continuous work' },
      { role: ROLES.ai_ml_eng,            rationale: 'two AI/ML engineers continue' },
      { role: ROLES.sre,                  rationale: 'two SREs for sustainable on-call + chaos drills + DR rehearsal' },
      { role: ROLES.data_eng,             rationale: 'data engineering specialization continues' },
      { role: ROLES.per_business_owner,   rationale: `${businessCount} business(es) × 1 owner each` },
      { role: ROLES.ai_platform,          rationale: 'AI platform engineer continues' },
      { role: ROLES.frontend_ux,          rationale: 'two frontend / UX engineers — operator UI is now substantial surface' },
      { role: ROLES.eval_engineer,        rationale: 'dedicated eval engineer — quality work that doesn\'t feel like building but matters most' },
      { role: ROLES.knowledge_manager,    rationale: 'knowledge base needs active curation as it scales' },
      { role: ROLES.red_team,             rationale: 'even part-time adversarial mindset prevents the next class of failure' },
      { role: ROLES.ops_process,          rationale: 'meta-ops of the brain itself need explicit management' },
    ]
    notes.push('Autonomy envelope expands as track record builds — but governance doesn\'t disappear, thresholds shift')
    notes.push('Brain genuinely learns — 18+ months of operational history feeds the Knowledge Curator')
  } else {
    // Stage 5+
    roleSet = [
      { role: ROLES.platform,             rationale: '3-4 platform engineers — full-stack platform team' },
      { role: ROLES.security_dedicated,   rationale: '2 security engineers' },
      { role: ROLES.ai_ml_eng,            rationale: '3-4 AI/ML engineers across agent / eval / platform' },
      { role: ROLES.sre,                  rationale: '2-3 SREs' },
      { role: ROLES.data_eng,             rationale: '1-2 data engineers' },
      { role: ROLES.per_business_owner,   rationale: `${businessCount} business(es) × 1 owner each` },
      { role: ROLES.ai_platform,          rationale: 'dedicated AI platform team' },
      { role: ROLES.frontend_ux,          rationale: '1-2 frontend / UX engineers' },
      { role: ROLES.eval_engineer,        rationale: 'dedicated eval engineer continues' },
      { role: ROLES.knowledge_manager,    rationale: 'knowledge curator partner' },
      { role: ROLES.red_team,             rationale: 'dedicated red team' },
      { role: ROLES.ops_process,          rationale: 'ops + process management' },
    ]
    notes.push('Composition varies significantly by scale and risk profile — could be 15 people running 5 businesses or 50 running 20')
  }

  const rolesOut: Array<RoleSpec & { rationale: string }> = []
  for (const r of roleSet) rolesOut.push({ ...r.role, rationale: r.rationale })

  // Burn estimate using midpoint count + midpoint comp.
  let burnMin = 0, burnMax = 0
  for (const r of rolesOut) {
    burnMin += r.count[0] * r.compRange[0]
    burnMax += r.count[1] * r.compRange[1]
  }
  const burnMid = Math.round((burnMin + burnMax) / 2)

  // Under-invested roles called out from the spec.
  const underInvested: Array<{ title: string; reason: string }> = []
  for (const r of Object.values(ROLES) as RoleSpec[]) {
    if (r.underInvestmentReason) underInvested.push({ title: r.title, reason: r.underInvestmentReason })
  }

  return {
    stage:               currentStage,
    recommendedRoles:    rolesOut,
    estimatedAnnualBurn: { min: burnMin, max: burnMax, midpoint: burnMid },
    underInvestedRoles:  underInvested,
    notes,
  }
}
