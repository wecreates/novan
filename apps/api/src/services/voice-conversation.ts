/**
 * voice-conversation.ts — natural-language conversation layer on top of
 * the intent parser + command router.
 *
 * Pure functions. The DB-backed context store lives in voice-context-store.ts
 * and threads through these helpers, so unit tests construct contexts
 * directly without IO.
 *
 * Responsibilities:
 *   1. Detect conversational META commands ("never mind", "explain that",
 *      "do the safer option", corrections like "actually, do X instead")
 *      that the rigid intent parser cannot model.
 *   2. Resolve referents using the carryover context — turn "zoom in",
 *      "focus on it", "go there", "open its detail" into concrete intents
 *      with target=context.selectedSystem.
 *   3. Decide when the operator needs to be asked for clarification vs
 *      when carryover is confident enough to act.
 *   4. Naturalize the spoken response to a short, calm sentence and offer
 *      a safer alternative when one exists.
 *
 * No DB. No fetch. Everything deterministic for tests.
 */
import { parseIntent, type VoiceIntent } from './voice-intent.js'
import { routeIntent, type ActionPlan, type Risk } from './voice-command-router.js'
import { classifyCommand } from './voice-safety.js'

export interface ExpectedNext {
  /** What kind of answer the operator is being asked for. */
  kind:     'yes_no' | 'choose_one' | 'specify_target' | 'specify_url' | 'free_text'
  /** Plan held for "yes" — when the assistant just queued a confirm-style follow-up. */
  pendingPlan?: ActionPlan | null
  /** Options offered (e.g. when the clarification listed choices). */
  options?: string[]
  /** What the operator was originally trying to do. */
  originalIntent?: string
  /** Free-text clarification copy for the UI. */
  prompt:   string
}

export interface ConversationContext {
  sessionId:        string
  workspaceId:      string
  currentNode?:     string | null
  currentTemplate?: string | null
  currentLod?:      string | null
  activeMission?:   string | null
  selectedSystem?:  string | null
  lastPlan?:        ActionPlan | null
  pendingPlan?:     ActionPlan | null
  currentRisk?:     Risk
  currentUiMode?:   string | null
  preferences?:     Record<string, unknown>
  turnCount?:       number
  expectedNext?:    ExpectedNext | null
  mutedUntil?:      number | null
  voiceLocked?:     boolean
  /** Most recently created dry-run id; the resolver lets the operator
   *  approve it with a spoken "approve" / "approve the dry run". */
  pendingDryRunId?: string | null
}

export type MetaKind =
  | 'never_mind'        // operator cancels pending or last action
  | 'explain'           // "what does that mean?" / "explain that"
  | 'safer'             // "do the safer option"
  | 'repeat'            // "say that again"
  | 'confirm'           // "confirm" / "yes do it" — applied to pendingPlan
  | 'correction'        // "actually …" / "no, …" — replaces pendingPlan
  | 'clarify'           // resolver needs operator to specify
  | 'stop'              // "stop" / "pause" — pause TTS + drop pending without canceling lastPlan
  | 'mute'              // "mute" — short timeout silence (does not stop the mic)
  | 'lock'              // "lock voice actions" — refuse all mutating actions until unlocked
  | 'unlock'            // "unlock voice"
  | 'approve_dry_run'   // "approve dry run" — spoken half of the dual-channel approval
  | 'reject_dry_run'    // "reject dry run" / "cancel dry run"
  | null

export interface ConversationTurn {
  meta:        MetaKind                   // detected meta-command, if any
  intent:      VoiceIntent                // resolved intent (carryover applied)
  plan:        ActionPlan                 // plan derived from intent
  clarification?: string                  // present when meta === 'clarify'
  carryover?:  { from: keyof ConversationContext; resolvedTo: string }
  naturalSpeak: string                    // the short, human-style reply
  /** When set, persist this so the NEXT utterance is read as an answer. */
  expectedNext?: ExpectedNext | null
  /** True when this turn was an answer to a prior expectedNext prompt. */
  answeredClarification?: boolean
}

