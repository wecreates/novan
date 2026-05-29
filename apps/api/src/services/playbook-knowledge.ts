/**
 * playbook-knowledge.ts — Loads the curated operator playbooks (markdown
 * files in apps/api/knowledge/) and makes them available to the brain.
 *
 * Three consumption paths:
 *   1. brain.task op `playbook.consult` — explicit lookup with a topic /
 *      section heading. Returns the relevant markdown chunk.
 *   2. novan-chat system-prompt auto-injection — when a user message
 *      mentions YouTube / TikTok / Etsy / portfolio / monetization, the
 *      relevant playbook section is appended to the system prompt as
 *      a "reference block" so the LLM grounds its reply in real
 *      operating knowledge instead of generic training-data fluff.
 *   3. autonomous-mind / planning — the planner can pull a section by
 *      name to ground a multi-step plan ("how should I scale to 10
 *      channels" → multi-channel-operations.md section 3).
 *
 * Knowledge is loaded once at first call and cached. The files ship
 * with the API package — no DB row, no network fetch — so a worker
 * restart re-loads from disk in ~10ms.
 *
 * The brain MUST cite the playbook section when its reply is derived
 * from one. The system-prompt block says so explicitly; if the LLM
 * answers a YouTube question without citing the playbook, that's a
 * signal the LLM ignored the reference and should be re-prompted.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname }     from 'node:path'
import { fileURLToPath }     from 'node:url'

const KNOWLEDGE_DIR = (() => {
  // From `apps/api/src/services/` the playbooks live at `../../knowledge/`.
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', 'knowledge')
})()

export interface PlaybookSection {
  slug:    string   // playbook file slug ('youtube-automation' etc.)
  title:   string   // first H1 from the file
  section: string   // H2 section header
  /** Body of the section without its heading; trimmed. */
  body:    string
  /** Approximate token count (chars/4). */
  tokens:  number
}

interface Playbook {
  slug:    string
  title:   string
  /** Full markdown content with front-matter stripped. */
  body:    string
  /** Parsed H2 sections keyed by lower-cased heading text. */
  sections: Map<string, PlaybookSection>
  /** Token-count of the full body (chars/4 approx). */
  tokens:  number
}

let cache: Map<string, Playbook> | null = null

/** Strip a trailing newline + collapse 3+ blank lines. */
function clean(s: string): string {
  return s.trim().replace(/\n{3,}/g, '\n\n')
}

/** Parse H2 sections (## headings). Returns ordered Map. */
function parseSections(slug: string, title: string, body: string): Map<string, PlaybookSection> {
  const out = new Map<string, PlaybookSection>()
  // Split on lines that begin with "## " — markdown H2.
  const lines = body.split('\n')
  let currentHeader: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (currentHeader === null) return
    const sectionBody = clean(buf.join('\n'))
    const key = currentHeader.toLowerCase()
    out.set(key, {
      slug, title, section: currentHeader,
      body: sectionBody,
      tokens: Math.ceil(sectionBody.length / 4),
    })
    buf = []
  }
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      flush()
      currentHeader = line.replace(/^##\s+/, '').trim()
    } else if (currentHeader !== null) {
      buf.push(line)
    }
  }
  flush()
  return out
}

async function loadAll(): Promise<Map<string, Playbook>> {
  if (cache) return cache
  const next = new Map<string, Playbook>()
  let files: string[] = []
  try { files = await readdir(KNOWLEDGE_DIR) } catch { /* dir missing — empty cache */ }
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    const slug = f.replace(/\.md$/, '')
    try {
      const raw = await readFile(join(KNOWLEDGE_DIR, f), 'utf8')
      const titleMatch = raw.match(/^#\s+(.+)$/m)
      const title = titleMatch?.[1]?.trim() ?? slug
      const body = clean(raw)
      const sections = parseSections(slug, title, body)
      next.set(slug, { slug, title, body, sections, tokens: Math.ceil(body.length / 4) })
    } catch {
      // Skip unreadable files; surface in observability via console.
      console.warn(`[playbook-knowledge] failed to load ${f}`)
    }
  }
  cache = next
  return next
}

