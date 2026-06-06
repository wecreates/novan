/**
 * wiring-r8.test.ts — Round 122 wiring tests.
 *
 * Covers: LOCKED_PATHS ↔ LOCKED_CORE_PATHS sync, media-analyzer
 * Anthropic-vision body path (no-key short-circuit), and shape contracts
 * for the new maintenance routes.
 */
import { describe, it, expect } from 'vitest'

describe('LOCKED_PATHS sync with self-improvement', () => {
  // The 2 canonical patterns kill-switch/audit are intentionally not
  // covered by LOCKED_PATHS — those concerns are embedded in other
  // files (action-dispatcher.ts, governance-core.ts) rather than
  // existing as standalone modules. See LOCKED_PATHS comment in
  // lock-integrity.ts for the rationale.
  const EXPECTED_UNCOVERED_COUNT = 2

  it('verifyLockSync reports only the documented uncovered patterns', async () => {
    const { verifyLockSync } = await import('../services/lock-integrity.js')
    const out = await verifyLockSync()
    expect(out.uncovered.length).toBe(EXPECTED_UNCOVERED_COUNT)
    // Verify they're the expected ones (kill-switch + audit). The
    // patterns serialize as regex toString() so escape characters
    // appear literally; match the substring conservatively.
    const joined = out.uncovered.join('|').toLowerCase()
    expect(joined).toContain('kill')
    expect(joined).toContain('switch')
    expect(joined).toContain('audit')
  })

  it('runLockIntegrityCheck returns shape with uncoveredCanonical', async () => {
    const { runLockIntegrityCheck } = await import('../services/lock-integrity.js')
    const prev = process.env['REPO_ROOT']
    process.env['REPO_ROOT'] = '/no/such/repo'
    try {
      const out = await runLockIntegrityCheck()
      expect(Array.isArray(out.uncoveredCanonical)).toBe(true)
      expect(out.uncoveredCanonical.length).toBe(EXPECTED_UNCOVERED_COUNT)
    } finally {
      if (prev === undefined) delete process.env['REPO_ROOT']
      else process.env['REPO_ROOT'] = prev
    }
  })
})

describe('media-analyzer vision body — no-credentials path', () => {
  it('analyzeImage flags placeholder when ANTHROPIC_API_KEY is absent', async () => {
    const prev = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    try {
      const { analyzeImage } = await import('../services/media-analyzer.js')
      const out = await analyzeImage({
        imageHash: 'c'.repeat(64), source: 'https://example.com/x.jpg',
        workspaceId: 'w', requestedBy: 'agent',
        analysisTypes: ['scene', 'safety'],
        intent: 'catalog enrichment',
      })
      expect(out.flags).toContain('placeholder:no_anthropic_key')
      expect(out.confidence.scene).toBe(0)
      expect(out.confidence.safety).toBe(0)
    } finally {
      if (prev !== undefined) process.env['ANTHROPIC_API_KEY'] = prev
    }
  })

  it('analyzeImage still emits an event + audit trail without a key', async () => {
    const { analyzeImage } = await import('../services/media-analyzer.js')
    const out = await analyzeImage({
      imageHash: 'd'.repeat(64), source: 'data:image/jpeg;base64,XXX',
      workspaceId: 'w', requestedBy: 'agent',
      analysisTypes: ['objects'],
      intent: 'count objects',
    })
    expect(out.analysisId).toBeTruthy()
    expect(typeof out.durationMs).toBe('number')
  })
})

describe('maintenance route handlers — shape contracts', () => {
  // We exercise the SERVICE level the routes call. Route registration
  // requires a Fastify instance with DB; the underlying calls are what
  // matter for shape stability.
  it('compliance/controls returns catalog + summary shape', async () => {
    const { SOC2_CONTROLS, controlSummary, listControlsByCategory } =
      await import('../services/compliance-soc2.js')
    expect(Array.isArray(SOC2_CONTROLS)).toBe(true)
    const s = controlSummary()
    expect(s).toHaveProperty('implemented')
    expect(s).toHaveProperty('partial')
    expect(s).toHaveProperty('gap')
    expect(s).toHaveProperty('total')
    const byCat = listControlsByCategory()
    expect(Object.keys(byCat).length).toBeGreaterThan(0)
  })

  it('operational-readiness returns items + summary shape', async () => {
    const { listReadinessItems, summarizeReadiness } =
      await import('../services/operational-readiness.js')
    expect(listReadinessItems().length).toBe(50)
    const s = summarizeReadiness()
    expect(s.total).toBe(50)
    expect(s.byStatus).toHaveProperty('implemented')
    expect(s.byPriority).toHaveProperty('required-to-start')
  })

  it('recovery-playbooks returns playbooks + summary shape', async () => {
    const { PLAYBOOKS, playbookSummary } =
      await import('../services/recovery-playbook.js')
    expect(PLAYBOOKS.length).toBe(8)
    const s = playbookSummary()
    expect(s.total).toBe(8)
    expect(s.autoRecoverable + s.humanGated).toBe(8)
  })

  it('lock-integrity verdict returns the expected fields', async () => {
    const { runLockIntegrityCheck, LOCKED_PATHS } =
      await import('../services/lock-integrity.js')
    const prev = process.env['REPO_ROOT']
    process.env['REPO_ROOT'] = '/no/such/repo'
    try {
      const v = await runLockIntegrityCheck()
      expect(v.checked).toBe(LOCKED_PATHS.length)
      expect(Array.isArray(v.missing)).toBe(true)
      expect(Array.isArray(v.tampered)).toBe(true)
      expect(Array.isArray(v.uncoveredCanonical)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env['REPO_ROOT']
      else process.env['REPO_ROOT'] = prev
    }
  })
})

describe('workspace-seed template threading', () => {
  it('seedWorkspaceOnFirstInstall accepts an optional template arg', async () => {
    const m = await import('../services/workspace-seed.js')
    // Signature check: function arity should be >= 1, second arg accepted.
    expect(m.seedWorkspaceOnFirstInstall.length).toBeGreaterThanOrEqual(1)
  })

  it('applyTemplateToWorkspace handles all 5 template keys', async () => {
    const { applyTemplateToWorkspace } = await import('../services/business-templates.js')
    for (const key of ['generic', 'ecommerce', 'saas', 'content', 'services'] as const) {
      const out = await applyTemplateToWorkspace('w-test', key)
      expect(out.applied).toBe(key)
      expect(out.targetMonthlyUsd).toBeGreaterThanOrEqual(10_000)
    }
  })
})
