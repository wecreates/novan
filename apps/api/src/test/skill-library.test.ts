/**
 * Tests for skill-library.ts.
 *
 * Covers:
 *   A) parseSkillFile — YAML frontmatter, quoted values, missing fm fallback
 *   B) recordSkillUsage bumps useCount via SQL increment
 *   C) listSkills sort/filter forwards to db chain
 *
 * Ingestion against a real directory is tested via the standalone CLI;
 * here we keep tests pure (no fs).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let selectRows: unknown[] = []
let lastReturning: unknown[] = []
const updateCalls: Array<{ set: unknown }> = []

vi.mock('../db/client.js', () => {
  function makeChain(rows: unknown[]): unknown {
    const p: Promise<unknown[]> & Record<string, unknown> = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>
    return new Proxy(p, {
      get(target, prop, receiver) {
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return Reflect.get(target, prop, receiver).bind(target)
        }
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
        return () => makeChain(rows)
      },
    })
  }
  const db = {
    select: () => makeChain(selectRows),
    insert: () => {
      const chain = {
        values: () => chain,
        returning: () => makeChain(lastReturning),
        onConflictDoNothing: () => chain,
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      }
      return chain
    },
    update: () => {
      const chain = {
        set: (v: unknown) => { updateCalls.push({ set: v }); return chain },
        where: () => chain,
        returning: () => makeChain(lastReturning),
      }
      return chain
    },
  }
  return { db }
})
vi.mock('../db/schema.js', () => ({ skillLibrary: {}, events: {} }))

import {
  parseSkillFile, recordSkillUsage, listSkills,
} from '../services/skill-library.js'

beforeEach(() => {
  selectRows = []
  lastReturning = []
  updateCalls.length = 0
})

// ── A. parseSkillFile ─────────────────────────────────────────────────

describe('parseSkillFile', () => {
  it('parses basic YAML frontmatter', () => {
    const raw = `---
name: refactor
description: Surgical refactoring
license: MIT
---

# Refactor

body text
`
    const p = parseSkillFile(raw, 'refactor')
    expect(p.name).toBe('refactor')
    expect(p.description).toBe('Surgical refactoring')
    expect(p.license).toBe('MIT')
    expect(p.body).toContain('# Refactor')
  })

  it('strips single-quoted values containing colons', () => {
    const raw = `---
name: code-review
description: 'Review code: PRs, diffs, and changes.'
---

content
`
    const p = parseSkillFile(raw, 'code-review')
    expect(p.description).toBe('Review code: PRs, diffs, and changes.')
  })

  it('strips double-quoted values', () => {
    const raw = `---
name: "double-quoted"
description: "with colons: inside"
---

x
`
    const p = parseSkillFile(raw, 'd')
    expect(p.name).toBe('double-quoted')
    expect(p.description).toBe('with colons: inside')
  })

  it('falls back to first H1 + first para when no frontmatter', () => {
    const raw = `# Some Skill

The first paragraph explains the thing.

More content.
`
    const p = parseSkillFile(raw, 'fallback')
    expect(p.name).toBe('Some Skill')
    expect(p.description).toContain('first paragraph')
    expect(p.license).toBeNull()
  })

  it('uses slug as fallback name when nothing matches', () => {
    const raw = 'just some prose with no header'
    const p = parseSkillFile(raw, 'my-skill')
    expect(p.name).toBe('my-skill')
  })
})

// ── B. recordSkillUsage ──────────────────────────────────────────────

describe('recordSkillUsage', () => {
  it('returns null when skill not found', async () => {
    lastReturning = []
    const r = await recordSkillUsage('missing')
    expect(r).toBeNull()
  })

  it('returns updated row when found', async () => {
    lastReturning = [{ id: 'refactor', useCount: 3, lastUsedAt: 999 }]
    const r = await recordSkillUsage('refactor')
    expect(r?.useCount).toBe(3)
    // set() was called with sql increment + timestamps
    expect(updateCalls.length).toBe(1)
    const setArg = updateCalls[0]!.set as Record<string, unknown>
    expect(setArg['lastUsedAt']).toBeDefined()
    expect(setArg['updatedAt']).toBeDefined()
  })
})

// ── C. listSkills ────────────────────────────────────────────────────

describe('listSkills', () => {
  it('returns empty array when db has nothing', async () => {
    selectRows = []
    const r = await listSkills()
    expect(r).toEqual([])
  })

  it('returns rows from the mock', async () => {
    selectRows = [
      { id: 'a', name: 'A', description: 'A desc', license: 'MIT', category: 'ai',  tags: ['x'], useCount: 5, lastUsedAt: 1, sourceRepo: 'r' },
      { id: 'b', name: 'B', description: 'B desc', license: null,  category: 'sql', tags: [],    useCount: 0, lastUsedAt: null, sourceRepo: 'r' },
    ]
    const r = await listSkills({ q: 'a', sort: 'used' })
    expect(r.length).toBe(2)
    expect(r[0]!.id).toBe('a')
  })
})
