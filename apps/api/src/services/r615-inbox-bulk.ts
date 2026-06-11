/**
 * R615 — Bulk inbox operations + result browsers.
 *
 * R612 ships the inbox primitive (one brief per call). For real content
 * production at scale, the operator wants to say "queue 20 image briefs
 * for X niche" once and walk away. R615 layers convenience on top:
 *
 *   - bulkAdd:    drop N briefs in a single call with shared params
 *   - bulkImage:  expand one niche prompt into N variant briefs (style,
 *                 color, composition modifiers) and queue them
 *   - recentDone: last N completed briefs with result preview, for the
 *                 operator to actually SEE what Novan made
 *   - clearOld:   delete done/failed briefs older than N days
 *
 * Quota: workspace soft-cap of 200 pending briefs at once. Bulk ops
 * that would exceed the cap fail fast with a clear count, instead of
 * queuing 200 then silently dropping the rest. Operator can raise via
 * INBOX_MAX_PENDING env or per-call quotaOverride.
 *
 * Variant modifiers for image briefs are curated style/color/composition
 * mod-trees designed for POD-style art generation. Operator can pass
 * variantPrompts to override.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { add, type InboxItem, VALID_KINDS_LIST } from './r612-task-inbox.js'

const DEFAULT_MAX_PENDING = 200

function envCap(): number {
  const n = Number(process.env['INBOX_MAX_PENDING'] ?? '')
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PENDING
}

async function currentPending(workspaceId: string): Promise<number> {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = 'pending'`).catch(() => [{ n: 0 }] as unknown[])
  return Number((r as Array<{ n: number }>)[0]?.n ?? 0)
}

// ─── Bulk add (generic) ──────────────────────────────────────────────────────

export interface BulkBrief {
  brief:        string
  params?:      Record<string, unknown>
  priority?:    number
  dueAt?:       number
}

export interface BulkAddInput {
  kind:         string
  briefs:       BulkBrief[]
  commonParams?:Record<string, unknown>
  commonPriority?:number
  businessId?:  string
  createdBy?:   string
  quotaOverride?:number      // raises the soft cap for THIS call only
}

export interface BulkAddResult {
  requested:    number
  queued:       number
  ids:          string[]
  rejectedReason?:string
  pendingAfter: number
  cap:          number
}

export async function bulkAdd(workspaceId: string, input: BulkAddInput): Promise<BulkAddResult> {
  if (!VALID_KINDS_LIST.includes(input.kind)) throw new Error(`unknown kind: ${input.kind}`)
  if (!Array.isArray(input.briefs) || input.briefs.length === 0) throw new Error('briefs[] required, non-empty')
  if (input.briefs.length > 500) throw new Error('briefs[] capped at 500 per call')

  const cap = input.quotaOverride ?? envCap()
  const pendingNow = await currentPending(workspaceId)
  const slots = Math.max(0, cap - pendingNow)
  const requested = input.briefs.length

  if (slots === 0) {
    return { requested, queued: 0, ids: [], rejectedReason: `inbox at cap (${pendingNow}/${cap}); cancel some pending or raise INBOX_MAX_PENDING`, pendingAfter: pendingNow, cap }
  }

  const toQueue = input.briefs.slice(0, slots)
  const ids: string[] = []
  for (const b of toQueue) {
    const opts: Parameters<typeof add>[1] = {
      kind: input.kind,
      brief: b.brief,
      params: { ...(input.commonParams ?? {}), ...(b.params ?? {}) },
      priority: b.priority ?? input.commonPriority ?? 50,
    }
    if (input.businessId) opts.businessId = input.businessId
    if (input.createdBy)  opts.createdBy = input.createdBy
    if (b.dueAt) opts.dueAt = b.dueAt
    try {
      const r = await add(workspaceId, opts)
      ids.push(r.id)
    } catch { /* per-brief failures tolerated; ids contains successes only */ }
  }
  const pendingAfter = await currentPending(workspaceId)
  const result: BulkAddResult = { requested, queued: ids.length, ids, pendingAfter, cap }
  if (requested > slots) {
    result.rejectedReason = `${requested - slots} of ${requested} rejected: would exceed cap ${cap} (now at ${pendingAfter})`
  }
  return result
}

// ─── Bulk image brief variants ──────────────────────────────────────────────

/** Curated variant modifiers for POD-style image gen. Combined product is
 *  about 50 distinct prompts — small enough that brief duplicates are rare
 *  even at count=50. Operator can override with variantPrompts. */
