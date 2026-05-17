/**
 * self-build-planner.ts — Convert a capability gap into an approval-gated
 * build plan.
 *
 * Outputs structured roadmap_tasks entries (the existing table). Does NOT
 * auto-execute — high-risk planning intents already get hard-blocked or
 * approval-required by governance-core. This planner just generates the
 * proposal.
 */
import crypto                          from 'node:crypto'
import { db }                          from '../db/client.js'
import { roadmapTasks, agents, events } from '../db/schema.js'
import { and, eq, sql }                from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'
import {
  detectCapabilities, type CapabilityStatus, type CapabilityDef,
  CAPABILITY_REGISTRY,
} from './capability-gap-detector.js'

/** Agent role types that should be assigned to a build plan. */
export const BUILD_ROLES = [
  'runtime_architect',   // designs the architecture
  'backend_engineer',    // implements service + routes
  'frontend_engineer',   // implements UI (when present)
  'reliability_engineer',// failure modes + retries + rollback
  'qa_engineer',         // tests
  'reviewer',            // pre-merge review
  'chief_security',      // security review (always assigned on protected paths)
] as const

export interface BuildTask {
  title:        string
  description:  string
  phase:        'immediate' | 'near_term' | 'backlog'
  category:     string
  impact:       number   // 1..5
  risk:         number   // 1..5
  requiresApproval: boolean
  assignedAgent?: string
}

export interface BuildPlan {
  capabilityId:  string
  capabilityTitle: string
  rationale:     string
  buildVsBuy:    CapabilityStatus['buildVsBuy']
  architecture:  {
    services:    string[]  // expected files under services/
    routes:      string[]
    tables:      string[]
    ui:          string[]
    workers:     string[]
  }
  tasks:         BuildTask[]
  agentAssignments: Array<{ role: typeof BUILD_ROLES[number]; agentId: string | null }>
  rolloutPlan:   string[]
  rollbackPlan:  string[]
  approvalsRequired: string[]   // human-readable approval gates
}

// ─── Architecture templates (concrete proposals per known capability) ──────

const ARCHITECTURE_BY_CAPABILITY: Record<string, BuildPlan['architecture']> = {
  js_rendering_fetcher: {
    services: ['playwright-fetcher.ts'],
    routes:   [],
    tables:   [],
    ui:       [],
    workers:  ['playwright-worker.ts (remote)'],
  },
  red_team_runtime: {
    services: ['red-team.ts'],
    routes:   ['red-team.ts'],
    tables:   ['red_team_runs', 'red_team_findings'],
    ui:       ['RedTeamPage.tsx'],
    workers:  [],
  },
  private_image_model: {
    services: ['private-image-model-client.ts'],
    routes:   [],
    tables:   ['private_image_models'],
    ui:       [],
    workers:  ['model-server (out-of-process GPU host)'],
  },
  gpu_inference_endpoint: {
    services: ['gpu-inference-client.ts'],
    routes:   [],
    tables:   ['gpu_models'],
    ui:       [],
    workers:  ['gpu-inference-server (out-of-process)'],
  },
}

function defaultArchitecture(c: CapabilityDef): BuildPlan['architecture'] {
  // Generic fallback: name the file after the capability id
  return {
    services: c.signals.serviceFile ? [c.signals.serviceFile] : [`${c.id.replace(/_/g, '-')}.ts`],
    routes:   c.signals.routeFile   ? [c.signals.routeFile]   : [],
    tables:   [],
    ui:       [],
    workers:  [],
  }
}

// ─── Approval gates per kind ────────────────────────────────────────────────

function approvalsRequiredFor(c: CapabilityDef): string[] {
  const a: string[] = []
  if (c.dimension === 'security') a.push('security:review')
  if (c.dimension === 'business_operations') a.push('billing:review')
  if (c.buildVsBuy.runtimeRiskIfBuilt >= 0.7) a.push('reliability:review')
  if (c.id === 'private_image_model' || c.id === 'gpu_inference_endpoint') a.push('infra:gpu-spend')
  // Always require schema-change approval if tables are proposed
  const arch = ARCHITECTURE_BY_CAPABILITY[c.id] ?? defaultArchitecture(c)
  if (arch.tables.length > 0) a.push('db:schema-change')
  return a
}

// ─── Agent assignment ───────────────────────────────────────────────────────

