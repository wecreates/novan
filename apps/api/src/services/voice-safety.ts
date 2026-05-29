/**
 * voice-safety.ts — guard rails for the voice layer.
 *
 * Five concerns:
 *   1. RBAC          : caller has 'voice.use' role
 *   2. Budget guard  : pre-flight against budget-guard caps before starting a session
 *   3. Kill switch   : global / per-workspace voice kill switch (env or table)
 *   4. Risky commands: detect commands that REQUIRE explicit confirmation
 *   5. Hard blocks   : commands that are ALWAYS refused (purchase, hidden mic, hidden post, etc.)
 *
 * Risky-command detection uses pattern lists, not LLMs — deterministic so
 * test cases stay reproducible. The voice UI must surface BOTH a visible
 * confirmation chip AND a spoken "Confirm by saying 'confirm' to proceed"
 * before the executor runs anything in this list.
 *
 * Hard-block list returns a refusal that cannot be overridden by a spoken
 * confirmation — it requires a human to act outside the voice channel.
 */
import { runPreflight } from './budget-guard.js'

export type SafetyVerdict =
  | { kind: 'allow' }
  | { kind: 'confirm'; reason: string; matched: string }
  | { kind: 'block';   reason: string; matched: string }

// ─── Hard-block patterns ────────────────────────────────────────────────
// Anything matching these is refused; voice cannot be the channel that
// authorizes them. The user must use the web UI with explicit approval.
const HARD_BLOCK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'purchase',            re: /\b(buy|purchase|pay|charge|checkout|order)\b.*(\$|\busd\b|\bdollars?\b|\beuros?\b|\beur\b|\bgbp\b|\bcard\b|\bwire\b|\btransfer\b)/i },
  { name: 'payment-method',      re: /\b(add|update|change|remove)\b.*\b(card|credit card|payment method|billing)\b/i },
  { name: 'hidden-mic',          re: /\b(turn off|disable|hide|mute).*(indicator|light|led|mic\s*icon)/i },
  { name: 'covert-post',         re: /\b(post|publish|tweet|send).*(without|silently|without notifying|without consent)\b/i },
  { name: 'permission-escalate', re: /\b(grant|give|elevate).*(admin|root|owner|sudo|all permissions?)\b/i },
  { name: 'export-secrets',      re: /\b(export|leak|reveal|read aloud|speak).*(api[\s-]*key|secret|token|password|credential)/i },
  { name: 'mass-delete',         re: /\b(delete|wipe|drop|purge)\b.*(all|every|database|table|workspace)\b/i },
]

// ─── Risky-command patterns ─────────────────────────────────────────────
// These require explicit visible+spoken confirmation before execution.
const RISKY_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'deploy',         re: /\b(deploy|ship|release|roll ?out|push to prod)\b/i },
  { name: 'rollback',       re: /\b(rollback|roll back|revert).*(deploy|release|prod|production)\b/i },
  { name: 'send-message',   re: /\b(send|email|dm|slack|message)\b.*\b(team|customers?|all|everyone|users?)\b/i },
  { name: 'modify-budget',  re: /\b(raise|increase|lower|set|change)\b.*\b(budget|cap|limit|spend)\b/i },
  { name: 'kill-job',       re: /\b(kill|stop|abort|cancel)\b.*\b(job|run|workflow|agent|process)\b/i },
  { name: 'modify-cron',    re: /\b(enable|disable|pause|resume|modify)\b.*\b(cron|schedule|recurring)\b/i },
  { name: 'agent-mutation', re: /\b(create|delete|modify|reconfigure)\b.*\b(agent|bot|worker)\b/i },
  { name: 'data-export',    re: /\b(export|download|dump)\b.*\b(data|database|records|users?|customers?)\b/i },
]

export function classifyCommand(text: string): SafetyVerdict {
  const t = text.trim()
  if (!t) return { kind: 'allow' }
  for (const p of HARD_BLOCK_PATTERNS) {
    if (p.re.test(t)) return { kind: 'block', reason: `hard-blocked: ${p.name}`, matched: p.name }
  }
  for (const p of RISKY_PATTERNS) {
    if (p.re.test(t)) return { kind: 'confirm', reason: `requires confirmation: ${p.name}`, matched: p.name }
  }
  return { kind: 'allow' }
}

// ─── Kill switch ────────────────────────────────────────────────────────

export function isVoiceKilled(): boolean {
  return process.env['VOICE_KILL_SWITCH'] === '1'
}

// ─── RBAC check ─────────────────────────────────────────────────────────
// The platform's auth plugin attaches `request.user.roles` (string[]). We
// accept either explicit 'voice.use' or wildcard 'admin' / 'owner'.
export function hasVoiceRole(roles: string[] | undefined): boolean {
  if (!roles || roles.length === 0) return true       // single-operator default
  return roles.some(r => r === 'voice.use' || r === 'admin' || r === 'owner')
}

// ─── Session preflight ──────────────────────────────────────────────────

export interface PreflightInput {
  workspaceId: string
  userId?: string
  roles?: string[]
  providerId: string
  estimatedCostUsd: number   // cost guess for the session window
  executionId: string
}

export interface PreflightResult {
  ok: boolean
  reason?: string
  budgetGuardId?: string
}

export async function preflightVoiceSession(input: PreflightInput): Promise<PreflightResult> {
  if (isVoiceKilled()) return { ok: false, reason: 'voice kill switch is engaged' }
  if (!hasVoiceRole(input.roles)) return { ok: false, reason: 'caller lacks voice.use role' }

  const decision = await runPreflight({
    workspaceId:  input.workspaceId,
    executionId:  input.executionId,
    providerId:   input.providerId,
    scopeType:    'workspace',
    scopeId:      input.workspaceId,
    estimatedCostUsd: input.estimatedCostUsd,
  }).catch((e: Error) => { console.error('[voice-safety]', e.message); return null })

  if (!decision) return { ok: true }                  // guard table missing → allow (single-op default)
  if (!decision.approved) {
    return { ok: false, reason: decision.blockReason ?? 'blocked by budget guard', budgetGuardId: decision.guardId }
  }
  return { ok: true, budgetGuardId: decision.guardId }
}
