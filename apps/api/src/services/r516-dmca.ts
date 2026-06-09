/**
 * R516 — DMCA takedown record + drafter.
 *
 * When operator spots a copy of one of their designs on a competing
 * marketplace, they paste the URL into this op. It records the claim and
 * generates a DMCA-compliant notice template that operator can send
 * (most platforms have a takedown form).
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS dmca_claims (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      offending_url     TEXT NOT NULL,
      original_design_id TEXT,
      platform          TEXT,
      status            TEXT NOT NULL DEFAULT 'drafted',  -- drafted|sent|acknowledged|removed|rejected
      created_at        BIGINT NOT NULL,
      updated_at        BIGINT NOT NULL,
      notes             TEXT
    )
  `).catch(() => {})
}

export interface DmcaInput {
  workspaceId:      string
  offendingUrl:     string
  originalDesignId?: string
  platform?:        string
}

export interface DmcaResult {
  ok:           boolean
  claimId:      string
  noticeText:   string
}

export async function fileDmcaClaim(input: DmcaInput): Promise<DmcaResult> {
  await ensureTable()
  const id = uuidv7()
  await db.execute(sql`
    INSERT INTO dmca_claims (id, workspace_id, offending_url, original_design_id, platform, status, created_at, updated_at)
    VALUES (${id}, ${input.workspaceId}, ${input.offendingUrl}, ${input.originalDesignId ?? null}, ${input.platform ?? null}, 'drafted', ${Date.now()}, ${Date.now()})
  `).catch(() => {/* tolerated */})

  const today = new Date().toISOString().slice(0, 10)
  const noticeText = `DMCA TAKEDOWN NOTICE

Date: ${today}

To: ${input.platform ?? '[platform]'} Designated Agent (legal@${input.platform ?? '[platform.com]'})

I am the copyright owner (or authorized representative) of an original work
of art that has been used without my permission in the following location:

  ${input.offendingUrl}

The original copyrighted work is published at:

  ${input.originalDesignId ? '[your listing URL for design ' + input.originalDesignId + ']' : '[your original listing URL]'}

The use described above is unauthorized and infringes my exclusive rights
under copyright law.

I have a good-faith belief that the use of the material in the manner
complained of is not authorized by the copyright owner, its agent, or the
law. I swear, under penalty of perjury, that the information in this
notification is accurate and that I am the copyright owner or am authorized
to act on behalf of the copyright owner.

Please remove the infringing material expeditiously.

Signed:
[Your full legal name]
[Your address]
[Your phone]
[Your email]

— Filed via Novan R516 · claim id ${id}
`
  return { ok: true, claimId: id, noticeText }
}

export async function listDmcaClaims(workspaceId: string): Promise<Array<{ id: string; offendingUrl: string; platform: string | null; status: string; createdAt: number }>> {
  await ensureTable()
  try {
    const r = await db.execute(sql`
      SELECT id, offending_url, platform, status, created_at FROM dmca_claims
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC LIMIT 50
    `)
    return (r as unknown as Array<{ id: string; offending_url: string; platform: string | null; status: string; created_at: number }>).map(x => ({
      id: x.id, offendingUrl: x.offending_url, platform: x.platform,
      status: x.status, createdAt: Number(x.created_at),
    }))
  } catch { return [] }
}