// ─── Meta-command detection ──────────────────────────────────────────────

const META_PATTERNS: Array<{ kind: Exclude<MetaKind, null>; re: RegExp }> = [
  // Order matters: more specific patterns first so they win ties.
  { kind: 'approve_dry_run', re: /\b(approve|run|execute) (?:the )?(?:dry[- ]?run|preview|plan|action)\b|\bapprove and execute\b/i },
  { kind: 'reject_dry_run',  re: /\b(reject|cancel|discard) (?:the )?(?:dry[- ]?run|preview|plan)\b/i },
  { kind: 'lock',        re: /\b(lock voice(?: actions)?|lock down voice|disable voice actions)\b/i },
  { kind: 'unlock',      re: /\b(unlock voice(?: actions)?|enable voice actions|resume voice)\b/i },
  { kind: 'mute',        re: /\b(mute(?:\s+(?:yourself|voice|for\s+\d+))?|quiet (?:mode|please)|be quiet|silence(?:\s+for\s+\d+)?)\b/i },
  { kind: 'stop',        re: /\b(stop talking|stop speaking|stop\b(?!\s*the\s+\w+)|pause(?: yourself)?(?!\s*\w+)|hold on)\b/i },
  { kind: 'never_mind',  re: /\b(never mind|nevermind|cancel that|forget it|drop it|abort|wait,? (?:no|stop))\b/i },
  { kind: 'safer',       re: /\b(do (?:the )?safer (?:option|one|version|thing)|safer (?:option|route)|less risky|lower risk option)\b/i },
  { kind: 'repeat',      re: /\b(say (?:that|it) again|repeat (?:that|yourself)?|come again|what did you say)\b/i },
  { kind: 'explain',     re: /\b(explain (?:that|it|this)|what does (?:that|it|this) mean|elaborate|tell me more|why)\b/i },
  { kind: 'confirm',     re: /\b(confirm|confirmed|yes|yeah|yep|yup|go ahead|proceed|sounds good|do it)\b/i },
  { kind: 'correction',  re: /\b(actually,?|no,? (?:instead|do|let'?s|make it)|i meant|scratch that,?)\b/i },
]

export function detectMeta(text: string): Exclude<MetaKind, null> | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  for (const p of META_PATTERNS) if (p.re.test(t)) return p.kind
  return null
}

// ─── Referent / carryover resolution ────────────────────────────────────

/** Pronouns that hint the operator means the current context. */
const REFERENT_RE = /\b(its?|that|there|this|them|those|the system|the node)\b/i
/** Verbs that imply brain navigation even without a system name. */
const FOLLOWUP_NAV_RE = /\b(zoom in|zoom out|focus|drill in|open (?:the )?detail|expand)\b/i

interface CarryoverResult {
  text:      string
  carryover?: { from: keyof ConversationContext; resolvedTo: string }
}

/**
 * Inject context referents into a transcript so the rigid parser can
 * match. e.g. "zoom in" + context.selectedSystem='security' → "zoom in security".
 *
 * Only applied when the operator referenced context implicitly via a
 * pronoun OR used a follow-up nav verb with no system name.
 */
export function applyCarryover(text: string, ctx: ConversationContext): CarryoverResult {
  const t = text.trim()
  if (!t) return { text }

  // If transcript already names a system, no carryover needed.
  const hasSystemWord = /\b(runtime|agents?|security|research|memory|image|browser|commerce|governance|war[\s-]?room|infra|infrastructure|fabric|learning|simulation|executive)\b/i.test(t)
  if (hasSystemWord) return { text }

  const referent = REFERENT_RE.test(t)
  const followupNav = FOLLOWUP_NAV_RE.test(t)
  if (!referent && !followupNav) return { text }

  // Prefer selectedSystem, fall back to currentNode if it looks like a system id
  const target = ctx.selectedSystem ?? ctx.currentNode ?? null
  if (!target) return { text }

  // Inject the target after the verb / pronoun naturally
  const enriched = referent
    ? t.replace(REFERENT_RE, target)
    : `${t} ${target}`
  return { text: enriched, carryover: { from: 'selectedSystem', resolvedTo: target } }
}

// ─── Natural response style ─────────────────────────────────────────────

const HYPE_WORDS = [
  /\babsolutely\b/gi, /\bcertainly\b/gi, /\bof course\b/gi,
  /\bgreat question\b/gi, /\bperfect\b/gi, /\bamazing\b/gi,
  /\bi'?ll be happy to\b/gi, /\bi'?d be glad to\b/gi,
  /\bdefinitely\b/gi, /\bfor sure\b/gi,
]
const FILLER_RE = /\b(just|simply|basically|essentially|in order to|please note that|i think that)\b/gi

/**
 * Trim monologue patterns, hype, and filler. Cap at ~22 words so spoken
 * responses stay short. Never returns empty — falls back to the input.
 *
 * Mode-aware tightening:
 *   - 'fast'      : 12-word cap (for "known workflow" turns)
 *   - 'executive' : 14-word cap, drops trailing 2nd sentence aggressively
 *   - 'engineer'  : keep technical detail; relax to 30-word cap
 *   - 'brain_ui'  : 18-word cap, prepend a visual cue when target known
 *   - 'detailed'  : 40-word cap (operator asked for explanation)
 *   - default     : 22-word cap (existing behavior)
 *
 * For risky-action speech, callers should pass mode='detailed' so the
 * operator gets the full reason; the route handler decides this.
 */
export type NaturalizeMode = 'fast' | 'normal' | 'detailed' | 'engineer' | 'executive' | 'brain_ui'

const MODE_CAPS: Record<NaturalizeMode, number> = {
  fast: 12, normal: 22, detailed: 40, engineer: 30, executive: 14, brain_ui: 18,
}

export function naturalize(speak: string, mode: NaturalizeMode = 'normal'): string {
  if (!speak) return ''
  let s = speak
  for (const re of HYPE_WORDS) s = s.replace(re, '')
  s = s.replace(FILLER_RE, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim()
  // Cap length softly at first sentence; if still long, hard cap at mode cap.
  const sentence = s.split(/(?<=[.!?])\s+/)[0] ?? s
  const cap = MODE_CAPS[mode] ?? MODE_CAPS.normal
  // 'detailed' keeps up to two sentences before applying cap
  const base = mode === 'detailed' ? s : sentence
  const words = base.split(/\s+/)
  const capped = words.length > cap ? words.slice(0, cap).join(' ') + '…' : base
  return capped || speak
}

// ─── Safer-alternative derivation ───────────────────────────────────────

/**
 * Given a pending plan, return a safer reframing or null if no safer
 * variant exists. Used for "do the safer option".
 */
export function saferAlternative(plan: ActionPlan): ActionPlan | null {
  if (!plan) return null
  // Mutating agent.pause on 'all' → narrow to a single system if context allows
  if (plan.intent.kind === 'agent.pause' && plan.intent.args['scope'] === 'all') {
    return {
      ...plan,
      risk: 'medium',
      speak: 'Safer option: pause only the currently focused system instead of all agents. Confirm?',
      reason: 'Reduces blast radius to one system. Reversible from the agents page.',
      intent: { ...plan.intent, args: { ...plan.intent.args, scope: plan.intent.target ?? 'research' } },
    }
  }
  // Research start → dry-run instead
  if (plan.intent.kind === 'research.start') {
    const base: ActionPlan = {
      ...plan,
      risk: 'low',
      speak: 'Safer option: plan the research without spawning agents yet. Confirm?',
      reason: 'Produces a research plan you can review before committing budget.',
    }
    if (plan.execute) base.execute = { ...plan.execute, body: { ...(plan.execute.body ?? {}), dryRun: true } }
    return base
  }
  // Browser open → read-only screenshot variant
  if (plan.intent.kind === 'browser.open') {
    const base: ActionPlan = {
      ...plan,
      risk: 'low',
      speak: 'Safer option: screenshot the page instead of opening it in a controlled browser. Confirm?',
      reason: 'Captures the page without granting the browser worker write access.',
    }
    if (plan.execute) base.execute = { ...plan.execute, path: '/api/v1/browser/screenshot', ...(plan.execute.body ? { body: plan.execute.body } : {}) }
    return base
  }
  // Image generate is already low risk
  if (plan.risk === 'low') return null
  return null
}

// ─── Main resolver ──────────────────────────────────────────────────────

/**
 * Resolve a single voice turn against context.
 *
 *   1. Detect meta-command → short-circuit if applicable.
 *   2. Apply carryover to fill referents.
 *   3. Parse intent.
 *   4. Decide if clarification is needed.
 *   5. Route to ActionPlan (unless meta already produced one).
 *   6. Naturalize the spoken response.
 *
 * Never throws. Falls back to a low-confidence clarification on any error.
 */
export function resolveTurn(text: string, ctx: ConversationContext): ConversationTurn {
  const trimmed = text.trim()
  if (!trimmed) {
    const empty = parseIntent('')
    const plan  = routeIntent(empty, '')
    return { meta: null, intent: empty, plan, naturalSpeak: '' }
  }

  // Hard-block check first — must reject regardless of carryover, meta,
  // correction, or any other conversational dressing.
  const safety = classifyCommand(trimmed)
  if (safety.kind === 'block') {
    const plan: ActionPlan = {
      verdict: 'reject',
      intent:  { kind: 'unknown', confidence: 1, args: {}, matched: safety.matched },
      speak:   `Refusing. That action is hard-blocked for safety: ${safety.matched}.`,
      reason:  `Voice cannot authorize ${safety.matched}. Use the web UI with explicit approval.`,
      risk: 'high', permission: null,
    }
    return { meta: null, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak), expectedNext: null }
  }

  // ─── Multi-turn disambiguation ────────────────────────────────────────
  // If the previous turn asked a clarification, treat this utterance as
  // the answer instead of routing it through the generic meta detector.
  if (ctx.expectedNext) {
    const answered = answerExpectedNext(trimmed, ctx.expectedNext, ctx)
    if (answered) return answered
    // Fall through if we couldn't resolve — the answer is ambiguous too.
  }

  const meta = detectMeta(trimmed)

  // ─── META: never mind ────────────────────────────────────────────────
  if (meta === 'never_mind') {
    const plan: ActionPlan = {
      verdict: 'execute',
      intent:  { kind: 'unknown', confidence: 1, args: {}, matched: 'never_mind' },
      speak:   'Cancelled.',
      reason:  ctx.pendingPlan ? `Discarded the pending ${ctx.pendingPlan.intent.kind} action.` : 'Nothing pending; standing by.',
      risk: 'low', permission: null,
    }
    return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak) }
  }

  // ─── META: confirm ──────────────────────────────────────────────────
  if (meta === 'confirm') {
    if (ctx.pendingPlan) {
      return {
        meta, intent: ctx.pendingPlan.intent, plan: ctx.pendingPlan,
        naturalSpeak: naturalize(`Confirmed. ${ctx.pendingPlan.speak}`),
      }
    }
    const plan: ActionPlan = {
      verdict: 'execute',
      intent:  { kind: 'unknown', confidence: 1, args: {}, matched: 'confirm_no_pending' },
      speak: 'Nothing pending to confirm.',
      reason: 'No queued plan in this session.',
      risk: 'low', permission: null,
    }
    return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak) }
  }

  // ─── META: repeat ───────────────────────────────────────────────────
  if (meta === 'repeat') {
    const last = ctx.lastPlan
    const speak = last?.speak ?? 'I have not said anything yet in this session.'
    return {
      meta,
      intent: last?.intent ?? { kind: 'unknown', confidence: 1, args: {}, matched: 'repeat' },
      plan: last ?? {
        verdict: 'execute', intent: { kind: 'unknown', confidence: 1, args: {} },
        speak, reason: 'No prior turn.', risk: 'low', permission: null,
      },
      naturalSpeak: naturalize(speak),
    }
  }

  // ─── META: explain ──────────────────────────────────────────────────
  if (meta === 'explain') {
    const last = ctx.lastPlan
    const explanation = last
      ? `${last.reason}${last.recommendation ? ' ' + last.recommendation : ''}`
      : 'There is no prior action to explain in this session.'
    return {
      meta,
      intent: last?.intent ?? { kind: 'unknown', confidence: 1, args: {}, matched: 'explain' },
      plan: {
        verdict: 'execute',
        intent: last?.intent ?? { kind: 'unknown', confidence: 1, args: {} },
        speak: explanation, reason: explanation, risk: 'low', permission: null,
      },
      naturalSpeak: naturalize(explanation),
    }
  }

  // ─── META: stop / pause ────────────────────────────────────────────
  // Pause Novan speaking + clear any pending plan, but do NOT erase
  // lastPlan — operator can still "repeat" or "explain that".
  if (meta === 'stop') {
    const plan: ActionPlan = {
      verdict: 'execute',
      intent:  { kind: 'unknown', confidence: 1, args: {}, matched: 'stop' },
      speak:   'Stopping.',
      reason:  'TTS paused; pending action cleared.',
      risk: 'low', permission: null,
    }
    return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak), expectedNext: null }
  }

  // ─── META: mute ────────────────────────────────────────────────────
  // Short-window silence for Novan. The frontend honors this by
  // suppressing TTS playback while context.mutedUntil > now.
  if (meta === 'mute') {
    const mins = trimmed.match(/for\s+(\d+)/)
    const ms = mins ? Number(mins[1]) * 60_000 : 5 * 60_000
    const plan: ActionPlan = {
      verdict: 'execute',
      intent:  { kind: 'unknown', confidence: 1, args: { mute_ms: ms }, matched: 'mute' },
      speak:   '',                                          // intentionally empty — we are mute
      reason:  `TTS muted for ${Math.round(ms / 60_000)} minute(s).`,
      risk: 'low', permission: null,
    }
    return { meta, intent: plan.intent, plan, naturalSpeak: '', expectedNext: null }
  }

  // ─── META: lock / unlock ──────────────────────────────────────────
  if (meta === 'lock') {
    const plan: ActionPlan = {
      verdict: 'execute',
      intent:  { kind: 'unknown', confidence: 1, args: { voice_locked: true }, matched: 'lock' },
      speak:   'Voice actions locked.',
      reason:  'Mutating voice actions are refused until "unlock voice".',
      risk: 'low', permission: null,
    }
    return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak), expectedNext: null }
  }
  if (meta === 'unlock') {
    const plan: ActionPlan = {
      verdict: 'execute',
      intent:  { kind: 'unknown', confidence: 1, args: { voice_locked: false }, matched: 'unlock' },
      speak:   'Voice actions unlocked.',
      reason:  'Mutating voice actions accepted again.',
      risk: 'low', permission: null,
    }
    return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak), expectedNext: null }
  }

  // ─── META: approve / reject dry-run ────────────────────────────────
  // Spoken half of the dual-channel approval. The route handler reads
  // `meta === 'approve_dry_run'` and ctx.pendingDryRunId to call
  // approveDryRun({ source: 'spoken' }) + executeDryRun.
  if (meta === 'approve_dry_run') {
    if (!ctx.pendingDryRunId) {
      const plan: ActionPlan = {
        verdict: 'execute',
        intent:  { kind: 'unknown', confidence: 1, args: {}, matched: 'approve_no_dry_run' },
        speak:   'Nothing pending to approve.',
        reason:  'No active dry-run in this session.',
        risk: 'low', permission: null,
      }
      return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak), expectedNext: null }
    }
    const plan: ActionPlan = {
      verdict: 'execute',
      intent:  { kind: 'unknown', confidence: 1, args: { dry_run_id: ctx.pendingDryRunId }, matched: 'approve_dry_run' },
      speak:   'Approving and executing.',
      reason:  `Approving dry-run ${ctx.pendingDryRunId} via spoken channel.`,
      risk: 'low', permission: null,
    }
    return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak), expectedNext: null }
  }
  if (meta === 'reject_dry_run') {
    const plan: ActionPlan = {
      verdict: 'execute',
      intent:  { kind: 'unknown', confidence: 1, args: ctx.pendingDryRunId ? { dry_run_id: ctx.pendingDryRunId } : {}, matched: 'reject_dry_run' },
      speak:   ctx.pendingDryRunId ? 'Dry-run rejected.' : 'Nothing to reject.',
      reason:  ctx.pendingDryRunId ? `Rejecting dry-run ${ctx.pendingDryRunId}.` : 'No active dry-run.',
      risk: 'low', permission: null,
    }
    return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak), expectedNext: null }
  }

  // ─── META: safer ────────────────────────────────────────────────────
  if (meta === 'safer') {
    const target = ctx.pendingPlan ?? ctx.lastPlan
    if (!target) {
      const plan: ActionPlan = {
        verdict: 'execute',
        intent:  { kind: 'unknown', confidence: 1, args: {}, matched: 'safer_no_target' },
        speak: 'No pending action to make safer.', reason: 'Nothing queued.',
        risk: 'low', permission: null,
      }
      return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak) }
    }
    const safer = saferAlternative(target)
    if (!safer) {
      const plan: ActionPlan = {
        verdict: 'execute',
        intent: target.intent,
        speak: 'That action is already the safer option.', reason: target.reason,
        risk: target.risk, permission: target.permission,
      }
      return { meta, intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak) }
    }
    return { meta, intent: safer.intent, plan: safer, naturalSpeak: naturalize(safer.speak) }
  }

  // ─── Carryover + parse + route ──────────────────────────────────────
  const carry = applyCarryover(trimmed, ctx)
  const intent = parseIntent(carry.text)

  // ─── META: correction — recompute with new wording, but mark for UI
  if (meta === 'correction' && ctx.pendingPlan) {
    // If the correction includes a real intent, return it; otherwise clarify.
    if (intent.kind !== 'unknown') {
      const plan = routeIntent(intent, carry.text)
      return {
        meta, intent, plan,
        ...(carry.carryover ? { carryover: carry.carryover } : {}),
        naturalSpeak: naturalize(`Got it. ${plan.speak}`),
      }
    }
    return clarification('What would you like to do instead?', intent)
  }

  // ─── Clarification when ambiguous + risky ───────────────────────────
  if (intent.kind === 'unknown') {
    if (ctx.pendingPlan) {
      return clarification(
        `Pending: ${ctx.pendingPlan.intent.kind}. Confirm or say "never mind".`,
        intent,
        undefined,
        { kind: 'yes_no', pendingPlan: ctx.pendingPlan, originalIntent: ctx.pendingPlan.intent.kind, prompt: `Confirm ${ctx.pendingPlan.intent.kind}?` },
      )
    }
    if (ctx.selectedSystem) {
      return clarification(
        `What about ${ctx.selectedSystem}? Zoom, open detail, or pause?`,
        intent,
        undefined,
        { kind: 'choose_one', options: ['zoom', 'detail', 'pause'], originalIntent: `${ctx.selectedSystem}`, prompt: 'Zoom, detail, or pause?' },
      )
    }
    return clarification('Could you rephrase that?', intent)
  }

  const plan = routeIntent(intent, carry.text)

  // ─── Lock-voice-actions enforcement ───────────────────────────────────
  // Once the operator says "lock voice actions", any mutating plan
  // (confirm verdict OR non-low risk) is refused until "unlock voice".
  if (ctx.voiceLocked && (plan.verdict === 'confirm' || plan.risk !== 'low')) {
    const refusal: ActionPlan = {
      verdict: 'reject',
      intent,
      speak:   'Voice actions are locked. Say "unlock voice" first.',
      reason:  'Workspace voice-lock is engaged.',
      risk:    plan.risk,
      permission: plan.permission,
    }
    return { meta: null, intent, plan: refusal, naturalSpeak: naturalize(refusal.speak), expectedNext: null }
  }

  // Low-confidence refusal — never execute when confidence is too low.
  // Navigation stays permissive (revertible); mutations require an
  // explicit confirmation even at slightly low confidence.
  const LOW_CONF = 0.65
  if (intent.confidence < LOW_CONF && plan.verdict !== 'navigate') {
    return clarification(
      `I heard "${trimmed}" with ${(intent.confidence * 100).toFixed(0)}% confidence. Did you mean ${intent.kind.replace(/\./g, ' ')}?`,
      intent, plan,
      { kind: 'yes_no', pendingPlan: plan, originalIntent: intent.kind, prompt: `Confirm ${intent.kind}?` },
    )
  }

  // Risky ambiguity — confidence < 0.7 AND verdict is confirm/execute on a non-low risk action
  if (intent.confidence < 0.7 && plan.verdict === 'confirm' && plan.risk !== 'low') {
    return clarification(
      `I heard "${trimmed}" — that sounds like ${intent.kind} at ${plan.risk} risk. Confirm or say a different action.`,
      intent, plan,
      { kind: 'yes_no', pendingPlan: plan, originalIntent: intent.kind, prompt: `Confirm ${intent.kind}?` },
    )
  }

  return {
    meta: null, intent, plan,
    ...(carry.carryover ? { carryover: carry.carryover } : {}),
    naturalSpeak: naturalize(plan.speak),
  }
}

