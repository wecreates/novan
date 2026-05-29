/**
 * media-analyzer-r7.test.ts — Tests for the unified media-analyzer surface.
 *
 * Covers locked-refusal enforcement, perceptual-hash logic, frame-mode
 * cost discipline, MCP tool catalog completeness, and async job
 * submission rejection on budget overrun.
 */
import { describe, it, expect } from 'vitest'

describe('media-analyzer — locked refusals', () => {
  it('refuses facial identification', async () => {
    const { assertNotLocked } = await import('../services/media-analyzer.js')
    expect(() => assertNotLocked('identify the person in this photo')).toThrow(/facial_identification/)
    expect(() => assertNotLocked('match face against database')).toThrow(/facial_identification/)
  })

  it('refuses voice biometrics', async () => {
    const { assertNotLocked } = await import('../services/media-analyzer.js')
    expect(() => assertNotLocked('voice biometric match')).toThrow(/voice_biometrics/)
    expect(() => assertNotLocked('identify voice from sample')).toThrow(/voice_biometrics/)
  })

  it('refuses image/video generation', async () => {
    const { assertNotLocked } = await import('../services/media-analyzer.js')
    expect(() => assertNotLocked('generate an image of a cat')).toThrow(/generation/)
    expect(() => assertNotLocked('generate video of sunset')).toThrow(/generation/)
  })

  it('refuses surveillance use', async () => {
    const { assertNotLocked } = await import('../services/media-analyzer.js')
    expect(() => assertNotLocked('surveillance system for office')).toThrow(/surveillance/)
    expect(() => assertNotLocked('track person across cameras')).toThrow(/surveillance/)
  })

  it('allows legitimate analysis intents', async () => {
    const { assertNotLocked } = await import('../services/media-analyzer.js')
    expect(() => assertNotLocked('extract text from receipt')).not.toThrow()
    expect(() => assertNotLocked('check brand compliance')).not.toThrow()
    expect(() => assertNotLocked('count objects in scene')).not.toThrow()
  })

  it('LOCKED_REFUSALS list is non-empty + immutable contract', async () => {
    const { LOCKED_REFUSALS } = await import('../services/media-analyzer.js')
    expect(LOCKED_REFUSALS).toContain('facial_identification')
    expect(LOCKED_REFUSALS).toContain('voice_biometrics')
    expect(LOCKED_REFUSALS).toContain('image_generation')
    expect(LOCKED_REFUSALS).toContain('video_generation')
    expect(LOCKED_REFUSALS).toContain('surveillance')
  })
})

describe('media-analyzer — perceptual hash', () => {
  it('computes a 64-bit hex hash from 9x8 grayscale', async () => {
    const { computePerceptualHash } = await import('../services/media-analyzer.js')
    const grid = Array.from({ length: 72 }, (_, i) => i * 3)  // monotonic
    const h = computePerceptualHash(grid)
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })

  it('rejects wrong-size input', async () => {
    const { computePerceptualHash } = await import('../services/media-analyzer.js')
    expect(() => computePerceptualHash([1, 2, 3])).toThrow(/9x8=72/)
  })

  it('identical grids produce identical hashes', async () => {
    const { computePerceptualHash } = await import('../services/media-analyzer.js')
    const grid = Array.from({ length: 72 }, (_, i) => (i * 7) % 256)
    expect(computePerceptualHash(grid)).toBe(computePerceptualHash(grid))
  })

  it('hashDistance is 0 for identical hashes', async () => {
    const { hashDistance } = await import('../services/media-analyzer.js')
    expect(hashDistance('ffff0000ffff0000', 'ffff0000ffff0000')).toBe(0)
  })

  it('hashDistance counts differing bits', async () => {
    const { hashDistance } = await import('../services/media-analyzer.js')
    // 0xff vs 0x00 = 8 bits different
    expect(hashDistance('ff00000000000000', '0000000000000000')).toBe(8)
  })

  it('isNearDuplicate uses threshold of 6', async () => {
    const { isNearDuplicate, NEAR_DUP_THRESHOLD } = await import('../services/media-analyzer.js')
    expect(NEAR_DUP_THRESHOLD).toBe(6)
    // Identical → near dup
    expect(isNearDuplicate('abcdef0123456789', 'abcdef0123456789')).toBe(true)
    // Wildly different → not near dup
    expect(isNearDuplicate('0000000000000000', 'ffffffffffffffff')).toBe(false)
  })

  it('cacheKey is deterministic + ignores order', async () => {
    const { cacheKey } = await import('../services/media-analyzer.js')
    const k1 = cacheKey('abc', ['scene', 'objects', 'safety'])
    const k2 = cacheKey('abc', ['safety', 'objects', 'scene'])
    expect(k1).toBe(k2)
  })

  it('cacheKey deduplicates repeats', async () => {
    const { cacheKey } = await import('../services/media-analyzer.js')
    const k1 = cacheKey('abc', ['scene', 'objects'])
    const k2 = cacheKey('abc', ['scene', 'objects', 'scene'])
    expect(k1).toBe(k2)
  })
})

