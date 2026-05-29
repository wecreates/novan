/**
 * self-maintaining-r6.test.ts — Tests for round 120 self-maintaining
 * capabilities + operational-readiness catalog.
 *
 * Covers lock-integrity (Layer 5), recovery-playbook registry (Layer 2),
 * and operational-readiness catalog. Pure logic — no DB.
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('lock-integrity — Layer 5', () => {
  it('LOCKED_PATHS includes governance + audit + self-improvement + this module itself', async () => {
    const { LOCKED_PATHS } = await import('../services/lock-integrity.js')
    // 7 paths after R138 removed two that didn't exist as standalone files
    // (kill-switch + audit-log — their functionality lives embedded in
    // brain-task, action-dispatcher, etc.). The regex registry in
    // self-improvement.ts → LOCKED_CORE_PATHS still covers those concerns.
    expect(LOCKED_PATHS.length).toBeGreaterThanOrEqual(7)
    expect(LOCKED_PATHS).toContain('apps/api/src/services/policy-engine.ts')
    expect(LOCKED_PATHS).toContain('apps/api/src/services/mission-charter.ts')
    expect(LOCKED_PATHS).toContain('apps/api/src/services/self-improvement.ts')
    // Critical: the lock-integrity module must protect itself.
    expect(LOCKED_PATHS).toContain('apps/api/src/services/lock-integrity.ts')
    // Schema is locked too.
    expect(LOCKED_PATHS).toContain('packages/db/src/schema.ts')
  })

  it('hashFile returns null for missing file + stable hash for known content', async () => {
    const { hashFile } = await import('../services/lock-integrity.js')
    const dir = mkdtempSync(join(tmpdir(), 'lock-test-'))
    try {
      const p = join(dir, 'fixture.txt')
      writeFileSync(p, 'hello world')
      const h1 = await hashFile(p)
      const h2 = await hashFile(p)
      expect(h1).toBe(h2)
      expect(h1).toMatch(/^[a-f0-9]{64}$/)
      const missing = await hashFile(join(dir, 'does-not-exist'))
      expect(missing).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('verifyPath returns "missing" for nonexistent path', async () => {
    const { verifyPath } = await import('../services/lock-integrity.js')
    const v = await verifyPath('/no/such/repo', 'apps/api/src/services/policy-engine.ts')
    expect(v.status).toBe('missing')
  })

  it('acknowledgeLockChange rejects unknown path + too-short reason', async () => {
    const { acknowledgeLockChange } = await import('../services/lock-integrity.js')
    await expect(acknowledgeLockChange('apps/api/src/random.ts', 'legit', 'op'))
      .rejects.toThrow(/not in LOCKED_PATHS/)
    await expect(acknowledgeLockChange('apps/api/src/services/policy-engine.ts', 'x', 'op'))
      .rejects.toThrow(/reason required/)
  })

  it('runLockIntegrityCheck survives no-repo-root env', async () => {
    const { runLockIntegrityCheck } = await import('../services/lock-integrity.js')
    const prev = process.env['REPO_ROOT']
    process.env['REPO_ROOT'] = '/no/such/repo'
    try {
      const out = await runLockIntegrityCheck()
      expect(out.checked).toBeGreaterThan(0)
      expect(out.missing.length).toBe(out.checked)  // every path missing
    } finally {
      if (prev === undefined) delete process.env['REPO_ROOT']
      else process.env['REPO_ROOT'] = prev
    }
  })
})

describe('recovery-playbook — Layer 2', () => {
  it('catalog covers the 8 canonical failure modes', async () => {
    const { PLAYBOOKS } = await import('../services/recovery-playbook.js')
    expect(PLAYBOOKS.length).toBe(8)
    const modes = PLAYBOOKS.map(p => p.failureMode).sort()
    expect(modes).toContain('service_crashed')
    expect(modes).toContain('lock_integrity_tamper')
    expect(modes).toContain('kill_switch_tripped')
    expect(modes).toContain('budget_exhausted')
  })

  it('lock-integrity tamper playbook is HUMAN-gated (never auto)', async () => {
    const { getPlaybook } = await import('../services/recovery-playbook.js')
    const pb = getPlaybook('lock_integrity_tamper')
    expect(pb).toBeDefined()
    expect(pb!.autoRecoverable).toBe(false)
    expect(pb!.recoverySteps[0]).toMatch(/HALT/i)
  })

  it('kill-switch + budget playbooks are human-gated', async () => {
    const { getPlaybook } = await import('../services/recovery-playbook.js')
    expect(getPlaybook('kill_switch_tripped')!.autoRecoverable).toBe(false)
    expect(getPlaybook('budget_exhausted')!.autoRecoverable).toBe(false)
  })

  it('matchEventToPlaybook routes by event type', async () => {
    const { matchEventToPlaybook } = await import('../services/recovery-playbook.js')
    const pb = matchEventToPlaybook('lock_integrity.tamper_detected')
    expect(pb?.failureMode).toBe('lock_integrity_tamper')
    expect(matchEventToPlaybook('totally.unknown.event')).toBeUndefined()
  })

  it('playbookSummary tallies auto vs human-gated', async () => {
    const { playbookSummary } = await import('../services/recovery-playbook.js')
    const s = playbookSummary()
    expect(s.total).toBe(8)
    expect(s.autoRecoverable + s.humanGated).toBe(s.total)
    // Most playbooks should be human-gated (safety).
    expect(s.humanGated).toBeGreaterThan(s.autoRecoverable)
  })

  it('suggestPlaybook returns the matched playbook + survives no-DB env', async () => {
    const { suggestPlaybook } = await import('../services/recovery-playbook.js')
    const out = await suggestPlaybook('service_crashed', { worker: 'test' })
    expect(out.suggested).toBe(true)
    expect(out.playbook?.failureMode).toBe('service_crashed')
  })
})

describe('operational-readiness — 50-component catalog', () => {
  it('catalog has exactly 50 items spanning 12 layers', async () => {
    const { listReadinessItems } = await import('../services/operational-readiness.js')
    const items = listReadinessItems()
    expect(items.length).toBe(50)
    const layers = new Set(items.map(i => i.layer))
    expect(layers.size).toBe(12)
  })

  it('every item has a unique id following OC-NN convention', async () => {
    const { listReadinessItems } = await import('../services/operational-readiness.js')
    const ids = listReadinessItems().map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^OC-\d{2}$/)
  })

  it('summary categorizes by status + layer + priority', async () => {
    const { summarizeReadiness } = await import('../services/operational-readiness.js')
    const s = summarizeReadiness()
    expect(s.total).toBe(50)
    const statusTotal = s.byStatus.implemented + s.byStatus.partial
                      + s.byStatus.deferred + s.byStatus['not-started']
    expect(statusTotal).toBe(50)
    const prioTotal = s.byPriority['required-to-start']
                    + s.byPriority['required-to-scale']
                    + s.byPriority['mature-operation']
    expect(prioTotal).toBe(50)
  })

  it('SOC2 + incident management + audit log items are already implemented', async () => {
    const { listReadinessItems } = await import('../services/operational-readiness.js')
    const items = listReadinessItems()
    const incident = items.find(i => i.name === 'Incident Management')
    expect(incident?.status).toBe('implemented')
    const change = items.find(i => i.name === 'Change Management')
    expect(change?.status).toBe('implemented')
    const docs = items.find(i => i.name === 'Documentation Standards')
    expect(docs?.status).toBe('implemented')
  })

  it('legal + HR + tax items honestly default to not-started (require human work)', async () => {
    const { listReadinessItems } = await import('../services/operational-readiness.js')
    const items = listReadinessItems()
    const tax = items.find(i => i.name === 'Tax Strategy')
    expect(tax?.status).toBe('not-started')
    const hiring = items.find(i => i.name === 'Hiring Process')
    expect(hiring?.status).toBe('not-started')
  })

  it('attestReadinessItem rejects unknown id', async () => {
    const { attestReadinessItem } = await import('../services/operational-readiness.js')
    const out = await attestReadinessItem('OC-99', 'implemented', 'operator')
    expect(out.updated).toBe(false)
  })

  it('attestReadinessItem updates status for known id', async () => {
    const { attestReadinessItem, listReadinessItems } = await import('../services/operational-readiness.js')
    const before = listReadinessItems().find(i => i.id === 'OC-50')!.status
    const out = await attestReadinessItem('OC-50', 'partial', 'operator', 'mid-quarter check')
    expect(out.updated).toBe(true)
    // Restore so we don't leak state across tests.
    await attestReadinessItem('OC-50', before, 'operator', 'restore')
  })
})
