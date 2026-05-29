/**
 * Tests for agency-catalog.ts — pure parsing + selection helpers.
 * DB I/O (`syncAgentCatalog`) is integration-tested separately.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled)
      if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
})

import { parseFrontmatter, parseAgentMarkdown, slugFromFilename, pickAgent } from '../services/agency-catalog.js'

// ─── parseFrontmatter ──────────────────────────────────────────────────

describe('agency-catalog: parseFrontmatter', () => {
  it('extracts key/value pairs from a clean frontmatter block', () => {
    const raw = `---
name: AI Engineer
description: Expert AI/ML engineer
color: blue
emoji: 🤖
vibe: Turns ML models into production features.
---
# Body
Long prompt here.`
    const { meta, body } = parseFrontmatter(raw)
    expect(meta['name']).toBe('AI Engineer')
    expect(meta['color']).toBe('blue')
    expect(meta['emoji']).toBe('🤖')
    expect(meta['vibe']).toContain('Turns ML')
    expect(body).toMatch(/^# Body/)
  })

  it('handles files without frontmatter (returns empty meta + full body)', () => {
    const { meta, body } = parseFrontmatter('# Just markdown')
    expect(Object.keys(meta).length).toBe(0)
    expect(body).toBe('# Just markdown')
  })

  it('strips wrapping quotes', () => {
    const { meta } = parseFrontmatter(`---
name: "Quoted Name"
vibe: 'single-quoted'
---
body`)
    expect(meta['name']).toBe('Quoted Name')
    expect(meta['vibe']).toBe('single-quoted')
  })

  it('lowercases keys for case-insensitive lookup', () => {
    const { meta } = parseFrontmatter(`---
Name: X
COLOR: red
---
body`)
    expect(meta['name']).toBe('X')
    expect(meta['color']).toBe('red')
  })

  it('strips UTF-8 BOM', () => {
    const raw = '﻿---\nname: BomTest\n---\nbody body body body body body body body body body'
    const { meta } = parseFrontmatter(raw)
    expect(meta['name']).toBe('BomTest')
  })
})

// ─── slugFromFilename ──────────────────────────────────────────────────

describe('agency-catalog: slugFromFilename', () => {
  it('strips .md and lowercases', () => {
    expect(slugFromFilename('Engineering-AI-Engineer.md')).toBe('engineering-ai-engineer')
  })
  it('strips leading/trailing dashes', () => {
    expect(slugFromFilename('--something--.md')).toBe('something')
  })
  it('returns empty string for empty filename', () => {
    expect(slugFromFilename('.md')).toBe('')
  })
})

// ─── parseAgentMarkdown ────────────────────────────────────────────────

describe('agency-catalog: parseAgentMarkdown', () => {
  const long = 'You are an Engineer. ' + 'word '.repeat(40)

  it('returns a ParsedAgent for a well-formed file', () => {
    const raw = `---
name: AI Engineer
description: ML expert
color: blue
emoji: 🤖
vibe: Production ML
---
${long}`
    const p = parseAgentMarkdown(raw, 'engineering/engineering-ai-engineer.md')
    expect(p).not.toBeNull()
    expect(p!.slug).toBe('engineering-ai-engineer')
    expect(p!.department).toBe('engineering')
    expect(p!.name).toBe('AI Engineer')
    expect(p!.color).toBe('blue')
    expect(p!.systemPrompt.length).toBeGreaterThan(80)
    expect(p!.checksum).toHaveLength(16)
  })

  it('falls back to humanized slug when name is missing', () => {
    const raw = `---
description: no name
---
${long}`
    const p = parseAgentMarkdown(raw, 'engineering/code-reviewer.md')
    expect(p!.name).toBe('Code Reviewer')
  })

  it('infers department=misc when at repo root', () => {
    const p = parseAgentMarkdown(`---\nname: Root Agent\n---\n${long}`, 'root-agent.md')
    expect(p!.department).toBe('misc')
  })

  it('rejects stub files (body < 80 chars)', () => {
    const raw = `---\nname: Stub\n---\nstub.`
    expect(parseAgentMarkdown(raw, 'misc/stub.md')).toBeNull()
  })

  it('rejects non-md filenames', () => {
    expect(parseAgentMarkdown(`---\nname: x\n---\n${long}`, 'misc/notes.txt')).toBeNull()
  })

  it('extracts tags from a ## Skills section', () => {
    const raw = `---
name: Tagged
---
${long}

## Skills
- python
- ml ops
- *system design*
`
    const p = parseAgentMarkdown(raw, 'engineering/tagged.md')
    expect(p!.tags).toEqual(expect.arrayContaining(['python', 'ml ops', 'system design']))
  })

  it('normalizes Windows path separators', () => {
    const p = parseAgentMarkdown(`---\nname: X\n---\n${long}`, 'engineering\\code-reviewer.md')
    expect(p!.sourcePath).toBe('engineering/code-reviewer.md')
    expect(p!.department).toBe('engineering')
  })

  it('checksum is stable for identical content', () => {
    const raw = `---\nname: X\n---\n${long}`
    const a = parseAgentMarkdown(raw, 'misc/x.md')
    const b = parseAgentMarkdown(raw, 'misc/x.md')
    expect(a!.checksum).toBe(b!.checksum)
  })

  it('checksum changes when content changes', () => {
    const a = parseAgentMarkdown(`---\nname: X\n---\n${long}`, 'misc/x.md')
    const b = parseAgentMarkdown(`---\nname: Y\n---\n${long}`, 'misc/x.md')
    expect(a!.checksum).not.toBe(b!.checksum)
  })
})

// ─── pickAgent ─────────────────────────────────────────────────────────

const sampleCatalog = [
  { slug: 'engineering-backend-architect',  department: 'engineering', name: 'Backend Architect',  description: 'APIs and databases', tags: ['api', 'postgres', 'distributed'], vibe: 'Builds scalable services' },
  { slug: 'engineering-code-reviewer',      department: 'engineering', name: 'Code Reviewer',      description: 'Reviews PRs',         tags: ['review', 'quality'],              vibe: 'Catches bugs early' },
  { slug: 'marketing-content-creator',      department: 'marketing',   name: 'Content Creator',    description: 'Writes content',      tags: ['blog', 'social'],                 vibe: 'Storytelling at scale' },
  { slug: 'sales-cold-outreach-specialist', department: 'sales',       name: 'Cold Outreach',      description: 'Cold email + LinkedIn', tags: ['outreach', 'cold email'],       vibe: 'Books meetings' },
  { slug: 'design-product-designer',        department: 'design',      name: 'Product Designer',   description: 'UI/UX',                tags: ['figma', 'design system'],         vibe: 'Crafts interfaces' },
]

describe('agency-catalog: pickAgent', () => {
  it('returns null on empty task', () => {
    expect(pickAgent({ task: '', catalog: sampleCatalog })).toBeNull()
  })

  it('returns null when catalog is empty', () => {
    expect(pickAgent({ task: 'do something', catalog: [] })).toBeNull()
  })

  it('picks engineering for an API task', () => {
    const r = pickAgent({ task: 'Refactor our backend API into smaller services', catalog: sampleCatalog })
    expect(r).not.toBeNull()
    expect(r!.department).toBe('engineering')
  })

  it('picks marketing for a content task', () => {
    const r = pickAgent({ task: 'Write a blog post about our new pricing', catalog: sampleCatalog })
    expect(r).not.toBeNull()
    expect(r!.department).toBe('marketing')
  })

  it('honors operator slug hint', () => {
    const r = pickAgent({
      task: 'something vague that wouldnt otherwise match',
      hint: 'design-product-designer',
      catalog: sampleCatalog,
    })
    expect(r!.slug).toBe('design-product-designer')
    expect(r!.score).toBe(1)
  })

  it('honors operator department hint', () => {
    const r = pickAgent({
      task: 'write something',
      hint: 'sales',
      catalog: sampleCatalog,
    })
    expect(r!.department).toBe('sales')
  })

  it('refuses (returns null) when no signal exceeds threshold', () => {
    const r = pickAgent({ task: 'xyzzy', catalog: sampleCatalog })
    expect(r).toBeNull()
  })

  it('reason field is always present on a result', () => {
    const r = pickAgent({ task: 'review my pull request for bugs', catalog: sampleCatalog })
    expect(r!.reason.length).toBeGreaterThan(0)
  })
})