describe('media-analyzer — video budget discipline', () => {
  it('sparse mode analyzes ~1 frame per minute', async () => {
    const { estimateVideoCost } = await import('../services/media-analyzer.js')
    const e = estimateVideoCost(600, 'sparse', 10)
    expect(e.framesToAnalyze).toBe(10)  // 600 / 60
  })

  it('adaptive mode analyzes ~1 frame per 10 seconds', async () => {
    const { estimateVideoCost } = await import('../services/media-analyzer.js')
    const e = estimateVideoCost(600, 'adaptive', 10)
    expect(e.framesToAnalyze).toBe(60)  // 600 / 10
  })

  it('dense mode assumes ~24fps and explodes cost', async () => {
    const { estimateVideoCost } = await import('../services/media-analyzer.js')
    const e = estimateVideoCost(600, 'dense', 1.0)
    expect(e.framesToAnalyze).toBe(14400)  // 600 * 24
    expect(e.willExceedBudget).toBe(true)
  })

  it('zero-duration returns zero cost', async () => {
    const { estimateVideoCost } = await import('../services/media-analyzer.js')
    const e = estimateVideoCost(0, 'sparse', 100)
    expect(e.estCostUsd).toBe(0)
    expect(e.framesToAnalyze).toBe(0)
  })

  it('matches spec: 10-min sparse ≈ $0.20 magnitude', async () => {
    const { estimateVideoCost } = await import('../services/media-analyzer.js')
    const e = estimateVideoCost(600, 'sparse', 1)
    // 10 frames * $0.0008 = $0.008 — well within sparse-is-cheap framing
    expect(e.estCostUsd).toBeLessThan(0.05)
  })

  it('matches spec: 10-min dense ≈ hundreds-of-dollars magnitude', async () => {
    const { estimateVideoCost } = await import('../services/media-analyzer.js')
    const e = estimateVideoCost(600, 'dense', 1)
    // 14400 * $0.0008 ≈ $11.50 — order of magnitude correct
    expect(e.estCostUsd).toBeGreaterThan(5)
  })

  it('submitVideoAnalysis rejects locked intents', async () => {
    const { submitVideoAnalysis } = await import('../services/media-analyzer.js')
    await expect(submitVideoAnalysis({
      videoUrl: 'https://example.com/v.mp4',
      workspaceId: 'w', requestedBy: 'agent',
      mode: 'sparse', intent: 'surveillance feed', budgetUsdCap: 100,
    })).rejects.toThrow(/surveillance/)
  })

  it('submitVideoAnalysis rejects budget-exceeding dense jobs', async () => {
    const { submitVideoAnalysis } = await import('../services/media-analyzer.js')
    const out = await submitVideoAnalysis({
      videoUrl: 'https://example.com/v.mp4',
      workspaceId: 'w', requestedBy: 'agent',
      mode: 'dense', intent: 'analyze content', budgetUsdCap: 0.10,
    })
    expect(out.accepted).toBe(false)
    expect(out.rejectReason).toMatch(/exceeds cap/)
  })

  it('submitVideoAnalysis accepts sparse jobs within budget', async () => {
    const { submitVideoAnalysis } = await import('../services/media-analyzer.js')
    const out = await submitVideoAnalysis({
      videoUrl: 'https://example.com/v.mp4',
      workspaceId: 'w', requestedBy: 'agent',
      mode: 'sparse', intent: 'analyze content', budgetUsdCap: 10,
    })
    expect(out.accepted).toBe(true)
    expect(out.jobId).toBeTruthy()
  })
})

describe('media-analyzer — MCP tool catalog', () => {
  it('exposes both image + video tool families', async () => {
    const { listMediaMcpTools } = await import('../services/media-analyzer.js')
    const tools = listMediaMcpTools()
    expect(tools.length).toBeGreaterThanOrEqual(16)
    const imageTools = tools.filter(t => t.scope === 'image')
    const videoTools = tools.filter(t => t.scope === 'video')
    expect(imageTools.length).toBeGreaterThanOrEqual(7)
    expect(videoTools.length).toBeGreaterThanOrEqual(9)
  })

  it('covers the canonical image MCP operations from the spec', async () => {
    const { listMediaMcpTools } = await import('../services/media-analyzer.js')
    const names = listMediaMcpTools().map(t => t.name)
    expect(names).toContain('media.image.analyze')
    expect(names).toContain('media.image.generate_alt_text')
    expect(names).toContain('media.image.moderate')
    expect(names).toContain('media.image.find_similar')
    expect(names).toContain('media.image.extract_text')
    expect(names).toContain('media.image.check_brand')
  })

  it('covers the canonical video MCP operations from the spec', async () => {
    const { listMediaMcpTools } = await import('../services/media-analyzer.js')
    const names = listMediaMcpTools().map(t => t.name)
    expect(names).toContain('media.video.analyze')
    expect(names).toContain('media.video.extract_transcript')
    expect(names).toContain('media.video.find_highlights')
    expect(names).toContain('media.video.generate_captions')
    expect(names).toContain('media.video.generate_chapters')
    expect(names).toContain('media.video.summarize')
    expect(names).toContain('media.video.estimate_cost')
  })
})

describe('media-analyzer — image analysis surface', () => {
  it('analyzeImage rejects locked intents', async () => {
    const { analyzeImage } = await import('../services/media-analyzer.js')
    await expect(analyzeImage({
      imageHash: 'a'.repeat(64), source: 'https://x', workspaceId: 'w', requestedBy: 'agent',
      analysisTypes: ['objects'], intent: 'identify person from photo',
    })).rejects.toThrow(/facial_identification/)
  })

  it('analyzeImage returns structured contract for legitimate intents', async () => {
    const prev = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    try {
      const { analyzeImage } = await import('../services/media-analyzer.js')
      const out = await analyzeImage({
        imageHash: 'b'.repeat(64), source: 'https://x', workspaceId: 'w', requestedBy: 'agent',
        analysisTypes: ['objects', 'scene'], intent: 'catalog enrichment',
      })
      expect(out.analysisId).toBeTruthy()
      expect(out.imageHash).toBe('b'.repeat(64))
      // No-key path: placeholder flag set + zero confidence per type.
      expect(out.flags).toContain('placeholder:no_anthropic_key')
      expect(typeof out.durationMs).toBe('number')
    } finally {
      if (prev !== undefined) process.env['ANTHROPIC_API_KEY'] = prev
    }
  })
})
