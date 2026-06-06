/**
 * R146.239 — Regression tests for R223-R238 extensions.
 * Source-level assertions guarding the invariants this session relies on.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'

async function src(relPath: string): Promise<string> {
  const url = new URL(`../${relPath}`, import.meta.url)
  return readFile(url, 'utf8')
}

describe('R146.217+R146.235 — Starter skill pack', () => {
  it('starter pack has ≥12 skills after R235 expansion', async () => {
    const s = await src('r217-starter-pack.ts')
    const matches = s.match(/^\s*name:\s*'/gm) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(12)
  })
  it('every starter skill has whenToUse + instructions fields', async () => {
    const s = await src('r217-starter-pack.ts')
    const skillCount = (s.match(/^\s*name:\s*'/gm) ?? []).length
    const whenToUseCount = (s.match(/whenToUse:\s*['`]/g) ?? []).length
    const instructionsCount = (s.match(/instructions:\s*[`']/g) ?? []).length
    expect(whenToUseCount).toBe(skillCount)
    expect(instructionsCount).toBe(skillCount)
  })
})

describe('R146.218 — HTTP histogram + backup health', () => {
  it('metrics.ts exposes observeHistogram', async () => {
    const s = await src('metrics.ts')
    expect(s).toMatch(/export function observeHistogram/)
    expect(s).toMatch(/DEFAULT_BUCKETS_MS/)
  })
  it('server.ts has onResponse hook measuring elapsedMs', async () => {
    const s = await src('../server.ts')
    expect(s).toMatch(/elapsedMs.*hrtime/)
    expect(s).toMatch(/http_request_duration_ms/)
  })
  it('platform.status includes backup field', async () => {
    const s = await src('r196-quickstart.ts')
    expect(s).toMatch(/backup:\s*\{\s*status:\s*string/)
  })
})

describe('R146.222 — Migration 0115 unique idx exists', () => {
  it('agent_registrations_ws_name_uniq migration created', async () => {
    const url = new URL('../../../../../packages/db/migrations/0115_agent_registrations_uniq.sql', import.meta.url)
    const sql = await readFile(url, 'utf8')
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS agent_registrations_ws_name_uniq/)
  })
})

describe('R146.224 — hook dispatch from learning-cron emit', () => {
  it('emit() calls hookDispatch fire-and-forget', async () => {
    const s = await src('learning-cron.ts')
    expect(s).toMatch(/hookDispatch\('global',\s*type/)
  })
})

describe('R146.226 — capability-layer retention prune', () => {
  it('runEventsPrune deletes from new capability tables', async () => {
    const s = await src('learning-cron.ts')
    expect(s).toMatch(/DELETE FROM subagent_runs/)
    expect(s).toMatch(/DELETE FROM workflow_journal/)
    expect(s).toMatch(/DELETE FROM skill_outcomes/)
    expect(s).toMatch(/DELETE FROM adversarial_verdicts/)
  })
})

describe('R146.227 — NL schedule cron tick', () => {
  it('learning-cron registers runNlSchedules', async () => {
    const s = await src('learning-cron.ts')
    expect(s).toMatch(/runNlSchedules/)
    expect(s).toMatch(/nlSchedules:\s*60_000/)
  })
})

describe('R146.230 — drift_warnings TOCTOU fix', () => {
  it('migration 0116 creates partial unique indexes', async () => {
    const url = new URL('../../../../../packages/db/migrations/0116_drift_warnings_partial_uniq.sql', import.meta.url)
    const sql = await readFile(url, 'utf8')
    expect(sql).toMatch(/drift_warnings_open_with_subject_uniq/)
    expect(sql).toMatch(/drift_warnings_open_no_subject_uniq/)
    expect(sql).toMatch(/WHERE status IN \('open', 'acknowledged'\)/)
  })
  it('dedupedWarn uses onConflictDoNothing + returning', async () => {
    const s = await src('drift-detector.ts')
    expect(s).toMatch(/onConflictDoNothing\(\)[\s\S]{0,200}\.returning/)
  })
})

describe('R146.231 — applier health surface', () => {
  it('exposes ApplierHealth with 4 statuses', async () => {
    const s = await src('r231-applier-health.ts')
    expect(s).toMatch(/'alive'/)
    expect(s).toMatch(/'stale'/)
    expect(s).toMatch(/'unwired'/)
    expect(s).toMatch(/'never'/)
    expect(s).toMatch(/STALE_MS\s*=\s*10\s*\*\s*60_000/)
  })
})

describe('R146.232 — applier daemon emits heartbeat', () => {
  it('script writes applier.cycle event', async () => {
    const url = new URL('../../../../../scripts/novan-self-dev-applier.mjs', import.meta.url)
    const src = await readFile(url, 'utf8')
    expect(src).toMatch(/emitHeartbeat/)
    expect(src).toMatch(/applier\.cycle/)
  })
})

describe('R146.236 — capability smoke', () => {
  it('exercises ≥15 ops + cleans synthetic writes', async () => {
    const s = await src('r236-capability-smoke.ts')
    const probes = (s.match(/\{\s*op:\s*'/g) ?? []).length
    expect(probes).toBeGreaterThanOrEqual(15)
    expect(s).toMatch(/db\.delete\(operatorSkills\)/)
    expect(s).toMatch(/db\.delete\(workspaceMemory\)/)
  })
})

describe('R146.238 — unknown-op suggestion', () => {
  it('brain-loop runOp calls opSearch on unknown', async () => {
    const s = await src('r215-brain-loop.ts')
    expect(s).toMatch(/opSearch\(op,\s*3\)/)
    expect(s).toMatch(/did you mean/)
  })
})
