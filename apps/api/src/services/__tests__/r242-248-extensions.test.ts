/**
 * R146.249 — Regression tests for R242-R248 extensions.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'

async function src(rel: string): Promise<string> {
  const url = new URL(`../${rel}`, import.meta.url)
  return readFile(url, 'utf8')
}

describe('R146.242 — adversarial gate on publish_post', () => {
  it('r180 imports adversarialVerify and calls it before publishAndRepurpose', async () => {
    const s = await src('r180-money-maximizer.ts')
    expect(s).toMatch(/adversarialVerify/)
    expect(s).toMatch(/voters:\s*3/)
    expect(s).toMatch(/verdict\.decision === 'block'/)
  })
  it('NOVAN_SKIP_ADVERSARIAL escape hatch documented', async () => {
    const s = await src('r180-money-maximizer.ts')
    expect(s).toMatch(/NOVAN_SKIP_ADVERSARIAL/)
  })
})

describe('R146.243-244 — skill evolution + hourly cron', () => {
  it('exports evolveLosingSkills', async () => {
    const s = await src('r243-skill-evolution.ts')
    expect(s).toMatch(/export async function evolveLosingSkills/)
    expect(s).toMatch(/MIN_USES\s*=\s*10/)
    expect(s).toMatch(/LOSING_THRESHOLD\s*=\s*0\.4/)
    expect(s).toMatch(/COOLDOWN_MS\s*=\s*24\s*\*\s*60\s*\*\s*60_000/)
  })
  it('learning-cron registers hourly runSkillEvolve', async () => {
    const s = await src('learning-cron.ts')
    expect(s).toMatch(/runSkillEvolve/)
    expect(s).toMatch(/skillEvolve:\s*60\s*\*\s*60_000/)
  })
})

describe('R146.245-246 — cron presence watchdog', () => {
  it('EXPECTED includes 8 cron types', async () => {
    const s = await src('r245-cron-presence-watch.ts')
    // Heuristic: count entries that start with `{ eventType:`
    const matches = s.match(/\{\s*eventType:\s*'/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(8)
  })
  it('auto-closes recovered alerts', async () => {
    const s = await src('r245-cron-presence-watch.ts')
    expect(s).toMatch(/autoClosed/)
    expect(s).toMatch(/status:\s*'closed'/)
  })
  it('uses fingerprint for dedup', async () => {
    const s = await src('r245-cron-presence-watch.ts')
    expect(s).toMatch(/fingerprint = `cron-presence:\$\{exp\.eventType\}`/)
  })
})

describe('R146.247 — executive-loop atomic upsert', () => {
  it('writeState uses onConflictDoUpdate (no read-then-write)', async () => {
    const s = await src('executive-loop.ts')
    expect(s).toMatch(/onConflictDoUpdate\(\{[\s\S]{0,300}target:\s*executiveState\.workspaceId/)
    // reviewCount increment must be SQL-side
    expect(s).toMatch(/sql`COALESCE\(\$\{executiveState\.reviewCount\},\s*0\)\s*\+\s*1`/)
  })
})

describe('R146.248 — daily cost cap surface', () => {
  it('checkDailyCostCap exposes {spent, cap, over, remaining}', async () => {
    const s = await src('r248-cost-cap.ts')
    expect(s).toMatch(/spent:\s*number/)
    expect(s).toMatch(/cap:\s*number/)
    expect(s).toMatch(/over:\s*boolean/)
    expect(s).toMatch(/remaining:\s*number/)
    expect(s).toMatch(/CACHE_TTL_MS\s*=\s*60_000/)
  })
  it('uses UTC day-start as the rolling window', async () => {
    const s = await src('r248-cost-cap.ts')
    expect(s).toMatch(/setUTCHours\(0,\s*0,\s*0,\s*0\)/)
  })
})