async function pickAgent(workspaceId: string, role: typeof BUILD_ROLES[number]): Promise<string | null> {
  const row = await db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.type, role)))
    .limit(1).then(r => r[0]).catch(() => null)
  return row?.id ?? null
}

// ─── Build plan generator ──────────────────────────────────────────────────

export async function planBuild(workspaceId: string, capabilityId: string): Promise<BuildPlan | null> {
  const def = CAPABILITY_REGISTRY.find(c => c.id === capabilityId)
  if (!def) return null

  const arch = ARCHITECTURE_BY_CAPABILITY[capabilityId] ?? defaultArchitecture(def)
  const approvals = approvalsRequiredFor(def)

  // Compose tasks
  const tasks: BuildTask[] = []
  // 1. Architecture sketch
  tasks.push({
    title: `Sketch architecture for ${def.title}`,
    description: `Design service module(s), table schema, route shape, UI surface. Capture trade-offs vs buying.`,
    phase: 'immediate', category: 'design', impact: 3, risk: 1,
    requiresApproval: false,
  })

  // 2. Schema (if any tables)
  if (arch.tables.length > 0) {
    tasks.push({
      title: `Add schema tables: ${arch.tables.join(', ')}`,
      description: 'Define columns + indexes in packages/db/src/schema.ts. Push via drizzle-kit. ALL schema changes require approval.',
      phase: 'immediate', category: 'schema', impact: 4, risk: 4,
      requiresApproval: true,
    })
  }

  // 3. Backend service
  if (arch.services.length > 0) {
    tasks.push({
      title: `Implement service: ${arch.services.join(', ')}`,
      description: 'Backend service with real provider drivers (no fakes). Emit runtime events at every meaningful step.',
      phase: 'immediate', category: 'backend', impact: 4, risk: 2,
      requiresApproval: false,
    })
  }

  // 4. Routes
  if (arch.routes.length > 0) {
    tasks.push({
      title: `Expose routes: ${arch.routes.join(', ')}`,
      description: 'Wire Fastify routes with input validation, error handling, and workspace_id auth.',
      phase: 'immediate', category: 'backend', impact: 3, risk: 2,
      requiresApproval: false,
    })
  }

  // 5. UI
  if (arch.ui.length > 0) {
    tasks.push({
      title: `Build UI: ${arch.ui.join(', ')}`,
      description: 'Premium minimal layout. Consume new endpoints. WorkspaceContext-aware.',
      phase: 'near_term', category: 'frontend', impact: 3, risk: 1,
      requiresApproval: false,
    })
  }

  // 6. Tests
  tasks.push({
    title: `Tests for ${def.title}`,
    description: 'Smoke tests + edge cases. Reach existing 469+ test baseline without regressing.',
    phase: 'near_term', category: 'testing', impact: 3, risk: 1,
    requiresApproval: false,
  })

  // 7. Safety review (if security-sensitive)
  if (def.dimension === 'security' || approvals.includes('security:review')) {
    tasks.push({
      title: `Security review of ${def.title}`,
      description: 'AppSec + Tenant-Isolation review. Verify all autonomy boundary calls + secret handling.',
      phase: 'near_term', category: 'security', impact: 4, risk: 3,
      requiresApproval: true,
    })
  }

  // 8. Rollout + telemetry
  tasks.push({
    title: `Rollout + telemetry for ${def.title}`,
    description: 'Feature flag, gradual enable, telemetry coverage, rollback steps documented.',
    phase: 'near_term', category: 'reliability', impact: 3, risk: 2,
    requiresApproval: def.buildVsBuy.runtimeRiskIfBuilt >= 0.7,
  })

  // Agent assignments — best-effort, returns null when role isn't seeded yet
  const roles: Array<typeof BUILD_ROLES[number]> = ['runtime_architect', 'backend_engineer', 'reliability_engineer', 'qa_engineer', 'reviewer']
  if (arch.ui.length > 0) roles.push('frontend_engineer')
  if (def.dimension === 'security' || approvals.includes('security:review')) roles.push('chief_security')

  const agentAssignments = await Promise.all(roles.map(async (role) => ({
    role, agentId: await pickAgent(workspaceId, role),
  })))

  // Plug agent IDs into tasks by role hint in title
  function pick(role: typeof BUILD_ROLES[number]): string | undefined {
    return agentAssignments.find(a => a.role === role)?.agentId ?? undefined
  }
  for (const t of tasks) {
    let id: string | undefined
    if (t.category === 'design')        id = pick('runtime_architect')
    else if (t.category === 'backend')  id = pick('backend_engineer')
    else if (t.category === 'frontend') id = pick('frontend_engineer')
    else if (t.category === 'testing')  id = pick('qa_engineer')
    else if (t.category === 'security') id = pick('chief_security')
    else if (t.category === 'reliability') id = pick('reliability_engineer')
    if (id !== undefined) t.assignedAgent = id
  }

  const bvb = (await detectCapabilities(workspaceId)).find(c => c.id === capabilityId)!.buildVsBuy

  return {
    capabilityId,
    capabilityTitle: def.title,
    rationale: `${def.description}. Verdict: ${bvb.verdict.toUpperCase()} — ${bvb.rationale}.`,
    buildVsBuy: bvb,
    architecture: arch,
    tasks, agentAssignments,
    rolloutPlan: [
      'Land changes behind feature flag (default off).',
      'Smoke test in single workspace.',
      'Operator approves enabling for all workspaces.',
      'Monitor 24h via daily review.',
    ],
    rollbackPlan: [
      'Disable feature flag — no DB rollback needed.',
      'If schema added: prepare reverse-migration before merge.',
      'patch-executor rollback restores file state.',
    ],
    approvalsRequired: approvals,
  }
}

