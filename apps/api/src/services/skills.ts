/**
 * skills.ts — Skill registry + execution + gap detection.
 *
 * A skill is a reusable, named workflow that wraps existing services with
 * declared inputs/outputs/safety rules. Skills are operator-visible and
 * versioned. Risky skills require approval before each execution.
 *
 * Honesty:
 *   - Skill execution is a router that dispatches to real services
 *     based on the skill's action steps. No fake execution.
 *   - Skills start in 'draft' status; promotion to 'verified' or
 *     'production' requires explicit operator action.
 *   - Failed executions write to failure_memory.
 */
import { db }                          from '../db/client.js'
import { skills, events, failureMemory } from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

export type SkillCategory =
  | 'research' | 'image' | 'deployment' | 'security'
  | 'patch' | 'debug' | 'report' | 'analysis' | 'ui' | 'incident'

export type RiskLevel = 'low' | 'medium' | 'high'

export interface SkillStep {
  action:     string                  // 'research.run_topic' | 'image.generate' | 'briefing.daily' | etc.
  params:     Record<string, unknown>
}

export interface SkillDefinition {
  name:        string
  slug:        string
  purpose:     string
  category:    SkillCategory
  riskLevel:   RiskLevel
  inputs:      Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'object'; required: boolean }>
  outputs:     Array<{ name: string; type: string }>
  steps:       SkillStep[]
  safetyRules: string[]
  rollbackBehavior?: string
  verificationRequirements?: Array<{ check: string; description: string }>
  ownerAgentType?: string
}

// ─── Built-in skill catalog (operator can clone + customize) ─────────────────

export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: 'Daily Briefing',
    slug: 'daily-briefing',
    purpose: 'Generate and emit the daily executive briefing now',
    category: 'report', riskLevel: 'low',
    inputs:  [],
    outputs: [{ name: 'briefing', type: 'object' }],
    steps:   [{ action: 'briefing.daily', params: {} }],
    safetyRules: ['read-only', 'no external write'],
    ownerAgentType: 'mission_planner',
  },
  {
    name: 'Research Topic',
    slug: 'research-topic',
    purpose: 'Run a research topic (Tavily auto-discovery + Groq extraction)',
    category: 'research', riskLevel: 'low',
    inputs: [
      { name: 'topic',           type: 'string', required: true },
      { name: 'approved_sources', type: 'object', required: false },
    ],
    outputs: [{ name: 'findings_count', type: 'number' }],
    steps: [
      { action: 'research.create_topic', params: { __from: ['topic', 'approved_sources'] } },
      { action: 'research.run_topic',    params: { __useResult: 'topicId' } },
    ],
    safetyRules: ['robots.txt enforced', 'SSRF blocked', 'unsafe-task blocklist'],
    ownerAgentType: 'web_research',
  },
  {
    name: 'Generate Image',
    slug: 'generate-image',
    purpose: 'Generate one image via smart router with budget cap',
    category: 'image', riskLevel: 'low',
    inputs: [
      { name: 'prompt',         type: 'string', required: true },
      { name: 'aspect_ratio',   type: 'string', required: false },
      { name: 'budget_cap_usd', type: 'number', required: false },
    ],
    outputs: [{ name: 'image_url', type: 'string' }],
    steps: [{ action: 'image.generate', params: { __from: ['prompt', 'aspect_ratio', 'budget_cap_usd'] } }],
    safetyRules: ['budget cap enforced', 'unsafe-prompt blocklist', 'secrets redacted'],
    rollbackBehavior: 'no rollback needed — generation is non-destructive',
    ownerAgentType: 'web_research',
  },
  {
    name: 'Weekly Roadmap Review',
    slug: 'weekly-roadmap-review',
    purpose: 'Run the weekly operational report',
    category: 'report', riskLevel: 'low',
    inputs: [],
    outputs: [{ name: 'report', type: 'object' }],
    steps: [{ action: 'briefing.weekly', params: {} }],
    safetyRules: ['read-only'],
    ownerAgentType: 'mission_planner',
  },
  {
    name: 'Capability Gap Scan',
    slug: 'capability-gap-scan',
    purpose: 'Detect missing capabilities and propose build plans',
    category: 'analysis', riskLevel: 'low',
    inputs: [],
    outputs: [{ name: 'gaps_count', type: 'number' }, { name: 'planned_tasks', type: 'number' }],
    steps: [
      { action: 'capability.detect_gaps', params: {} },
      { action: 'capability.plan_all_buildable', params: {} },
    ],
    safetyRules: ['read-only detection', 'plans land in roadmap_tasks (approval required for schema changes)'],
    ownerAgentType: 'mission_planner',
  },
  {
    name: 'Stability Snapshot',
    slug: 'stability-snapshot',
    purpose: 'Read current platform stability indicators',
    category: 'analysis', riskLevel: 'low',
    inputs: [],
    outputs: [{ name: 'overall', type: 'string' }, { name: 'unstable_count', type: 'number' }],
    steps: [{ action: 'governance.stability_snapshot', params: {} }],
    safetyRules: ['read-only'],
    ownerAgentType: 'reliability_engineer',
  },
]

