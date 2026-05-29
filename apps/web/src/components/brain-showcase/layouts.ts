/**
 * layouts.ts — Pure positioning functions for each Showcase view mode.
 *
 * Kept as pure functions so they can be unit-tested without R3F /
 * jsdom. The Scene component just calls these and renders.
 *
 * Four modes per the UI spec:
 *   - galaxy    : workspace clusters orbit a brain core (default)
 *   - hierarchy : tree-style top-down — groups stacked vertically,
 *                 nodes hang below their group root
 *   - activity  : same XY layout as galaxy but node Z + glow scaled by
 *                 activity intensity, brain core dims
 *   - focus     : one group large + centered; others tiny + faded
 *                 around the periphery
 */

export type ViewMode = 'galaxy' | 'hierarchy' | 'activity' | 'focus'

export interface LayoutInput {
  id:        string
  group:     string
  activity?: number
}

export interface LayoutOutput {
  pos:       [number, number, number]
  /** Opacity multiplier for emphasis/de-emphasis between modes. */
  emphasis:  number
}

/** Deterministic hash → integer in [0, mod). */
function hashMod(s: string, mod: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % Math.max(1, mod)
}

/** Group nodes by their `group` field, preserve first-seen order. */
function bucketByGroup<T extends LayoutInput>(nodes: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const n of nodes) {
    const g = n.group || 'default'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(n)
  }
  return groups
}

export function layoutGalaxy(nodes: LayoutInput[]): Map<string, LayoutOutput> {
  const out = new Map<string, LayoutOutput>()
  const groups = bucketByGroup(nodes)
  const groupList = Array.from(groups.entries())
  const groupCount = Math.max(1, groupList.length)
  const groupRadius = 12

  groupList.forEach(([_g, list], gi) => {
    const groupAngle = (gi / groupCount) * Math.PI * 2
    const groupX = Math.cos(groupAngle) * groupRadius
    const groupZ = Math.sin(groupAngle) * groupRadius
    const groupY = (gi % 2 === 0 ? 1 : -1) * 0.8
    list.forEach((n, ii) => {
      const orbitAngle  = (hashMod(n.id, 360)) * (Math.PI / 180)
      const orbitR      = 1.6 + (ii % 6) * 0.5
      const orbitHeight = (hashMod(n.id + 'h', 100) / 100 - 0.5) * 1.5
      out.set(n.id, {
        pos: [
          groupX + Math.cos(orbitAngle) * orbitR,
          groupY + orbitHeight,
          groupZ + Math.sin(orbitAngle) * orbitR,
        ],
        emphasis: 1,
      })
    })
  })
  return out
}

export function layoutHierarchy(nodes: LayoutInput[]): Map<string, LayoutOutput> {
  const out = new Map<string, LayoutOutput>()
  const groups = bucketByGroup(nodes)
  const groupList = Array.from(groups.entries())
  // Lay groups out as columns on the X axis, nodes stacking down Y
  // under each group root. Z stays close to 0 so the whole thing reads
  // like a top-down org chart from the default camera angle.
  const colSpacing = 5
  const totalWidth = (groupList.length - 1) * colSpacing
  groupList.forEach(([_g, list], gi) => {
    const x = -totalWidth / 2 + gi * colSpacing
    const groupY = 6
    // Place group root at the top
    list.forEach((n, ii) => {
      const y = ii === 0 ? groupY : groupY - 1.4 - (ii - 1) * 1.1
      // Slight horizontal spread on children to avoid perfect column
      const childX = ii === 0 ? x : x + ((ii % 3) - 1) * 0.9
      out.set(n.id, {
        pos: [childX, y, 0],
        emphasis: 1,
      })
    })
  })
  return out
}

export function layoutActivity(nodes: LayoutInput[]): Map<string, LayoutOutput> {
  // Reuse galaxy XY but push high-activity nodes forward on Z so the
  // hottest action visibly stands out from the cooler background.
  const base = layoutGalaxy(nodes)
  const out = new Map<string, LayoutOutput>()
  for (const n of nodes) {
    const b = base.get(n.id)
    if (!b) continue
    const a = Math.max(0, Math.min(1, n.activity ?? 0))
    const zBoost = a * 6   // up to +6 units forward for fully-active nodes
    // Emphasis = 0.35 baseline + 0.65 * activity so cold nodes recede.
    const emphasis = 0.35 + 0.65 * a
    out.set(n.id, {
      pos: [b.pos[0], b.pos[1], b.pos[2] + zBoost],
      emphasis,
    })
  }
  return out
}