function clarification(message: string, intent: VoiceIntent, plan?: ActionPlan, expected?: ExpectedNext): ConversationTurn {
  const fallback: ActionPlan = plan ?? {
    verdict: 'execute',
    intent,
    speak: message,
    reason: message,
    risk: 'low', permission: null,
  }
  return {
    meta: 'clarify', intent, plan: fallback,
    clarification: message,
    naturalSpeak: naturalize(message),
    expectedNext: expected ?? { kind: 'free_text', prompt: message },
  }
}

/**
 * Try to resolve the current utterance as the answer to a pending
 * clarification. Returns null when the utterance doesn't fit, so the
 * caller can fall through to normal parsing.
 */
function answerExpectedNext(text: string, expected: ExpectedNext, ctx: ConversationContext): ConversationTurn | null {
  const t = text.trim().toLowerCase()
  if (!t) return null

  if (expected.kind === 'yes_no') {
    const yes = /\b(yes|yeah|yep|yup|sure|go ahead|do it|proceed|confirm)\b/i.test(t)
    const no  = /\b(no|nope|nah|don'?t|cancel|never mind|skip)\b/i.test(t)
    if (yes && expected.pendingPlan) {
      const plan = expected.pendingPlan
      return {
        meta: 'confirm', intent: plan.intent, plan,
        naturalSpeak: naturalize(`Confirmed. ${plan.speak}`),
        expectedNext: null, answeredClarification: true,
      }
    }
    if (no) {
      const plan: ActionPlan = {
        verdict: 'execute',
        intent:  { kind: 'unknown', confidence: 1, args: {}, matched: 'declined_clarification' },
        speak:   'Cancelled.',
        reason:  expected.originalIntent ? `Discarded the pending ${expected.originalIntent}.` : 'Nothing to do.',
        risk: 'low', permission: null,
      }
      return { meta: 'never_mind', intent: plan.intent, plan, naturalSpeak: naturalize(plan.speak), expectedNext: null, answeredClarification: true }
    }
    return null
  }

  if (expected.kind === 'choose_one' && expected.options?.length) {
    const picked = expected.options.find(o => new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t))
    if (picked) {
      const target = expected.originalIntent ?? ''
      // Idiomatic templates so the rigid parser can match the re-issued
      // phrase. Falls back to "<option> <target>" for unknown options.
      const CHOICE_TEMPLATES: Record<string, (tgt: string) => string> = {
        zoom:    (g) => `zoom into ${g}`,
        focus:   (g) => `focus on ${g}`,
        detail:  (g) => `open detail for ${g}`,
        details: (g) => `open detail for ${g}`,
        pause:   (g) => `pause ${g} agents`,
        audit:   ()  => `start safe audit`,
        global:  ()  => `return to global view`,
      }
      const tplFn = CHOICE_TEMPLATES[picked.toLowerCase()]
      const replay = tplFn ? tplFn(target) : `${picked} ${target}`.trim()
      const intent = parseIntent(replay)
      const plan = routeIntent(intent, replay)
      return {
        meta: null, intent, plan,
        naturalSpeak: naturalize(plan.speak),
        expectedNext: null, answeredClarification: true,
      }
    }
    return null
  }

  if (expected.kind === 'specify_target' || expected.kind === 'specify_url' || expected.kind === 'free_text') {
    // Combine prior intent with the new specifier into a single phrase.
    const replay = expected.originalIntent ? `${expected.originalIntent} ${text}` : text
    const intent = parseIntent(replay)
    if (intent.kind === 'unknown') return null      // still ambiguous → fall through
    const plan = routeIntent(intent, replay)
    return {
      meta: null, intent, plan,
      naturalSpeak: naturalize(plan.speak),
      expectedNext: null, answeredClarification: true,
    }
  }

  // Fallback: pure free-text → re-parse the answer alone
  void ctx
  return null
}

