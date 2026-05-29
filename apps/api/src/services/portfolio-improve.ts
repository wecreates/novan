/**
 * portfolio-improve.ts — The continuous-improvement loop, callable.
 *
 * This is the high-level op the operator (or autonomous-mind cron) calls
 * once a week to get a concrete, actionable plan toward closing the
 * $10k/mo-per-business gap. It composes the existing pieces:
 *
 *   1. portfolio.weeklyReview      — what's behind / on track / candidate sunset
 *   2. playbook-knowledge.consult  — what the relevant playbook says about it
 *   3. LLM call (cheap, structured) — produce 3–5 concrete next steps
 *   4. queue-as-tasks              — caller can hand each step to brain.task
 *
 * The output is intentionally NOT a free-text essay. It's a structured
 * list of {action, rationale, expectedImpact, suggestedOp?} entries the
 * operator can approve one at a time. Free-text plans get ignored;
 * structured action lists get done.
 *
 * Honest scope: the LLM step is conservative. It does not invent new
 * niches or revenue mechanisms — it picks from the playbook's action
 * vocabulary and recommends the highest-leverage application of that
 * vocabulary to the current portfolio state.
 */
import { weeklyReview, type BusinessStatus } from './business-portfolio.js'
import { findRelevantSections } from './playbook-knowledge.js'
import { streamChat } from './chat-providers.js'

export interface ImproveStep {
  action:          string
  rationale:       string
  expectedImpact:  string
  suggestedOp?:    string         // brain-task op name the operator can fire
  suggestedParams?: Record<string, unknown>
  businessId?:     string
  priority:        'high' | 'medium' | 'low'
}

export interface ImprovePlan {
  workspaceId:        string
  generatedAt:        number
  reviewSummary: {
    businessCount:     number
    totalMonthlyUsd:   number
    totalTargetUsd:    number
    gapUsd:            number
    underperformingCount: number
  }
  steps:           ImproveStep[]
  honestCaveats:   string[]    // explicit limits the operator should remember
}

/**
 * Produce a structured weekly action plan for one workspace.
 * Side-effect free (no DB writes); the caller decides whether to enqueue
 * the steps as brain.tasks.
 */
