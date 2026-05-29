/**
 * image-creative-graph.ts — builds the data the Creative Brain View
 * renders: prompt clusters, remix trees, and a quality heatmap.
 *
 * Three derived structures:
 *   1. Clusters — group generations by stylePreset (with a fallback
 *      "uncategorized" bucket). Each cluster carries an aggregate
 *      composite quality and a sample thumbnail.
 *   2. Remix trees — generations are connected to their source via
 *      sourceImageRef → child. We build a flat node + edge list so the
 *      UI can render the tree without recursion.
 *   3. Quality heatmap — buckets generations by quality decile so the
 *      page can render a calm gradient strip showing the operator's
 *      portfolio health at a glance.
 *
 * Pure aggregator + a DB-backed wrapper. The aggregator is exported so
 * tests can drive it with fixtures.
 */
import { db } from '../db/client.js'
import { imageGenerations } from '../db/schema.js'
import { and, eq, gte, desc } from 'drizzle-orm'

export interface CreativeGraphNode {
  id:             string
  prompt:         string
  thumbUrl:       string | null
  provider:       string
  stylePreset:    string | null
  brandCategory:  string | null
  qualityScore:   number | null
  slopRiskScore:  number | null
  originalityScore: number | null
  batchId:        string | null
  sourceImageRef: string | null
  createdAt:      number
}

export interface CreativeGraphEdge {
  from:    string             // parent generation id (or source ref)
  to:      string             // child generation id
  kind:    'remix' | 'batch'
}

export interface CreativeCluster {
  key:           string                  // style preset or 'uncategorized'
  count:         number
  avgQuality:    number
  avgSlopRisk:   number
  sampleNodeId:  string | null
}

export interface CreativeHeatmap {
  /** 10 bins from quality 0..1; counts per bin. */
  bins:    number[]
  /** Counts of low (≤0.4), medium (0.4-0.7), high (>0.7) quality. */
  buckets: { low: number; medium: number; high: number }
  total:   number
}

export interface CreativeGraph {
  nodes:    CreativeGraphNode[]
  edges:    CreativeGraphEdge[]
  clusters: CreativeCluster[]
  heatmap:  CreativeHeatmap
  /** Highest-quality node in the window — the workspace's "best so far". */
  best:     CreativeGraphNode | null
  windowMs: number
}

type Row = {
  id: string; prompt: string; imageUrl: string | null
  provider: string; stylePreset: string | null
  brandCategory: string | null; batchId: string | null
  sourceImageRef: string | null
  qualityScore: number | null; slopRiskScore: number | null; originalityScore: number | null
  createdAt: number
}

/** Pure: build the graph from a fetched row set. */
export function aggregateCreativeGraph(rows: ReadonlyArray<Row>, windowMs: number): CreativeGraph {
  const nodes: CreativeGraphNode[] = rows.map(r => ({
    id: r.id, prompt: r.prompt.slice(0, 200), thumbUrl: r.imageUrl,
    provider: r.provider, stylePreset: r.stylePreset, brandCategory: r.brandCategory,
    qualityScore: r.qualityScore, slopRiskScore: r.slopRiskScore, originalityScore: r.originalityScore,
    batchId: r.batchId, sourceImageRef: r.sourceImageRef, createdAt: r.createdAt,
  }))

  // Edges: remix lineage + batch grouping
  const edges: CreativeGraphEdge[] = []
  const byId = new Map(rows.map(r => [r.id, r] as const))
  // 1. Remix: each row's sourceImageRef is a parent if it matches an id
  for (const r of rows) {
    if (r.sourceImageRef && byId.has(r.sourceImageRef)) {
      edges.push({ from: r.sourceImageRef, to: r.id, kind: 'remix' })
    }
  }
  // 2. Batch: connect all members of a batch back to the earliest
  const batches = new Map<string, Row[]>()
  for (const r of rows) {
    if (r.batchId) {
      const arr = batches.get(r.batchId) ?? []
      arr.push(r)
      batches.set(r.batchId, arr)
    }
  }
  for (const [, members] of batches) {
    if (members.length < 2) continue
    const sorted = [...members].sort((a, b) => a.createdAt - b.createdAt)
    const root = sorted[0]!
    for (let i = 1; i < sorted.length; i++) {
      edges.push({ from: root.id, to: sorted[i]!.id, kind: 'batch' })
    }
  }

  // Clusters by style preset
  const clusterMap = new Map<string, { count: number; qSum: number; qN: number; sSum: number; sN: number; sample: string | null }>()
  for (const r of rows) {
    const key = r.stylePreset ?? 'uncategorized'
    const e = clusterMap.get(key) ?? { count: 0, qSum: 0, qN: 0, sSum: 0, sN: 0, sample: null }
    e.count++
    if (typeof r.qualityScore  === 'number') { e.qSum += r.qualityScore;  e.qN++ }
    if (typeof r.slopRiskScore === 'number') { e.sSum += r.slopRiskScore; e.sN++ }
    if (!e.sample && r.imageUrl) e.sample = r.id
    clusterMap.set(key, e)
  }
  const clusters: CreativeCluster[] = [...clusterMap.entries()]
    .map(([key, e]) => ({
      key, count: e.count,
      avgQuality:  e.qN === 0 ? 0 : Number((e.qSum / e.qN).toFixed(3)),
      avgSlopRisk: e.sN === 0 ? 0 : Number((e.sSum / e.sN).toFixed(3)),
      sampleNodeId: e.sample,
    }))
    .sort((a, b) => b.count - a.count)

  // Quality heatmap (10 bins)
  const bins = new Array<number>(10).fill(0)
  let low = 0, medium = 0, high = 0
  let bestId: string | null = null
  let bestScore = -1
  for (const r of rows) {
    if (typeof r.qualityScore !== 'number') continue
    const q = Math.max(0, Math.min(0.9999, r.qualityScore))
    const bin = Math.floor(q * 10)
    bins[bin] = (bins[bin] ?? 0) + 1
    if      (q <= 0.4) low++
    else if (q <= 0.7) medium++
    else               high++
    if (r.qualityScore > bestScore) { bestScore = r.qualityScore; bestId = r.id }
  }
  const heatmap: CreativeHeatmap = { bins, buckets: { low, medium, high }, total: low + medium + high }
  const best = bestId ? nodes.find(n => n.id === bestId) ?? null : null

  return { nodes, edges, clusters, heatmap, best, windowMs }
}

export async function buildCreativeGraph(workspaceId: string, opts: { windowMs?: number; limit?: number } = {}): Promise<CreativeGraph> {
  const windowMs = opts.windowMs ?? 30 * 86_400_000
  const limit = opts.limit ?? 200
  const since = Date.now() - windowMs
  const rows = await db.select({
    id: imageGenerations.id, prompt: imageGenerations.prompt, imageUrl: imageGenerations.imageUrl,
    provider: imageGenerations.provider, stylePreset: imageGenerations.stylePreset,
    brandCategory: imageGenerations.brandCategory, batchId: imageGenerations.batchId,
    sourceImageRef: imageGenerations.sourceImageRef,
    qualityScore: imageGenerations.qualityScore, slopRiskScore: imageGenerations.slopRiskScore,
    originalityScore: imageGenerations.originalityScore,
    createdAt: imageGenerations.createdAt,
  }).from(imageGenerations)
    .where(and(
      eq(imageGenerations.workspaceId, workspaceId),
      gte(imageGenerations.createdAt, since),
      eq(imageGenerations.status, 'succeeded'),
    ))
    .orderBy(desc(imageGenerations.createdAt))
    .limit(limit).catch(() => [])
  return aggregateCreativeGraph(rows, windowMs)
}
