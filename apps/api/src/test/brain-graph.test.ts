/**
 * Tests for brain-graph.ts — node detail shape + LOD filtering invariants.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      // Thenable that resolves to []; .then(fn).catch() must chain correctly
      if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled)
      if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain, execute: () => Promise.resolve({ rows: [] }) } }
})

import { buildGraph, getNodeDetail } from '../services/brain-graph.js'

describe('brain-graph: structural invariants', () => {
  it('returns core + 14 system nodes minimum', async () => {
    const g = await buildGraph('__test__', 'neural')
    expect(g.systems.length).toBe(14)
    // core + systems = 15 minimum
    expect(g.nodes.length).toBeGreaterThanOrEqual(15)
    expect(g.nodes.find(n => n.id === 'core')).toBeDefined()
  })

  it('every system has an orbit edge from core', async () => {
    const g = await buildGraph('__test__', 'neural')
    for (const sys of g.systems) {
      const edge = g.edges.find(e => e.from === 'core' && e.to === sys.id)
      expect(edge, `missing orbit edge for ${sys.id}`).toBeDefined()
    }
  })

  it('lod=global returns no subnodes', async () => {
    const g = await buildGraph('__test__', 'neural', { lod: 'global' })
    const subnodes = g.nodes.filter(n => n.kind !== 'core' && n.kind !== 'system')
    expect(subnodes.length).toBe(0)
  })

  it('lod=focus with focusSystem returns core + 1 system + its subnodes', async () => {
    const g = await buildGraph('__test__', 'neural', { lod: 'focus', focusSystem: 'security' })
    const systems = g.nodes.filter(n => n.kind === 'system')
    expect(systems.length).toBe(1)
    expect(systems[0]!.id).toBe('security')
  })

  it('all 8 templates produce 14 systems', async () => {
    for (const tpl of ['neural', 'solar', 'command_core', 'galaxy', 'runtime_mesh', 'agent_swarm', 'security_grid', 'mission_orbit'] as const) {
      const g = await buildGraph('__test__', tpl)
      expect(g.systems.length, `template ${tpl} should have 14 systems`).toBe(14)
    }
  })
})

describe('brain-graph: getNodeDetail', () => {
  it('returns core detail with no actions', async () => {
    const d = await getNodeDetail('__test__', 'core')
    expect(d).not.toBeNull()
    expect(d?.kind).toBe('core')
    expect(d?.actions.length).toBe(0)
  })

  it('returns system detail for known system id', async () => {
    const d = await getNodeDetail('__test__', 'runtime')
    expect(d).not.toBeNull()
    expect(d?.kind).toBe('system')
    expect(d?.label).toBe('Runtime')
  })

  it('returns null for unknown node id', async () => {
    const d = await getNodeDetail('__test__', 'nonexistent:xyz')
    expect(d).toBeNull()
  })
})
