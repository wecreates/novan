/**
 * chat-intent.ts — Recognize operator intents in chat and surface
 * structured action suggestions with risk classification.
 *
 * PURE module. No I/O. Returns ActionSuggestion[] — the chat layer
 * persists and surfaces them with approval cards in the UI.
 *
 * Conservative: only matches strong intent patterns. False negatives
 * are fine; false positives create approval friction.
 */

export type ChatActionType =
  | 'notify_operator'
  | 'record_decision'
  | 'throttle_queue'
  | 'engage_kill_switch'
  | 'swap_provider_recommendation'
  | 'cancel_pending'
  | 'pause_agent'
  | 'approve_proposal'
  | 'reject_proposal'
  | 'build_proposal'
  | 'set_horizon'

export interface ActionSuggestion {
  actionType: ChatActionType
  title:      string
  summary:    string
  payload:    Record<string, unknown>
  riskLevel:  'low' | 'medium' | 'high' | 'critical'
}

interface Pattern {
  match:     RegExp
  build:     (m: RegExpMatchArray) => ActionSuggestion | null
}

const PATTERNS: Pattern[] = [
  // ── Build a code proposal ─────────────────────────────────────────────
  {
    match: /\b(build|create|make|generate|scaffold|implement)\s+(a|an|the)?\s*(proposal|feature|service|page|component|workflow)\s+(?:for|to|that)\s+(.{8,200})/i,
    build: (m) => ({
      actionType: 'build_proposal',
      title: `Build proposal: ${m[4]!.slice(0, 80)}`,
      summary: `Generate a code proposal scaffold for "${m[4]!.slice(0, 120)}". Output goes to /proposals for review.`,
      payload: { description: m[4]!.trim() },
      riskLevel: 'low',
    }),
  },
  // ── Throttle a queue ──────────────────────────────────────────────────
  {
    match: /\b(throttle|slow\s+down|reduce)\s+(?:the\s+)?(ai|browser|remote|workflow)\s+(?:queue|jobs?)?(?:\s+to\s+([0-9.]+))?/i,
    build: (m) => ({
      actionType: 'throttle_queue',
      title: `Throttle ${m[2]!.toLowerCase()} queue${m[3] ? ` to ${m[3]}` : ''}`,
      summary: `Set concurrency factor for ${m[2]!.toLowerCase()} queue to ${m[3] ?? '0.5'}. Workers consult this at lease time.`,
      payload: { queue: m[2]!.toLowerCase(), factor: m[3] ? Number(m[3]) : 0.5, reason: 'chat-suggested' },
      riskLevel: 'medium',
    }),
  },
  // ── Swap provider ─────────────────────────────────────────────────────
  {
    match: /\b(swap|switch|change|migrate)\s+(?:from\s+)?(\w+)\s+to\s+(\w+)(?:\s+for\s+(\w+))?/i,
    build: (m) => {
      const knownProviders = ['groq', 'openai', 'anthropic', 'gemini', 'openrouter', 'together', 'mistral', 'deepseek', 'fireworks', 'cerebras']
      const from = m[2]!.toLowerCase(), to = m[3]!.toLowerCase()
      if (!knownProviders.includes(to)) return null   // require known target
      return {
        actionType: 'swap_provider_recommendation',
        title: `Swap provider: ${from} → ${to}${m[4] ? ` for ${m[4]}` : ''}`,
        summary: `Record pending preference: route ${m[4] ?? 'all'} task type to ${to}. Operator activates at /operator-input.`,
        payload: { from, to, taskType: m[4] ?? 'chat', reason: 'chat-suggested' },
        riskLevel: 'medium',
      }
    },
  },
  // ── Engage kill switch ────────────────────────────────────────────────
  {
    match: /\b(engage|enable|trigger|activate|fire)\s+(?:the\s+)?kill[-\s]?switch(?:\s+(?:for|on)\s+(\w+))?/i,
    build: (m) => ({
      actionType: 'engage_kill_switch',
      title: `Engage kill switch: ${m[1] ?? 'research'}`,
      summary: `Halt all ${m[1] ?? 'research'} activity until operator disengages. This is a hard stop.`,
      payload: { switchType: m[1] ?? 'research', reason: 'chat-suggested' },
      riskLevel: 'critical',
    }),
  },
  // ── Pause agent ───────────────────────────────────────────────────────
  {
    match: /\b(pause|halt|stop)\s+(?:the\s+)?(agent\s+)?([a-z][a-z0-9-]+)\s+(?:agent|service)?/i,
    build: (m) => {
      const name = m[3]!.toLowerCase()
      if (name.length < 3 || name.length > 60) return null
      return {
        actionType: 'pause_agent',
        title: `Pause agent: ${name}`,
        summary: `Mark ${name} as paused. Operator can resume from /trust-governance.`,
        payload: { agentName: name, reason: 'chat-suggested' },
        riskLevel: 'medium',
      }
    },
  },
  // ── Approve proposal by id/title ──────────────────────────────────────
  {
    match: /\b(approve|accept|ok)\s+(?:proposal\s+)?([a-z0-9-]{4,40})/i,
    build: (m) => {
      const id = m[2]!.toLowerCase()
      if (id.length < 4 || /^(the|that|this|it)$/i.test(id)) return null
      return {
        actionType: 'approve_proposal',
        title: `Approve proposal: ${id}`,
        summary: `Set proposal ${id} status to approved. Operator can trigger build from /proposals.`,
        payload: { proposalId: id },
        riskLevel: 'low',
      }
    },
  },
  // ── Set strategic horizon ─────────────────────────────────────────────
  {
    match: /\b(?:set|create|add)\s+(?:a\s+)?(90d|180d|1y|3y)?\s*(?:horizon|goal|objective)\s*(?::\s*|\s+to\s+|\s+that\s+)(.{8,200})/i,
    build: (m) => ({
      actionType: 'set_horizon',
      title: `Set horizon (${m[1] ?? '90d'}): ${m[2]!.slice(0, 60)}`,
      summary: `Create a ${m[1] ?? '90d'} strategic horizon: ${m[2]!.slice(0, 200)}`,
      payload: { horizon: m[1] ?? '90d', title: m[2]!.slice(0, 120), objective: m[2]!.trim() },
      riskLevel: 'low',
    }),
  },
  // ── Record a decision ─────────────────────────────────────────────────
  {
    match: /\b(record|log|capture)\s+(?:a\s+)?decision\s*[:.]?\s*(.{12,300})/i,
    build: (m) => ({
      actionType: 'record_decision',
      title: `Record decision: ${m[2]!.slice(0, 60)}`,
      summary: `Persist a reasoning chain entry: "${m[2]!.slice(0, 200)}"`,
      payload: { decision: m[2]!.trim(), confidence: 0.8 },
      riskLevel: 'low',
    }),
  },
]

export function detectIntents(text: string): ActionSuggestion[] {
  if (!text || text.length < 8) return []
  const out: ActionSuggestion[] = []
  const seenTypes = new Set<string>()
  for (const p of PATTERNS) {
    const m = text.match(p.match)
    if (!m) continue
    const action = p.build(m)
    if (!action) continue
    const sig = `${action.actionType}:${JSON.stringify(action.payload)}`
    if (seenTypes.has(sig)) continue
    seenTypes.add(sig)
    out.push(action)
    // Cap at 3 suggestions per message to avoid card spam
    if (out.length >= 3) break
  }
  return out
}