// ─── Skill registry ─────────────────────────────────────────────────────────

export async function seedBuiltinSkills(workspaceId: string): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0
  const now = Date.now()
  for (const def of BUILTIN_SKILLS) {
    const existing = await db.select({ id: skills.id }).from(skills)
      .where(and(eq(skills.workspaceId, workspaceId), eq(skills.slug, def.slug)))
      .limit(1).then(r => r[0]).catch(() => null)
    if (existing) { skipped++; continue }
    await db.insert(skills).values({
      id:              uuidv7(),
      workspaceId,
      name:            def.name,
      slug:            def.slug,
      purpose:         def.purpose,
      category:        def.category,
      version:         1,
      ownerAgentType:  def.ownerAgentType ?? null,
      riskLevel:       def.riskLevel,
      requiresApproval: def.riskLevel === 'high',
      inputs:          def.inputs as never,
      outputs:         def.outputs as never,
      steps:           def.steps as never,
      safetyRules:     def.safetyRules,
      rollbackBehavior: def.rollbackBehavior ?? null,
      verificationRequirements: (def.verificationRequirements ?? []) as never,
      status:          'verified',   // built-ins are pre-verified
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing().catch(() => null)
    created++
  }
  return { created, skipped }
}

export async function listSkills(workspaceId: string, opts?: { status?: string; category?: SkillCategory }) {
  const conds = [eq(skills.workspaceId, workspaceId)]
  if (opts?.status)   conds.push(eq(skills.status, opts.status))
  if (opts?.category) conds.push(eq(skills.category, opts.category))
  return db.select().from(skills)
    .where(and(...conds))
    .orderBy(desc(skills.successCount))
    .catch(() => [])
}

export async function getSkill(workspaceId: string, slug: string) {
  return db.select().from(skills)
    .where(and(eq(skills.workspaceId, workspaceId), eq(skills.slug, slug)))
    .limit(1).then(r => r[0]).catch(() => null)
}

// ─── Skill execution router ──────────────────────────────────────────────────

export interface ExecuteResult {
  skillSlug:  string
  status:     'succeeded' | 'failed' | 'blocked'
  outputs?:   Record<string, unknown>
  steps:      Array<{ action: string; status: 'ok' | 'failed' | 'skipped'; output?: unknown; error?: string; durationMs: number }>
  totalDurationMs: number
  errorMessage?: string
}

export async function executeSkill(workspaceId: string, slug: string, inputs: Record<string, unknown>): Promise<ExecuteResult> {
  const skill = await getSkill(workspaceId, slug)
  if (!skill) return { skillSlug: slug, status: 'failed', steps: [], totalDurationMs: 0, errorMessage: `skill '${slug}' not found` }

  const start = Date.now()
  const steps: ExecuteResult['steps'] = []
  const outputs: Record<string, unknown> = {}

  // Emit start event
  await db.insert(events).values({
    id: uuidv7(), type: 'skill.execution_started', workspaceId,
    payload: { skillId: skill.id, slug, riskLevel: skill.riskLevel, inputs },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'skills', version: 1, createdAt: Date.now(),
  }).catch(() => null)

  // Risk gate
  if (skill.requiresApproval) {
    const blocked: ExecuteResult = {
      skillSlug: slug, status: 'blocked', steps: [], totalDurationMs: 0,
      errorMessage: 'Skill requires approval — operator must approve before execution. Use POST /skills/:slug/approve.',
    }
    await db.insert(events).values({
      id: uuidv7(), type: 'skill.execution_blocked', workspaceId,
      payload: { skillId: skill.id, slug, reason: 'requires_approval' },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'skills', version: 1, createdAt: Date.now(),
    }).catch(() => null)
    return blocked
  }

  // Step dispatcher — wires actions to existing services
  for (const stepDef of (skill.steps as unknown as SkillStep[])) {
    const stepStart = Date.now()
    try {
      const resolvedParams = resolveParams(stepDef.params, inputs, outputs)
      const output = await dispatchAction(workspaceId, stepDef.action, resolvedParams)
      Object.assign(outputs, typeof output === 'object' && output !== null ? output as Record<string, unknown> : { result: output })
      steps.push({ action: stepDef.action, status: 'ok', output, durationMs: Date.now() - stepStart })
    } catch (e) {
      const msg = (e as Error).message
      steps.push({ action: stepDef.action, status: 'failed', error: msg, durationMs: Date.now() - stepStart })
      // Record failure (target_ref + target_kind are required)
      await db.insert(failureMemory).values({
        id: uuidv7(), workspaceId,
        agentId: null,
        failureType: 'skill_execution',
        rootCauseClass: 'unknown',
        targetRef: `skill:${slug}`,
        targetKind: 'skill',
        signature: `skill:${slug}:${stepDef.action}:${msg.slice(0, 80)}`,
        errorPattern: msg.slice(0, 500),
        occurrenceCount: 1,
        evidenceIds: [],
        attemptedFixIds: [],
        blocked: false,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }).onConflictDoNothing().catch(() => null)

      // Update failure count + emit
      await db.update(skills).set({
        failureCount: sql`${skills.failureCount} + 1`,
        lastUsedAt:   Date.now(),
        updatedAt:    Date.now(),
      }).where(eq(skills.id, skill.id)).catch(() => null)

      await db.insert(events).values({
        id: uuidv7(), type: 'skill.execution_failed', workspaceId,
        payload: { skillId: skill.id, slug, action: stepDef.action, error: msg },
        traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
        source: 'skills', version: 1, createdAt: Date.now(),
      }).catch(() => null)

      return {
        skillSlug: slug, status: 'failed', outputs, steps,
        totalDurationMs: Date.now() - start, errorMessage: msg,
      }
    }
  }

  const totalDurationMs = Date.now() - start
  await db.update(skills).set({
    successCount: sql`${skills.successCount} + 1`,
    lastUsedAt:   Date.now(),
    avgDurationMs: skill.avgDurationMs
      ? Math.round((skill.avgDurationMs * Number(skill.successCount) + totalDurationMs) / (Number(skill.successCount) + 1))
      : totalDurationMs,
    updatedAt:    Date.now(),
  }).where(eq(skills.id, skill.id)).catch(() => null)

  await db.insert(events).values({
    id: uuidv7(), type: 'skill.execution_succeeded', workspaceId,
    payload: { skillId: skill.id, slug, durationMs: totalDurationMs, outputs },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'skills', version: 1, createdAt: Date.now(),
  }).catch(() => null)

  return { skillSlug: slug, status: 'succeeded', outputs, steps, totalDurationMs }
}

function resolveParams(params: Record<string, unknown>, inputs: Record<string, unknown>, priorOutputs: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...params }
  // __from: pluck these keys from inputs
  if (Array.isArray(resolved['__from'])) {
    for (const key of resolved['__from'] as string[]) {
      if (inputs[key] !== undefined) resolved[key] = inputs[key]
    }
    delete resolved['__from']
  }
  // __useResult: pluck this key from prior step outputs
  if (typeof resolved['__useResult'] === 'string') {
    const k = resolved['__useResult'] as string
    if (priorOutputs[k] !== undefined) resolved[k] = priorOutputs[k]
    delete resolved['__useResult']
  }
  // Also inline merge inputs that aren't explicit
  for (const [k, v] of Object.entries(inputs)) {
    if (!(k in resolved)) resolved[k] = v
  }
  return resolved
}