export async function improvePlan(workspaceId: string): Promise<ImprovePlan> {
  const review = await weeklyReview(workspaceId)
  const gap    = Math.max(0, review.totalTargetUsd - review.totalMonthlyUsd)

  // Cap LLM analysis to the top 3 underperformers + top 1 on-track (for
  // diversification advice). Sending all 30 to the LLM blows context
  // budget without improving plan quality.
  const focus = [
    ...review.underperforming.slice(0, 3),
    ...review.onTrack.slice(0, 1),
  ]

  // Aggregate the playbook reference material relevant to the focus
  // businesses' categories. Each category maps to a playbook slug; we
  // pull the top section per slug.
  const categoryTopics = unique(focus.map(b => categoryTopic(b)))
  const refs: Array<{ title: string; section: string; body: string }> = []
  for (const t of categoryTopics) {
    const sections = await findRelevantSections(t, 1)
    if (sections[0]) {
      refs.push({
        title:   sections[0].title,
        section: sections[0].section,
        // Cap each playbook block at 1200 chars so 4 categories fit
        // comfortably inside the LLM context budget.
        body:    sections[0].body.slice(0, 1200),
      })
    }
  }

  const llmSteps = await askLlmForSteps(workspaceId, review, focus, refs)

  // Final plan always includes at least one structural step even if the
  // LLM returns nothing useful — so the operator never sees an empty plan.
  const fallbackSteps: ImproveStep[] = []
  if (llmSteps.length === 0 && review.businessCount === 0) {
    fallbackSteps.push({
      action: 'Create your first business',
      rationale: 'No businesses tracked yet. The brain needs a concrete revenue unit before it can plan toward $10k/mo.',
      expectedImpact: 'unblocks the planning loop entirely',
      suggestedOp: 'business.create',
      suggestedParams: { name: '(your brand name)', category: 'youtube | pod | social | newsletter' },
      priority: 'high',
    })
  }
  if (llmSteps.length === 0 && review.underperforming.length > 0) {
    for (const u of review.underperforming.slice(0, 3)) {
      fallbackSteps.push({
        action: `Run a format pivot proposal for "${u.name}"`,
        rationale: `Last 30d = $${u.last30DaysUsd.toFixed(0)} vs $${u.monthlyTargetUsd} target. Trajectory ($${u.trajectoryUsd.toFixed(0)}/mo) is also short — the current format isn't converging on goal.`,
        expectedImpact: 'identifies whether the niche is wrong (sunset) or the format is wrong (pivot)',
        suggestedOp: 'portfolio.status',
        suggestedParams: { businessId: u.id },
        businessId: u.id,
        priority: 'high',
      })
    }
  }

  return {
    workspaceId,
    generatedAt: Date.now(),
    reviewSummary: {
      businessCount:        review.businessCount,
      totalMonthlyUsd:      review.totalMonthlyUsd,
      totalTargetUsd:       review.totalTargetUsd,
      gapUsd:               gap,
      underperformingCount: review.underperforming.length,
    },
    steps: llmSteps.length > 0 ? llmSteps : fallbackSteps,
    honestCaveats: [
      'These steps are derived from the playbooks + your current portfolio state. They are not guarantees of revenue outcomes.',
      'Real revenue depends on niche/algorithm/timing factors outside the brain\'s control.',
      'High-risk steps (publish, ad spend changes, sunset) require your approval before the brain executes them.',
      review.businessCount === 0
        ? 'You have zero businesses tracked — create one and record some revenue before the brain can give useful weekly plans.'
        : `Current trajectory will hit ~$${(review.totalMonthlyUsd * 1.25).toFixed(0)}/mo on autopilot. Closing the $${gap.toFixed(0)}/mo gap to $${review.totalTargetUsd}/mo requires structural changes, not just more output.`,
    ],
  }
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

function categoryTopic(b: BusinessStatus): string {
  const c = (b.category || '').toLowerCase()
  if (c.includes('youtube') || c.includes('video')) return 'YouTube channel growth and monetization'
  if (c.includes('pod') || c.includes('etsy') || c.includes('shop')) return 'Etsy print-on-demand listing optimization'
  if (c.includes('social') || c.includes('tiktok') || c.includes('reel')) return 'TikTok and Instagram Reels engagement'
  if (c.includes('newsletter') || c.includes('email')) return 'newsletter monetization and audience growth'
  return 'multi-channel portfolio operations toward $10k/mo'
}

async function askLlmForSteps(
  workspaceId: string,
  review:      Awaited<ReturnType<typeof weeklyReview>>,
  focus:       BusinessStatus[],
  refs:        Array<{ title: string; section: string; body: string }>,
): Promise<ImproveStep[]> {
  // Build a compact context. The LLM gets enough to be useful, not so
  // much that the bill is unjustified.
  const context = [
    `Workspace: ${workspaceId}`,
    `Total businesses: ${review.businessCount}, on-track: ${review.onTrack.length}, underperforming: ${review.underperforming.length}`,
    `Combined monthly: $${review.totalMonthlyUsd.toFixed(0)} / target $${review.totalTargetUsd.toFixed(0)} (${(review.pctToCombinedGoal * 100).toFixed(1)}%)`,
    '',
    'Focus businesses:',
    ...focus.map(b =>
      `  • [${b.category}] ${b.name} (id=${b.id}): 30d $${b.last30DaysUsd.toFixed(0)} vs $${b.monthlyTargetUsd} target, traj $${b.trajectoryUsd.toFixed(0)}/mo, phase=${b.phase}, ${b.needsAttention ? 'NEEDS ATTENTION' : 'on track'}`
    ),
    '',
    'Playbook references (cite by section name when used):',
    ...refs.map(r => `### ${r.title} — ${r.section}\n${r.body}`),
  ].join('\n')

  const system = `You produce structured weekly action plans for an operator running multiple online businesses. Your output is a JSON array of 3–5 ImproveStep objects, ranked by priority (high first).

ImproveStep schema:
  { "action": "...short imperative...", "rationale": "...one sentence with a number...", "expectedImpact": "...one phrase...", "suggestedOp": "brain-task op name or null", "suggestedParams": { ... } or null, "businessId": "..." or null, "priority": "high" | "medium" | "low" }

THE $10K/MO FLOOR (non-negotiable platform constraint):
- Every business in this workspace has a $10,000/month minimum revenue target — this is the FLOOR, not a stretch goal
- ANY suggested step must have a plausible path to closing the gap to $10k/mo, not just "improve metric by 10%"
- A step that would generate +$200/mo on a business $7,000 short of target is a low-priority filler — reject it in favor of a step that meaningfully closes the gap (publish cadence ×2, niche pivot, second channel launch, ad spend at a winner, etc.)
- For a business at < 30% of floor: the only valid high-priority actions are STRUCTURAL — niche pivot, format pivot, second channel/shop launch, sunset proposal. NOT thumbnail tweaks.
- For a business at 30–80% of floor: scale what's working (channel count, publish cadence, ad spend on winners)
- For a business at 80–100% of floor: optimization wins (CTR/AVD/conversion), and start a second business in the same vertical
- For a business OVER floor: propose raising the target OR opening a new business to diversify
- The rationale field MUST quote the current gap to $10k/mo when proposing a structural step (e.g. "Business is $4,200 short of $10k floor; per YouTube playbook §7 a 3-channel portfolio at $5 RPM × 200k views/mo/channel × 0.55 share = $1,650/channel — needs +5 channels or 3× the per-channel views to close the gap")

Rules:
- Every action MUST cite a specific playbook section name in the rationale (e.g. "per the YouTube playbook §7 multi-channel scaling")
- Prefer concrete, measurable actions ("publish 2 additional Shorts/week on channel-X", "swap the thumbnail on listing-Y") over vague advice
- Recommend suggestedOp only when the platform's brain-task API can execute it — examples: "portfolio.status", "playbook.consult", "channel.list", "schedule.save", "business.feasibility", "business.create". Never invent op names.
- Never recommend buying followers, auto-comment, anti-detect browsers, or anything banned by the platform ToS
- Never promise a revenue outcome — use phrases like "should improve CTR" not "will make $X"
- For businesses well under target, prefer suggesting business.feasibility (run the math on a pivot niche) before suggesting full pivots

Output ONLY the JSON array — no preamble, no markdown fence.`

  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const t0 = Date.now()
  try {
    const stream = streamChat(workspaceId, [
      { role: 'system', content: system },
      { role: 'user',   content: context },
    ], { skipUsageTracking: true })   // R146.10 — caller records its own ai_usage row below
    // We need the StreamResult (provider/model/tokens/costUsd) for cost
    // tracking, which only the generator-return value carries. Iterate
    // manually so we can capture the return.
    let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
    while (!(next = await stream.next()).done) {
      if (next.value.delta) raw += next.value.delta
    }
    final = next.value
    // Record cost to ai_usage so weekly portfolio.improve runs show up in
    // the operator's cost report. Without this, the brain's own self-
    // improvement loop is invisible to budget-guard.
    const { recordAiUsage } = await import('./ai-cost-tracker.js')
    recordAiUsage({
      workspaceId,
      provider:     final.provider,
      model:        final.model,
      // The chat stream doesn't separate prompt vs output tokens — assign
      // all to outputTokens as a conservative approximation.
      promptTokens: 0,
      outputTokens: final.tokens,
      costUsd:      final.costUsd,
      latencyMs:    Date.now() - t0,
      taskType:     'chat',
    })
  } catch (e) {
    console.error('[portfolio-improve] LLM call failed:', (e as Error).message)
    return []
  }

  // Parse the LLM output as JSON. Tolerate prose wrapping by extracting
  // the first [...] block if direct parse fails.
  let parsed: unknown = null
  const trimmed = raw.trim()
  try { parsed = JSON.parse(trimmed) }
  catch {
    const m = trimmed.match(/\[[\s\S]*\]/)
    if (m) { try { parsed = JSON.parse(m[0]) } catch { /* fall through */ } }
  }
  if (!Array.isArray(parsed)) return []

  // Validate each entry. Drop invalid ones; cap to 5.
  const out: ImproveStep[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const action          = typeof e['action']         === 'string' ? e['action']         : null
    const rationale       = typeof e['rationale']      === 'string' ? e['rationale']      : null
    const expectedImpact  = typeof e['expectedImpact'] === 'string' ? e['expectedImpact'] : null
    const priorityRaw     = typeof e['priority']       === 'string' ? e['priority']       : 'medium'
    const priority        = (['high', 'medium', 'low'] as const).find(p => p === priorityRaw) ?? 'medium'
    if (!action || !rationale || !expectedImpact) continue
    if (action.length > 200) continue
    const step: ImproveStep = { action, rationale, expectedImpact, priority }
    if (typeof e['suggestedOp']    === 'string') step.suggestedOp    = e['suggestedOp']    as string
    if (typeof e['suggestedParams'] === 'object' && e['suggestedParams'] !== null) step.suggestedParams = e['suggestedParams'] as Record<string, unknown>
    if (typeof e['businessId']     === 'string') step.businessId     = e['businessId']     as string
    out.push(step)
    if (out.length >= 5) break
  }
  // Sort by priority
  const order = { high: 0, medium: 1, low: 2 } as const
  out.sort((a, b) => order[a.priority] - order[b.priority])
  return out
}
