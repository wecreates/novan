/**
 * R146.341 — Domain Skill Registry (closes skills.domain_specialized 4→7)
 *
 * Claude has ~150 skills (canvas-design, deep-research, mcp-builder, etc.)
 * Novan's equivalent: a registry of domain-specialized capability bundles,
 * each tuned for a revenue vertical (POD design, social engagement, SEO
 * audit, etc.). A skill bundles: domain knowledge, prompt templates, tool
 * preferences, success-pattern memory.
 *
 * v1 here is the registry + invocation harness. Specific skill content
 * lives in r341-skills/* (separate files per skill).
 */

export interface NovanSkill {
  id:              string
  name:            string
  category:        'pod' | 'social' | 'seo' | 'analytics' | 'compliance' | 'audio' | 'video' | 'sales' | 'support' | 'engineering'
  description:     string
  whenToUse:       string                  // when the orchestrator should pick this skill
  requiredOps:     string[]                 // brain-task ops it needs available
  optionalOps:     string[]                 // ops that enhance it but aren't required
  promptTemplate?: string                   // optional system-prompt to inject
  tags:            string[]
}

export const SKILLS: NovanSkill[] = [
  {
    id: 'pod.first-product-listing',
    name: 'POD First Product Listing',
    category: 'pod',
    description: 'Create + publish the first POD product on a connected store',
    whenToUse: 'Operator has connected Printful + a sync store but has 0 products listed',
    requiredOps: ['art.public_domain_fetch', 'brand.dba_propagation_plan', 'privacy.check_submit'],
    optionalOps: ['decide.image_gen_fallback', 'confidence.score_op'],
    tags: ['revenue', 'pod', 'cold-start'],
  },
  {
    id: 'pod.quality-audit',
    name: 'POD Design Quality Audit',
    category: 'pod',
    description: 'Verify designs meet "no AI tells" bar before publishing',
    whenToUse: 'Before any POD design publish + as nightly sweep over recent uploads',
    requiredOps: ['memory.recall', 'lesson.applicable_for'],
    optionalOps: ['confidence.score_op'],
    tags: ['quality', 'pod', 'pre-publish'],
  },
  {
    id: 'social.engagement-warmup',
    name: 'Social Account Warm-Up',
    category: 'social',
    description: 'Slow-grow engagement on a new social channel to avoid automation detection',
    whenToUse: 'New social account < 7 days old, before any posting velocity',
    requiredOps: ['lesson.applicable_for', 'confidence.score_op'],
    optionalOps: ['decide.image_gen_fallback'],
    tags: ['social', 'cold-start', 'compliance'],
  },
  {
    id: 'seo.programmatic-page-set',
    name: 'Programmatic SEO Page Set',
    category: 'seo',
    description: 'Generate a structured set of landing pages targeting a keyword cluster',
    whenToUse: 'Operator has a business + a target keyword cluster + a Shopify or static site',
    requiredOps: ['memory.recall'],
    optionalOps: ['art.public_domain_fetch'],
    tags: ['seo', 'growth', 'long-form'],
  },
  {
    id: 'analytics.weekly-revenue-report',
    name: 'Weekly Revenue Report',
    category: 'analytics',
    description: 'Generate weekly revenue + cost + capability progress report',
    whenToUse: 'Every Monday morning; ad-hoc on request',
    requiredOps: ['report.revenue_by_business', 'report.capability_parity'],
    optionalOps: ['platform.poll_all'],
    tags: ['analytics', 'cadence', 'operator-facing'],
  },
  {
    id: 'compliance.platform-policy-check',
    name: 'Platform Policy Pre-Flight',
    category: 'compliance',
    description: 'Before publishing to a platform, check current policy memory + recent bans',
    whenToUse: 'Before every platform-first action; cached for 24h',
    requiredOps: ['platform.state_probe', 'lesson.applicable_for'],
    optionalOps: ['memory.recall'],
    tags: ['compliance', 'pre-flight', 'safety'],
  },
  {
    id: 'engineering.daily-self-review',
    name: 'Daily Self-Review',
    category: 'engineering',
    description: 'Review own recent changes + propose next closure',
    whenToUse: 'Daily 6am cron tick',
    requiredOps: ['closer.tick', 'capability.next_target', 'report.capability_parity'],
    optionalOps: ['provider.health.probe_all'],
    tags: ['engineering', 'meta', 'continuous-improvement'],
  },
]

export interface SkillMatch {
  skill:       NovanSkill
  matchScore:  number          // 0-1
  matchReasons: string[]
  readiness:   'ready' | 'partial' | 'blocked'
  missingOps:  string[]
}

export function listSkills(category?: NovanSkill['category']): NovanSkill[] {
  return category ? SKILLS.filter(s => s.category === category) : SKILLS
}

export function findSkill(id: string): NovanSkill | undefined {
  return SKILLS.find(s => s.id === id)
}

/**
 * Score skills against a user request. Used by the orchestrator to pick
 * which skill (if any) matches the intent.
 */
export function rankForRequest(request: string, availableOps: string[]): SkillMatch[] {
  const lower = request.toLowerCase()
  const out: SkillMatch[] = []
  for (const skill of SKILLS) {
    const reasons: string[] = []
    let score = 0
    for (const tag of skill.tags) {
      if (lower.includes(tag)) { score += 0.2; reasons.push(`tag:${tag}`) }
    }
    if (lower.includes(skill.category)) { score += 0.3; reasons.push(`category:${skill.category}`) }
    for (const word of skill.name.toLowerCase().split(/\s+/)) {
      if (word.length >= 4 && lower.includes(word)) { score += 0.1; reasons.push(`name:${word}`) }
    }
    const missing = skill.requiredOps.filter(op => !availableOps.includes(op))
    const readiness: SkillMatch['readiness'] =
      missing.length === 0 ? 'ready' :
      missing.length === skill.requiredOps.length ? 'blocked' : 'partial'
    out.push({ skill, matchScore: Math.min(1, score), matchReasons: reasons, readiness, missingOps: missing })
  }
  return out.sort((a, b) => b.matchScore - a.matchScore)
}
