/**
 * R146.326 — Honest task assessment.
 *
 * When the operator hands Novan a task, this answers three questions
 * before committing to do it:
 *
 *   1. Can I do this? (yes / partial / no)
 *   2. If yes — which capabilities + steps?
 *   3. If no / partial — what's missing AND what ARE the paths forward?
 *
 * Output is structured so it can drive either an honest reply
 * ("I can do steps 1-3, but step 4 needs your Slack creds, and there
 * are three workarounds: X / Y / Z") OR autonomous execution.
 *
 * Lives in services/ so brain-task can expose it as the `task.honest_assess`
 * op AND novan-chat can call it inline before claiming "yes I'll do that".
 */
import { CAPABILITIES, type Capability } from './brain-completeness.js'

export interface AssessmentInput {
  task:        string                     // raw operator description
  requiredCaps?: string[]                 // optional pre-classified IDs
  context?:    Record<string, unknown>
}

export interface AssessmentOutput {
  verdict:      'can_do' | 'partial' | 'cannot'
  confidence:   number                    // 0..1
  steps:        Array<{ step: string; capability?: string; ok: boolean; note?: string }>
  gaps:         Array<{ capability: string; reason: string; workarounds: string[] }>
  honestReply:  string                    // human-readable text to send back
}

const KEYWORD_TO_CAP: Array<{ rx: RegExp; capId: string }> = [
  { rx: /\b(send|email|message|dm|text|reply)\s+.*(to|via)\s+(slack|email|sms|whatsapp|discord)/i, capId: 'act.send' },
  { rx: /\b(post|publish|upload)\s+.*(youtube|tiktok|instagram|x\.com|twitter|reddit)/i,           capId: 'act.send' },
  { rx: /\b(buy|purchase|order|pay|checkout|charge|withdraw)/i,                                     capId: 'NOT_SUPPORTED:financial' },
  // R327 #11 — allow ≤3 filler words between verb and noun ("generate a logo image")
  { rx: /\b(generate|create|make|design|draw|render)\b(?:\s+\w+){0,3}\s+(image|picture|photo|logo|thumbnail|graphic|illustration|icon|banner)/i, capId: 'act.image' },
  { rx: /\b(generate|create|make|produce|edit)\b(?:\s+\w+){0,3}\s+(video|short|reel|tiktok|youtube|clip)/i, capId: 'act.video' },
  { rx: /\b(transcribe|listen|speech-to-text|stt)/i,                                                capId: 'perceive.audio' },
  { rx: /\b(read|fetch|scrape|browse|visit|open)\s+.*(http|website|url|page)/i,                     capId: 'perceive.web' },
  { rx: /\b(click|fill|submit|navigate|automate)\s+.*(form|button|page)/i,                          capId: 'act.web' },
  { rx: /\b(fix|patch|edit|refactor|implement)\s+.*(code|bug|file|function)/i,                      capId: 'act.code' },
  { rx: /\b(deploy|ship|release|push)\s+.*(prod|production|live)/i,                                 capId: 'act.deploy' },
  { rx: /\b(call|phone|voice|dial)/i,                                                               capId: 'NOT_SUPPORTED:telephony' },
  { rx: /\b(remember|recall|what did|last week|last month)/i,                                       capId: 'memory.long' },
]

const FINANCIAL_BAN = (
  'I won\'t handle money movement directly — no purchases, transfers, trades, or payment-method changes. ' +
  'I can prepare the order details, draft the email/DM to the vendor, and walk you through the checkout, but you press the final button.'
)
const TELEPHONY_BAN = (
  'I can\'t place phone calls on your behalf. Workarounds: I can draft a script and book a Zoom/Meet for you to run, ' +
  'send a follow-up email after the call, or hand the task to a phone-capable assistant if you wire one up.'
)

function classify(task: string, override?: string[]): string[] {
  if (override && override.length > 0) return override
  const matched: string[] = []
  for (const { rx, capId } of KEYWORD_TO_CAP) {
    if (rx.test(task)) matched.push(capId)
  }
  // If nothing matched, default to chat (we can at least reply).
  if (matched.length === 0) matched.push('act.chat')
  return matched
}

