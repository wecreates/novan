/**
 * voice-command-router.ts — convert a parsed VoiceIntent into a concrete
 * UI ActionPlan the frontend can execute or surface for confirmation.
 *
 * The router NEVER executes side effects itself. It returns a plan with
 * one of four verdicts:
 *
 *   - 'navigate' : frontend should change route / URL params (no backend write)
 *   - 'execute'  : safe to run immediately (read-only fetches, summaries)
 *   - 'confirm'  : requires visible UI confirmation + spoken "confirm" before
 *                  any side effect (mutating actions, agent control, etc.)
 *   - 'reject'   : hard-blocked (purchase, payment, covert post, etc.)
 *
 * Every plan also surfaces:
 *   - speak     : concise sentence Novan reads aloud
 *   - risk      : 'low' | 'medium' | 'high'
 *   - permission: required role (or null for read-only)
 *
 * Logs are emitted by the route handler — keep this module pure for tests.
 */
import { classifyCommand } from './voice-safety.js'
import type { VoiceIntent } from './voice-intent.js'

export type ActionVerdict = 'navigate' | 'execute' | 'confirm' | 'reject'
export type Risk = 'low' | 'medium' | 'high'

export interface ActionPlan {
  verdict:    ActionVerdict
  intent:     VoiceIntent
  /** Concise sentence Novan reads aloud. */
  speak:      string
  /** Reason copy for the UI (longer than `speak`). */
  reason:     string
  /** Risk classification — informs the UI confirmation chip. */
  risk:       Risk
  /** Role required to run; null for read-only navigations/summaries. */
  permission: string | null
  /** Frontend navigation hint, when verdict === 'navigate'. */
  navigate?:  { path: string; params: Record<string, string> }
  /** Backend execution hint, when verdict === 'execute' or 'confirm'. */
  execute?:   { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> }
  /** Suggested next step Novan can offer. */
  recommendation?: string
}

function brainNavigate(params: Record<string, string | number | boolean>): { path: string; params: Record<string, string> } {
  const p: Record<string, string> = {}
  for (const [k, v] of Object.entries(params)) p[k] = String(v)
  return { path: '/brain', params: p }
}

/**
 * Convert an intent into a plan. Pure function — no DB, no IO.
 */