/** Action dispatcher — maps skill step actions to real service calls. */
async function dispatchAction(workspaceId: string, action: string, params: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'briefing.daily': {
      const { generateDailyReview } = await import('./daily-review.js')
      return { briefing: await generateDailyReview(workspaceId) }
    }
    case 'briefing.weekly': {
      const { weeklyOperationalReport } = await import('./executive-briefings.js')
      return { report: await weeklyOperationalReport(workspaceId) }
    }
    case 'research.create_topic': {
      const { createTopic } = await import('./research-engine.js')
      const id = await createTopic({
        workspaceId,
        topic: String(params['topic']),
        approvedSources: (params['approved_sources'] as string[] | undefined) ?? [],
      })
      return { topicId: id }
    }
    case 'research.run_topic': {
      const { runTopic } = await import('./research-engine.js')
      const result = await runTopic(String(params['topicId']))
      return { findings_count: result.findingsAdded, result }
    }
    case 'image.generate': {
      const { generateImage } = await import('./image-generator.js')
      const { selectProvider } = await import('./image-router.js')
      const route = await selectProvider({ workspaceId, ...(params['aspect_ratio'] ? { aspectRatio: params['aspect_ratio'] as string } : {}) })
      const r = await generateImage({
        workspaceId,
        prompt: String(params['prompt']),
        provider: route.provider,
        routerProvenance: route.provenance,
        ...(params['aspect_ratio']   ? { aspectRatio:  params['aspect_ratio'] as string } : {}),
        ...(params['budget_cap_usd'] ? { budgetCapUsd: params['budget_cap_usd'] as number } : {}),
      })
      if (r.status !== 'succeeded') throw new Error(r.errorMessage ?? `image generation ${r.status}`)
      return { image_url: r.imageUrl }
    }
    case 'capability.detect_gaps': {
      const { detectGaps } = await import('./capability-gap-detector.js')
      const g = await detectGaps(workspaceId)
      return { gaps_count: g.length, gaps: g.map(x => ({ id: x.id, maturity: x.maturity })) }
    }
    case 'capability.plan_all_buildable': {
      const { planAllGaps } = await import('./self-build-planner.js')
      const r = await planAllGaps(workspaceId, { onlyVerdicts: ['build', 'hybrid'] })
      return { planned_tasks: r.totalTasksCreated, plans: r.planned.length }
    }
    case 'governance.stability_snapshot': {
      const { stabilitySnapshot } = await import('./governance-core.js')
      const s = await stabilitySnapshot(workspaceId)
      return { overall: s.overall, unstable_count: s.indicators.filter(i => i.unstable).length, snapshot: s }
    }
    default:
      throw new Error(`Unknown skill action: ${action}`)
  }
}