const STYLE_MODS = [
  'minimalist vector illustration, flat colors',
  'photorealistic studio shot, soft natural lighting',
  'vintage 1960s travel poster, screen-print look',
  'hand-drawn ink illustration with watercolor wash',
  'cyberpunk neon, holographic accents',
  'pastel anime aesthetic, soft gradients',
  'mid-century modern geometric composition',
  'art-deco gold and black, symmetrical layout',
  'isometric 3D render, low-poly aesthetic',
  'pencil sketch, cross-hatched shading',
]
const COLOR_MODS = [
  'muted earth tones, sand and terracotta',
  'high-contrast monochrome, charcoal and ivory',
  'sunset palette, coral and amber',
  'forest palette, sage and moss',
  'ocean palette, navy and seafoam',
  'pastel rainbow, soft saturation',
  'bold primary colors',
  'jewel tones, sapphire and emerald',
]
const COMPOSITION_MODS = [
  'centered hero subject, clean negative space',
  'rule-of-thirds, off-center subject',
  'full-bleed pattern, edge to edge',
  'top-down flat lay',
  'low-angle dramatic perspective',
]

function variantPrompts(niche: string, count: number, custom?: string[]): string[] {
  if (custom && custom.length > 0) {
    const out: string[] = []
    for (let i = 0; i < count; i++) out.push(`${niche.trim()}, ${custom[i % custom.length]}`)
    return out
  }
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const style = STYLE_MODS[i % STYLE_MODS.length]
    const color = COLOR_MODS[Math.floor(i / STYLE_MODS.length) % COLOR_MODS.length]
    const comp  = COMPOSITION_MODS[Math.floor(i / (STYLE_MODS.length * COLOR_MODS.length)) % COMPOSITION_MODS.length]
    out.push(`${niche.trim()}, ${style}, ${color}, ${comp}`)
  }
  return out
}

export interface BulkImageInput {
  niche:           string
  count:           number
  variantPrompts?: string[]
  width?:          number
  height?:         number
  model?:          'flux_schnell' | 'flux_dev' | 'sdxl' | 'sd3_medium'
  priority?:       number
  businessId?:     string
  createdBy?:      string
  seedBase?:       number      // each brief gets seedBase+i
  quotaOverride?:  number
}

export async function bulkImage(workspaceId: string, input: BulkImageInput): Promise<BulkAddResult & { previewPrompts: string[] }> {
  if (!input.niche?.trim()) throw new Error('niche required')
  const count = Math.max(1, Math.min(100, Math.floor(input.count)))
  const prompts = variantPrompts(input.niche, count, input.variantPrompts)
  const seedBase = typeof input.seedBase === 'number' ? input.seedBase : Math.floor(Date.now() % 1_000_000)
  const briefs: BulkBrief[] = prompts.map((p, i) => ({
    brief: p,
    params: {
      width:  input.width  ?? 1024,
      height: input.height ?? 1024,
      ...(input.model ? { model: input.model } : { model: 'flux_schnell' }),
      seed: seedBase + i,
    },
  }))
  const bulkAddInput: BulkAddInput = {
    kind: 'image', briefs,
    commonPriority: input.priority ?? 50,
  }
  if (input.businessId) bulkAddInput.businessId = input.businessId
  if (input.createdBy)  bulkAddInput.createdBy  = input.createdBy
  else                  bulkAddInput.createdBy  = 'r615-bulk-image'
  if (typeof input.quotaOverride === 'number') bulkAddInput.quotaOverride = input.quotaOverride
  const r = await bulkAdd(workspaceId, bulkAddInput)
  return { ...r, previewPrompts: prompts.slice(0, 3) }
}

// ─── Recent done items with result preview ──────────────────────────────────

export async function recentDone(workspaceId: string, opts: { kind?: string; limit?: number } = {}): Promise<Array<Pick<InboxItem, 'id' | 'kind' | 'brief' | 'completedAt' | 'createdBy'> & { resultPreview: string; resultBytes: number }>> {
  const lim = Math.min(opts.limit ?? 20, 100)
  const r = opts.kind
    ? await db.execute(sql`SELECT id, kind, brief, result::text AS result_text, completed_at, created_by FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = 'done' AND kind = ${opts.kind} ORDER BY completed_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
    : await db.execute(sql`SELECT id, kind, brief, result::text AS result_text, completed_at, created_by FROM novan_inbox WHERE workspace_id = ${workspaceId} AND status = 'done' ORDER BY completed_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<{ id: string; kind: string; brief: string; result_text: string; completed_at: number; created_by: string | null }>).map(x => ({
    id: x.id, kind: x.kind, brief: x.brief.slice(0, 200),
    completedAt: Number(x.completed_at),
    createdBy: x.created_by,
    resultPreview: (x.result_text ?? '').slice(0, 300),
    resultBytes: (x.result_text ?? '').length,
  }))
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

export async function clearOld(workspaceId: string, olderThanDays = 14): Promise<{ deleted: number }> {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60_000
  const r = await db.execute(sql`
    DELETE FROM novan_inbox
    WHERE workspace_id = ${workspaceId}
          AND status IN ('done', 'failed', 'cancelled')
          AND COALESCE(completed_at, created_at) <= ${cutoff}
    RETURNING id
  `).catch(() => [] as unknown[])
  return { deleted: (r as Array<{ id: string }>).length }
}
