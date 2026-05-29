/**
 * voice-intent.ts — deterministic intent parser for voice/text commands.
 *
 * Goal: map a short transcript to a structured intent without an LLM
 * round-trip so the Brain UI can react instantly. The parser scores each
 * known intent against the transcript and returns the best match with a
 * confidence value (0..1). Confidence below `MIN_CONFIDENCE` returns
 * `{ kind: 'unknown' }` so the UI can fall back to chat / chat-LLM.
 *
 * Intents fall into five families:
 *   - brain.*       : 3D Brain navigation (focus, zoom, template, mode, drawer, replay, global)
 *   - war_room.*    : open war-room views (approvals, attention, today)
 *   - research.*    : start/pause research jobs
 *   - image.*       : image generation
 *   - browser.*     : browser control
 *   - agent.*       : agent control (pause, audit)
 *   - exec.*        : executive briefings / summaries
 *
 * The parser is intentionally regex-driven; tests pin every supported
 * phrase to its expected intent so behavior cannot drift silently.
 */

export type IntentKind =
  | 'brain.focus'
  | 'brain.zoom'
  | 'brain.global'
  | 'brain.template'
  | 'brain.mode'
  | 'brain.detail'
  | 'brain.replay'
  | 'war_room.approvals'
  | 'war_room.attention'
  | 'war_room.today'
  | 'war_room.runtime'
  | 'research.start'
  | 'research.pause'
  | 'image.generate'
  | 'image.variations'
  | 'image.improve_prompt'
  | 'image.make_premium'
  | 'image.reduce_slop'
  | 'image.upscale'
  | 'image.remix'
  | 'browser.open'
  | 'agent.pause'
  | 'agent.audit'
  | 'exec.summary'
  | 'exec.briefing'
  | 'unknown'

export interface VoiceIntent {
  kind: IntentKind
  /** Free-form target (system id, template name, search query, etc.). */
  target?: string
  /** Structured args for the router. */
  args: Record<string, string | number | boolean>
  confidence: number
  matched?: string          // regex / phrase that matched, for telemetry
}

/** All 14 brain system ids (kept in sync with brain-graph.SYSTEMS). */
const SYSTEM_IDS = [
  'runtime', 'agents', 'security', 'research', 'memory', 'image_studio',
  'browser_control', 'commerce', 'governance', 'war_room', 'infrastructure',
  'learning', 'simulation', 'executive_loop',
] as const

/** Aliases — spoken/colloquial → canonical system id. */
const SYSTEM_ALIASES: Record<string, string> = {
  runtime: 'runtime', 'run time': 'runtime', heartbeat: 'runtime',
  agent: 'agents', agents: 'agents', 'agent swarm': 'agents', swarm: 'agents',
  security: 'security', 'security grid': 'security',
  research: 'research', studies: 'research',
  memory: 'memory', knowledge: 'memory',
  image: 'image_studio', images: 'image_studio', studio: 'image_studio', 'image studio': 'image_studio',
  browser: 'browser_control', web: 'browser_control', browsing: 'browser_control', 'browser control': 'browser_control',
  commerce: 'commerce', shop: 'commerce', sales: 'commerce',
  governance: 'governance', trust: 'governance', policy: 'governance',
  'war room': 'war_room', warroom: 'war_room',
  infra: 'infrastructure', infrastructure: 'infrastructure', fabric: 'infrastructure',
  learning: 'learning', learn: 'learning',
  simulation: 'simulation', sim: 'simulation', forecast: 'simulation',
  executive: 'executive_loop', exec: 'executive_loop', 'executive loop': 'executive_loop',
}

/** Templates supported by the 3D Brain. */
const TEMPLATES = ['neural', 'solar', 'command_core', 'galaxy', 'runtime_mesh', 'agent_swarm', 'security_grid', 'mission_orbit'] as const
const TEMPLATE_ALIASES: Record<string, string> = {
  neural: 'neural', brain: 'neural',
  solar: 'solar', sun: 'solar',
  'command core': 'command_core', command: 'command_core',
  galaxy: 'galaxy', spiral: 'galaxy',
  'runtime mesh': 'runtime_mesh', mesh: 'runtime_mesh',
  'agent swarm': 'agent_swarm', swarm: 'agent_swarm',
  'security grid': 'security_grid', grid: 'security_grid',
  'mission orbit': 'mission_orbit', mission: 'mission_orbit', orbit: 'mission_orbit',
}

const MIN_CONFIDENCE = 0.55

function findSystem(text: string): { id: string; matched: string } | null {
  const t = text.toLowerCase()
  // Match longest alias first so 'agent swarm' beats 'agent'.
  const aliases = Object.keys(SYSTEM_ALIASES).sort((a, b) => b.length - a.length)
  for (const a of aliases) {
    const re = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(t)) return { id: SYSTEM_ALIASES[a]!, matched: a }
  }
  // Direct system id (e.g. caller said the exact id)
  for (const id of SYSTEM_IDS) if (new RegExp(`\\b${id}\\b`, 'i').test(t)) return { id, matched: id }
  return null
}

