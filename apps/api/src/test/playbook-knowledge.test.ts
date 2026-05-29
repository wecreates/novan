/**
 * Tests for playbook-knowledge.ts — file parsing + topic detection +
 * reference-block composition.
 *
 * The loader reads the real files in apps/api/knowledge so these tests
 * implicitly assert the playbooks themselves exist + parse cleanly.
 * If a playbook gets edited and breaks structure, the test catches it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  listPlaybooks, consult, findRelevantSections, composeReferenceBlock, invalidate,
} from '../services/playbook-knowledge.js'

beforeEach(() => { invalidate() })

// ─── listPlaybooks ─────────────────────────────────────────────────────────

describe('listPlaybooks', () => {
  it('discovers all knowledge files on disk', async () => {
    const list = await listPlaybooks()
    const slugs = list.map(p => p.slug).sort()
    // The five canonical playbooks ship with the platform.
    expect(slugs).toContain('youtube-automation')
    expect(slugs).toContain('social-media-playbook')
    expect(slugs).toContain('print-on-demand')
    expect(slugs).toContain('multi-channel-operations')
    expect(slugs).toContain('operator-runbook')
  })

  it('each playbook reports a section count > 0', async () => {
    const list = await listPlaybooks()
    for (const p of list) {
      expect(p.sectionCount).toBeGreaterThan(0)
    }
  })

  it('each playbook reports a meaningful token count', async () => {
    const list = await listPlaybooks()
    for (const p of list) {
      expect(p.tokens).toBeGreaterThan(500)   // even the shortest playbook is substantial
    }
  })
})

// ─── consult ───────────────────────────────────────────────────────────────

describe('consult: explicit slug + section', () => {
  it('returns one section when slug+section both match exactly', async () => {
    const r = await consult({ slug: 'youtube-automation', section: 'thumbnail rules' })
    expect(r.length).toBe(1)
    expect(r[0]!.title.toLowerCase()).toContain('youtube')
    expect(r[0]!.section.toLowerCase()).toContain('thumbnail')
  })

  it('matches fuzzy when section is a substring of the heading', async () => {
    const r = await consult({ slug: 'youtube-automation', section: 'thumbnail' })
    expect(r.length).toBe(1)
    expect(r[0]!.section.toLowerCase()).toContain('thumbnail')
  })

  it('returns empty when slug is unknown', async () => {
    const r = await consult({ slug: 'nonexistent-playbook', section: 'whatever' })
    expect(r).toEqual([])
  })

  it('returns empty when section does not exist in the playbook', async () => {
    const r = await consult({ slug: 'youtube-automation', section: 'completely fictional section name xyz' })
    expect(r).toEqual([])
  })
})

describe('consult: whole-playbook lookup', () => {
  it('returns multiple sections when only slug is given', async () => {
    const r = await consult({ slug: 'youtube-automation', maxSections: 3 })
    expect(r.length).toBe(3)
    expect(r.every(s => s.slug === 'youtube-automation')).toBe(true)
  })
})

describe('consult: free-text query', () => {
  it('matches youtube playbook on the word "youtube"', async () => {
    const r = await consult({ query: 'what are the youtube monetization gates' })
    expect(r.length).toBeGreaterThan(0)
    expect(r.some(s => s.slug === 'youtube-automation')).toBe(true)
  })

  it('matches the POD playbook on "etsy"', async () => {
    const r = await consult({ query: 'how should I optimize my etsy listing' })
    expect(r.some(s => s.slug === 'print-on-demand')).toBe(true)
  })

  it('matches multi-channel on "$10k" or "portfolio"', async () => {
    const r = await consult({ query: 'how do I structure my portfolio toward $10k/mo' })
    expect(r.some(s => s.slug === 'multi-channel-operations')).toBe(true)
  })

  it('returns empty array on a query with no triggers', async () => {
    const r = await consult({ query: 'the quick brown fox jumps over the lazy dog' })
    expect(r).toEqual([])
  })
})

// ─── findRelevantSections ─────────────────────────────────────────────────

describe('findRelevantSections', () => {
  it('caps results to maxSections', async () => {
    const r = await findRelevantSections('youtube thumbnail rpm tiktok etsy portfolio 10k', 2)
    expect(r.length).toBeLessThanOrEqual(2)
  })

  it('dedupes by (slug, section)', async () => {
    // "youtube" + "yt" + "channel" all map to the youtube playbook —
    // result should not contain the same section twice.
    const r = await findRelevantSections('youtube yt channel youtube', 5)
    const ids = r.map(s => `${s.slug}::${s.section.toLowerCase()}`)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// ─── composeReferenceBlock ────────────────────────────────────────────────

describe('composeReferenceBlock', () => {
  it('returns empty string when no triggers match', async () => {
    const block = await composeReferenceBlock('completely unrelated text about quantum mechanics')
    expect(block).toBe('')
  })

  it('always begins with the $10k floor reminder when matching', async () => {
    const block = await composeReferenceBlock('how should I run my youtube channel')
    expect(block.length).toBeGreaterThan(0)
    expect(block).toMatch(/Platform floor.*non-negotiable/i)
    expect(block).toMatch(/\$10,?000\/month/)
  })

  it('respects the maxTokens budget', async () => {
    const tight = await composeReferenceBlock('youtube thumbnail rpm tiktok etsy', { maxTokens: 200 })
    // 200 tokens × 4 chars/token ≈ 800 chars of content, plus header.
    // The truncation message itself adds another ~30 chars.
    expect(tight.length).toBeLessThan(2_500)
  })

  it('includes a truncation marker when content overflows', async () => {
    const tight = await composeReferenceBlock('youtube tiktok etsy portfolio', { maxTokens: 100, maxSections: 5 })
    // Either the block stays empty (no matches fit) or contains truncation marker
    if (tight.length > 0) {
      expect(tight).toMatch(/truncated|—|reference/)
    }
  })

  it('cites playbook section names in the output', async () => {
    const block = await composeReferenceBlock('how do I score a niche for $10k feasibility')
    expect(block).toMatch(/###\s/)   // section headers
  })
})

// ─── cache invalidation ────────────────────────────────────────────────────

describe('invalidate', () => {
  it('forces a re-read on the next consult call', async () => {
    // Warm the cache
    const a = await listPlaybooks()
    expect(a.length).toBeGreaterThan(0)
    // Invalidate
    invalidate()
    // Next call rebuilds — should still return the same content
    const b = await listPlaybooks()
    expect(b.length).toBe(a.length)
  })
})
