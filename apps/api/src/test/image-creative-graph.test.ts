/**
 * Tests for the Creative Brain View data layer.
 *   - aggregateCreativeGraph builds node/edge/cluster/heatmap structures
 *   - remix lineage via sourceImageRef
 *   - batch lineage via batchId
 *   - quality heatmap bin math
 *   - best-of-window selection
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

import { aggregateCreativeGraph } from '../services/image-creative-graph.js'

type Row = Parameters<typeof aggregateCreativeGraph>[0][number]

function row(over: Partial<Row>): Row {
  return {
    id: 'g1', prompt: 'p', imageUrl: 'http://i/img.png',
    provider: 'openai', stylePreset: 'editorial',
    brandCategory: null, batchId: null, sourceImageRef: null,
    qualityScore: 0.6, slopRiskScore: 0.2, originalityScore: 0.7,
    createdAt: 1000,
    ...over,
  }
}

describe('aggregateCreativeGraph: structural invariants', () => {
  it('produces nodes 1:1 with input rows', () => {
    const g = aggregateCreativeGraph([row({ id: 'a' }), row({ id: 'b' })], 86_400_000)
    expect(g.nodes.length).toBe(2)
    expect(g.nodes.map(n => n.id).sort()).toEqual(['a', 'b'])
  })

  it('groups by stylePreset and uncategorized', () => {
    const g = aggregateCreativeGraph([
      row({ id: 'a', stylePreset: 'editorial' }),
      row({ id: 'b', stylePreset: 'editorial' }),
      row({ id: 'c', stylePreset: 'minimal' }),
      row({ id: 'd', stylePreset: null }),
    ], 86_400_000)
    const keys = g.clusters.map(c => c.key)
    expect(keys).toContain('editorial')
    expect(keys).toContain('minimal')
    expect(keys).toContain('uncategorized')
    expect(g.clusters.find(c => c.key === 'editorial')?.count).toBe(2)
  })

  it('handles empty input safely', () => {
    const g = aggregateCreativeGraph([], 86_400_000)
    expect(g.nodes).toEqual([])
    expect(g.edges).toEqual([])
    expect(g.clusters).toEqual([])
    expect(g.heatmap.total).toBe(0)
    expect(g.best).toBeNull()
  })
})

describe('aggregateCreativeGraph: remix lineage', () => {
  it('connects rows whose sourceImageRef is another row id', () => {
    const g = aggregateCreativeGraph([
      row({ id: 'root', sourceImageRef: null }),
      row({ id: 'child1', sourceImageRef: 'root' }),
      row({ id: 'child2', sourceImageRef: 'root' }),
    ], 86_400_000)
    const remixEdges = g.edges.filter(e => e.kind === 'remix')
    expect(remixEdges.length).toBe(2)
    expect(remixEdges.every(e => e.from === 'root')).toBe(true)
  })

  it('ignores sourceImageRef when the source is not in the window', () => {
    const g = aggregateCreativeGraph([
      row({ id: 'child', sourceImageRef: 'external-url' }),
    ], 86_400_000)
    expect(g.edges.filter(e => e.kind === 'remix').length).toBe(0)
  })
})

describe('aggregateCreativeGraph: batch lineage', () => {
  it('connects all batch members back to the earliest as root', () => {
    const g = aggregateCreativeGraph([
      row({ id: 'b1', batchId: 'batch-1', createdAt: 1000 }),
      row({ id: 'b2', batchId: 'batch-1', createdAt: 2000 }),
      row({ id: 'b3', batchId: 'batch-1', createdAt: 3000 }),
    ], 86_400_000)
    const batchEdges = g.edges.filter(e => e.kind === 'batch')
    expect(batchEdges.length).toBe(2)
    expect(batchEdges.every(e => e.from === 'b1')).toBe(true)
  })

  it('single-member batches produce no batch edges', () => {
    const g = aggregateCreativeGraph([row({ id: 'b1', batchId: 'solo' })], 86_400_000)
    expect(g.edges.filter(e => e.kind === 'batch').length).toBe(0)
  })
})

describe('aggregateCreativeGraph: quality heatmap', () => {
  it('bins quality scores into 10 buckets', () => {
    const rows: Row[] = [
      row({ id: '1', qualityScore: 0.05 }),  // bin 0
      row({ id: '2', qualityScore: 0.15 }),  // bin 1
      row({ id: '3', qualityScore: 0.75 }),  // bin 7
      row({ id: '4', qualityScore: 0.95 }),  // bin 9
    ]
    const g = aggregateCreativeGraph(rows, 86_400_000)
    expect(g.heatmap.bins[0]).toBe(1)
    expect(g.heatmap.bins[1]).toBe(1)
    expect(g.heatmap.bins[7]).toBe(1)
    expect(g.heatmap.bins[9]).toBe(1)
    expect(g.heatmap.total).toBe(4)
  })

  it('categorizes low / medium / high buckets', () => {
    const g = aggregateCreativeGraph([
      row({ id: '1', qualityScore: 0.2 }),   // low
      row({ id: '2', qualityScore: 0.5 }),   // medium
      row({ id: '3', qualityScore: 0.85 }),  // high
      row({ id: '4', qualityScore: 0.9 }),   // high
    ], 86_400_000)
    expect(g.heatmap.buckets.low).toBe(1)
    expect(g.heatmap.buckets.medium).toBe(1)
    expect(g.heatmap.buckets.high).toBe(2)
  })

  it('skips rows without a quality score', () => {
    const g = aggregateCreativeGraph([
      row({ id: '1', qualityScore: null }),
      row({ id: '2', qualityScore: 0.6 }),
    ], 86_400_000)
    expect(g.heatmap.total).toBe(1)
  })
})

describe('aggregateCreativeGraph: best-of-window', () => {
  it('picks the highest-quality row as the best', () => {
    const g = aggregateCreativeGraph([
      row({ id: 'a', qualityScore: 0.5 }),
      row({ id: 'b', qualityScore: 0.9 }),
      row({ id: 'c', qualityScore: 0.7 }),
    ], 86_400_000)
    expect(g.best?.id).toBe('b')
  })
})

describe('aggregateCreativeGraph: cluster averages', () => {
  it('computes avgQuality + avgSlopRisk per cluster', () => {
    const g = aggregateCreativeGraph([
      row({ id: '1', stylePreset: 'editorial', qualityScore: 0.8, slopRiskScore: 0.1 }),
      row({ id: '2', stylePreset: 'editorial', qualityScore: 0.6, slopRiskScore: 0.3 }),
    ], 86_400_000)
    const editorial = g.clusters.find(c => c.key === 'editorial')!
    expect(editorial.avgQuality).toBeCloseTo(0.7, 2)
    expect(editorial.avgSlopRisk).toBeCloseTo(0.2, 2)
  })

  it('attaches a sampleNodeId for clusters that have at least one thumb', () => {
    const g = aggregateCreativeGraph([
      row({ id: '1', stylePreset: 'minimal', imageUrl: 'http://i/x.png' }),
      row({ id: '2', stylePreset: 'minimal', imageUrl: null }),
    ], 86_400_000)
    expect(g.clusters.find(c => c.key === 'minimal')?.sampleNodeId).toBe('1')
  })
})