// ─── Skill gap detector ──────────────────────────────────────────────────────

/**
 * Look for event-type clusters that suggest a repeated workflow exists
 * but isn't packaged as a skill. Honest: only surfaces patterns that
 * actually occur ≥3 times in recent history.
 */
export interface SkillGap {
  pattern:        string
  occurrences:    number
  exampleEvents:  string[]
  suggestedSkill: { name: string; category: SkillCategory; reason: string }
}

export async function detectSkillGaps(workspaceId: string): Promise<SkillGap[]> {
  const dayAgo = Date.now() - 7 * 24 * 60 * 60_000
  const counts = await db.select({
    type: events.type,
    c: sql<number>`count(*)::int`,
  }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, dayAgo)))
    .groupBy(events.type)
    .orderBy(desc(sql`count(*)`))
    .catch(() => [])

  const existingSkillSlugs = new Set((await listSkills(workspaceId)).map(s => s.slug))
  const gaps: SkillGap[] = []

  // Heuristic: repeated event types (≥3) that don't have a skill
  for (const c of counts) {
    if (Number(c.c) < 3) continue
    const t = c.type
    // Filter out noisy cron events
    if (t.startsWith('cron.')) continue
    if (t.startsWith('governance.')) continue
    if (t === 'web_fetch.completed') continue

    let suggested: SkillGap['suggestedSkill'] | null = null
    if (t.startsWith('research.') && !existingSkillSlugs.has('research-topic')) {
      suggested = { name: 'Research Topic', category: 'research', reason: 'Repeated research events without packaged skill' }
    } else if (t === 'image.generation_completed' && !existingSkillSlugs.has('generate-image')) {
      suggested = { name: 'Generate Image', category: 'image', reason: 'Image generation pattern repeated' }
    } else if (t === 'patch.applied' && !existingSkillSlugs.has('patch-apply')) {
      suggested = { name: 'Apply Patch (verified)', category: 'patch', reason: 'Patch application repeats — wrap with verification skill' }
    } else if (t === 'incident.opened' && !existingSkillSlugs.has('incident-triage')) {
      suggested = { name: 'Incident Triage', category: 'incident', reason: 'Incident pattern repeats — wrap triage workflow' }
    }

    if (suggested) {
      gaps.push({
        pattern: t, occurrences: Number(c.c),
        exampleEvents: [t],
        suggestedSkill: suggested,
      })
    }
  }
  return gaps
}
