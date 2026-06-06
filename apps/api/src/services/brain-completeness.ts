/**
 * R146.326 — Brain capability completeness registry.
 *
 * What a digital teammate needs to feel "complete" — and where each lives
 * in this codebase (or what's still missing). Drives:
 *
 *   - introspection: when operator asks "what can you do", we read this
 *   - self-improvement: missing items become brain-task issues
 *   - honest-assess: when a task can't be done, we cite which capability
 *     is missing
 *
 * Keep this list HONEST — mark partial/missing accurately. Updating the
 * status field is part of every PR that adds a capability.
 */
export type CapabilityStatus = 'present' | 'partial' | 'missing'

export interface Capability {
  id:       string
  category: 'perception' | 'memory' | 'reasoning' | 'action' | 'meta' | 'social'
  name:     string
  why:      string                  // why a teammate needs this
  status:   CapabilityStatus
  service?: string                  // file path of the implementation
  gap?:     string                  // what's needed if partial/missing
}

export const CAPABILITIES: Capability[] = [
  // PERCEPTION
  { id: 'perceive.text',    category: 'perception', name: 'Read text input', why: 'understand what the operator typed',
    status: 'present', service: 'apps/api/src/services/novan-chat.ts' },
  { id: 'perceive.image',   category: 'perception', name: 'See images', why: 'analyze screenshots, photos, designs',
    status: 'present', service: 'apps/api/src/services/media-analyzer.ts' },
  { id: 'perceive.audio',   category: 'perception', name: 'Hear audio', why: 'transcribe voice notes + calls',
    status: 'present', service: 'apps/api/src/services/voice.ts' },
  { id: 'perceive.video',   category: 'perception', name: 'Watch video', why: 'analyze videos for content + meaning',
    status: 'present', service: 'apps/api/src/services/video-analyzer.ts' },
  { id: 'perceive.web',     category: 'perception', name: 'Browse the web', why: 'pull live info',
    status: 'present', service: 'apps/api/src/services/web-fetch.ts' },
  { id: 'perceive.dom',     category: 'perception', name: 'Render JS-heavy pages', why: 'see SPA shells',
    status: 'present', service: 'apps/api/src/services/playwright-fetcher.ts' },

  // MEMORY
  { id: 'memory.workingset', category: 'memory', name: 'Current conversation', why: 'continuity within a session',
    status: 'present', service: 'apps/api/src/services/novan-chat.ts' },
  { id: 'memory.short',      category: 'memory', name: 'Short-term workspace memory', why: 'remember today\'s decisions',
    status: 'present', service: 'apps/api/src/services/r211-workplace.ts' },
  { id: 'memory.long',       category: 'memory', name: 'Long-term episodic memory', why: 'recall what happened last month',
    status: 'present', service: 'apps/api/src/services/brain-persistence.ts' },
  { id: 'memory.semantic',   category: 'memory', name: 'Semantic search over memory', why: 'find relevant past context',
    status: 'present', service: 'apps/api/src/services/embeddings.ts' },
  { id: 'memory.relationships', category: 'memory', name: 'People/business relationships', why: 'know who is who',
    status: 'partial', gap: 'no relationship-graph; only flat business_portfolio + operator_profile' },
  { id: 'memory.decay',      category: 'memory', name: 'Forgets the trivial', why: 'avoid drowning in noise',
    status: 'present', service: 'apps/api/src/services/r252-memory-decay.ts' },

  // REASONING
  { id: 'reason.plan',       category: 'reasoning', name: 'Decompose a goal into steps', why: 'turn intent into work',
    status: 'present', service: 'apps/api/src/services/brain-task-planner.ts' },
  { id: 'reason.tools',      category: 'reasoning', name: 'Choose the right tool', why: 'know when to search vs ask vs act',
    status: 'present', service: 'apps/api/src/services/tool-call-classifier.ts' },
  { id: 'reason.math',       category: 'reasoning', name: 'Arithmetic + symbolic', why: 'compute without hallucinating',
    status: 'present', service: 'apps/api/src/services/r146-ai-c2-tier.ts' },
  { id: 'reason.judge',      category: 'reasoning', name: 'Judge own output', why: 'catch mistakes before shipping',
    status: 'present', service: 'apps/api/src/services/ai-product-agents.ts' },
  { id: 'reason.tradeoff',   category: 'reasoning', name: 'Compare tradeoffs', why: 'recommend, not just list',
    status: 'present', service: 'apps/api/src/services/ceo-orchestrator.ts' },

  // ACTION
  { id: 'act.chat',          category: 'action', name: 'Reply in conversation', why: 'the primary surface',
    status: 'present', service: 'apps/api/src/services/novan-chat.ts' },
  { id: 'act.code',          category: 'action', name: 'Write code patches', why: 'fix bugs / build features',
    status: 'present', service: 'apps/api/src/services/code-agent.ts' },
  { id: 'act.deploy',        category: 'action', name: 'Ship code to prod', why: 'follow through',
    status: 'present', service: 'apps/api/src/services/deploy-guard.ts' },
  { id: 'act.image',         category: 'action', name: 'Generate images', why: 'visual outputs',
    status: 'present', service: 'apps/api/src/services/image-generator.ts' },
  { id: 'act.video',         category: 'action', name: 'Generate / edit video', why: 'short-form content',
    status: 'present', service: 'apps/api/src/services/ai-video-executor.ts' },
  { id: 'act.voice',         category: 'action', name: 'Speak', why: 'voice-first experiences',
    status: 'present', service: 'apps/api/src/services/voiceover-service.ts' },
  { id: 'act.music',         category: 'action', name: 'Make music', why: 'audio outputs',
    status: 'present', service: 'apps/api/src/services/music-studio.ts' },
  { id: 'act.web',           category: 'action', name: 'Drive a browser', why: 'do things on websites',
    status: 'partial', gap: 'playwright-fetcher reads only; no form-submit/click-flow automation',
    service: 'apps/api/src/services/playwright-fetcher.ts' },
  { id: 'act.send',          category: 'action', name: 'Send messages externally', why: 'reach out without operator',
    status: 'partial', gap: 'connectors registered (slack/email/etc) but most require operator-provided creds' },

  // META — knows itself
  { id: 'meta.intro',        category: 'meta', name: 'Introspect own capabilities', why: 'answer "what can you do"',
    status: 'present', service: 'apps/api/src/services/brain-completeness.ts' },
  { id: 'meta.cost',         category: 'meta', name: 'Track its own cost', why: 'stay inside budget',
    status: 'present', service: 'apps/api/src/services/cost-governor.ts' },
  { id: 'meta.health',       category: 'meta', name: 'Self-health check', why: 'know when broken',
    status: 'present', service: 'apps/api/src/services/r253-brain-health.ts' },
  { id: 'meta.honest_gap',   category: 'meta', name: 'Honest about limits', why: 'say "I can\'t, but here\'s how you could"',
    status: 'present', service: 'apps/api/src/services/task-honest-assess.ts' },
  { id: 'meta.learn',        category: 'meta', name: 'Learn from outcomes', why: 'get better over time',
    status: 'present', service: 'apps/api/src/services/learning-cron.ts' },
  { id: 'meta.killswitch',   category: 'meta', name: 'Respect kill_switch', why: 'stop on operator command',
    status: 'present', service: 'apps/api/src/services/scheduled-production.ts' },

  // SOCIAL — feels human
  { id: 'social.persona',    category: 'social', name: 'Has a voice / persona', why: 'feels like a teammate not a tool',
    status: 'present', service: 'apps/api/src/services/brain-persona.ts' },
  { id: 'social.clarify',    category: 'social', name: 'Ask clarifying questions', why: 'doesn\'t guess when unclear',
    status: 'partial', gap: 'prompt nudges this but no dedicated clarify-or-act decision layer' },
  { id: 'social.energy_mirror', category: 'social', name: 'Mirror operator energy', why: 'doesn\'t feel mismatched',
    status: 'present', service: 'apps/api/src/services/brain-persona.ts' },
  { id: 'social.time_aware', category: 'social', name: 'Knows what time it is', why: 'greets appropriately',
    status: 'present', service: 'apps/api/src/services/brain-persona.ts' },
  { id: 'social.proactive',  category: 'social', name: 'Brings things up unprompted', why: 'true assistant behavior',
    status: 'present', service: 'apps/api/src/services/r74-monday-briefing.ts' },
]

