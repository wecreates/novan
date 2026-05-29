/**
 * Tests for content-prompt-scoring.ts — pure math, no DB writes.
 *
 * `applyOutcome` is mocked at the recordOutcome boundary so we can
 * assert which prompts got which scores without writing rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const recordedOutcomes: Array<{ id: string; score: number }> = []

vi.mock('../services/prompt-evolution.js', () => ({
  recordOutcome: vi.fn(async (id: string, score: number) => {
    recordedOutcomes.push({ id, score })
  }),
}))

import { scoreFromSignals, applyOutcome } from '../services/content-prompt-scoring.js'

beforeEach(() => { recordedOutcomes.length = 0 })

// ─── scoreFromSignals ─────────────────────────────────────────────────────

describe('scoreFromSignals: CTR signal → thumbnail + title', () => {
  it('returns thumbnail + title scores when ctr is present', () => {
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'youtube',
      promptIds: { thumbnail: 't1', title: 'tt1' },
      signals: { ctr: 0.04 },
    })
    expect(s.thumbnail).toBeGreaterThan(0)
    expect(s.title).toBeGreaterThan(0)
  })

  it('scores higher CTR closer to 1.0', () => {
    const low  = scoreFromSignals({ workspaceId: 'w', platform: 'youtube', promptIds: {}, signals: { ctr: 0.02 } })
    const high = scoreFromSignals({ workspaceId: 'w', platform: 'youtube', promptIds: {}, signals: { ctr: 0.12 } })
    expect(high.thumbnail!).toBeGreaterThan(low.thumbnail!)
    expect(high.thumbnail!).toBeGreaterThan(0.8)
    expect(low.thumbnail!).toBeLessThan(0.5)
  })

  it('omits thumbnail score when ctr is absent', () => {
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'youtube', promptIds: {},
      signals: { views: 1000 },
    })
    expect(s.thumbnail).toBeUndefined()
    expect(s.title).toBeUndefined()
  })

  it('honors caller baseline (per-channel median) over platform default', () => {
    // Operator's channel median CTR is 8% → 0.05 is BELOW baseline.
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'youtube',
      promptIds: {}, baseline: { ctr: 0.08 },
      signals: { ctr: 0.05 },
    })
    expect(s.thumbnail!).toBeLessThan(0.5)   // below the operator's own baseline
  })
})

describe('scoreFromSignals: AVD signal → script + hook', () => {
  it('computes AVD% from avg_view_duration_sec / durationSec', () => {
    // 60s of 600s = 10% AVD — well below the 40% YouTube target
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'youtube', promptIds: {},
      signals: { avg_view_duration_sec: 60, durationSec: 600 },
    })
    expect(s.script!).toBeLessThan(0.2)
  })

  it('rewards on-target AVD%', () => {
    // 50% AVD on YouTube — above the 40% baseline
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'youtube', promptIds: {},
      signals: { avg_view_duration_sec: 300, durationSec: 600 },
    })
    expect(s.script!).toBeGreaterThan(0.5)
  })

  it('grades the hook stricter than the script', () => {
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'youtube', promptIds: {},
      signals: { avg_view_duration_sec: 240, durationSec: 600 },
    })
    // Same AVD value, hook scored against 1.2× target → strictly less than script
    expect(s.hook!).toBeLessThan(s.script!)
  })

  it('handles TikTok watch-through threshold', () => {
    // 70% watch-through (well above TikTok's 50% target)
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'tiktok', promptIds: {},
      signals: { avg_view_duration_sec: 21, durationSec: 30 },
    })
    expect(s.script!).toBeGreaterThan(0.5)
  })

  it('omits script when durationSec is 0 or absent', () => {
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'youtube', promptIds: {},
      signals: { avg_view_duration_sec: 60, durationSec: 0 },
    })
    expect(s.script).toBeUndefined()
    expect(s.hook).toBeUndefined()
  })
})

describe('scoreFromSignals: conversion rate → description + tags', () => {
  it('scores Etsy listings on conversion_rate', () => {
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'etsy', promptIds: {},
      signals: { conversion_rate: 0.05 },
    })
    expect(s.description!).toBeGreaterThan(0.5)
    expect(s.tags!).toBeGreaterThan(0.5)
  })

  it('low conversion → low score', () => {
    const s = scoreFromSignals({
      workspaceId: 'w', platform: 'etsy', promptIds: {},
      signals: { conversion_rate: 0.005 },
    })
    expect(s.description!).toBeLessThan(0.3)
  })
})

// ─── applyOutcome ─────────────────────────────────────────────────────────

describe('applyOutcome: writes per-slot scores', () => {
  it('records outcomes only for prompts that have ids and signals', async () => {
    const r = await applyOutcome({
      workspaceId: 'w', platform: 'youtube',
      promptIds: { thumbnail: 'thumb-1', script: 'script-1' },
      signals: { ctr: 0.05, avg_view_duration_sec: 240, durationSec: 600 },
    })
    expect(r.thumbnail).toBeDefined()
    expect(r.script).toBeDefined()
    // Two writes — thumbnail + script. Title was scored from CTR but no id provided.
    expect(recordedOutcomes.length).toBe(2)
    const ids = recordedOutcomes.map(o => o.id).sort()
    expect(ids).toEqual(['script-1', 'thumb-1'])
  })

  it('records nothing when no promptIds match scored slots', async () => {
    await applyOutcome({
      workspaceId: 'w', platform: 'youtube', promptIds: {},
      signals: { ctr: 0.05 },
    })
    expect(recordedOutcomes.length).toBe(0)
  })

  it('records hook + script when both have ids and AVD is present', async () => {
    await applyOutcome({
      workspaceId: 'w', platform: 'tiktok',
      promptIds: { hook: 'hook-1', script: 'script-1' },
      signals: { avg_view_duration_sec: 21, durationSec: 30 },
    })
    expect(recordedOutcomes.length).toBe(2)
  })

  it('skips a slot whose signal is absent even if the id is provided', async () => {
    await applyOutcome({
      workspaceId: 'w', platform: 'etsy',
      promptIds: { description: 'd-1', tags: 't-1', thumbnail: 'th-1' },
      signals: { conversion_rate: 0.05 },   // no ctr → thumbnail not scored
    })
    const ids = recordedOutcomes.map(o => o.id).sort()
    expect(ids).toEqual(['d-1', 't-1'])
  })

  it('all scores are in the 0..1 range', async () => {
    await applyOutcome({
      workspaceId: 'w', platform: 'youtube',
      promptIds: { thumbnail: 'a', script: 'b', title: 'c', hook: 'd' },
      signals: { ctr: 0.20, avg_view_duration_sec: 540, durationSec: 600 },
    })
    for (const o of recordedOutcomes) {
      expect(o.score).toBeGreaterThanOrEqual(0)
      expect(o.score).toBeLessThanOrEqual(1)
    }
  })
})
