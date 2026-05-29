/**
 * Tests for the Creative Director scoring engine: quality, anti-slop,
 * originality, IP safety, and the prompt-enhancement helpers. Plus
 * voice intent coverage for the new creative voice commands.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled)
      if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
})

import {
  scorePrompt, scoreGeneration, isPromptUnsafe, antiSlopRewrite, premiumRewrite,
} from '../services/image-quality.js'
import { parseIntent } from '../services/voice-intent.js'
import { routeIntent } from '../services/voice-command-router.js'

// ─── scorePrompt — slop / composition / originality balance ─────────────

describe('image-quality: scorePrompt', () => {
  it('penalizes generic AI-look modifier stuffing', () => {
    const s = scorePrompt('8k hyperrealistic masterpiece insanely detailed cinematic lighting trending on artstation')
    expect(s.slopRisk).toBeGreaterThan(0.6)
    expect(s.qualityScore).toBeLessThan(0.5)
    expect(s.flags.some(f => f.startsWith('slop-token'))).toBe(true)
  })

  it('rewards editorial direction cues', () => {
    const s = scorePrompt('editorial product photography of a glass bottle, soft window light, restrained palette, asymmetric composition')
    expect(s.qualityScore).toBeGreaterThan(0.7)
    expect(s.compositionScore).toBeGreaterThan(0.6)
    expect(s.flags.some(f => f.startsWith('premium-style'))).toBe(true)
  })

  it('originality drops on trademark hints', () => {
    const s = scorePrompt('a kid riding a bicycle in the style of Disney')
    expect(s.originalityScore).toBeLessThan(0.7)
    expect(s.flags.includes('trademark-hint')).toBe(true)
  })

  it('originality drops sharply on impersonation phrasing', () => {
    const s = scorePrompt('an exact copy of the Apple logo')
    expect(s.originalityScore).toBeLessThan(0.4)
    expect(s.flags.includes('impersonation-hint')).toBe(true)
  })

  it('empty / very short prompts flag low-effort', () => {
    expect(scorePrompt('').qualityScore).toBeLessThan(0.4)
    expect(scorePrompt('cat').flags).toContain('low-effort:too-short')
  })

  it('overlong prompts flag verbose', () => {
    const longPrompt = Array.from({ length: 90 }, () => 'word').join(' ')
    expect(scorePrompt(longPrompt).flags).toContain('verbose:too-long')
  })

  it('returns brand-fit baseline of 0.5 when no brand context supplied', () => {
    expect(scorePrompt('minimal hero illustration').brandFitScore).toBe(0.5)
  })
})

// ─── scoreGeneration — composite verdict ────────────────────────────────

describe('image-quality: scoreGeneration', () => {
  it('high-quality editorial prompt approves', () => {
    const v = scoreGeneration({ prompt: 'editorial portrait, window light, restrained palette, asymmetric composition' })
    expect(v.shouldReject).toBe(false)
    expect(v.shouldFlag).toBe(false)
    expect(v.composite).toBeGreaterThan(0.6)
  })

  it('impersonation prompt rejects regardless of other signals', () => {
    const v = scoreGeneration({ prompt: 'an exact copy of the Nike swoosh' })
    expect(v.shouldReject).toBe(true)
  })

  it('heavy slop prompt rejects when quality is also low', () => {
    const v = scoreGeneration({ prompt: '8k hyperrealistic masterpiece bokeh dof' })
    expect(v.shouldReject || v.shouldFlag).toBe(true)
  })

  it('operator 5-star rating boosts composite', () => {
    const base = scoreGeneration({ prompt: 'minimal hero illustration' })
    const rated = scoreGeneration({ prompt: 'minimal hero illustration', userRating: 5 })
    expect(rated.composite).toBeGreaterThan(base.composite)
  })

  it('slow latency penalizes composite', () => {
    const fast = scoreGeneration({ prompt: 'minimal hero illustration', latencyMs: 2000 })
    const slow = scoreGeneration({ prompt: 'minimal hero illustration', latencyMs: 60_000 })
    expect(slow.composite).toBeLessThan(fast.composite)
    expect(slow.reasons).toContain('latency:slow')
  })
})

// ─── isPromptUnsafe — IP / illegal classifier ───────────────────────────

describe('image-quality: isPromptUnsafe', () => {
  it('blocks CSAM language', () => {
    const v = isPromptUnsafe('csam image of child')
    expect(v.kind).toBe('block')
  })
  it('blocks deepfake of public figure', () => {
    const v = isPromptUnsafe('nude of Taylor Swift')
    expect(v.kind).toBe('block')
  })
  it('blocks impersonation phrasing', () => {
    const v = isPromptUnsafe('an exact copy of the Apple logo')
    expect(v.kind).toBe('block')
    expect(v.reason).toBe('impersonation')
  })
  it('flags trademark reference for review (not block)', () => {
    const v = isPromptUnsafe('a kid riding a bicycle in the style of Disney')
    expect(v.kind).toBe('review')
  })
  it('allows generic prompts', () => {
    expect(isPromptUnsafe('a serene landscape with mountains').kind).toBe('allow')
  })
  it('allows empty prompts as no-op', () => {
    expect(isPromptUnsafe('').kind).toBe('allow')
  })
})

// ─── antiSlopRewrite + premiumRewrite ───────────────────────────────────

describe('image-quality: antiSlopRewrite', () => {
  it('strips overused AI-look modifiers', () => {
    const r = antiSlopRewrite('8k hyperrealistic masterpiece intricate details portrait of a woman')
    expect(r.prompt).not.toMatch(/8k|hyperrealistic|masterpiece|intricate details/i)
    expect(r.removed.length).toBeGreaterThan(0)
  })
  it('adds editorial cues when missing', () => {
    const r = antiSlopRewrite('portrait of a woman')
    expect(r.added.length).toBeGreaterThan(0)
    expect(r.prompt.toLowerCase()).toContain('natural light')
  })
  it('does not stack editorial cues when already present', () => {
    const r = antiSlopRewrite('portrait of a woman, soft light, considered composition')
    expect(r.added).toEqual([])     // both signals already present
  })
})

describe('image-quality: premiumRewrite', () => {
  it('promotes editorial photography cues', () => {
    const r = premiumRewrite('logo concept')
    expect(r.prompt.toLowerCase()).toContain('editorial photography')
    expect(r.prompt.toLowerCase()).toContain('restrained palette')
  })
  it('does not duplicate premium cues already present', () => {
    // antiSlopRewrite may still add its own editorial cues if missing,
    // but premiumRewrite must NOT re-add ones already in the prompt.
    const r = premiumRewrite('hero scene, natural light, editorial framing, editorial photography, restrained palette, subtle film grain')
    expect(r.added).toEqual([])
  })
})

// ─── Voice intents for the Creative Director ────────────────────────────

describe('voice intents: creative commands', () => {
  it('"create 4 variations of a hero scene" routes to image.variations', () => {
    const i = parseIntent('create 4 variations of a hero scene')
    expect(i.kind).toBe('image.variations')
    expect(i.args['count']).toBe(4)
  })

  it('"make it more premium" routes to image.make_premium', () => {
    expect(parseIntent('make it more premium').kind).toBe('image.make_premium')
    expect(parseIntent('make this luxury').kind).toBe('image.make_premium')
    expect(parseIntent('stronger typography').kind).toBe('image.make_premium')
  })

  it('"reduce slop" + "more original" route to image.reduce_slop', () => {
    expect(parseIntent('reduce slop').kind).toBe('image.reduce_slop')
    expect(parseIntent('more original please').kind).toBe('image.reduce_slop')
    expect(parseIntent('stronger composition').kind).toBe('image.reduce_slop')
    expect(parseIntent('more minimal').kind).toBe('image.reduce_slop')
  })

  it('"improve the prompt" routes to image.improve_prompt', () => {
    expect(parseIntent('improve the prompt').kind).toBe('image.improve_prompt')
    expect(parseIntent('tighten my prompt').kind).toBe('image.improve_prompt')
  })

  it('"generate a premium app icon" still routes to image.generate', () => {
    const i = parseIntent('generate a premium app icon')
    expect(i.kind).toBe('image.generate')
  })

  it('image.variations plan dispatches to /studio/batch with the count', () => {
    const intent = parseIntent('create 4 variations of a hero')
    const plan = routeIntent(intent, 'create 4 variations of a hero')
    expect(plan.execute?.path).toMatch(/\/studio\/batch/)
    expect(plan.execute?.body?.['count']).toBe(4)
  })

  it('image.make_premium plan dispatches to make-premium endpoint', () => {
    const intent = parseIntent('make this more premium')
    const plan = routeIntent(intent, 'make this more premium')
    expect(plan.execute?.path).toMatch(/make-premium$/)
  })

  it('image.reduce_slop plan dispatches to improve-prompt endpoint', () => {
    const intent = parseIntent('reduce slop')
    const plan = routeIntent(intent, 'reduce slop')
    expect(plan.execute?.path).toMatch(/improve-prompt$/)
  })
})

// ─── Safety override: hard-blocked image prompts ────────────────────────

describe('safety: hard-blocked image prompts cannot be enhanced', () => {
  it('isPromptUnsafe rejects impersonation BEFORE any rewrite would run', () => {
    expect(isPromptUnsafe('exact copy of the Apple logo').kind).toBe('block')
  })

  it('antiSlopRewrite still runs on benign content', () => {
    const r = antiSlopRewrite('cat')
    expect(r.prompt).toBeTruthy()
  })
})