/** Force-reload from disk. Called from the brain when an operator edits
 *  a playbook file and runs `playbook.reload`. Without this, the only way
 *  to pick up edits is an API restart. */
export function invalidate(): void { cache = null }

// ─── Topic detection ─────────────────────────────────────────────────────────

/** Map of trigger keywords → (slug, section heading prefix). Topic
 *  detection lives next to the loader because the keyword list is part
 *  of the playbook contract — touching one without the other is the
 *  common source of "the brain forgot to cite the playbook" bugs. */
const TOPIC_TRIGGERS: Array<{ pattern: RegExp; slug: string; section?: string }> = [
  // YouTube — broad pattern catches both shorthand + long-form
  { pattern: /\byoutube\b|\byt\b|\bchannel\b/i,                     slug: 'youtube-automation' },
  { pattern: /\bthumbnail|\bctr\b|\bavd\b|\bapv\b/i,                slug: 'youtube-automation', section: 'thumbnail rules' },
  { pattern: /\bmonetization|\bypp\b|\badsense\b/i,                 slug: 'youtube-automation', section: 'monetization gates' },
  { pattern: /\brpm\b|\bniche\b.*\bselect/i,                        slug: 'youtube-automation', section: 'niche selection criteria' },
  // Social media
  { pattern: /\btiktok\b|\bfyp\b/i,                                 slug: 'social-media-playbook', section: 'tiktok' },
  { pattern: /\binstagram\b|\bigreels?\b|\breels?\b/i,              slug: 'social-media-playbook', section: 'instagram reels' },
  { pattern: /\btwitter\b|\bx\.com\b|\bthreads\b/i,                 slug: 'social-media-playbook' },
  { pattern: /\blinkedin\b/i,                                       slug: 'social-media-playbook', section: 'linkedin' },
  { pattern: /\bpinterest\b|\bpin\b/i,                              slug: 'social-media-playbook', section: 'pinterest' },
  // Print on demand
  { pattern: /\betsy\b|\bprintify\b|\bprintful\b|\bredbubble\b|\bpod\b/i,
    slug: 'print-on-demand' },
  { pattern: /\bmug\b|\bt-?shirt\b|\bhoodie\b|\bposter\b/i,         slug: 'print-on-demand', section: 'pricing strategy' },
  { pattern: /\bmockup\b/i,                                         slug: 'print-on-demand', section: 'etsy seo (the dominant lever)' },
  // Multi-channel + operations
  { pattern: /\bmulti[-\s]?channel\b|\bportfolio\b/i,               slug: 'multi-channel-operations' },
  { pattern: /\b10k\b|\$10,?000\b/i,                                slug: 'multi-channel-operations', section: 'cash-flow model (real numbers)' },
  { pattern: /\bsunset|\bkill\b.*\bchannel\b/i,                     slug: 'multi-channel-operations', section: 'sunsetting + pivoting' },
  // Cross-business
  { pattern: /\bcross[-\s]?(promote|business|platform)\b/i,         slug: 'multi-channel-operations', section: 'cross-business synergies' },
]

/** Find playbook sections relevant to a free-text topic.
 *  Returns at most `maxSections` sections, deduped by (slug, section).
 *  Order: explicit section matches first, then broad-slug matches. */
