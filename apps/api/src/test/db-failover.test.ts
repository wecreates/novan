/**
 * Tests for db-failover (#1) — pure state derivation.
 * Probes themselves are not tested (would require a live DB);
 * the state machine is what determines what the operator sees.
 */
import { describe, it, expect } from 'vitest'
import { deriveState, type ProbeResult } from '../services/db-failover.js'

const probe = (over: Partial<ProbeResult>): ProbeResult => ({
  role: 'primary', status: 'healthy', latencyMs: 50,
  error: null, probedAt: 1, ...over,
})

describe('db-failover: deriveState', () => {
  it('both healthy with replica → normal', () => {
    const s = deriveState(
      probe({ role: 'primary' }),
      probe({ role: 'replica' }),
      { primary: 0, replica: 0 },
    )
    expect(s.recommendation).toBe('normal')
  })

  it('primary healthy + no replica → replica_unconfigured', () => {
    const s = deriveState(probe({ role: 'primary' }), null, { primary: 0, replica: 0 })
    expect(s.recommendation).toBe('replica_unconfigured')
    expect(s.reason).toMatch(/replica/i)
  })

  it('primary failed + replica healthy → consider_failover', () => {
    const s = deriveState(
      probe({ role: 'primary', status: 'failed', error: 'ECONNREFUSED' }),
      probe({ role: 'replica' }),
      { primary: 2, replica: 0 },
    )
    expect(s.recommendation).toBe('consider_failover')
    expect(s.reason).toMatch(/2 consecutive/)
  })

  it('primary failed + replica failed → both_down', () => {
    const s = deriveState(
      probe({ role: 'primary', status: 'failed' }),
      probe({ role: 'replica', status: 'failed' }),
      { primary: 3, replica: 3 },
    )
    expect(s.recommendation).toBe('both_down')
  })

  it('primary degraded ≥3 probes → watch_primary', () => {
    const s = deriveState(
      probe({ role: 'primary', status: 'degraded', latencyMs: 2500 }),
      probe({ role: 'replica' }),
      { primary: 4, replica: 0 },
    )
    expect(s.recommendation).toBe('watch_primary')
  })

  it('primary degraded with <3 fails stays normal', () => {
    const s = deriveState(
      probe({ role: 'primary', status: 'degraded' }),
      probe({ role: 'replica' }),
      { primary: 1, replica: 0 },
    )
    expect(s.recommendation).toBe('normal')
  })

  it('primary failed + no replica → both_down (no alternative)', () => {
    const s = deriveState(
      probe({ role: 'primary', status: 'failed' }),
      null,
      { primary: 3, replica: 0 },
    )
    expect(s.recommendation).toBe('both_down')
  })

  it('reason field is always non-empty', () => {
    for (const status of ['healthy', 'degraded', 'failed', 'unknown'] as const) {
      const s = deriveState(probe({ status }), null, { primary: 0, replica: 0 })
      expect(s.reason.length).toBeGreaterThan(0)
    }
  })

  it('updatedAt is current', () => {
    const before = Date.now()
    const s = deriveState(probe({}), null, { primary: 0, replica: 0 })
    expect(s.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('preserves the original probe results in the response', () => {
    const p = probe({ role: 'primary', latencyMs: 123 })
    const r = probe({ role: 'replica', latencyMs: 456 })
    const s = deriveState(p, r, { primary: 0, replica: 0 })
    expect(s.primary.latencyMs).toBe(123)
    expect(s.replica?.latencyMs).toBe(456)
  })
})
