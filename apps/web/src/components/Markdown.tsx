/**
 * Markdown — minimal safe renderer (item #23).
 *
 * No external deps. Supports: bold **x**, italic *x*, inline `code`,
 * links [text](url), bullet lists, line breaks. Escapes HTML by default.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isSafeUrl(url: string): boolean {
  const u = url.trim().toLowerCase()
  // R146.42 — protocol-relative URLs (starting with //) inherit the
  // current scheme and navigate to an attacker-controlled host. The
  // earlier startsWith('/') was meant to allow same-origin relative
  // paths but also accidentally allowed //evil.com/phish. Reject any
  // path that starts with // explicitly.
  if (u.startsWith('//')) return false
  return u.startsWith('http://') || u.startsWith('https://') || u.startsWith('mailto:') || u.startsWith('/')
}

/** Exported for use by other components rendering user/LLM-supplied
 *  URLs in anchor tags. Returns the original URL when safe, '#' when
 *  not — so an attempted javascript:/data:/protocol-relative URL
 *  becomes a no-op anchor instead of a navigation/script vector. */
export function safeHref(url: string | undefined | null): string {
  if (!url) return '#'
  return isSafeUrl(url) ? url : '#'
}

function renderInline(text: string): string {
  let html = escapeHtml(text)
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--accent-blue)] text-[0.9em]">$1</code>')
  // Bold (**x**)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // Italic (*x*) — only if not adjacent to space-asterisks already
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
  // Links [text](url) with safe scheme check
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t: string, u: string) => {
    if (!isSafeUrl(u)) return escapeHtml(`[${t}](${u})`)
    return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" class="text-[var(--accent-blue)] hover:underline">${t}</a>`
  })
  return html
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  if (!source) return null
  const lines = source.split('\n')
  const parts: string[] = []
  let inList = false

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.match(/^\s*[-*]\s+/)) {
      if (!inList) { parts.push('<ul class="list-disc list-inside space-y-0.5">'); inList = true }
      const item = line.replace(/^\s*[-*]\s+/, '')
      parts.push(`<li>${renderInline(item)}</li>`)
    } else {
      if (inList) { parts.push('</ul>'); inList = false }
      if (line.trim() === '') parts.push('<br/>')
      else parts.push(`<p>${renderInline(line)}</p>`)
    }
  }
  if (inList) parts.push('</ul>')

  return (
    <div
      className={className ?? 'text-sm text-[var(--text)] leading-relaxed space-y-1'}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: parts.join('') }}
    />
  )
}