export function routeIntent(intent: VoiceIntent, originalTranscript: string): ActionPlan {
  // Safety classification first — hard blocks override everything.
  const safety = classifyCommand(originalTranscript)
  if (safety.kind === 'block') {
    return {
      verdict: 'reject',
      intent,
      speak: `Refusing. That action is hard-blocked for safety: ${safety.matched}.`,
      reason: `Voice cannot authorize ${safety.matched}. Use the web UI with explicit approval.`,
      risk: 'high', permission: null,
    }
  }
  const needsConfirm = safety.kind === 'confirm'

  switch (intent.kind) {
    // ─── Brain navigation (read-only) ───────────────────────────────────
    case 'brain.global':
      return {
        verdict: 'navigate', intent,
        speak: 'Switching to the global view.',
        reason: 'Brain returns to global LOD (all 14 systems orbit the core).',
        risk: 'low', permission: null,
        navigate: brainNavigate({ lod: 'global' }),
      }

    case 'brain.zoom':
    case 'brain.focus': {
      const focus = intent.args['focus'] ?? intent.target
      if (!focus) {
        return { verdict: 'execute', intent, speak: 'Which system?', reason: 'Specify a system to focus.', risk: 'low', permission: null }
      }
      return {
        verdict: 'navigate', intent,
        speak: `Focusing on ${focus}.`,
        reason: `Brain zooms into ${focus} system.`,
        risk: 'low', permission: null,
        navigate: brainNavigate({ focus: String(focus), lod: 'focus' }),
      }
    }

    case 'brain.template': {
      const tpl = intent.args['template'] ?? intent.target
      if (!tpl) return { verdict: 'execute', intent, speak: 'Which template?', reason: 'Specify a template (neural, solar, command_core…).', risk: 'low', permission: null }
      return {
        verdict: 'navigate', intent,
        speak: `Switching template to ${tpl}.`,
        reason: `Brain re-layouts with the ${tpl} template.`,
        risk: 'low', permission: null,
        navigate: brainNavigate({ template: String(tpl) }),
      }
    }

    case 'brain.mode': {
      const lod = intent.args['lod'] ?? 'systems'
      return {
        verdict: 'navigate', intent,
        speak: `Switching to ${lod} mode.`,
        reason: `LOD changed to ${lod}.`,
        risk: 'low', permission: null,
        navigate: brainNavigate({ lod: String(lod) }),
      }
    }

    case 'brain.detail': {
      const node = intent.args['node'] ?? intent.target
      if (!node) return { verdict: 'execute', intent, speak: 'Which node?', reason: 'Specify a node to inspect.', risk: 'low', permission: null }
      return {
        verdict: 'navigate', intent,
        speak: `Opening detail for ${node}.`,
        reason: `Detail drawer opens for node ${node}.`,
        risk: 'low', permission: null,
        navigate: brainNavigate({ node: String(node) }),
      }
    }

    case 'brain.replay': {
      const at = intent.args['replay_at']
      if (!at) return { verdict: 'execute', intent, speak: 'How far back?', reason: 'Specify a time (e.g. "5 minutes ago").', risk: 'low', permission: null }
      return {
        verdict: 'navigate', intent,
        speak: `Replaying state from that moment.`,
        reason: `Brain timeline rewinds to ${new Date(Number(at)).toLocaleString()}.`,
        risk: 'low', permission: null,
        navigate: brainNavigate({ replay_at: String(at) }),
      }
    }

    // ─── War-room reads (safe) ──────────────────────────────────────────
    case 'war_room.approvals':
      return { verdict: 'navigate', intent, speak: 'Showing pending approvals.', reason: 'Approvals queue.', risk: 'low', permission: null,
        navigate: { path: '/approvals', params: {} } }
    case 'war_room.attention':
      return { verdict: 'execute', intent, speak: 'Pulling what needs attention.', reason: 'Aggregating alerts and risks.', risk: 'low', permission: null,
        execute: { method: 'GET', path: '/api/v1/intelligence/attention' } }
    case 'war_room.today':
      return { verdict: 'execute', intent, speak: `Summarizing today.`, reason: 'Aggregating today\'s activity.', risk: 'low', permission: null,
        execute: { method: 'GET', path: '/api/v1/briefings/today' } }
    case 'war_room.runtime':
      return { verdict: 'navigate', intent, speak: 'Showing runtime health.', reason: 'Runtime page.', risk: 'low', permission: null,
        navigate: { path: '/runtime', params: {} } }

    // ─── Research / agents (mutating → confirm) ─────────────────────────
    case 'research.start':
      return {
        verdict: needsConfirm ? 'confirm' : 'execute', intent,
        speak: `Starting research${intent.args['query'] ? ' on ' + intent.args['query'] : ''}. Confirm?`,
        reason: 'Spawns a research job that may consume LLM budget.',
        risk: 'medium', permission: 'agents.run',
        execute: { method: 'POST', path: '/api/v1/agents/research', body: { query: intent.args['query'] ?? '' } },
        recommendation: 'I will return findings to the brain memory system.',
      }
    case 'research.pause':
      return {
        verdict: 'confirm', intent,
        speak: 'Pause research agents. Confirm?',
        reason: 'Halts active research jobs. Reversible.',
        risk: 'medium', permission: 'agents.control',
        execute: { method: 'POST', path: '/api/v1/agents/pause', body: { scope: 'research' } },
      }

    case 'agent.pause': {
      const scope = intent.args['scope'] ?? 'all'
      return {
        verdict: 'confirm', intent,
        speak: `Pause ${scope} agents. Confirm?`,
        reason: `Halts ${scope} workers. Reversible from the agents page.`,
        risk: scope === 'all' ? 'high' : 'medium', permission: 'agents.control',
        execute: { method: 'POST', path: '/api/v1/agents/pause', body: { scope } },
      }
    }
    case 'agent.audit':
      return {
        verdict: 'confirm', intent,
        speak: 'Starting a safety audit. Confirm?',
        reason: 'Runs the audit pipeline across active agents and recent patches.',
        risk: 'low', permission: 'agents.audit',
        execute: { method: 'POST', path: '/api/v1/agents/audit', body: {} },
      }

    // ─── Image gen ──────────────────────────────────────────────────────
    case 'image.generate':
      return {
        verdict: needsConfirm ? 'confirm' : 'execute', intent,
        speak: `Generating an image${intent.args['prompt'] ? ' of ' + intent.args['prompt'] : ''}.`,
        reason: 'Consumes image-gen budget. Output requires creative review before publishing.',
        risk: 'low', permission: 'image.generate',
        execute: { method: 'POST', path: '/api/v1/studio/generate', body: { prompt: intent.args['prompt'] ?? '' } },
      }
    case 'image.variations': {
      const n = Number(intent.args['count'] ?? 4)
      return {
        verdict: needsConfirm ? 'confirm' : 'execute', intent,
        speak: `Generating ${n} variations.`,
        reason: `Runs a ${n}-image batch via the smart router. Each image is auto-scored.`,
        risk: 'low', permission: 'image.generate',
        execute: { method: 'POST', path: '/api/v1/studio/batch', body: { prompt: intent.args['prompt'] ?? '', count: n } },
      }
    }
    case 'image.upscale':
      return {
        verdict: 'execute', intent,
        speak: 'Upscaling the selected image.',
        reason: 'Runs the upscale path on the most recent selection.',
        risk: 'low', permission: 'image.generate',
      }
    case 'image.remix':
      return {
        verdict: 'execute', intent,
        speak: 'Preparing a remix of the selected image.',
        reason: 'Re-uses the source image with the current prompt.',
        risk: 'low', permission: 'image.generate',
      }
    case 'image.improve_prompt':
      return {
        verdict: 'execute', intent,
        speak: 'Tightening the prompt.',
        reason: 'Anti-slop rewrite — strips overused modifiers, adds editorial cues.',
        risk: 'low', permission: null,
        execute: { method: 'POST', path: '/api/v1/studio/creative/improve-prompt', body: { prompt: intent.args['prompt'] ?? '' } },
      }
    case 'image.make_premium':
      return {
        verdict: 'execute', intent,
        speak: 'Making it more premium.',
        reason: 'Promotes editorial photography cues + restrained palette.',
        risk: 'low', permission: null,
        execute: { method: 'POST', path: '/api/v1/studio/creative/make-premium', body: { prompt: intent.args['prompt'] ?? '' } },
      }
    case 'image.reduce_slop':
      return {
        verdict: 'execute', intent,
        speak: 'Reducing slop.',
        reason: 'Removes generic AI-look modifiers from the prompt.',
        risk: 'low', permission: null,
        execute: { method: 'POST', path: '/api/v1/studio/creative/improve-prompt', body: { prompt: intent.args['prompt'] ?? '' } },
      }

    // ─── Browser ───────────────────────────────────────────────────────
    case 'browser.open':
      if (!intent.args['url']) return { verdict: 'execute', intent, speak: 'Which URL?', reason: 'No URL detected.', risk: 'low', permission: null }
      return {
        verdict: 'confirm', intent,
        speak: `Open ${intent.args['url']}. Confirm?`,
        reason: 'Browser navigation under operator oversight.',
        risk: 'medium', permission: 'browser.use',
        execute: { method: 'POST', path: '/api/v1/browser/navigate', body: { url: intent.args['url'] } },
      }

    // ─── Executive summary / briefing ──────────────────────────────────
    case 'exec.summary':
      return { verdict: 'execute', intent, speak: 'Summarizing now.', reason: 'Aggregating recent activity into a summary.', risk: 'low', permission: null,
        execute: { method: 'POST', path: '/api/v1/briefings/summary', body: { topic: intent.args['topic'] ?? 'all' } } }
    case 'exec.briefing':
      return { verdict: 'navigate', intent, speak: 'Opening executive briefing.', reason: 'Daily briefing view.', risk: 'low', permission: null,
        navigate: { path: '/briefings', params: {} } }

    case 'unknown':
    default:
      return { verdict: 'execute', intent, speak: 'I did not catch a specific command.', reason: 'No matching intent above confidence threshold.', risk: 'low', permission: null }
  }
}
