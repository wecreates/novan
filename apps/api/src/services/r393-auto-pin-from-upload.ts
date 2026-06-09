/**
 * R393 — Auto-Pinterest-pin from successful upload.
 *
 * When a Gumroad listing goes live (R349 markUploaded), automatically
 * generate 3 Pinterest pin variants pointing to it. Each variant uses a
 * different angle (problem-solution, aesthetic, gift) so they index for
 * distinct search terms.
 *
 * Idempotent on (workspace, link_url) — re-running on the same listing does
 * not dupe pins.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const TEMPLATES: Array<{ angle: string; titleSuffix: string; descTpl: (title: string) => string }> = [
  {
    angle: 'problem-solution',
    titleSuffix: '| Affordable Wall Art Download',
    descTpl: t => `Searching for affordable, archival-quality wall art? "${t}" downloads instantly — print at home or local shop for under $5. Personal-use license, ready in minutes. $9 download.`,
  },
  {
    angle: 'aesthetic',
    titleSuffix: '| Cottagecore Botanical Print',
    descTpl: t => `Hand-finished vintage botanical aesthetic. "${t}" pairs with antique frames, gallery walls, and quiet reading nooks. Print at any size from 8×10 to 24×36.`,
  },
  {
    angle: 'gift',
    titleSuffix: '| Thoughtful Botanical Gift Idea',
    descTpl: t => `Looking for a thoughtful gift? "${t}" — instant digital download, print and frame in under an hour. Personal-use license, $9.`,
  },
]

const TAG_POOL = [
  'cottagecore', 'vintagebotanical', 'botanicalprint', 'printableart',
  'digitaldownload', 'wallartdownload', 'cottagecorebedroom', 'gallerywall',
  'affordableart', 'archivalprint',
]

function pickTags(seed: string, n: number): string[] {
  // deterministic shuffle by char-code sum
  const seedNum = [...seed].reduce((a, c) => a + c.charCodeAt(0), 0)
  const shuffled = [...TAG_POOL].sort((a, b) => ((seedNum + a.length) % 7) - ((seedNum + b.length) % 7))
  return shuffled.slice(0, n)
}

export interface AutoPinInput {
  workspaceId:  string
  designId:     string
  title:        string                        // listing title (used as pin subject)
  externalUrl:  string                        // gumroad permalink
  boardName?:   string
}

export interface AutoPinResult {
  ok:        boolean
  enqueued:  number
  skipped:   number
}

export async function autoPinFromListing(input: AutoPinInput): Promise<AutoPinResult> {
  // Idempotency: count existing pins for this link
  let existing = 0
  try {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM pinterest_pin_queue
      WHERE workspace_id = ${input.workspaceId} AND link_url = ${input.externalUrl}
    `)
    existing = Number((r as Array<{ n: number }>)[0]?.n ?? 0)
  } catch { /* table may not exist yet */ }

  if (existing >= TEMPLATES.length) {
    return { ok: true, enqueued: 0, skipped: TEMPLATES.length }
  }

  // Look up design file from design_catalog
  let designFile: string | undefined
  try {
    const r = await db.execute(sql`
      SELECT image_path FROM design_catalog WHERE id = ${input.designId} LIMIT 1
    `)
    designFile = (r as Array<{ image_path: string | null }>)[0]?.image_path ?? undefined
  } catch { /* tolerated */ }

  const { enqueuePin } = await import('./r368-pinterest-pin-queue.js')

  let enqueued = 0
  for (const tpl of TEMPLATES) {
    const title = `${input.title.slice(0, 60)} ${tpl.titleSuffix}`.slice(0, 100)
    // Skip if a pin with this title for this URL already exists (extra guard)
    try {
      const dup = await db.execute(sql`
        SELECT 1 FROM pinterest_pin_queue
        WHERE workspace_id = ${input.workspaceId} AND link_url = ${input.externalUrl} AND title = ${title}
        LIMIT 1
      `)
      if (Array.isArray(dup) && dup.length > 0) continue
    } catch { /* tolerated */ }

    await enqueuePin({
      workspaceId:  input.workspaceId,
      title,
      description:  tpl.descTpl(input.title),
      tags:         pickTags(`${input.designId}|${tpl.angle}`, 8),
      linkUrl:      input.externalUrl,
      boardName:    input.boardName ?? 'Vintage Botanical Prints | CYZOR CREATIONS',
      ...(designFile ? { designFile } : {}),
      priority:     60,                       // below seed pins (95-75) but above default
      notes:        `auto-pin angle=${tpl.angle} designId=${input.designId}`,
    }).catch(() => {/* best-effort */})
    enqueued++
  }

  return { ok: true, enqueued, skipped: TEMPLATES.length - enqueued }
}
