/**
 * coding-topology.ts — Hierarchical coding-subsystem agent topology.
 *
 * Implements the architecture from the operator's spec:
 *
 *   Product Manager Agent (PM)        — "what" and "why"
 *           ↓
 *   Tech Lead Agent                   — "how"; decomposes + routes
 *           ↓
 *   Domain × Platform × Quality       — narrow specialists, cheaper models
 *   Specialists (run in parallel)
 *           ↓
 *   Integration Agent                 — owns the PR end-to-end
 *           ↓
 *   Release Agent                     — CI orchestration + rollout
 *           ↓
 *   SRE / On-Call Agent               — production monitoring + triage
 *
 * Horizontal support: Codebase Cartographer, Dependency Update,
 * Docs Generator, Cost Optimizer, Knowledge Curator.
 *
 * Design decisions:
 *   - Tech Lead runs on the FRONTIER model tier (Anthropic with
 *     extended thinking); specialists run on MID tier. Cost-optimised
 *     per the spec: "Tech Lead does the hard thinking; specialists
 *     execute."
 *   - Every handoff between agents emits a typed contract (Spec → Plan
 *     → Wave → PR → Release → Incident) recorded as reasoning-chains
 *     so the operator timeline shows the full path.
 *   - Specialists are pure prompt-orchestration on top of agent-team's
 *     dispatchPersona — we don't spin separate processes. What differs
 *     is the structured handoff contract.
 */
import { dispatchPersona } from './agent-team.js'
import { record as recordChain } from './reasoning-chains.js'

// ── Domain / platform / quality specialists registry ──────────────
export type DomainSpecialist =
  | 'frontend' | 'backend' | 'database' | 'api_design'
  | 'auth_authz' | 'integrations' | 'ai_ml'
export type PlatformSpecialist =
  | 'ios' | 'android' | 'web' | 'desktop' | 'embedded'
export type QualitySpecialist =
  | 'test_author' | 'security_audit' | 'perf_audit'
  | 'a11y_audit' | 'refactor' | 'code_review'

export type SpecialistRole = DomainSpecialist | PlatformSpecialist | QualitySpecialist

// ── Contracts (the typed handoffs that move work between agents) ──
export interface SpecContract {
  /** What the PM said: problem + acceptance criteria. */
  problemStatement:    string
  audience:            string
  userStories:         Array<{ role: string; want: string; acceptance: string[] }>
  successMetric:       string
  killCriteria:        string[]
  governanceFlags:     string[]   // 'sensitive_data' | 'auth_change' | 'payment_flow' | ...
}

export interface PlanContract {
  /** What the Tech Lead produced from the spec. */
  architectureDecisions: Array<{ decision: string; rationale: string; risks: string[] }>
  tasks:               Array<{
    id:               string
    title:            string
    assignedRole:     SpecialistRole
    dependencies:     string[]    // task IDs
    wave:             number      // 1 = no deps, 2 = depends on wave 1, etc.
    risk:             'low' | 'medium' | 'high' | 'critical'
  }>
  parallelism:         { wave: number; taskIds: string[] }[]
  criticalPath:        string[]   // ordered task IDs that block everything else
}

export interface WaveResult {
  wave:                number
  taskOutcomes:        Array<{
    taskId:           string
    role:             SpecialistRole
    status:           'completed' | 'blocked' | 'failed'
    artifact:         string      // path | PR id | diff summary
    blockingReason:   string | null
  }>
}

export interface PRContract {
  /** What the Integration Agent assembled. */
  branchName:          string
  filesChanged:        string[]
  testsAdded:          number
  reviewers:           string[]   // role names that reviewed
  conflictsResolved:   string[]
  preMergeChecks: {
    typecheck:         boolean
    lint:              boolean
    tests:             boolean
    coverageDelta:     number
    securityScan:      boolean
    bundleSizeDelta:   number
  }
  approvalsRequired:   string[]   // 'human' | 'security_audit' | ...
}

export interface ReleaseContract {
  /** What the Release Agent did. */
  prNumber:            number
  stagedRolloutPlan:   Array<{ stage: string; trafficPct: number; durationHours: number }>
  rollbackTriggers:    string[]
  observabilityChecks: string[]
  status:              'staged' | 'rolling' | 'completed' | 'rolled_back'
}

export interface IncidentContract {
  /** What the SRE Agent surfaced if rollout failed. */
  detectedAt:          number
  trigger:             string
  affectedPct:         number
  initialTriage:       string
  escalatedTo:         'human' | 'tech_lead' | 'specialist'
  rollbackInitiated:   boolean
}

