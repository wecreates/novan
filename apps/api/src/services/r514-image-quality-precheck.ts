/**
 * R514 — Image-quality pre-check before queueing.
 *
 * Sometimes image-gen returns a degenerate image (all-black, all-white, all
 * one color, way too small, transparent only). Shipping that to platforms
 * gets accounts flagged.
 *
 * This is a cheap header + first-N-bytes check. Doesn't decode full pixel
 * data — just rejects obvious failures:
 *   - bytes < 5KB (PNG smaller than 5KB is almost certainly broken)
 *   - PNG declared 0x0 dimensions
 *   - JPEG with no SOF marker in first 16KB
 */
import fs from 'node:fs'

export interface QualityVerdict {
  ok:        boolean
  reason?:   string
  bytes:     number
}

export function precheckImageBuffer(buf: Buffer): QualityVerdict {
  if (buf.length < 5 * 1024) return { ok: false, reason: 'file too small (<5KB)', bytes: buf.length }
  if (buf.length > 25 * 1024 * 1024) return { ok: false, reason: 'file too large (>25MB)', bytes: buf.length }

  // PNG magic + IHDR width/height check
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    // PNG IHDR at offset 16 (after 8-byte sig + 4-byte length + 4-byte 'IHDR')
    if (buf.length < 24) return { ok: false, reason: 'PNG truncated', bytes: buf.length }
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    if (w === 0 || h === 0) return { ok: false, reason: 'PNG declared 0x0 dimensions', bytes: buf.length }
    if (w < 100 || h < 100) return { ok: false, reason: `PNG ${w}x${h} too small for print`, bytes: buf.length }
    return { ok: true, bytes: buf.length }
  }
  // JPEG: must start with FF D8 FF and have a SOF0/SOF2 marker (FF C0 / FF C2)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const scan = buf.subarray(0, Math.min(buf.length, 16 * 1024))
    for (let i = 0; i < scan.length - 1; i++) {
      if (scan[i] === 0xff && (scan[i + 1] === 0xc0 || scan[i + 1] === 0xc2)) {
        // SOF: bytes [i+5..i+6]=height, [i+7..i+8]=width (big-endian)
        if (i + 9 < scan.length) {
          const h = (scan[i + 5]! << 8) | scan[i + 6]!
          const w = (scan[i + 7]! << 8) | scan[i + 8]!
          if (w === 0 || h === 0) return { ok: false, reason: 'JPEG 0x0 dims', bytes: buf.length }
          if (w < 100 || h < 100) return { ok: false, reason: `JPEG ${w}x${h} too small for print`, bytes: buf.length }
        }
        return { ok: true, bytes: buf.length }
      }
    }
    return { ok: false, reason: 'JPEG missing SOF marker', bytes: buf.length }
  }
  return { ok: false, reason: 'unrecognized format', bytes: buf.length }
}

export async function precheckImageFile(path: string): Promise<QualityVerdict> {
  try {
    const buf = await fs.promises.readFile(path)
    return precheckImageBuffer(buf)
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 100), bytes: 0 }
  }
}
