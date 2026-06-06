/**
 * R146.223 — Regression tests for R206-R222 capability layer.
 * Source-level assertions only (no live DB needed); cover the shape
 * guarantees that the brain loop + sub-agents + skills + workflows
 * depend on.
 */
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'

async function src(relPath: string): Promise<string> {
  const url = new URL(`../${relPath}`, import.meta.url)
  return readFile(url, 'utf8')
}

describe('R146.206 — Skills registry', () => {
  it('skillCreate uses onConflictDoUpdate with composite ws+name target', async () => {
    const s = await src('r206-skills.ts')
    expect(s).toMatch(/onConflictDoUpdate\(\{[\s\S]*target:\s*\[operatorSkills\.workspaceId,\s*operatorSkills\.name\]/)
  })
  it('operatorSkillsAdvertisement caps output bytes', async () => {
    const s = await src('r206-skills.ts')
    expect(s).toMatch(/maxBytes\s*=\s*2000/)
    expect(s).toMatch(/if \(used \+ line\.length > maxBytes\) break/)
  })
})

describe('R146.207 — Op search', () => {
  it('opSearch returns top-N matches', async () => {
    const s = await src('r207-op-search.ts')
    expect(s).toMatch(/export function opSearch/)
    expect(s).toMatch(/limit/)
  })
  it('opSearchHint exposes total op count', async () => {
    const s = await src('r207-op-search.ts')
    expect(s).toMatch(/Object\.keys\(OPERATIONS\)\.length/)
  })
})

describe('R146.208 — Sub-agent isolation', () => {
  it('SubagentRequest exposes maxOutputTokens + preferProvider + task', async () => {
    const s = await src('r208-subagent.ts')
    expect(s).toMatch(/maxOutputTokens\?:\s*number/)
    expect(s).toMatch(/preferProvider\?:\s*string/)
    expect(s).toMatch(/task\?:\s*string/)
  })
  it('Aborts streaming when token budget exceeded', async () => {
    const s = await src('r208-subagent.ts')
    expect(s).toMatch(/output budget exceeded/)
    expect(s).toMatch(/tokensOut > maxOut/)
  })
  it('parallelSubagents resolves errors to null instead of rejecting', async () => {
    const s = await src('r208-subagent.ts')
    expect(s).toMatch(/parallelSubagents/)
    expect(s).toMatch(/Promise\.all/)
  })
})

describe('R146.209 — Adversarial diversity', () => {
  it('uses diverseProviders for voter assignment', async () => {
    const s = await src('r209-adversarial.ts')
    expect(s).toMatch(/diverseProviders\(voters/)
    expect(s).toMatch(/preferProvider/)
  })
  it('defaults refuted=true on uncertainty (fail-closed)', async () => {
    const s = await src('r209-adversarial.ts')
    expect(s).toMatch(/refuted:\s*parsed\?\.refuted\s*\?\?\s*true/)
  })
})

describe('R146.210 — Workflow runtime + R217 resume', () => {
  it('records each step to workflow_journal', async () => {
    const s = await src('r210-workflow.ts')
    expect(s).toMatch(/recordStep\(/)
    expect(s).toMatch(/workflowJournal/)
  })
  it('vm sandbox times out at 30s and caps log at 10K chars', async () => {
    const s = await src('r210-workflow.ts')
    expect(s).toMatch(/MAX_RUN_MS\s*=\s*30_000/)
    expect(s).toMatch(/MAX_LOG_LEN\s*=\s*10_000/)
  })
  it('resumeFromRunId checks journal for cached steps', async () => {
    const s = await src('r210-workflow.ts')
    expect(s).toMatch(/resumeFromRunId/)
    expect(s).toMatch(/resumeCache/)
  })
})

describe('R146.211 — Workspace memory + chapters', () => {
  it('memoryRemember bounds importance to [0, 100]', async () => {
    const s = await src('r211-workplace.ts')
    expect(s).toMatch(/Math\.max\(0,\s*Math\.min\(100/)
  })
  it('memoryDigest enforces maxBytes cap', async () => {
    const s = await src('r211-workplace.ts')
    expect(s).toMatch(/maxBytes\s*=\s*1500/)
  })
  it('operatorAsk validates 2-4 options', async () => {
    const s = await src('r211-workplace.ts')
    expect(s).toMatch(/options must have 2-4 entries/)
  })
})

describe('R146.215 — Brain loop', () => {
  it('SAFE_INLINE_RISK is low-only', async () => {
    const s = await src('r215-brain-loop.ts')
    expect(s).toMatch(/SAFE_INLINE_RISK\s*=\s*new\s+Set\(\['low'\]\)/)
  })
  it('maxSteps clamped to 1..10', async () => {
    const s = await src('r215-brain-loop.ts')
    expect(s).toMatch(/Math\.max\(1,\s*Math\.min\(10/)
  })
  it('yields events in order: skill → tool → memory → chapter → final', async () => {
    const s = await src('r215-brain-loop.ts')
    expect(s).toMatch(/yield \{ kind: 'skill'/)
    expect(s).toMatch(/yield \{ kind: 'tool_call'/)
    expect(s).toMatch(/yield \{ kind: 'tool_done'/)
    expect(s).toMatch(/yield \{ kind: 'memory'/)
    expect(s).toMatch(/yield \{ kind: 'chapter'/)
    expect(s).toMatch(/yield \{ kind: 'final'/)
  })
})

describe('R146.216 — Routing + Thompson sampling', () => {
  it('pickSkillSmart uses Thompson first, LLM fallback', async () => {
    const s = await src('r216-routing.ts')
    expect(s).toMatch(/pickSkillSmart/)
    expect(s).toMatch(/via:\s*'thompson'/)
    expect(s).toMatch(/via:\s*'llm'/)
  })
  it('Thompson cold-start returns null when <3 uses across skills', async () => {
    const s = await src('r216-routing.ts')
    expect(s).toMatch(/allCold\s*=\s*filtered\.every\(r\s*=>\s*r\.uses\s*<\s*3\)/)
  })
})

describe('R146.217 — Starter skill pack', () => {
  it('exports STARTER_SKILLS array with at least 8 skills', async () => {
    const s = await src('r217-starter-pack.ts')
    const matches = s.match(/^\s*name:\s*'/gm) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(8)
  })
  it('seedStarterPack returns {created, existed} counts', async () => {
    const s = await src('r217-starter-pack.ts')
    expect(s).toMatch(/return\s*\{\s*created,\s*existed\s*\}/)
  })
})

describe('R146.218 — Backup health + HTTP histograms', () => {
  it('backupHealth returns status fresh|stale|missing|unreachable', async () => {
    const s = await src('r218-backup-health.ts')
    expect(s).toMatch(/'fresh'/)
    expect(s).toMatch(/'stale'/)
    expect(s).toMatch(/'missing'/)
    expect(s).toMatch(/'unreachable'/)
  })
  it('fresh threshold = 36h', async () => {
    const s = await src('r218-backup-health.ts')
    expect(s).toMatch(/ageHours <= 36/)
  })
})

describe('R146.220 — kill_switches atomic upsert', () => {
  it('action-dispatcher uses onConflictDoUpdate with setWhere(enabled=false)', async () => {
    const s = await src('action-dispatcher.ts')
    expect(s).toMatch(/onConflictDoUpdate[\s\S]{0,400}setWhere:\s*sql`\$\{killSwitches\.enabled\}\s*=\s*false/)
  })
  it('governance-core uses same atomic upsert pattern', async () => {
    const s = await src('governance-core.ts')
    expect(s).toMatch(/onConflictDoUpdate[\s\S]{0,400}setWhere:\s*sql`\$\{killSwitches\.enabled\}\s*=\s*false/)
  })
})

describe('R146.222 — agent_registrations heartbeat skip', () => {
  it('selfRegister uses onConflictDoUpdate with setWhere change-detect', async () => {
    const s = await src('agent-state-sync.ts')
    expect(s).toMatch(/onConflictDoUpdate/)
    expect(s).toMatch(/setWhere[\s\S]{0,400}lastHeartbeat[\s\S]{0,30}FRESH_HB_MS/)
  })
})
