/**
 * Tests for the four operational intelligence primitives shipped
 * under migration 0034:
 *   #18 cognitive load scorer (pure)
 *   #21 anomaly detector (pure)
 *   #29 why-chain role classification + summary (pure)
 *
 * #20 self-healing is DB-bound; the route + cron registration is the
 * integration surface.
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

import { scoreCognitiveLoad } from '../services/operator-cognitive-load.js'
import { detectAnomalies, type EventLike } from '../services/anomaly-detection.js'
import { classifyRole, summarizeEvent } from '../services/voice-why-chain.js'

// ─── #18 Cognitive load ─────────────────────────────────────────────────

describe('cognitive load: scoreCognitiveLoad', () => {
  it('idle workspace scores calm', () => {
    const v = scoreCognitiveLoad({ eventVolume: 10, alertVolume: 0, pendingCount: 0, interruptionRate: 0, windowMs: 1_800_000 })
    expect(v.mode).toBe('calm')
    expect(v.loadScore).toBeLessThan(0.2)
  })

  it('mid-incident workspace scores deep or overload', () => {
    const v = scoreCognitiveLoad({ eventVolume: 250, alertVolume: 8, pendingCount: 6, interruptionRate: 0.4, windowMs: 1_800_000 })
    expect(['deep', 'overload']).toContain(v.mode)
    expect(v.loadScore).toBeGreaterThan(0.5)
  })

  it('overload mode recommends suppressing non-critical alerts', () => {
    const v = scoreCognitiveLoad({ eventVolume: 400, alertVolume: 15, pendingCount: 10, interruptionRate: 0.6, windowMs: 1_800_000 })
    expect(v.mode).toBe('overload')
    expect(v.recommendation.toLowerCase()).toContain('non-critical')
  })

  it('caps load at 1.0', () => {
    const v = scoreCognitiveLoad({ eventVolume: 9999, alertVolume: 999, pendingCount: 999, interruptionRate: 5, windowMs: 1_800_000 })
    expect(v.loadScore).toBeLessThanOrEqual(1)
  })

  it('calm mode requires very low signals', () => {
    expect(scoreCognitiveLoad({ eventVolume: 5, alertVolume: 0, pendingCount: 0, interruptionRate: 0, windowMs: 1_800_000 }).mode).toBe('calm')
    // Adding a single alert moves it out of calm
    expect(scoreCognitiveLoad({ eventVolume: 5, alertVolume: 3, pendingCount: 1, interruptionRate: 0, windowMs: 1_800_000 }).mode).not.toBe('calm')
  })
})

// ─── #21 Anomaly detection ──────────────────────────────────────────────

describe('anomaly detection: detectAnomalies', () => {
  const ev = (type: string, payload: unknown = {}, ageMs = 1000): EventLike =>
    ({ type, payload, createdAt: Date.now() - ageMs })

  it('flags auth burst at 5+ failures', () => {
    const rows = Array.from({ length: 8 }, () => ev('auth.failure'))
    const verdicts = detectAnomalies(rows)
    const v = verdicts.find(x => x.kind === 'auth_burst')
    expect(v).toBeTruthy()
    expect(v!.severity).toMatch(/medium|high/)
  })

  it('escalates auth_burst to critical at 20+', () => {
    const rows = Array.from({ length: 25 }, () => ev('auth.failure'))
    const v = detectAnomalies(rows).find(x => x.kind === 'auth_burst')!
    expect(v.severity).toBe('critical')
  })

  it('detects unsafe automation hard blocks', () => {
    const rows = [
      ev('voice.image.generate', { plan: { verdict: 'reject' } }),
      ev('voice.browser.open',   { plan: { verdict: 'reject' } }),
      ev('voice.research.start', { plan: { verdict: 'reject' } }),
      ev('voice.image.generate', { plan: { verdict: 'reject' } }),
    ]
    const v = detectAnomalies(rows).find(x => x.kind === 'unsafe_automation')
    expect(v).toBeTruthy()
  })

  it('detects api abuse from same subject', () => {
    const rows = Array.from({ length: 15 }, () => ev('api.error', { source: 'abuser-1' }))
    const v = detectAnomalies(rows).find(x => x.kind === 'api_abuse')
    expect(v).toBeTruthy()
    expect(v!.subject).toBe('abuser-1')
  })

  it('flags secret leak when payload carries an obvious key', () => {
    const rows = [ev('audit.log', { token: 'sk-' + 'a'.repeat(40) })]
    const v = detectAnomalies(rows).find(x => x.kind === 'secret_leak')
    expect(v).toBeTruthy()
    expect(v!.severity).toBe('critical')
  })

  it('produces no verdicts on empty input', () => {
    expect(detectAnomalies([])).toEqual([])
  })

  it('detects runtime spike against a low baseline', () => {
    // 200 events in 1 minute → 200/min vs default baseline 8/min = 25x
    const rows = Array.from({ length: 200 }, () => ev('runtime.tick', {}, 30_000))
    const v = detectAnomalies(rows).find(x => x.kind === 'runtime_spike')
    expect(v).toBeTruthy()
  })

  it('does not flag normal traffic', () => {
    const rows = Array.from({ length: 10 }, () => ev('user.view'))
    expect(detectAnomalies(rows).length).toBe(0)
  })
})

// ─── #29 Why-chain pure helpers ─────────────────────────────────────────

describe('why-chain: classifyRole', () => {
  it('routes dry-run lifecycle (non-executed) to approval role', () => {
    expect(classifyRole('voice.dry_run.created')).toBe('approval')
    expect(classifyRole('voice.dry_run.approval')).toBe('approval')
  })
  it('routes dry-run executed to execution role', () => {
    expect(classifyRole('voice.dry_run.executed')).toBe('execution')
  })
  it('routes safety / block events to safety role', () => {
    expect(classifyRole('safety.classifier.block')).toBe('safety')
    expect(classifyRole('voice.command.reject')).toBe('safety')
  })
  it('routes budget events to budget role', () => {
    expect(classifyRole('budget.exceeded')).toBe('budget')
    expect(classifyRole('budget.cap_reached')).toBe('budget')
  })
  it('routes execute events to execution role', () => {
    expect(classifyRole('agent.execute')).toBe('execution')
  })
  it('falls back to context', () => {
    expect(classifyRole('something.random')).toBe('context')
  })
})

describe('why-chain: summarizeEvent', () => {
  it('summarizes dry-run created events with risk + hardBlocked', () => {
    const s = summarizeEvent('voice.dry_run.created', { risk: 'medium', hardBlocked: false })
    expect(s).toMatch(/Dry-run created/i)
    expect(s).toMatch(/medium/)
  })
  it('summarizes voice intent events with kind and verdict', () => {
    const s = summarizeEvent('voice.brain.zoom', { intent: { kind: 'brain.zoom' }, plan: { verdict: 'navigate' } })
    expect(s).toMatch(/brain.zoom/)
    expect(s).toMatch(/navigate/)
  })
  it('summarizes self-heal events', () => {
    const s = summarizeEvent('runtime.self_heal.voice_session_closed', { id: 'sess-1' })
    expect(s).toMatch(/Self-heal/i)
  })
})
