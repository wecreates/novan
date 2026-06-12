/**
 * R681 — Export a novan.chat session as a PDF transcript.
 *
 * Combines R663 chat history with R679 markdown→PDF. Useful for archiving
 * a research conversation, sharing an agent walkthrough, or attaching a
 * session log to a follow-up.
 */
import { getChatSession } from './r663-novan-chat.js'
import { markdownToPdf } from './r679-markdown-pdf.js'

export interface ChatExportInput {
  sessionId: string
  title?:    string
  includeMeta?: boolean
}

export async function exportChatPdf(workspaceId: string, input: ChatExportInput): Promise<{
  ok: boolean
  assetId?: string
  publicUrl?: string
  bytes?: number
  pages?: number
  turns?: number
  latencyMs: number
  error?: string
}> {
  const t0 = Date.now()
  if (!input.sessionId) return { ok: false, error: 'sessionId required', latencyMs: 0 }
  const turns = await getChatSession(workspaceId, input.sessionId)
  if (turns.length === 0) return { ok: false, error: 'session has no turns', latencyMs: Date.now() - t0 }

  const title = input.title ?? `Chat ${input.sessionId.slice(0, 16)}`
  const showMeta = input.includeMeta !== false

  const lines: string[] = [`# ${title}`, '']
  if (showMeta) {
    const totalTokens = turns.reduce((s, t) => s + Number(t['tokens'] ?? 0), 0)
    const totalCost   = turns.reduce((s, t) => s + Number(t['cost_usd'] ?? 0), 0)
    const totalTools  = turns.reduce((s, t) => s + Number(t['tool_calls'] ?? 0), 0)
    const first       = String(turns[0]?.['created_at'] ?? '').slice(0, 16)
    lines.push(`*Session ${input.sessionId} · ${turns.length} turns · ${totalTokens} tokens · $${totalCost.toFixed(4)} · ${totalTools} tool calls · started ${first}*`, '', '---', '')
  }
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!
    const ts = String(t['created_at'] ?? '').slice(11, 16)
    lines.push(`## Turn ${i + 1} · ${ts}`, '')
    lines.push(`**You:** ${String(t['user_message'] ?? '').replace(/\n/g, ' ')}`, '')
    const assistant = String(t['assistant_msg'] ?? '')
    lines.push(`**Novan:**`, '', assistant, '')
    if (showMeta) {
      const tc = Number(t['tool_calls'] ?? 0)
      const tk = Number(t['tokens'] ?? 0)
      const cu = Number(t['cost_usd'] ?? 0)
      lines.push(`*${tk} tokens · $${cu.toFixed(6)}${tc ? ` · ${tc} tool calls` : ''}*`, '')
    }
  }

  const pdf = await markdownToPdf(workspaceId, {
    markdown: lines.join('\n'),
    title,
    format: 'A4',
  })
  const out: ReturnType<typeof exportChatPdf> extends Promise<infer R> ? R : never = {
    ok: pdf.ok,
    turns: turns.length,
    latencyMs: Date.now() - t0,
  }
  if (pdf.error)     out.error     = pdf.error
  if (pdf.assetId)   out.assetId   = pdf.assetId
  if (pdf.publicUrl) out.publicUrl = pdf.publicUrl
  if (pdf.bytes)     out.bytes     = pdf.bytes
  if (pdf.pages)     out.pages     = pdf.pages
  return out
}