/** Persist a plan as roadmap_tasks rows. Idempotent via recommendationId. */
export async function persistPlan(workspaceId: string, plan: BuildPlan): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0
  const now = Date.now()
  const recoBase = `capability:${plan.capabilityId}`

  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i]!
    const recoId = `${recoBase}:${i}:${crypto.createHash('sha256').update(t.title).digest('hex').slice(0, 12)}`
    const existing = await db.select({ id: roadmapTasks.id }).from(roadmapTasks)
      .where(and(eq(roadmapTasks.workspaceId, workspaceId), eq(roadmapTasks.recommendationId, recoId)))
      .limit(1).then(r => r[0]).catch(() => null)
    if (existing) { skipped++; continue }

    const priorityScore = Math.round(t.impact * 20 - t.risk * 5 + (t.phase === 'immediate' ? 30 : t.phase === 'near_term' ? 15 : 0))
    await db.insert(roadmapTasks).values({
      id: uuidv7(),
      workspaceId,
      recommendationId: recoId,
      phase: t.phase,
      title: t.title,
      description: t.description,
      category: t.category,
      impact: t.impact,
      risk: t.risk,
      priorityScore,
      assignedAgent:   t.assignedAgent ?? null,
      requiresApproval: t.requiresApproval,
      status: 'pending',
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing().catch(() => null)
    created++
  }

  if (created > 0) {
    await db.insert(events).values({
      id: uuidv7(), type: 'self_build.plan_persisted', workspaceId,
      payload: {
        capabilityId:  plan.capabilityId,
        tasks:         created,
        approvals:     plan.approvalsRequired,
        verdict:       plan.buildVsBuy.verdict,
      },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'self-build-planner', version: 1, createdAt: now,
    }).catch(() => null)
  }
  return { created, skipped }
}

/** Convenience: detect gaps, plan each, persist. Returns full summary. */
export async function planAllGaps(workspaceId: string, opts?: { onlyVerdicts?: Array<'build' | 'hybrid'> }): Promise<{
  planned: BuildPlan[]
  totalTasksCreated: number
  skipped: Array<{ capabilityId: string; reason: string }>
}> {
  const all = await detectCapabilities(workspaceId)
  const gaps = all.filter(c => c.maturity === 'missing' || c.maturity === 'scaffolded')
  const verdictFilter = opts?.onlyVerdicts ?? ['build', 'hybrid']
  const planned: BuildPlan[] = []
  const skipped: Array<{ capabilityId: string; reason: string }> = []
  let totalTasksCreated = 0

  for (const g of gaps) {
    if (!verdictFilter.includes(g.buildVsBuy.verdict as 'build' | 'hybrid')) {
      skipped.push({ capabilityId: g.id, reason: `verdict=${g.buildVsBuy.verdict} (filtered)` })
      continue
    }
    const plan = await planBuild(workspaceId, g.id)
    if (!plan) { skipped.push({ capabilityId: g.id, reason: 'no plan template' }); continue }
    planned.push(plan)
    const r = await persistPlan(workspaceId, plan)
    totalTasksCreated += r.created
  }
  return { planned, totalTasksCreated, skipped }
}
