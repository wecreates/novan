/**
 * R146.254 — Regression tests for R250-R253.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'

async function src(rel: string): Promise<string> {
  const url = new URL(`../${rel}`, import.meta.url)
  return readFile(url, 'utf8')
}

describe('R146.250 — brain-loop cost cap gate', () => {
  it('runBrainLoop calls checkDailyCostCap before any other work', async () => {
    const s = await src('r215-brain-loop.ts')
    expect(s).toMatch(/import \{ checkDailyCostCap \} from '\.\/r248-cost-cap\.js'/)
    // The gate must come before the skill pick (which spawns a subagent and costs money)
    const gateIdx = s.indexOf('checkDailyCostCap')
    const skillIdx = s.indexOf('1. Skill auto-pick')
    expect(gateIdx).toBeGreaterThan(0)
    expect(skillIdx).toBeGreaterThan(gateIdx)
  })
  it('yields final + returns on over-cap (no further LLM calls)', async () => {
    const s = await src('r215-brain-loop.ts')
    expect(s).toMatch(/if \(cap\?\.over\) \{[\s\S]{0,500}yield \{ kind: 'final'/)
    expect(s).toMatch(/daily AI budget exhausted/)
  })
})

describe('R146.251 — adversarial cost cap gate', () => {
  it('adversarialVerify fail-closes on over-cap', async () => {
    const s = await src('r209-adversarial.ts')
    expect(s).toMatch(/import \{ checkDailyCostCap \} from '\.\/r248-cost-cap\.js'/)
    expect(s).toMatch(/if \(cap\?\.over\) \{[\s\S]{0,800}decision: 'block'/)
    expect(s).toMatch(/blocked fail-closed/)
  })
  it('persists the blocked verdict for audit trail', async () => {
    const s = await src('r209-adversarial.ts')
    // The over-cap branch must still insert into adversarialVerdicts
    const overCapBranch = s.split('cap?.over')[1]?.split('return { id')[0] ?? ''
    expect(overCapBranch).toMatch(/db\.insert\(adversarialVerdicts\)/)
  })
})

describe('R146.252 — workspace memory decay', () => {
  it('decay step + grace + prune thresholds are sensible', async () => {
    const s = await src('r252-memory-decay.ts')
    expect(s).toMatch(/DECAY_AGE_MS\s*=\s*7\s*\*\s*24/)
    expect(s).toMatch(/DECAY_STEP\s*=\s*5/)
    expect(s).toMatch(/PROMOTED_FLOOR\s*=\s*80/)
    expect(s).toMatch(/PRUNE_THRESHOLD\s*=\s*5/)
  })
  it('promoted rows (importance >= 80) are exempt from decay', async () => {
    const s = await src('r252-memory-decay.ts')
    expect(s).toMatch(/importance < \$\{PROMOTED_FLOOR\}/)
  })
  it('atomic single UPDATE + single DELETE (no read-then-write)', async () => {
    const s = await src('r252-memory-decay.ts')
    expect(s).toMatch(/db\.execute\(sql`\s*UPDATE workspace_memory/)
    expect(s).toMatch(/db\.delete\(workspaceMemory\)/)
  })
  it('wired into learning-cron as daily wmDecay tick', async () => {
    const s = await src('learning-cron.ts')
    expect(s).toMatch(/wmDecay:\s*24 \* 60 \* 60_000/)
    expect(s).toMatch(/runWmDecaySweep/)
  })
})

describe('R146.253 — brain.health unified op', () => {
  it('aggregates 6 subsystems in a single Promise.all', async () => {
    const s = await src('r253-brain-health.ts')
    expect(s).toMatch(/await Promise\.all\(/)
    expect(s).toMatch(/checkDailyCostCap/)
    expect(s).toMatch(/backupHealth/)
    expect(s).toMatch(/applierHealth/)
    expect(s).toMatch(/checkCronPresence/)
  })
  it('overall classification has 3 tiers with the right gates', async () => {
    const s = await src('r253-brain-health.ts')
    expect(s).toMatch(/overall: Health = 'healthy'/)
    expect(s).toMatch(/'critical'/)
    expect(s).toMatch(/'degraded'/)
    // Critical iff cost.over OR backup missing OR applier never
    expect(s).toMatch(/c\.over \|\| b\.status === 'missing' \|\| a\.status === 'never'/)
  })
  it('each subsystem fetch is .catch-guarded so one outage cannot throw the snapshot', async () => {
    const s = await src('r253-brain-health.ts')
    const catchCount = (s.match(/\.catch\(\(\)\s*=>\s*(null|\[\]|0)\)/g) ?? []).length
    expect(catchCount).toBeGreaterThanOrEqual(6)
  })
})
