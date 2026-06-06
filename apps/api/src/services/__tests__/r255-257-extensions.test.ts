/**
 * R146.258 — Regression tests for R255-R257.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'

async function src(rel: string): Promise<string> {
  const url = new URL(`../${rel}`, import.meta.url)
  return readFile(url, 'utf8')
}

describe('R146.255 — brain.health state-change alert tick', () => {
  it('reads prior state from workspace_memory before emitting', async () => {
    const s = await src('r255-brain-alert-tick.ts')
    expect(s).toMatch(/STATE_KEY = '_brainHealthState'/)
    expect(s).toMatch(/async function readPrev/)
  })
  it('only emits on state change (no spam)', async () => {
    const s = await src('r255-brain-alert-tick.ts')
    expect(s).toMatch(/if \(prev !== snap\.overall\)/)
  })
  it('emits three distinct event types with the right transitions', async () => {
    const s = await src('r255-brain-alert-tick.ts')
    expect(s).toMatch(/'brain\.critical'/)
    expect(s).toMatch(/'brain\.degraded'/)
    expect(s).toMatch(/'brain\.healthy'/)
    // recovered: requires prev !== null so we don't fire on first-ever run
    expect(s).toMatch(/else if \(prev !== null\)\s+emitted = 'brain\.healthy'/)
  })
  it('persists state with importance=90 so wmDecay treats it as promoted', async () => {
    const s = await src('r255-brain-alert-tick.ts')
    expect(s).toMatch(/importance: 90/)
    expect(s).toMatch(/scope: 'system'/)
  })
})

describe('R146.256 — heartbeat into cron presence watchdog', () => {
  it('R245 includes cron.brain_alert_heartbeat in EXPECTED', async () => {
    const s = await src('r245-cron-presence-watch.ts')
    expect(s).toMatch(/cron\.brain_alert_heartbeat/)
    expect(s).toMatch(/maxAgeMs: 45 \* 60_000/)
  })
  it('learning-cron emits heartbeat unconditionally each run', async () => {
    const s = await src('learning-cron.ts')
    // unconditional emit (not gated by emitted > 0)
    const wrap = s.match(/runBrainAlertTick[\s\S]{0,1200}/)?.[0] ?? ''
    expect(wrap).toMatch(/await emit\('cron\.brain_alert_heartbeat'/)
    expect(wrap).toMatch(/if \(emitted > 0\) await emit\('cron\.brain_alert_completed'/)
  })
})

describe('R146.257 — default event hook seeding', () => {
  it('seeds brain.critical and brain.degraded → issue.create', async () => {
    const s = await src('r257-seed-default-hooks.ts')
    expect(s).toMatch(/eventPattern: 'brain\.critical'/)
    expect(s).toMatch(/eventPattern: 'brain\.degraded'/)
    expect(s).toMatch(/opName: 'issue\.create'/)
  })
  it('uses atomic onConflictDoNothing on (workspaceId, name)', async () => {
    const s = await src('r257-seed-default-hooks.ts')
    expect(s).toMatch(/onConflictDoNothing\(\{[\s\S]{0,200}target:\s*\[eventHooks\.workspaceId,\s*eventHooks\.name\]/)
  })
  it('returns counted result {created, skipped}', async () => {
    const s = await src('r257-seed-default-hooks.ts')
    expect(s).toMatch(/created\+\+|skipped\+\+/)
    expect(s).toMatch(/SeedResult/)
  })
})
