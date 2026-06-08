/**
 * R358 — Mockup generator for Etsy listing-photo carousels.
 *
 * Etsy requires 5-9 listing photos per item. For digital downloads, sellers
 * normally pair: (1) the bare design, (2-5) the design composited into
 * styled scenes — framed on a wall, on a desk, gallery-wall layout, etc.
 *
 * This generator uses sharp to procedurally composite the design onto
 * synthesized scene backgrounds. No external API call, no scene-asset
 * library to maintain. Output is N JPEGs in the same directory as the
 * source design.
 *
 * Quality is intentionally "good enough" — operator can swap in real
 * studio mockups later via SVG/Figma exports.
 */
import path from 'node:path'
import { promises as fs } from 'node:fs'

// Lazy sharp import so the agent boots even if sharp install fails on first run
async function getSharp(): Promise<typeof import('sharp')['default']> {
  const m = await import('sharp')
  return m.default
}

export interface MockupResult {
  paths:        string[]
  warnings:     string[]
}

const SCENES = [
  // Each scene is a procedural background + design composition
  { name: 'bare',          bg: { r: 245, g: 240, b: 232 }, scale: 0.85, frame: 0  },  // off-white card
  { name: 'wall_neutral',  bg: { r: 220, g: 212, b: 198 }, scale: 0.55, frame: 24 },  // taupe wall + white frame
  { name: 'wall_sage',     bg: { r: 188, g: 200, b: 178 }, scale: 0.55, frame: 24 },  // sage wall + frame
  { name: 'desk_warm',     bg: { r: 168, g: 140, b: 112 }, scale: 0.45, frame: 18 },  // walnut desk
  { name: 'gallery_wall',  bg: { r: 235, g: 230, b: 222 }, scale: 0.42, frame: 18, multi: true },  // 3x staggered
]

export async function generateMockups(designPath: string, outDir?: string): Promise<MockupResult> {
  const warnings: string[] = []
  let sharp: Awaited<ReturnType<typeof getSharp>>
  try {
    sharp = await getSharp()
  } catch (e) {
    warnings.push(`sharp unavailable: ${(e as Error).message}; skipping mockup generation`)
    return { paths: [], warnings }
  }

  const baseDir = outDir ?? path.dirname(designPath)
  const baseName = path.basename(designPath, path.extname(designPath))
  await fs.mkdir(baseDir, { recursive: true })
  const out: string[] = []

  const designMeta = await sharp(designPath).metadata()
  const dw = designMeta.width  ?? 1024
  const dh = designMeta.height ?? 1024
  const aspect = dw / dh

  // Canvas size for all mockups
  const CW = 2000, CH = Math.round(2000 / aspect)

  for (const scene of SCENES) {
    const outPath = path.join(baseDir, `${baseName}_mockup_${scene.name}.jpg`)
    try {
      const canvas = sharp({
        create: {
          width:  CW,
          height: CH,
          channels: 3,
          background: scene.bg,
        },
      })

      const designSize = Math.round(Math.min(CW, CH) * scene.scale)
      const designBuf = await sharp(designPath).resize(designSize, designSize, { fit: 'inside' }).png().toBuffer()
      const dMeta = await sharp(designBuf).metadata()
      const dActualW = dMeta.width  ?? designSize
      const dActualH = dMeta.height ?? designSize

      const composites: Array<{ input: Buffer; top: number; left: number }> = []

      if (scene.multi) {
        // 3-up gallery wall layout
        const offsets = [
          { dx: -1, dy: -0.15, s: 1.0 },
          { dx:  0, dy:  0.15, s: 1.1 },
          { dx:  1, dy: -0.10, s: 0.9 },
        ]
        for (const o of offsets) {
          const sw = Math.round(dActualW * o.s)
          const sh = Math.round(dActualH * o.s)
          const buf = await sharp(designPath).resize(sw, sh, { fit: 'inside' }).png().toBuffer()
          const cx = Math.round(CW / 2 + o.dx * (CW * 0.22))
          const cy = Math.round(CH / 2 + o.dy * CH)
          if (scene.frame > 0) {
            // Add white frame matte behind
            const matte = await sharp({
              create: { width: sw + scene.frame * 2, height: sh + scene.frame * 2, channels: 3, background: { r: 248, g: 246, b: 242 } },
            }).png().toBuffer()
            composites.push({ input: matte, top: cy - sh/2 - scene.frame, left: cx - sw/2 - scene.frame })
          }
          composites.push({ input: buf, top: cy - sh/2, left: cx - sw/2 })
        }
      } else {
        if (scene.frame > 0) {
          const matte = await sharp({
            create: { width: dActualW + scene.frame * 2, height: dActualH + scene.frame * 2, channels: 3, background: { r: 248, g: 246, b: 242 } },
          }).png().toBuffer()
          composites.push({
            input: matte,
            top:   Math.round((CH - dActualH) / 2) - scene.frame,
            left:  Math.round((CW - dActualW) / 2) - scene.frame,
          })
        }
        composites.push({
          input: designBuf,
          top:   Math.round((CH - dActualH) / 2),
          left:  Math.round((CW - dActualW) / 2),
        })
      }

      await canvas.composite(composites).jpeg({ quality: 88 }).toFile(outPath)
      out.push(outPath)
    } catch (e) {
      warnings.push(`scene ${scene.name} failed: ${(e as Error).message}`)
    }
  }

  return { paths: out, warnings }
}