function findTemplate(text: string): { id: string; matched: string } | null {
  const t = text.toLowerCase()
  const aliases = Object.keys(TEMPLATE_ALIASES).sort((a, b) => b.length - a.length)
  for (const a of aliases) {
    const re = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(t)) return { id: TEMPLATE_ALIASES[a]!, matched: a }
  }
  for (const id of TEMPLATES) if (new RegExp(`\\b${id}\\b`, 'i').test(t)) return { id, matched: id }
  return null
}

interface Rule {
  kind: IntentKind
  /** Regex on lowercased + trimmed input. */
  re: RegExp
  /** Confidence assigned on match. */
  weight: number
  /** Optional post-processor to extract target/args. */
  extract?: (m: RegExpMatchArray, text: string) => Partial<VoiceIntent>
}

const RULES: Rule[] = [
  // Brain navigation
  { kind: 'brain.global',  re: /\b(global view|return to global|back to global|overview|zoom out fully|all systems)\b/, weight: 0.95 },
  { kind: 'brain.zoom',    re: /\b(zoom (?:in|into|to)|focus on|focus into|drill into|enter)\b/, weight: 0.85,
    extract: (_m, t) => { const s = findSystem(t); return s ? { target: s.id, args: { focus: s.id, lod: 'focus' }, matched: s.matched } : {} } },
  { kind: 'brain.focus',   re: /\b(show|open|highlight|find)\b/, weight: 0.7,
    extract: (_m, t) => { const s = findSystem(t); return s ? { target: s.id, args: { focus: s.id }, matched: s.matched } : {} } },
  { kind: 'brain.template', re: /\b(switch|change|set|use|render)\s+(template|layout|view)\b/, weight: 0.85,
    extract: (_m, t) => { const tpl = findTemplate(t); return tpl ? { target: tpl.id, args: { template: tpl.id }, matched: tpl.matched } : {} } },
  { kind: 'brain.mode',    re: /\b(switch|change|set)\s+(?:to\s+)?(systems|global|focus)\s+(mode|lod|view)\b/, weight: 0.85,
    extract: (m) => ({ args: { lod: m[2] ?? 'systems' } }) },
  { kind: 'brain.detail',  re: /\b(open|show)\s+(detail|drawer|details|inspector|info)\b/, weight: 0.8,
    extract: (_m, t) => { const s = findSystem(t); return s ? { target: s.id, args: { node: s.id } } : {} } },
  { kind: 'brain.replay',  re: /\b(replay|rewind|timeline|history|what happened)\b/, weight: 0.8,
    extract: (m, t) => {
      const ago = t.match(/(\d+)\s*(s|sec|second|m|min|minute|h|hour|d|day)s?\s*ago/i)
      if (ago) {
        const n = Number(ago[1])
        const unit = (ago[2] ?? 'm').toLowerCase()
        const ms = unit.startsWith('s') ? n * 1000
                 : unit.startsWith('m') ? n * 60_000
                 : unit.startsWith('h') ? n * 3_600_000
                 : n * 86_400_000
        return { args: { replay_at: Date.now() - ms } }
      }
      return {}
    } },

  // War room
  { kind: 'war_room.approvals', re: /\b(pending approvals?|approvals (?:queue|panel|list)|what needs approval)\b/, weight: 0.95 },
  { kind: 'war_room.attention', re: /\b(what needs attention|what'?s broken|alerts?|critical|on fire|attention)\b/, weight: 0.9 },
  { kind: 'war_room.today',     re: /\b(summari[sz]e today|what (?:happened|did we do) today|today'?s (?:summary|brief|review))\b/, weight: 0.9 },
  { kind: 'war_room.runtime',   re: /\b(runtime (?:health|status)|is the system (?:ok|healthy|up)|heartbeat|uptime status)\b/, weight: 0.95 },

  // Research
  { kind: 'research.start', re: /\b(start|launch|kick off|begin)\b.*\b(research|investigation|study)\b/, weight: 0.85,
    extract: (_m, t) => ({ args: { query: t.replace(/\b(start|launch|kick off|begin|research|investigation|study|on|about)\b/gi, '').trim() } }) },
  { kind: 'research.pause', re: /\b(pause|stop|halt|hold)\b.*\b(research|investigation|investigations|studies)\b/, weight: 0.85 },

  // Image — base generation
  { kind: 'image.generate', re: /\b(generate|create|make|render|produce)\b.*\b(image|picture|graphic|art|photo|illustration|icon|logo|thumbnail|mockup|banner|hero)\b/, weight: 0.9,
    extract: (_m, t) => ({ args: { prompt: t.replace(/\b(generate|create|make|render|produce|an?|image|picture|graphic|art|photo|illustration|icon|logo|thumbnail|mockup|banner|hero|of)\b/gi, '').trim() } }) },
  // Image — variations + remix + upscale
  { kind: 'image.variations', re: /\b(create|make|generate|give me)\b.*\b(\d+|four|three|two)\s+variations?\b/i, weight: 0.92,
    extract: (m, t) => {
      const num = m[2] ?? ''
      const map: Record<string, number> = { two: 2, three: 3, four: 4 }
      const n = Number(num) || map[num.toLowerCase()] || 4
      return { args: { count: n, prompt: t } }
    } },
  { kind: 'image.upscale', re: /\b(upscale|enhance|sharpen)\b.*\b(this|that|the (?:image|photo|picture))\b/i, weight: 0.9 },
  { kind: 'image.remix',   re: /\b(remix|reimagine|reinterpret|variant of)\b.*\b(this|that|image|photo)\b/i, weight: 0.88 },
  // Image — prompt enhancements (Creative Director voice commands)
  { kind: 'image.improve_prompt', re: /\b(improve|fix|tighten)\s+(?:this|the|my)?\s*prompt\b/i, weight: 0.95 },
  { kind: 'image.make_premium',   re: /\bmake\s+(?:it|this|the prompt)\s+more\s+premium\b|\bmake\s+(?:this|it)\s+luxury\b|\bstronger\s+typography\b/i, weight: 0.95 },
  { kind: 'image.reduce_slop',    re: /\breduce\s+slop\b|\bless\s+ai\s*looking?\b|\bmore\s+original\b|\bcleaner\s+composition\b|\bstronger\s+composition\b|\bmore\s+minimal\b/i, weight: 0.95 },

  // Browser
  { kind: 'browser.open', re: /\b(open (?:the )?browser|navigate to|browse to|go to (?:url|site)|fetch (?:the )?page)\b/, weight: 0.85,
    extract: (_m, t) => {
      const url = t.match(/\b(https?:\/\/\S+|[\w-]+\.[\w.-]+(?:\/\S*)?)\b/)
      return url ? { args: { url: url[1]! } } : {}
    } },

  // Agent control
  { kind: 'agent.pause', re: /\b(pause|stop|hold)\b.*\b(agents?|workers?|jobs?)\b/, weight: 0.85,
    extract: (_m, t) => {
      // "pause all agents" / "pause every worker" → scope=all (high risk)
      if (/\b(all|every|each)\b/.test(t)) return { args: { scope: 'all' } }
      const s = findSystem(t)
      return s ? { target: s.id, args: { scope: s.id } } : { args: { scope: 'all' } }
    } },
  { kind: 'agent.audit', re: /\b(start|run|begin)\b.*\b(safe audit|safety audit|security audit|audit)\b/, weight: 0.9 },

  // Executive
  { kind: 'exec.summary',  re: /\b(summari[sz]e|tldr|brief me)\b/, weight: 0.7,
    extract: (_m, t) => ({ args: { topic: t.replace(/\b(summari[sz]e|tldr|brief me on|about)\b/gi, '').trim() || 'all' } }) },
  { kind: 'exec.briefing', re: /\b(executive briefing|morning briefing|daily briefing|exec brief)\b/, weight: 0.95 },
]

/**
 * Parse a transcript into a structured intent. Multiple rules may match;
 * the highest-weighted one wins. Ties are broken by rule order (earlier
 * rules in `RULES` take priority, which gives brain.* a small edge over
 * generic exec.* — this matches operator expectations when navigating).
 */
export function parseIntent(transcript: string): VoiceIntent {
  const text = transcript.trim().toLowerCase()
  if (!text) return { kind: 'unknown', confidence: 0, args: {} }

  let best: VoiceIntent = { kind: 'unknown', confidence: 0, args: {} }
  for (const rule of RULES) {
    const m = text.match(rule.re)
    if (!m) continue
    const extra = rule.extract?.(m, text) ?? {}
    // Penalize matches that needed a target but didn't extract one.
    const needsTarget = rule.kind === 'brain.zoom' || rule.kind === 'brain.focus' || rule.kind === 'brain.template' || rule.kind === 'brain.detail'
    const hasTarget = !!(extra.target ?? extra.args?.['focus'] ?? extra.args?.['template'] ?? extra.args?.['node'])
    const confidence = needsTarget && !hasTarget ? rule.weight * 0.4 : rule.weight
    if (confidence > best.confidence) {
      best = {
        kind: rule.kind,
        confidence: Number(confidence.toFixed(2)),
        args: { ...(extra.args ?? {}) },
        ...(extra.target ? { target: extra.target } : {}),
        ...(extra.matched ? { matched: extra.matched } : { matched: m[0] }),
      }
    }
  }
  if (best.confidence < MIN_CONFIDENCE) return { kind: 'unknown', confidence: best.confidence, args: {} }
  return best
}

export const VOICE_INTENT_CATALOGUE = RULES.map(r => ({ kind: r.kind, sample: r.re.source }))