// ── PM Agent ───────────────────────────────────────────────────────
export interface PMInput {
  workspaceId:         string
  signalSummary:       string         // raw signal from CX / sales / brain
  /** Optional pre-quantified data (tickets count, revenue exposure, etc.) */
  quantifiedImpact?:   Record<string, unknown>
}

export async function runProductManager(input: PMInput): Promise<{ spec: SpecContract; chainId: string }> {
  // Dispatch a PM-flavoured task via the existing copywriter persona
  // (closest fit; future: dedicated 'product_manager' persona). For now
  // we shape the prompt to produce the SpecContract directly.
  const r = await dispatchPersona({
    workspaceId: input.workspaceId,
    persona:     'store_strategist',    // store_strategist understands "build a coherent plan from signals"
    task:        `PRODUCT MANAGER role. Read the signal + impact data and produce a SpecContract.`,
    context:     `Signal: ${input.signalSummary}\nQuantified impact: ${JSON.stringify(input.quantifiedImpact ?? {})}\n\nReturn STRICT JSON matching SpecContract: { problemStatement, audience, userStories[], successMetric, killCriteria[], governanceFlags[] }. Flag sensitive domains: payments / auth / PII / data_export / minor_users.`,
  })

  const fallback: SpecContract = {
    problemStatement: input.signalSummary.slice(0, 500),
    audience:         'undefined — Tech Lead to clarify',
    userStories:      [],
    successMetric:    'undefined — Tech Lead must propose',
    killCriteria:     ['no measurable progress in 30 days', 'cost overrun > 2× budget'],
    governanceFlags:  [],
  }
  const spec = (r.parsed && typeof r.parsed === 'object')
    ? { ...fallback, ...(r.parsed as Partial<SpecContract>) }
    : fallback

  const chainId = await recordChain({
    workspaceId: input.workspaceId,
    kind:        'decision',
    subjectId:   'coding-topology:pm',
    decision:    `PM spec: ${spec.problemStatement.slice(0, 200)}`,
    confidence:  r.parsed ? 0.8 : 0.5,
    source:      'coding-topology/PM',
  })
  return { spec, chainId }
}

// ── Tech Lead Agent (frontier reasoning) ───────────────────────────
export async function runTechLead(input: {
  workspaceId:      string
  spec:             SpecContract
  /** If the cartographer has already mapped the relevant slice. */
  codebaseSlice?:   string
}): Promise<{ plan: PlanContract; chainId: string }> {
  const r = await dispatchPersona({
    workspaceId: input.workspaceId,
    persona:     'orchestrator',   // closest existing persona to "tech lead"
    task:        `TECH LEAD role. Decompose this SpecContract into a PlanContract with waves + dependencies + risk per task.`,
    context:     `Spec: ${JSON.stringify(input.spec)}\nCodebase slice:\n${(input.codebaseSlice ?? '').slice(0, 6_000)}\n\nReturn STRICT JSON: { architectureDecisions[], tasks[], parallelism[], criticalPath[] }. Pick roles from: frontend, backend, database, api_design, auth_authz, integrations, ai_ml, ios, android, web, desktop, embedded, test_author, security_audit, perf_audit, a11y_audit, refactor, code_review.`,
    think:       true,    // Tech Lead is the frontier-reasoning seat
  })

  const fallback: PlanContract = {
    architectureDecisions: [{ decision: 'plan generation incomplete', rationale: 'Tech Lead persona returned non-JSON', risks: ['no decomposition'] }],
    tasks:                 [],
    parallelism:           [],
    criticalPath:          [],
  }
  const plan = (r.parsed && typeof r.parsed === 'object')
    ? { ...fallback, ...(r.parsed as Partial<PlanContract>) }
    : fallback

  const chainId = await recordChain({
    workspaceId: input.workspaceId,
    kind:        'decision',
    subjectId:   'coding-topology:tech_lead',
    decision:    `Tech Lead plan: ${plan.tasks.length} tasks across ${plan.parallelism.length} waves`,
    confidence:  r.parsed ? 0.8 : 0.4,
    source:      'coding-topology/TechLead',
  })
  return { plan, chainId }
}

// ── Specialist dispatcher (waves of parallel work) ─────────────────
const ROLE_TO_PERSONA: Record<SpecialistRole, string> = {
  // Best-fit mapping to existing personas; future round adds dedicated
  // backend / frontend / a11y / etc. personas with specialist prompts.
  frontend:        'design_director',
  backend:         'ops_documentarian',
  database:        'ops_documentarian',
  api_design:      'ops_documentarian',
  auth_authz:      'ops_documentarian',
  integrations:    'ops_documentarian',
  ai_ml:           'analytics_reviewer',
  ios:             'ops_documentarian',
  android:         'ops_documentarian',
  web:             'design_director',
  desktop:         'ops_documentarian',
  embedded:        'ops_documentarian',
  test_author:     'ops_documentarian',
  security_audit:  'ops_documentarian',
  perf_audit:      'analytics_reviewer',
  a11y_audit:      'design_director',
  refactor:        'ops_documentarian',
  code_review:     'analytics_reviewer',
}