export async function findRelevantSections(text: string, maxSections = 3): Promise<PlaybookSection[]> {
  const books = await loadAll()
  const out: PlaybookSection[] = []
  const seen = new Set<string>()
  const hay = text.slice(0, 4000)   // bound the regex work
  // First pass — section-specific triggers
  for (const t of TOPIC_TRIGGERS) {
    if (out.length >= maxSections) break
    if (!t.pattern.test(hay)) continue
    if (!t.section) continue
    const book = books.get(t.slug)
    if (!book) continue
    // Find a section whose lower-cased header *contains* the trigger section text
    for (const [key, sec] of book.sections) {
      if (key.includes(t.section.toLowerCase())) {
        const id = `${t.slug}::${key}`
        if (!seen.has(id)) {
          seen.add(id)
          out.push(sec)
          break
        }
      }
    }
  }
  // Second pass — slug-only triggers, return the first section (usually
  // "the algorithm in one paragraph" / "the math (read this first)")
  for (const t of TOPIC_TRIGGERS) {
    if (out.length >= maxSections) break
    if (t.section) continue
    if (!t.pattern.test(hay)) continue
    const book = books.get(t.slug)
    if (!book) continue
    const firstSection = book.sections.values().next().value
    if (!firstSection) continue
    const id = `${t.slug}::${firstSection.section.toLowerCase()}`
    if (!seen.has(id)) { seen.add(id); out.push(firstSection) }
  }
  return out
}

/** Explicit lookup. Used by the brain-task op `playbook.consult`. */
export async function consult(opts: { slug?: string; section?: string; query?: string; maxSections?: number }): Promise<PlaybookSection[]> {
  const books = await loadAll()
  // Explicit (slug, section)
  if (opts.slug && opts.section) {
    const book = books.get(opts.slug)
    if (!book) return []
    const key = opts.section.toLowerCase()
    const direct = book.sections.get(key)
    if (direct) return [direct]
    // Fuzzy: section name contains the query as substring
    for (const [k, s] of book.sections) if (k.includes(key)) return [s]
    return []
  }
  // Whole playbook by slug
  if (opts.slug) {
    const book = books.get(opts.slug)
    if (!book) return []
    return [...book.sections.values()].slice(0, opts.maxSections ?? 5)
  }
  // Free-text search
  if (opts.query) return findRelevantSections(opts.query, opts.maxSections ?? 3)
  return []
}

/** List available playbooks — used by the chat to advertise capabilities. */
export async function listPlaybooks(): Promise<Array<{ slug: string; title: string; sectionCount: number; tokens: number }>> {
  const books = await loadAll()
  return [...books.values()].map(b => ({
    slug: b.slug, title: b.title, sectionCount: b.sections.size, tokens: b.tokens,
  }))
}

/** Compose a single reference block to splice into a chat system prompt.
 *  Caps the total token cost so a verbose match doesn't blow the budget. */
export async function composeReferenceBlock(text: string, opts?: { maxTokens?: number; maxSections?: number }): Promise<string> {
  const maxTokens = opts?.maxTokens   ?? 1800
  const maxSections = opts?.maxSections ?? 2
  const matches = await findRelevantSections(text, maxSections)
  if (matches.length === 0) return ''
  // The $10k/mo per-business floor reminder leads EVERY playbook block.
  // Without this, LLMs drift toward smaller-stakes advice ("here's how
  // to grow your channel to 1k subs!") instead of staying anchored on
  // what actually matters: closing the gap to $10k/mo.
  let acc = `\n\n## Playbook reference (cite the section name if you draw from it)

**Platform floor (non-negotiable)**: every business in this workspace targets at least $10,000/month in revenue. This is the FLOOR, not a stretch goal. Suggestions that don't have a plausible path to $10k/mo are filler — anchor every recommendation to the gap-to-$10k math. Use the deterministic math op \`business.feasibility\` when you're unsure whether a niche / format / cadence can close to floor; never guess.
`
  let used = 0
  for (const m of matches) {
    const block = `\n### ${m.title} — ${m.section}\n${m.body}\n`
    const cost = Math.ceil(block.length / 4)
    if (used + cost > maxTokens) {
      // Truncate the last block so we stay under budget but still emit something
      const budget = Math.max(0, maxTokens - used)
      const cutoff = Math.max(0, budget * 4 - 100)
      acc += `\n### ${m.title} — ${m.section}\n${m.body.slice(0, cutoff)}\n[…truncated to fit budget…]\n`
      break
    }
    acc += block
    used += cost
  }
  return acc
}