export interface CompletenessReport {
  total:    number
  present:  number
  partial:  number
  missing:  number
  byCategory: Record<string, { present: number; partial: number; missing: number }>
  gaps:     Array<{ id: string; name: string; status: CapabilityStatus; gap?: string }>
}

export function completenessReport(): CompletenessReport {
  const byCategory: Record<string, { present: number; partial: number; missing: number }> = {}
  const gaps: CompletenessReport['gaps'] = []
  let present = 0, partial = 0, missing = 0
  for (const c of CAPABILITIES) {
    byCategory[c.category] ??= { present: 0, partial: 0, missing: 0 }
    byCategory[c.category]![c.status]++
    if (c.status === 'present') present++
    else if (c.status === 'partial') partial++
    else missing++
    if (c.status !== 'present') gaps.push({ id: c.id, name: c.name, status: c.status, ...(c.gap ? { gap: c.gap } : {}) })
  }
  return { total: CAPABILITIES.length, present, partial, missing, byCategory, gaps }
}

/** Human-readable summary — used by the chat introspection answer. */
export function completenessSummary(): string {
  const r = completenessReport()
  const lines = [
    `${r.present}/${r.total} capabilities present, ${r.partial} partial, ${r.missing} missing.`,
  ]
  if (r.gaps.length > 0) {
    lines.push('Gaps:')
    for (const g of r.gaps) {
      lines.push(`  - ${g.name} (${g.status})${g.gap ? `: ${g.gap}` : ''}`)
    }
  }
  return lines.join('\n')
}