export function layoutFocus(nodes: LayoutInput[], focusGroup: string): Map<string, LayoutOutput> {
  // The focused group sits centered + scaled up; other groups orbit
  // far out + dimmed. Caller picks which group via URL state.
  const out = new Map<string, LayoutOutput>()
  const groups = bucketByGroup(nodes)
  const others = Array.from(groups.keys()).filter(g => g !== focusGroup)

  // Focused group: cluster around origin with wider spread
  const focusList = groups.get(focusGroup) ?? []
  focusList.forEach((n, ii) => {
    const angle = (hashMod(n.id, 360)) * (Math.PI / 180)
    const r     = 2 + (ii % 8) * 0.7
    const y     = (hashMod(n.id + 'y', 100) / 100 - 0.5) * 3
    out.set(n.id, {
      pos: [Math.cos(angle) * r, y, Math.sin(angle) * r],
      emphasis: 1,
    })
  })

  // Other groups: pushed to a far ring, dimmed.
  const ringRadius = 20
  others.forEach((g, gi) => {
    const groupAngle = (gi / Math.max(1, others.length)) * Math.PI * 2
    const cx = Math.cos(groupAngle) * ringRadius
    const cz = Math.sin(groupAngle) * ringRadius
    const list = groups.get(g) ?? []
    list.forEach((n, ii) => {
      const localAngle = (hashMod(n.id, 360)) * (Math.PI / 180)
      const lr = 0.8 + (ii % 4) * 0.3
      out.set(n.id, {
        pos: [cx + Math.cos(localAngle) * lr, (ii % 2 === 0 ? 0.5 : -0.5), cz + Math.sin(localAngle) * lr],
        emphasis: 0.18,    // heavily dimmed periphery
      })
    })
  })
  return out
}

export function layoutFor(mode: ViewMode, nodes: LayoutInput[], focusGroup?: string): Map<string, LayoutOutput> {
  if (mode === 'galaxy')    return layoutGalaxy(nodes)
  if (mode === 'hierarchy') return layoutHierarchy(nodes)
  if (mode === 'activity')  return layoutActivity(nodes)
  if (mode === 'focus' && focusGroup) return layoutFocus(nodes, focusGroup)
  return layoutGalaxy(nodes)
}

/** Encode a showcase state into URL params (round-trip safe). */
export interface ShowcaseState {
  view:    ViewMode
  focus?:  string
  anon:    boolean
  cinema:  boolean
}

export function encodeState(s: ShowcaseState): string {
  const u = new URLSearchParams()
  u.set('view', s.view)
  if (s.focus) u.set('focus', s.focus)
  u.set('anon', s.anon ? '1' : '0')
  u.set('cinema', s.cinema ? '1' : '0')
  return u.toString()
}

export function decodeState(q: string): ShowcaseState {
  const p = new URLSearchParams(q)
  const v = p.get('view')
  const view: ViewMode =
    v === 'galaxy' || v === 'hierarchy' || v === 'activity' || v === 'focus' ? v : 'galaxy'
  const focus = p.get('focus') ?? undefined
  const anon  = p.get('anon')   === '0' ? false : true
  const cinema = p.get('cinema') === '0' ? false : true
  return { view, ...(focus ? { focus } : {}), anon, cinema }
}

/** Merge duplicate edges into single weighted edges + cap render count.
 *  Renders thousands of duplicate from→to lines were the main perf hit
 *  in the initial showcase. */
export interface EdgeRaw { from: string; to: string; weight?: number }
export interface EdgeMerged { from: string; to: string; weight: number }

export function dedupeEdges(edges: EdgeRaw[], cap: number = 250): EdgeMerged[] {
  if (edges.length === 0) return []
  const map = new Map<string, EdgeMerged>()
  for (const e of edges) {
    if (!e.from || !e.to || e.from === e.to) continue
    // Canonical key — keeps direction (a→b ≠ b→a) since data flow has direction.
    const k = `${e.from}${e.to}`
    const cur = map.get(k)
    const w = Math.max(0, e.weight ?? 0.2)
    if (cur) cur.weight += w
    else     map.set(k, { from: e.from, to: e.to, weight: w })
  }
  // Sort by weight desc + cap. Highest-traffic edges always render;
  // long tail drops cleanly when there's too much to show.
  const all = Array.from(map.values()).sort((a, b) => b.weight - a.weight)
  return all.slice(0, cap)
}