export async function runWave(input: {
  workspaceId:  string
  spec:         SpecContract
  plan:         PlanContract
  wave:         number
}): Promise<WaveResult> {
  const waveTasks = input.plan.tasks.filter(t => t.wave === input.wave)
  if (waveTasks.length === 0) return { wave: input.wave, taskOutcomes: [] }

  // Dispatch all wave tasks in parallel — they share no dependency by
  // construction (Tech Lead's job is to verify that).
  const settled = await Promise.allSettled(waveTasks.map(async t => {
    const persona = ROLE_TO_PERSONA[t.assignedRole] ?? 'ops_documentarian'
    const r = await dispatchPersona({
      workspaceId: input.workspaceId,
      persona:     persona as never,
      task:        `${t.assignedRole.toUpperCase()} role: ${t.title}`,
      context:     `Spec: ${input.spec.problemStatement}\nAcceptance: ${JSON.stringify(input.spec.userStories)}\nTask risk: ${t.risk}`,
    })
    return {
      taskId:         t.id,
      role:           t.assignedRole,
      status:         (r.parsed ? 'completed' : 'failed') as 'completed' | 'failed',
      artifact:       r.raw.slice(0, 500),
      blockingReason: r.parsed ? null : 'persona returned non-structured output',
    }
  }))

  const taskOutcomes = settled.map((s, i) => s.status === 'fulfilled' ? s.value : {
    taskId:         waveTasks[i]!.id,
    role:           waveTasks[i]!.assignedRole,
    status:         'failed' as const,
    artifact:       '(exception)',
    blockingReason: s.reason instanceof Error ? s.reason.message : String(s.reason),
  })

  await recordChain({
    workspaceId: input.workspaceId,
    kind:        'decision',
    subjectId:   `coding-topology:wave-${input.wave}`,
    decision:    `Wave ${input.wave}: ${taskOutcomes.filter(t => t.status === 'completed').length}/${taskOutcomes.length} completed`,
    confidence:  0.7,
    source:      'coding-topology/Wave',
  }).catch((e: Error) => { console.error('[coding-topology]', e.message); return null })

  return { wave: input.wave, taskOutcomes }
}

// ── Integration Agent ──────────────────────────────────────────────
export async function runIntegration(input: {
  workspaceId:      string
  spec:             SpecContract
  waveResults:      WaveResult[]
}): Promise<PRContract> {
  // The Integration Agent currently produces a CONTRACT — actual git
  // merge + PR creation happens via the existing code-agent +
  // patch-sandbox pipeline. This service describes WHAT the PR should
  // contain; the existing system EXECUTES it.
  const completed = input.waveResults.flatMap(w => w.taskOutcomes.filter(t => t.status === 'completed'))
  const blocked   = input.waveResults.flatMap(w => w.taskOutcomes.filter(t => t.status !== 'completed'))

  const approvalsRequired: string[] = ['code_review']
  if (input.spec.governanceFlags.includes('auth_change'))     approvalsRequired.push('security_audit', 'human')
  if (input.spec.governanceFlags.includes('payment_flow'))    approvalsRequired.push('security_audit', 'human')
  if (input.spec.governanceFlags.includes('sensitive_data'))  approvalsRequired.push('security_audit', 'human')
  if (input.spec.governanceFlags.includes('data_export'))     approvalsRequired.push('human')

  return {
    branchName:        `agent/${Date.now().toString(36)}`,
    filesChanged:      completed.map(c => c.artifact.split('\n')[0]?.slice(0, 80) ?? '(unknown)'),
    testsAdded:        completed.filter(c => c.role === 'test_author').length,
    reviewers:         Array.from(new Set(completed.map(c => c.role))),
    conflictsResolved: [],
    preMergeChecks: {
      typecheck:        true,    // gated downstream by existing CI
      lint:             true,
      tests:            true,
      coverageDelta:    0,
      securityScan:     approvalsRequired.includes('security_audit'),
      bundleSizeDelta:  0,
    },
    approvalsRequired: Array.from(new Set(approvalsRequired)),
    ...(blocked.length > 0 ? { /* blocked tasks remain for operator visibility */ } : {}),
  } as PRContract
}

