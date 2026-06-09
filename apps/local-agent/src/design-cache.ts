/**
 * R357 — Local design file cache.
 *
 * Designs are stored as data: URIs in the droplet's design_catalog. On first
 * access we decode + write to disk so Playwright can pass the local path to
 * each platform's file-input.
 */
import { promises as fs, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fetchDesignFileUrl } from './api.js'
import type { AgentConfig } from './config.js'

export async function getDesignFilePath(cfg: AgentConfig, designId: string): Promise<string> {
  const dir = path.resolve(cfg.designsRoot, 'cache')
  await fs.mkdir(dir, { recursive: true })

  // Probe cache by id (extension determined after decode)
  const existing = ['.png', '.jpg', '.jpeg'].map(e => path.join(dir, `${designId}${e}`))
  for (const p of existing) if (existsSync(p)) return p

  // Fetch from droplet, decode data: URI
  const url = await fetchDesignFileUrl(cfg, designId)
  if (!url) throw new Error(`design ${designId} has no image_url in catalog`)

  const m = url.match(/^data:([^;,]+);base64,(.+)$/s)
  if (!m) {
    // Fallback: treat as remote URL
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
    return writeWithExtSniff(dir, designId, buf)
  }
  const buf = Buffer.from(m[2]!, 'base64')
  return writeWithExtSniff(dir, designId, buf)
}

function writeWithExtSniff(dir: string, id: string, buf: Buffer): string {
  const isPng = buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47
  const isJpg = buf[0]===0xFF && buf[1]===0xD8 && buf[2]===0xFF
  // R533 — refuse degenerate buffers before they ever land on disk. Same
  // header-only checks as the API-side R514 precheck so local-agent doesn't
  // attempt to upload a corrupt file (which would get the account flagged).
  if (buf.length < 5 * 1024) {
    throw new Error(`design ${id}: file too small (${buf.length}B < 5KB) — R514 precheck`)
  }
  if (!isPng && !isJpg) {
    throw new Error(`design ${id}: unrecognized format (not PNG/JPEG) — R514 precheck`)
  }
  if (isPng && buf.length >= 24) {
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20)
    if (w < 100 || h < 100) throw new Error(`design ${id}: PNG ${w}x${h} too small for print — R514 precheck`)
  }
  const ext = isPng ? '.png' : isJpg ? '.jpg' : '.bin'
  const p = path.join(dir, id + ext)
  // sync write is fine; files are 100-500 KB
  writeFileSync(p, buf)
  return p
}
