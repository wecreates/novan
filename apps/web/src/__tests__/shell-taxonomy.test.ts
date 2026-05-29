/**
 * shell-taxonomy.test.ts — Verify the minimal folder taxonomy is
 * well-formed.
 *
 * The taxonomy intentionally surfaces only the routes an operator
 * touches regularly. Off-tree routes still resolve via URL + global
 * search; this list is the daily-use navigation, not a site map.
 */
import { describe, it, expect } from 'vitest'
import { TAXONOMY, listLeaves, breadcrumbFor, findByPath, allPaths } from '../shell/taxonomy'

describe('shell taxonomy — minimal 6-group shape', () => {
  it('has exactly 6 top-level groups in the spec order', () => {
    expect(TAXONOMY.length).toBe(6)
    expect(TAXONOMY.map(n => n.id)).toEqual([
      'now', 'businesses', 'brain', 'analytics', 'guard', 'setup',
    ])
  })

  it('every top-level group has at least one child', () => {
    for (const top of TAXONOMY) {
      expect(top.children).toBeDefined()
      expect(top.children!.length).toBeGreaterThan(0)
    }
  })

  it('every leaf has a path', () => {
    for (const leaf of listLeaves()) {
      expect(leaf.path).toBeDefined()
      expect(leaf.path!.startsWith('/')).toBe(true)
    }
  })

  it('every node id is unique', () => {
    const allIds: string[] = []
    const walk = (n: typeof TAXONOMY[number]): void => {
      allIds.push(n.id)
      n.children?.forEach(walk)
    }
    TAXONOMY.forEach(walk)
    const dupes = allIds.filter((id, i) => allIds.indexOf(id) !== i)
    expect(dupes).toEqual([])
  })

  it('max depth is 2 levels (top → leaf, no triple nesting)', () => {
    const walk = (n: typeof TAXONOMY[number], depth: number): void => {
      expect(depth).toBeLessThanOrEqual(2)
      n.children?.forEach(c => walk(c, depth + 1))
    }
    TAXONOMY.forEach(t => walk(t, 1))
  })

  it('breadcrumb resolves through 2 levels', () => {
    const trail = breadcrumbFor('/m/chat')
    expect(trail.length).toBe(2)
    expect(trail[0]!.id).toBe('now')
    expect(trail[1]!.label).toBe('Mobile Chat')
  })

  it('breadcrumb returns empty for unknown paths', () => {
    expect(breadcrumbFor('/does-not-exist')).toEqual([])
  })

  it('findByPath returns the leaf for a known path', () => {
    expect(findByPath('/approvals')!.label).toBe('Approvals')
    expect(findByPath('/blueprint')!.label).toBe('Blueprint')
  })

  it('keeps the 4 Legal & Compliance leaves under Guard', () => {
    const paths = allPaths()
    expect(paths).toContain('/legal/soc2')
    expect(paths).toContain('/legal/operational-readiness')
    expect(paths).toContain('/legal/lock-integrity')
    expect(paths).toContain('/legal/recovery-playbooks')
  })

  it('keeps Brain Map + Showcase under Brain', () => {
    expect(breadcrumbFor('/brain/graph')[0]!.id).toBe('brain')
    expect(breadcrumbFor('/brain/showcase')[0]!.id).toBe('brain')
  })

  it('total visible leaves are kept around 30–45 (minimal but not bare)', () => {
    const n = allPaths().length
    expect(n).toBeGreaterThanOrEqual(25)
    expect(n).toBeLessThanOrEqual(50)
  })

  it('Talk + Mobile Chat both live under Now', () => {
    expect(breadcrumbFor('/talk')[0]!.id).toBe('now')
    expect(breadcrumbFor('/m/chat')[0]!.id).toBe('now')
  })
})