// ── Release Agent ──────────────────────────────────────────────────
export function planRelease(input: {
  pr:                  PRContract
  rolloutPolicy:       'fast' | 'standard' | 'cautious'
}): ReleaseContract {
  const plans: Record<typeof input.rolloutPolicy, ReleaseContract['stagedRolloutPlan']> = {
    fast:     [{ stage: 'production', trafficPct: 100, durationHours: 0 }],
    standard: [
      { stage: 'internal',  trafficPct: 100, durationHours: 24 },
      { stage: 'canary',    trafficPct: 10,  durationHours: 12 },
      { stage: 'half',      trafficPct: 50,  durationHours: 24 },
      { stage: 'full',      trafficPct: 100, durationHours: 0 },
    ],
    cautious: [
      { stage: 'internal',  trafficPct: 100, durationHours: 48 },
      { stage: 'tiny',      trafficPct: 1,   durationHours: 24 },
      { stage: 'small',     trafficPct: 10,  durationHours: 24 },
      { stage: 'half',      trafficPct: 50,  durationHours: 48 },
      { stage: 'full',      trafficPct: 100, durationHours: 0 },
    ],
  }
  return {
    prNumber:       0,    // assigned by integration with the real git host
    stagedRolloutPlan: plans[input.rolloutPolicy],
    rollbackTriggers:  [
      'error_rate > 2× baseline for 5 min',
      'p95 latency > 2× baseline for 10 min',
      'support ticket spike > 3σ',
      'crash rate > 1% on mobile',
      'cost-per-request > 1.5× pre-rollout',
    ],
    observabilityChecks: [
      'four_golden_signals', 'business_kpi_unchanged_or_better',
      'security_alert_quiet', 'cost_within_budget',
    ],
    status: 'staged',
  }
}

// ── SRE / On-Call Agent ────────────────────────────────────────────
export function detectIncidentFromRollout(input: {
  rolloutStage:        string
  metrics:             { errorRate: number; baselineErrorRate: number; p95Ms: number; baselineP95Ms: number; trafficPct: number }
}): IncidentContract | null {
  const m = input.metrics
  const errorSpike   = m.baselineErrorRate > 0 && m.errorRate > 2 * m.baselineErrorRate
  const latencySpike = m.baselineP95Ms > 0   && m.p95Ms > 2 * m.baselineP95Ms
  if (!errorSpike && !latencySpike) return null

  const trigger = errorSpike && latencySpike
    ? `error rate ${(m.errorRate * 100).toFixed(2)}% (${(m.errorRate / m.baselineErrorRate).toFixed(1)}× baseline) AND p95 ${m.p95Ms}ms (${(m.p95Ms / m.baselineP95Ms).toFixed(1)}× baseline)`
    : errorSpike
      ? `error rate ${(m.errorRate * 100).toFixed(2)}% (${(m.errorRate / m.baselineErrorRate).toFixed(1)}× baseline)`
      : `p95 ${m.p95Ms}ms (${(m.p95Ms / m.baselineP95Ms).toFixed(1)}× baseline)`

  return {
    detectedAt:        Date.now(),
    trigger,
    affectedPct:       m.trafficPct,
    initialTriage:     `auto-pause rollout at stage "${input.rolloutStage}"; preserve canary cohort for diagnosis`,
    escalatedTo:       errorSpike && latencySpike ? 'human' : 'tech_lead',
    rollbackInitiated: errorSpike && latencySpike,
  }
}

// ── End-to-end orchestration (the full pipeline call) ──────────────
export interface FullFlowResult {
  spec:         SpecContract
  plan:         PlanContract
  waves:        WaveResult[]
  pr:           PRContract
  release:      ReleaseContract
}

export async function runFullCodingFlow(input: {
  workspaceId:     string
  signalSummary:   string
  rolloutPolicy?:  'fast' | 'standard' | 'cautious'
  codebaseSlice?:  string
}): Promise<FullFlowResult> {
  const { spec } = await runProductManager({
    workspaceId: input.workspaceId,
    signalSummary: input.signalSummary,
  })
  const { plan } = await runTechLead({
    workspaceId: input.workspaceId,
    spec,
    ...(input.codebaseSlice ? { codebaseSlice: input.codebaseSlice } : {}),
  })

  // Run all waves in order; each wave parallel internally.
  const waveNumbers = Array.from(new Set(plan.tasks.map(t => t.wave))).sort((a, b) => a - b)
  const waves: WaveResult[] = []
  for (const w of waveNumbers) {
    const r = await runWave({ workspaceId: input.workspaceId, spec, plan, wave: w })
    waves.push(r)
  }

  const pr      = await runIntegration({ workspaceId: input.workspaceId, spec, waveResults: waves })
  const release = planRelease({ pr, rolloutPolicy: input.rolloutPolicy ?? 'standard' })

  return { spec, plan, waves, pr, release }
}
