/**
 * Governance core — protected paths + autonomous intent classification.
 *
 * Pure unit tests: no DB writes. Covers the hard boundaries that prevent
 * autonomous agents from modifying the platform's own safety controls.
 */
import { describe, it, expect, vi } from 'vitest'

// db client is imported transitively by governance-core; mock it so tests
// don't require a real DATABASE_URL.
vi.mock('../db/client.js', () => ({ db: {} }))

const { classifyAutonomousAction, isProtectedPath, GOVERNANCE_DAILY_LIMITS } =
  await import('../services/governance-core.js')

describe('governance-core: protected path enforcement', () => {
  it('blocks autonomous patches to the orchestrator', () => {
    const r = isProtectedPath('/app/apps/api/src/services/autonomous-orchestrator.ts')
    expect(r.protected).toBe(true)
  })

  it('blocks autonomous patches to schema.ts', () => {
    const r = isProtectedPath('/app/packages/db/src/schema.ts')
    expect(r.protected).toBe(true)
  })

  it('blocks autonomous patches to the Dockerfile', () => {
    const r = isProtectedPath('/app/Dockerfile')
    expect(r.protected).toBe(true)
  })

  it('blocks autonomous patches to secrets-vault', () => {
    const r = isProtectedPath('/app/apps/api/src/services/secrets-vault.ts')
    expect(r.protected).toBe(true)
  })

  it('blocks autonomous patches to governance-core itself', () => {
    const r = isProtectedPath('/app/apps/api/src/services/governance-core.ts')
    expect(r.protected).toBe(true)
  })

  it('allows autonomous patches to test files', () => {
    const r = isProtectedPath('/app/apps/api/src/test/example.test.ts')
    expect(r.protected).toBe(false)
  })

  it('allows autonomous patches to a normal route file', () => {
    const r = isProtectedPath('/app/apps/api/src/routes/health.ts')
    expect(r.protected).toBe(false)
  })
})

describe('governance-core: autonomous intent classifier', () => {
  it('hard-blocks bypass_approval intent', () => {
    const r = classifyAutonomousAction('bypass_approval')
    expect(r.decision).toBe('hard_blocked')
  })

  it('hard-blocks bypass_kill_switch intent', () => {
    const r = classifyAutonomousAction('bypass_kill_switch')
    expect(r.decision).toBe('hard_blocked')
  })

  it('hard-blocks bypass_verification intent', () => {
    const r = classifyAutonomousAction('bypass_verification')
    expect(r.decision).toBe('hard_blocked')
  })

  it('hard-blocks recursive_self_modify intent', () => {
    const r = classifyAutonomousAction('recursive_self_modify')
    expect(r.decision).toBe('hard_blocked')
  })

  it('requires approval for deploy intent', () => {
    const r = classifyAutonomousAction('deploy')
    expect(r.decision).toBe('requires_approval')
  })

  it('requires approval for modify_budget intent', () => {
    const r = classifyAutonomousAction('modify_budget')
    expect(r.decision).toBe('requires_approval')
  })

  it('requires approval for modify_kill_switch intent', () => {
    const r = classifyAutonomousAction('modify_kill_switch')
    expect(r.decision).toBe('requires_approval')
  })

  it('auto-applies safe apply_patch when no protected paths touched', () => {
    const r = classifyAutonomousAction('apply_patch', { filePaths: ['/app/apps/api/src/routes/health.ts'] })
    expect(r.decision).toBe('auto_apply_ok')
  })

  it('requires approval for apply_patch when protected paths touched', () => {
    const r = classifyAutonomousAction('apply_patch', { filePaths: ['/app/apps/api/src/routes/health.ts', '/app/packages/db/src/schema.ts'] })
    expect(r.decision).toBe('requires_approval')
    expect(r.reason).toContain('protected path')
  })
})

describe('governance-core: daily limits exported', () => {
  it('exports sane default daily limits', () => {
    expect(GOVERNANCE_DAILY_LIMITS.maxAutonomousPatches).toBeGreaterThan(0)
    expect(GOVERNANCE_DAILY_LIMITS.maxDeployments).toBeGreaterThan(0)
    expect(GOVERNANCE_DAILY_LIMITS.maxDeployments).toBeLessThan(GOVERNANCE_DAILY_LIMITS.maxAutonomousPatches)
  })
})
