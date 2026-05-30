/**
 * conversation-export.ts — render a conversation as Markdown or JSON.
 *
 * Pure formatters. The route layer fetches the rows and hands them in;
 * tests exercise the formatters without DB.
 *
 * Markdown shape:
 *   # <title>
 *   _Exported <ISO ts> · N messages_
 *   ---
 *   **You** · <iso>
 *   <content>
 *
 *   **Novan** · <iso> · <model> · <tokens> tok
 *   <content>
 *
 *   ...
 *
 * Superseded messages are skipped by default (they're roll-backed turns);
 * pass `includeSuperseded: true` to keep the full lineage in the file.
 */

export interface ExportMessage {
  id:              string
  role:            string
  content:         string
  createdAt:       number
  provider?:       string | null
  model?:          string | null
  tokens?:         number
  costUsd?:        number
  citations?:      Array<{ kind: string; id: string; extract: string }>
  attachments?:    Array<{ url: string; mime: string; kind: string; name?: string; sizeBytes?: number }>
  supersededAt?:   number | null
  cancelled?:      boolean
  regeneratedFrom?: string | null
}

export interface ExportConversation {
  id:                       string
  title:                    string
  createdAt:                number
  forkedFromConversationId?: string | null
  forkedFromMessageId?:      string | null
}

export interface ExportOptions {
  includeSuperseded?: boolean
  includeAudit?:      boolean
  /** Now-ish; injected for deterministic testing. */
  now?: number
}

// ─── Markdown ──────────────────────────────────────────────────────────

export function renderMarkdown(
  conv: ExportConversation,
  messages: ExportMessage[],
  opts: ExportOptions = {},
): string {
  const now = opts.now ?? Date.now()
  const visible = opts.includeSuperseded
    ? [...messages]
    : messages.filter(m => !m.supersededAt)
  const sorted = visible.sort((a, b) => a.createdAt - b.createdAt)

  const lines: string[] = []
  lines.push(`# ${conv.title}`)
  lines.push('')
  const head = [`Exported ${new Date(now).toISOString()}`, `${sorted.length} messages`]
  if (conv.forkedFromConversationId) {
    head.push(`forked from \`${conv.forkedFromConversationId}\``)
  }
  lines.push(`_${head.join(' · ')}_`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const m of sorted) {
    const who = m.role === 'user' ? '**You**' : m.role === 'assistant' ? '**Novan**' : `**${m.role}**`
    const meta: string[] = [new Date(m.createdAt).toISOString()]
    if (m.role === 'assistant') {
      if (m.model)  meta.push(String(m.model))
      if (m.tokens) meta.push(`${m.tokens} tok`)
    }
    if (m.cancelled)       meta.push('_stopped_')
    if (m.regeneratedFrom) meta.push('_regenerated_')
    lines.push(`${who} · ${meta.join(' · ')}`)

    if (m.attachments && m.attachments.length > 0) {
      for (const a of m.attachments) {
        // R146.52 — escape markdown link syntax in label + URL. Label is
        // a.name ?? a.mime; a `]` in either breaks out of the link text
        // bracket and could let an attacker plant `[fake](javascript:0)`
        // even though our URL is R146.50-locked to https/data. Cheap to
        // strip the structural chars on the markdown side.
        const safeLabel = (a.name ?? a.mime).replace(/[\\[\]]/g, ' ').slice(0, 200)
        const safeUrl   = a.url.replace(/[\s)<>]/g, '')   // URL has no whitespace; strip ) too so it can't close the link early
        if (a.url.startsWith('data:')) {
          lines.push(`> 📎 ${safeLabel} *(inline ${a.kind}, ${a.sizeBytes ?? '?'} bytes)*`)
        } else {
          lines.push(`> 📎 [${safeLabel}](${safeUrl})`)
        }
      }
    }
    lines.push('')
    lines.push(m.content)
    lines.push('')

    if (opts.includeAudit && m.citations && m.citations.length > 0) {
      lines.push(`> _citations:_ ${m.citations.map(c => `\`${c.kind}:${c.id.slice(0, 8)}\``).join(' · ')}`)
      lines.push('')
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

// ─── JSON ──────────────────────────────────────────────────────────────

export interface JsonExport {
  conversation: ExportConversation
  exportedAt:   number
  messageCount: number
  messages:     ExportMessage[]
}

export function renderJson(
  conv: ExportConversation,
  messages: ExportMessage[],
  opts: ExportOptions = {},
): JsonExport {
  const now = opts.now ?? Date.now()
  const visible = opts.includeSuperseded
    ? [...messages]
    : messages.filter(m => !m.supersededAt)
  const sorted = visible.sort((a, b) => a.createdAt - b.createdAt)
  return {
    conversation: conv,
    exportedAt:   now,
    messageCount: sorted.length,
    messages:     sorted,
  }
}

// ─── Filename helper ───────────────────────────────────────────────────

/**
 * Build a safe filename like `talk-novan-strategy-2026-05-18.md`.
 * Strips anything but a-z0-9-_, truncates to 60 chars total.
 */
export function exportFilename(title: string, ts: number, ext: 'md' | 'json'): string {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'conversation'
  const date = new Date(ts).toISOString().slice(0, 10)
  return `talk-${slug}-${date}.${ext}`
}