function findCap(id: string): Capability | undefined {
  return CAPABILITIES.find(c => c.id === id)
}

function workaroundsFor(capId: string): string[] {
  if (capId.startsWith('NOT_SUPPORTED:financial')) return [
    'I can prepare the order draft and email it for your approval.',
    'I can compare prices/options and send you a one-click checkout link.',
    'I can schedule a reminder when the purchase window opens.',
  ]
  if (capId.startsWith('NOT_SUPPORTED:telephony')) return [
    'Draft a call script and email it to you.',
    'Book a Zoom/Meet for you to run the call.',
    'Wait for the call to finish and send the follow-up message.',
  ]
  if (capId === 'act.send') return [
    'Draft the message and show it to you to send.',
    'Send it once you provide the connector creds.',
    'Use the closest connector that IS wired (e.g. webhook → Zapier).',
  ]
  if (capId === 'act.web') return [
    'Read the page and walk you through clicking it yourself.',
    'Generate a Playwright script and run it once approved.',
    'Use the connector for that service if one exists.',
  ]
  return ['Hand the step back to you with the partial output I produced.']
}

export function assessTask(input: AssessmentInput): AssessmentOutput {
  const capIds = classify(input.task, input.requiredCaps)
  const steps: AssessmentOutput['steps'] = []
  const gaps: AssessmentOutput['gaps'] = []

  for (const capId of capIds) {
    if (capId.startsWith('NOT_SUPPORTED:')) {
      const reason = capId.endsWith('financial') ? FINANCIAL_BAN : TELEPHONY_BAN
      gaps.push({ capability: capId, reason, workarounds: workaroundsFor(capId) })
      steps.push({ step: `Direct execution of "${input.task.slice(0, 80)}"`, capability: capId, ok: false, note: reason })
      continue
    }
    const cap = findCap(capId)
    if (!cap) {
      steps.push({ step: `Use ${capId}`, capability: capId, ok: false, note: 'capability not registered' })
      gaps.push({ capability: capId, reason: 'unknown capability', workarounds: ['I\'ll ask you for guidance on next step.'] })
      continue
    }
    if (cap.status === 'present') {
      steps.push({ step: cap.name, capability: capId, ok: true })
    } else {
      steps.push({ step: cap.name, capability: capId, ok: false, note: cap.gap ?? cap.status })
      gaps.push({ capability: capId, reason: cap.gap ?? `${cap.name} is ${cap.status}`, workarounds: workaroundsFor(capId) })
    }
  }

  const verdict: AssessmentOutput['verdict'] =
    gaps.length === 0 ? 'can_do'
      : gaps.every(g => g.capability.startsWith('NOT_SUPPORTED')) ? 'cannot'
      : 'partial'
  const confidence = verdict === 'can_do' ? 0.9 : verdict === 'partial' ? 0.6 : 0.95

  // Compose the honest reply.
  const lines: string[] = []
  if (verdict === 'can_do') {
    lines.push(`Yes, I can do this. Plan: ${steps.map(s => s.step).join(' → ')}.`)
  } else if (verdict === 'partial') {
    const doable = steps.filter(s => s.ok).map(s => s.step)
    lines.push(`Mostly. I can handle: ${doable.join(', ') || 'no steps directly'}.`)
    lines.push('Where I get stuck:')
    for (const g of gaps) {
      lines.push(`  - ${g.reason}`)
      lines.push(`    Workarounds: ${g.workarounds.join(' / ')}`)
    }
  } else {
    lines.push('I can\'t directly do this, but here\'s every way it could still get done:')
    for (const g of gaps) {
      lines.push(`  - ${g.reason}`)
      for (const w of g.workarounds) lines.push(`    • ${w}`)
    }
  }

  return { verdict, confidence, steps, gaps, honestReply: lines.join('\n') }
}
