/**
 * Tests for conversation-export — pure markdown + JSON formatters.
 */
import { describe, it, expect } from 'vitest'
import {
  renderMarkdown, renderJson, exportFilename,
  type ExportMessage, type ExportConversation,
} from '../services/conversation-export.js'

const conv: ExportConversation = {
  id: 'c1', title: 'Strategy review', createdAt: 1_700_000_000_000,
}

const msgs: ExportMessage[] = [
  { id: 'm1', role: 'user',      content: 'How are costs trending?', createdAt: 1_700_000_001_000 },
  { id: 'm2', role: 'assistant', content: 'API spend up 12% WoW.',   createdAt: 1_700_000_002_000, model: 'claude-sonnet', tokens: 184, provider: 'anthropic' },
  { id: 'm3', role: 'user',      content: 'Why?',                     createdAt: 1_700_000_003_000 },
]

const NOW = 1_700_000_500_000

// ─── Markdown ──────────────────────────────────────────────────────────

describe('conversation-export: renderMarkdown', () => {
  it('includes the title and message count', () => {
    const md = renderMarkdown(conv, msgs, { now: NOW })
    expect(md).toMatch(/^# Strategy review/)
    expect(md).toMatch(/3 messages/)
  })

  it('labels roles as You / Novan', () => {
    const md = renderMarkdown(conv, msgs, { now: NOW })
    expect(md).toMatch(/\*\*You\*\*/)
    expect(md).toMatch(/\*\*Novan\*\*/)
  })

  it('shows model + token meta on assistant turns', () => {
    const md = renderMarkdown(conv, msgs, { now: NOW })
    expect(md).toMatch(/claude-sonnet/)
    expect(md).toMatch(/184 tok/)
  })

  it('orders messages by createdAt ascending', () => {
    const shuffled = [msgs[2]!, msgs[0]!, msgs[1]!]
    const md = renderMarkdown(conv, shuffled, { now: NOW })
    const userIdx     = md.indexOf('How are costs trending?')
    const apiIdx      = md.indexOf('API spend up 12%')
    const whyIdx      = md.indexOf('Why?')
    expect(userIdx).toBeLessThan(apiIdx)
    expect(apiIdx).toBeLessThan(whyIdx)
  })

  it('skips superseded messages by default', () => {
    const m: ExportMessage = { ...msgs[1]!, id: 'm2x', content: 'old answer', supersededAt: 1_700_000_001_500 }
    const md = renderMarkdown(conv, [...msgs, m], { now: NOW })
    expect(md).not.toMatch(/old answer/)
  })

  it('includes superseded when opted in', () => {
    const m: ExportMessage = { ...msgs[1]!, id: 'm2x', content: 'old answer', supersededAt: 1_700_000_001_500 }
    const md = renderMarkdown(conv, [...msgs, m], { now: NOW, includeSuperseded: true })
    expect(md).toMatch(/old answer/)
  })

  it('renders inline attachment as placeholder, hosted as link', () => {
    const m: ExportMessage = {
      ...msgs[0]!,
      attachments: [
        { url: 'data:image/png;base64,AAA', mime: 'image/png', kind: 'image', name: 'shot.png', sizeBytes: 1024 },
        { url: 'https://x.com/a.pdf',       mime: 'application/pdf', kind: 'document', name: 'a.pdf' },
      ],
    }
    const md = renderMarkdown(conv, [m, msgs[1]!], { now: NOW })
    expect(md).toMatch(/inline image/)
    expect(md).toMatch(/\[a\.pdf\]\(https:\/\/x\.com\/a\.pdf\)/)
  })

  it('shows fork lineage when forked', () => {
    const md = renderMarkdown(
      { ...conv, forkedFromConversationId: 'parent_x' },
      msgs, { now: NOW },
    )
    expect(md).toMatch(/forked from `parent_x`/)
  })

  it('shows _stopped_ / _regenerated_ when applicable', () => {
    const stopped:   ExportMessage = { ...msgs[1]!, cancelled: true }
    const regen:     ExportMessage = { ...msgs[1]!, id: 'm2b', regeneratedFrom: 'm2', createdAt: 1_700_000_002_500 }
    const md = renderMarkdown(conv, [msgs[0]!, stopped, regen], { now: NOW })
    expect(md).toMatch(/_stopped_/)
    expect(md).toMatch(/_regenerated_/)
  })

  it('collapses excess blank lines', () => {
    const md = renderMarkdown(conv, msgs, { now: NOW })
    expect(md).not.toMatch(/\n{3,}/)
  })
})

// ─── JSON ──────────────────────────────────────────────────────────────

describe('conversation-export: renderJson', () => {
  it('embeds conversation + sorted messages', () => {
    const j = renderJson(conv, [msgs[2]!, msgs[0]!, msgs[1]!], { now: NOW })
    expect(j.conversation.id).toBe('c1')
    expect(j.messageCount).toBe(3)
    expect(j.messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(j.exportedAt).toBe(NOW)
  })

  it('drops superseded by default', () => {
    const m: ExportMessage = { ...msgs[1]!, id: 'm2x', supersededAt: 1_700_000_001_500 }
    const j = renderJson(conv, [...msgs, m], { now: NOW })
    expect(j.messageCount).toBe(3)
  })

  it('keeps superseded when opted in', () => {
    const m: ExportMessage = { ...msgs[1]!, id: 'm2x', supersededAt: 1_700_000_001_500 }
    const j = renderJson(conv, [...msgs, m], { now: NOW, includeSuperseded: true })
    expect(j.messageCount).toBe(4)
  })
})

// ─── exportFilename ────────────────────────────────────────────────────

describe('conversation-export: exportFilename', () => {
  it('slugifies the title', () => {
    expect(exportFilename('Strategy review!', 1_700_000_000_000, 'md'))
      .toMatch(/^talk-strategy-review-\d{4}-\d{2}-\d{2}\.md$/)
  })

  it('caps title length', () => {
    const long = 'a'.repeat(200)
    const fn = exportFilename(long, NOW, 'json')
    expect(fn.length).toBeLessThan(80)
    expect(fn).toMatch(/\.json$/)
  })

  it('falls back when title is empty', () => {
    expect(exportFilename('', NOW, 'md')).toMatch(/^talk-conversation-/)
  })

  it('strips trailing dashes', () => {
    const fn = exportFilename('hi!!!', NOW, 'md')
    expect(fn).not.toMatch(/-+\.\w+$/)
  })
})
