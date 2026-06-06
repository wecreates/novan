/**
 * R146.326 — Persona / voice / tone layer.
 *
 * Centralizes the personality injection so every chat call (novan-chat,
 * ceo-orchestrator, brain.loop) speaks with the same voice without each
 * service re-deriving "be friendly". Also gives the operator one place to
 * tune the tone (`PERSONA_NAME`, `PERSONA_STYLE` env, or memory override).
 *
 * Design goals:
 *   - Sounds like a thoughtful colleague, not a chatbot.
 *   - Honest about uncertainty (hedges with specifics, not weasel words).
 *   - Uses contractions, varied sentence length, occasional aside.
 *   - Mirrors operator energy (terse → terse; warm → warm).
 *   - Time-aware (good morning / afternoon / evening / late-night).
 *   - Memory-aware ("like we did Monday").
 *   - Never robotic phrases: "As an AI", "I'm happy to help", "Certainly!",
 *     "Let me know if...", "Hope this helps".
 */
import { db } from '../db/client.js'
import { workspaceMemory } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'

const ROBOTIC_BANS = [
  'as an ai', 'i am an ai', 'as a language model',
  'certainly!', 'absolutely!', 'great question!',
  "i'd be happy to", 'happy to help', 'hope this helps',
  'let me know if', 'feel free to ask',
] as const

export interface PersonaContext {
  workspaceId:    string
  operatorName?:  string
  localHour?:     number    // 0-23 — for greeting selection
  recentTopic?:   string    // for "like we discussed X" callbacks
  energy?:        'terse' | 'warm' | 'analytical'  // operator energy mirror
}

/** The core voice contract — appended to every system prompt. Kept short
 *  so it competes with task-specific instructions cleanly. */
function voiceContract(): string {
  return [
    'Voice contract:',
    '- Write like a thoughtful senior teammate. Contractions. Varied length.',
    '- When unsure, name the specific thing you\'re unsure about. Skip generic hedges.',
    '- Mirror the operator\'s energy. Terse messages get terse replies.',
    '- Skip preamble. Skip closing pleasantries. End on the answer.',
    `- Never use: ${ROBOTIC_BANS.join(' / ')}.`,
    '- Reference shared history when relevant (\"like the schedule we set Monday\").',
    '- If you can\'t do something, say so plainly and list what you CAN do.',
  ].join('\n')
}

function greeting(hour: number, operator?: string): string {
  const who = operator ? `, ${operator}` : ''
  if (hour < 5)  return `Late night${who}`
  if (hour < 12) return `Morning${who}`
  if (hour < 17) return `Afternoon${who}`
  if (hour < 22) return `Evening${who}`
  return `Late${who}`
}

async function loadPersonaOverride(workspaceId: string): Promise<string | null> {
  const [row] = await db.select({ value: workspaceMemory.value })
    .from(workspaceMemory)
    .where(and(eq(workspaceMemory.workspaceId, workspaceId), eq(workspaceMemory.key, '_personaOverride')))
    .limit(1)
    .catch(() => [])
  return row?.value ?? null
}

/** Produce a system-prompt prelude that injects the persona. Call from
 *  any service before assembling the final messages array. */
export async function personaPrelude(ctx: PersonaContext): Promise<string> {
  const override = await loadPersonaOverride(ctx.workspaceId)
  if (override) return override

  const lines: string[] = []
  const opName = ctx.operatorName ?? process.env['PERSONA_OPERATOR_NAME']
  if (typeof ctx.localHour === 'number') lines.push(greeting(ctx.localHour, opName))
  lines.push(voiceContract())
  if (ctx.energy === 'terse')      lines.push('Operator is in terse mode — single sentences, no headers.')
  if (ctx.energy === 'analytical') lines.push('Operator is digging — show reasoning steps when they matter.')
  if (ctx.recentTopic)             lines.push(`Recent shared topic: ${ctx.recentTopic}.`)
  return lines.join('\n\n')
}

/** Sanity-check a draft reply for robotic phrasing. Returns rewritten if
 *  any bans found; otherwise the original. Cheap — string search only. */
export function scrubRobotic(text: string): { rewritten: string; flagged: string[] } {
  const flagged: string[] = []
  let out = text
  const lower = text.toLowerCase()
  for (const phrase of ROBOTIC_BANS) {
    if (lower.includes(phrase)) flagged.push(phrase)
  }
  // Strip common opening preamble lines.
  out = out.replace(/^(Certainly|Absolutely|Sure|Of course|Great question)[.!,]\s*/i, '')
  // Strip closing pleasantries.
  out = out.replace(/\n+(Hope this helps|Let me know if[^\n]*|Feel free[^\n]*)\.?\s*$/i, '')
  return { rewritten: out.trim(), flagged }
}

/** Mirror the operator's energy. Heuristic: short msg + no punctuation
 *  variety → terse; many \"?\" → analytical; emoji/exclamation → warm. */
export function detectEnergy(lastOperatorMsg: string): PersonaContext['energy'] {
  if (!lastOperatorMsg) return 'warm'
  const len = lastOperatorMsg.length
  if (len < 60 && !/[!?]/.test(lastOperatorMsg))     return 'terse'
  if ((lastOperatorMsg.match(/\?/g) ?? []).length >= 2) return 'analytical'
  return 'warm'
}
