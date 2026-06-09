/**
 * R369 — Seed Pinterest pin queue from R360-pinterest-pins.md.
 *
 * Parses the markdown structure (## SKU sections, ### Pin sub-sections),
 * extracts title/description/tags/link/image, and bulk-loads into the
 * pinterest_pin_queue via brain-task. Idempotent.
 *
 * Run once: pnpm seed-pins
 */
import fs from 'node:fs'
import path from 'node:path'

{
  const envPath = path.resolve(process.cwd(), '.env.local')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
      if (!m) continue
      const k = m[1]!
      let v = m[2]!.trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (process.env[k] === undefined) process.env[k] = v
    }
  }
}
import { loadConfig, requireOpsToken } from './config.js'

interface Pin {
  title:       string
  description: string
  tags:        string[]
  linkUrl:     string
  designFile:  string
  priority:    number
}

function parsePinsMd(md: string): Pin[] {
  const pins: Pin[] = []
  // Split by "## " level: each section is a SKU. Skip the header.
  const sections = md.split(/^## /m).slice(1)
  for (const section of sections) {
    const headerLine = section.split('\n')[0]?.trim()
    if (!headerLine || headerLine.startsWith('Posting calendar') || headerLine.startsWith('Board structure') || headerLine.startsWith('Pinterest profile')) continue

    // Pull SKU link + image
    const linkMatch = section.match(/\*\*Link:\*\*\s*(\S+)/)
    const imgMatch  = section.match(/\*\*Image file:\*\*\s*`?([^\s`\n]+)`?/)
    if (!linkMatch || !imgMatch) continue
    const linkUrl = linkMatch[1]!
    const imgRel  = imgMatch[1]!
    // Resolve relative path
    const designFile = path.isAbsolute(imgRel)
      ? imgRel
      : path.resolve(process.cwd(), '..', '..', imgRel)

    // Each Pin under this SKU
    const pinBlocks = section.split(/^### Pin /m).slice(1)
    for (const block of pinBlocks) {
      const idLine = block.split('\n')[0]?.trim() ?? ''
      const idMatch = idLine.match(/^(\d+)\.(\d+)/)
      const priority = idMatch ? 100 - Number(idMatch[2]!) * 5 : 50  // pin 1 = highest priority
      const titleMatch = block.match(/\*\*Title[^:]*:\*\*\s*(.+)/)
      const title = titleMatch?.[1]?.trim() ?? ''
      if (!title) continue
      // Description: everything between "**Description:**" and "**Hashtags:**"
      const descMatch = block.match(/\*\*Description:\*\*\s*([\s\S]+?)\*\*Hashtags?:\*\*/i)
      const description = (descMatch?.[1] ?? '').trim()
      const tagsMatch = block.match(/\*\*Hashtags?:\*\*\s*(.+)/i)
      const tagsRaw = tagsMatch?.[1] ?? ''
      const tags = tagsRaw.split(/\s+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean)
      pins.push({ title, description, tags, linkUrl, designFile, priority })
    }
  }
  return pins
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  requireOpsToken(cfg)

  const mdPath = path.resolve(process.cwd(), '..', '..', 'R360-pinterest-pins.md')
  if (!fs.existsSync(mdPath)) {
    console.error('[seed-pins] R360-pinterest-pins.md not found at ' + mdPath)
    process.exit(1)
  }

  const md = fs.readFileSync(mdPath, 'utf8')
  const pins = parsePinsMd(md)
  console.log(`[seed-pins] parsed ${pins.length} pins from R360-pinterest-pins.md`)
  if (pins.length === 0) { console.error('[seed-pins] no pins found, aborting'); process.exit(1) }

  // Bulk-load
  const res = await fetch(`${cfg.apiBase}/api/v1/brain/task`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${cfg.opsToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      workspace_id: cfg.workspaceId,
      // non_financial=true because pin descriptions reference price like "$9" but it's content, not a financial op
      plan: [{ op: 'pinterest.bulk_load', params: { pins, non_financial: true } }],
    }),
  })
  const raw = await res.text()
  if (!res.ok) { console.error('[seed-pins] HTTP ' + res.status + ': ' + raw.slice(0, 400)); process.exit(1) }
  console.log('[seed-pins] sample pin 0:', JSON.stringify(pins[0]).slice(0, 300))
  console.log('[seed-pins] response: ' + raw.slice(0, 500))
}

main().catch((e: unknown) => { console.error('[seed-pins] fatal:', e); process.exit(1) })