// ─── Context update derivation ──────────────────────────────────────────

/**
 * Given a resolved turn, compute the context patch the store should
 * persist. Pure — caller writes the patch through the context-store.
 */
export function deriveContextPatch(turn: ConversationTurn, prev: ConversationContext): Partial<ConversationContext> {
  const patch: Partial<ConversationContext> = { turnCount: (prev.turnCount ?? 0) + 1 }
  const intent = turn.intent
  const plan   = turn.plan

  // Brain navigation updates current node/template/lod and selectedSystem
  if (intent.kind === 'brain.zoom' || intent.kind === 'brain.focus') {
    if (intent.target) {
      patch.selectedSystem = intent.target
      patch.currentNode    = intent.target
      patch.currentLod     = 'focus'
    }
  }
  if (intent.kind === 'brain.template' && intent.target) patch.currentTemplate = intent.target
  if (intent.kind === 'brain.mode' && typeof intent.args['lod'] === 'string') patch.currentLod = intent.args['lod']
  if (intent.kind === 'brain.detail' && intent.target) patch.currentNode = intent.target
  if (intent.kind === 'brain.global') { patch.currentLod = 'global'; patch.selectedSystem = null; patch.currentNode = null }

  // Plan tracking
  if (plan.verdict === 'confirm') patch.pendingPlan = plan
  if (turn.meta === 'never_mind' || turn.meta === 'confirm') patch.pendingPlan = null
  patch.lastPlan    = plan
  patch.currentRisk = plan.risk

  // ExpectedNext: set on clarification, clear on every other resolution.
  patch.expectedNext = turn.expectedNext ?? null

  // Mute / lock side effects from the new meta-commands.
  if (turn.meta === 'mute') {
    const ms = Number(intent.args['mute_ms'] ?? 5 * 60_000)
    patch.mutedUntil = Date.now() + ms
  }
  if (turn.meta === 'lock')   patch.voiceLocked = true
  if (turn.meta === 'unlock') patch.voiceLocked = false
  // Approving or rejecting clears the pending dry-run reference; the
  // route handler is responsible for setting it when a new run is born.
  if (turn.meta === 'approve_dry_run' || turn.meta === 'reject_dry_run') {
    patch.pendingDryRunId = null
  }

  return patch
}
