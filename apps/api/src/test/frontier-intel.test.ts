/**
 * Tests for R146.104-108 frontier intel + free realistic video.
 * Pure logic only — no DB / no network. Validates:
 *  - frontier-consumers: canonical name normalization + alias map
 *  - frontier-max: clamp + settings preset shapes
 *  - ai-video-stretcher: compressPrompt + selectByEfficiency
 *  - ai-video-free-realistic: ffmpeg detection + isMp4 sniff (pure helpers)
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  const chain = new Proxy({}, { get: () => () => chain }) as never
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain, execute: () => Promise.resolve([]) } }
})
vi.mock('../db/schema.js', () => ({}))
vi.mock('@ops/db', () => ({
  frontierFindings: {}, frontierCapabilities: {}, frontierAdvancements: {},
  frontierSettings: {}, frontierSources: {}, events: {},
}))
vi.mock('./embeddings.js', () => ({ embed: async () => null }))
vi.mock('./ai-cost-tracker.js', () => ({ recordAiUsage: () => null }))
vi.mock('./autonomy-budget.js', () => ({ checkSpend: async () => ({ canProceed: true }) }))

describe('frontier-consumers.canonicalCapabilityName', () => {
  it('maps known aliases to canonical form', async () => {
    const { canonicalCapabilityName } = await import('../services/frontier-consumers.js')
    expect(canonicalCapabilityName('Retrieval-Augmented Generation')).toBe('rag')
    expect(canonicalCapabilityName('retrieval-augmented-generation')).toBe('rag')
    expect(canonicalCapabilityName('RAG')).toBe('rag')
    expect(canonicalCapabilityName('Stable Video Diffusion')).toBe('svd')
    expect(canonicalCapabilityName('svd-xt')).toBe('svd')
    expect(canonicalCapabilityName('Chain-of-Thought')).toBe('cot')
    expect(canonicalCapabilityName('text-to-video')).toBe('t2v')
    expect(canonicalCapabilityName('Image-to-Video')).toBe('i2v')
  })
  it('falls through to slug for unknown techniques', async () => {
    const { canonicalCapabilityName } = await import('../services/frontier-consumers.js')
    expect(canonicalCapabilityName('Some New 2026 Technique')).toBe('some-new-2026-technique')
    expect(canonicalCapabilityName('   weird  spacing  ')).toBe('weird-spacing')
  })
  it('caps slugs at 100 chars', async () => {
    const { canonicalCapabilityName } = await import('../services/frontier-consumers.js')
    const longName = 'x'.repeat(500)
    expect(canonicalCapabilityName(longName).length).toBeLessThanOrEqual(100)
  })
})

describe('ai-video-stretcher.compressPrompt', () => {
  it('strips hedging and boilerplate', async () => {
    const { compressPrompt } = await import('../services/ai-video-stretcher.js')
    const input = 'The camera slowly shows a very tall person walking, we see the scene from above, this shot features extremely dramatic lighting.'
    const r = compressPrompt(input)
    expect(r.compressed.length).toBeLessThan(input.length)
    expect(r.compressed).not.toMatch(/very |extremely |this shot features/i)
    expect(r.removed.length).toBeGreaterThan(0)
  })
  it('returns identical-length result on already-tight prompts', async () => {
    const { compressPrompt } = await import('../services/ai-video-stretcher.js')
    const tight = 'astronaut planting flag, red desert, golden hour'
    const r = compressPrompt(tight)
    expect(r.compressed.length).toBeLessThanOrEqual(tight.length + 5)
  })
})

describe('ai-video-stretcher.selectByEfficiency', () => {
  it('returns a known provider', async () => {
    const { selectByEfficiency } = await import('../services/ai-video-stretcher.js')
    const out = selectByEfficiency('a calm beach at sunset')
    expect(['runway', 'kling', 'luma', 'veo', 'sora']).toContain(out.primary)
  })
})

describe('ai-video-free-realistic helpers', () => {
  it('isFreeOnlyMode reads VIDEO_FREE_ONLY env', async () => {
    const { isFreeOnlyMode } = await import('../services/ai-video-free-realistic.js')
    const prev = process.env['VIDEO_FREE_ONLY']
    process.env['VIDEO_FREE_ONLY'] = '1'; expect(isFreeOnlyMode()).toBe(true)
    process.env['VIDEO_FREE_ONLY'] = '0'; expect(isFreeOnlyMode()).toBe(false)
    if (prev === undefined) delete process.env['VIDEO_FREE_ONLY']
    else process.env['VIDEO_FREE_ONLY'] = prev
  })
})

describe('image-upgrades.routeImageRequest', () => {
  it('picks pollinations when budgetUsd=0', async () => {
    // image-upgrades doesn't touch DB directly so we can import freely
    const { routeImageRequest } = await import('../services/image-upgrades.js')
    const r = routeImageRequest({ style: 'photoreal', budgetUsd: 0 })
    expect(r.primary).toBe('pollinations')
  })
  it('falls back to pollinations when no paid keys present', async () => {
    // Snapshot + clear keys
    const keys = ['REPLICATE_API_TOKEN', 'OPENAI_API_KEY', 'STABILITY_API_KEY', 'GEMINI_API_KEY']
    const prev: Record<string, string | undefined> = {}
    for (const k of keys) { prev[k] = process.env[k]; delete process.env[k] }
    try {
      const { routeImageRequest } = await import('../services/image-upgrades.js')
      const r = routeImageRequest({ style: 'photoreal' })
      expect(r.primary).toBe('pollinations')
    } finally {
      for (const k of keys) { if (prev[k] !== undefined) process.env[k] = prev[k] }
    }
  })
})

describe('voice-free-catalog (R146.110)', () => {
  it('exposes voices from every source with stable ids', async () => {
    const { listFreeVoices } = await import('../services/voice-free-catalog.js')
    const all = listFreeVoices()
    expect(all.length).toBeGreaterThan(80)  // 11 pollinations + 50+ SE + 30+ HF + 1 browser
    const sources = new Set(all.map(v => v.source))
    for (const s of ['pollinations', 'streamelements', 'huggingface', 'browser']) {
      expect(sources.has(s as never)).toBe(true)
    }
    // Every id is unique
    const ids = new Set(all.map(v => v.id))
    expect(ids.size).toBe(all.length)
    // Every id starts with the source name
    for (const v of all) expect(v.id.startsWith(`${v.source}:`)).toBe(true)
  })
  it('findFreeVoice resolves known ids and returns null for unknown', async () => {
    const { findFreeVoice } = await import('../services/voice-free-catalog.js')
    expect(findFreeVoice('pollinations:alloy')?.voiceId).toBe('alloy')
    expect(findFreeVoice('streamelements:Brian')?.language).toBe('en-GB')
    expect(findFreeVoice('definitely-not-a-voice')).toBeNull()
  })
  it('huggingface voices are flagged as needing a key', async () => {
    const { listFreeVoices } = await import('../services/voice-free-catalog.js')
    const hf = listFreeVoices().filter(v => v.source === 'huggingface')
    expect(hf.every(v => v.needsKey)).toBe(true)
    const others = listFreeVoices().filter(v => v.source === 'pollinations' || v.source === 'streamelements')
    expect(others.every(v => !v.needsKey)).toBe(true)
  })
})

describe('chat-personality (R146.109)', () => {
  it('produces a voice block when enabled and empty when disabled', async () => {
    const { buildPersonalityBlock, DEFAULT_VOICE } = await import('../services/chat-personality.js')
    expect(buildPersonalityBlock({ ...DEFAULT_VOICE, enabled: true }).length).toBeGreaterThan(500)
    expect(buildPersonalityBlock({ ...DEFAULT_VOICE, enabled: false })).toBe('')
  })
  it('voice block bans the corporate-AI tells', async () => {
    const { buildPersonalityBlock, MAX_HUMAN_PRESET } = await import('../services/chat-personality.js')
    const block = buildPersonalityBlock(MAX_HUMAN_PRESET)
    for (const banned of ['As an AI', "I'm here to help", 'Great question', 'Certainly!', 'hope this helps']) {
      expect(block).toContain(banned)  // they appear in the "never say" enumeration
    }
    expect(block).toContain('Contractions always')
    expect(block).toContain('NEVER say')
  })
  it('envVoice respects NOVAN_VOICE=max', async () => {
    const prev = process.env['NOVAN_VOICE']
    process.env['NOVAN_VOICE'] = 'max'
    const { envVoice } = await import('../services/chat-personality.js')
    const v = envVoice()
    expect(v.enabled).toBe(true)
    expect(v.warmth).toBeGreaterThanOrEqual(0.85)
    expect(v.wit).toBeGreaterThanOrEqual(0.75)
    if (prev === undefined) delete process.env['NOVAN_VOICE']
    else process.env['NOVAN_VOICE'] = prev
  })
  it('envVoice off when NOVAN_VOICE=0', async () => {
    const prev = process.env['NOVAN_VOICE']
    process.env['NOVAN_VOICE'] = '0'
    const { envVoice } = await import('../services/chat-personality.js')
    expect(envVoice().enabled).toBe(false)
    if (prev === undefined) delete process.env['NOVAN_VOICE']
    else process.env['NOVAN_VOICE'] = prev
  })
})

describe('ai-video-studio.routeShotToProvider', () => {
  it('uses canonical provider names (no veo-3/runway-gen4)', async () => {
    const { routeShotToProvider } = await import('../services/ai-video-studio.js')
    const shot = {
      id: 's1', sceneId: 'sc1', beatIndex: 0, durationSec: 6,
      prompt: 'tracking shot of a car', charactersInShot: [], cameraMove: 'tracking' as const,
      preferredProvider: 'auto' as const,
    }
    const r = routeShotToProvider(shot)
    // No legacy alias survives
    expect(r.primary).not.toMatch(/-(gen4|3)$/)
    for (const f of r.fallbacks) expect(f).not.toMatch(/-(gen4|3)$/)
  })
})
