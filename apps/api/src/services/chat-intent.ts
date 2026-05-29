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
  | 'delegate_to_agency'
  | 'construct_business'
  // Brain-task-bridged operations (dispatched via /api/v1/brain/task)
  | 'run_auto_loop'
  | 'run_smoke'
  | 'browser_open'
  | 'code_search'
  | 'db_query'
  | 'providers_validate'
  | 'safety_flags'
  | 'mind_cycle'

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
  // ── Construct a new business (live spawn on /brain) ─────────────────
  // Matches phrasing like "build me a print-on-demand business",
  // "launch a newsletter for X", "spin up a SaaS that …". The dispatcher
  // routes this to `business-construction.constructBusiness()` which
  // emits the spawn event stream the brain canvas consumes.
  {
    match: /\b(?:build|create|launch|spin\s*up|start)\s+(?:me\s+)?(?:a|an|the)?\s*(?:new\s+)?([\w\s-]{3,80}?)\s+(business|store|brand|company|startup|product|saas|newsletter|agency)\b/i,
    build: (m) => {
      const brief = (m[0] ?? '').trim()
      const noun  = (m[1] ?? '').trim()
      if (brief.length < 12) return null
      return {
        actionType: 'construct_business',
        title:   `Construct: ${noun} ${m[2]}`,
        summary: `Decompose this into departments + workflows + agent slots and spawn them live on /brain. Persists real DB rows.`,
        payload: { brief },
        riskLevel: 'low',
      }
    },
  },

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
  // ── Delegate to a specialist agent (CEO routes through /agency) ─────
  // Matches "delegate this to <slug>" or "have the <department> agent
  // <do something>" patterns. The CEO picks the agent at execute time
  // so the operator doesn't need to know the slug.
  {
    match: /\b(delegate|hand\s+(?:this\s+)?off|ask|route)\b.*\b(to|the)\b\s+(?:the\s+)?([\w-]+(?:\s+(?:agent|team|specialist))?)\b(?:\s+(?:to|for)\s+(.{8,300}))?/i,
    build: (m) => {
      const targetRaw = (m[3] ?? '').toLowerCase().replace(/\s+(agent|team|specialist)$/, '').trim()
      const task      = (m[4] ?? '').trim()
      if (!task && targetRaw.length < 3) return null
      return {
        actionType: 'delegate_to_agency',
        title: `Delegate to ${targetRaw || 'best agent'}`,
        summary: `CEO routes task through /api/v1/agency/delegate. Hint: "${targetRaw}". Task: "${task.slice(0, 160) || '(use operator question)'}"`,
        payload: { hint: targetRaw, task: task || '__use_user_message__' },
        riskLevel: 'low',
      }
    },
  },
]

// Additional patterns covering common operator phrases. These are
// broad enough that real conversation triggers chat_actions rows
// instead of leaving the table permanently empty.
const ADDITIONAL_PATTERNS: Pattern[] = [
  // ── Find / fix bugs (runs the full auto-loop) ────────────────────────
  { match: /\b(?:find|fix|patch|resolve|address)\s+(?:any\s+)?(?:bugs?|errors?|failures?|incidents?|issues?)\b/i,
    build: () => ({
      actionType: 'run_auto_loop',
      title: 'Run issue auto-loop',
      summary: 'Detect → diagnose → propose → approve (safe only) → build → apply patches. Same pipeline the cron runs every 10 min.',
      payload: { stages: ['ingest', 'diagnose', 'promote', 'approve', 'build', 'apply', 'reconcile'] },
      riskLevel: 'medium',
    }) },
  // ── Health / smoke ──────────────────────────────────────────────────
  { match: /\b(?:health|smoke|check\s+all|are\s+(?:the\s+)?(?:routes|endpoints))\b/i,
    build: () => ({
      actionType: 'run_smoke',
      title: 'Run platform smoke test',
      summary: 'Hit every public GET route the UI uses; return pass/fail per endpoint.',
      payload: {},
      riskLevel: 'low',
    }) },
  // ── Open a URL in browser ───────────────────────────────────────────
  { match: /\b(?:open|browse|visit|navigate to|fetch)\s+(https?:\/\/\S+)/i,
    build: (m) => ({
      actionType: 'browser_open',
      title: `Open ${m[1]!.slice(0, 60)}`,
      summary: `Launch a headless browser session for ${m[1]}. Returns sessionId for follow-up clicks/extracts.`,
      payload: { url: m[1] },
      riskLevel: 'low',
    }) },
  // ── Search the codebase ─────────────────────────────────────────────
  { match: /\bsearch\s+(?:the\s+)?(?:codebase|code|repo|repository)\s+for\s+(.{2,80})/i,
    build: (m) => ({
      actionType: 'code_search',
      title: `Code search: ${m[1]!.slice(0, 60)}`,
      summary: 'Native grep across apps/, packages/, workers/. Returns matched files.',
      payload: { pattern: m[1]!.trim() },
      riskLevel: 'low',
    }) },
  // ── Show / list things ──────────────────────────────────────────────
  { match: /\b(?:show|list)\s+(?:recent\s+)?(issues?|proposals?|chains?|patches?|incidents?|events?)\b/i,
    build: (m) => {
      const tableMap: Record<string, string> = {
        issues: 'issues', issue: 'issues',
        proposals: 'code_proposals', proposal: 'code_proposals',
        chains: 'reasoning_chains', chain: 'reasoning_chains',
        patches: 'patch_records', patch: 'patch_records',
        incidents: 'incidents', incident: 'incidents',
        events: 'events', event: 'events',
      }
      const table = tableMap[m[1]!.toLowerCase()]
      if (!table) return null
      return {
        actionType: 'db_query',
        title: `Show recent ${m[1]}`,
        summary: `Read latest rows from ${table}.`,
        payload: { table, limit: 20, minutes: 1440 },
        riskLevel: 'low',
      }
    } },
  // ── Provider validation ─────────────────────────────────────────────
  { match: /\b(?:validate|test|check)\s+(?:all\s+)?providers?\b/i,
    build: () => ({
      actionType: 'providers_validate',
      title: 'Validate all AI providers',
      summary: 'Probe every configured provider for liveness + auth.',
      payload: {},
      riskLevel: 'low',
    }) },
  // ── Safety / flags ──────────────────────────────────────────────────
  { match: /\b(?:show|check|what(?:'s|\s+is))\s+(?:my\s+)?(safety\s+flags?|tonight\s+mode|kill\s+switches?)\b/i,
    build: () => ({
      actionType: 'safety_flags',
      title: 'Show safety flags',
      summary: 'Read tonight-mode + autonomous-gate flags + active kill switches.',
      payload: {},
      riskLevel: 'low',
    }) },
  // ── Mind cycle ──────────────────────────────────────────────────────
  { match: /\b(?:run|trigger|fire)\s+(?:a\s+)?(?:mind\s+cycle|autonomous\s+mind|capability\s+scan)\b/i,
    build: () => ({
      actionType: 'mind_cycle',
      title: 'Run autonomous-mind cycle',
      summary: 'Detect capability gaps + generate build plans now (instead of waiting 10 min).',
      payload: {},
      riskLevel: 'low',
    }) },
]

export function detectIntents(text: string): ActionSuggestion[] {
  if (!text || text.length < 8) return []
  const out: ActionSuggestion[] = []
  const seenTypes = new Set<string>()
  for (const p of [...PATTERNS, ...ADDITIONAL_PATTERNS]) {
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
