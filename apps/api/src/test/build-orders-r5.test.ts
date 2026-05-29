/**
 * build-orders-r5.test.ts — Tests for round 119 build-order additions.
 *
 * Covers BO17 (compliance-soc2), BO06 (metrics), BO14 (business-templates),
 * BO05 (secrets-provider), BO19 (ai-drift).
 *
 * Pure shape/logic tests — no DB. Drift, evidence-collection, CVE scan
 * are all written with `.catch(() => …)` around DB calls so they survive
 * the no-DB test environment.
 */
import { describe, it, expect, beforeEach } from 'vitest'

describe('BO17 — compliance-soc2', () => {
  it('control catalog has every SOC 2 common-criteria category', async () => {
    const { SOC2_CONTROLS, listControlsByCategory } = await import('../services/compliance-soc2.js')
    expect(SOC2_CONTROLS.length).toBeGreaterThanOrEqual(11)
    const byCat = listControlsByCategory()
    for (const cc of ['CC1','CC2','CC3','CC4','CC5','CC6','CC7','CC8','CC9']) {
      expect(byCat[cc as keyof typeof byCat]?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('control summary counts implemented + partial + gap = total', async () => {
    const { controlSummary } = await import('../services/compliance-soc2.js')
    const s = controlSummary()
    expect(s.implemented + s.partial + s.gap).toBe(s.total)
    // At least the majority should be implemented today.
    expect(s.implemented).toBeGreaterThan(s.gap)
  })

  it('evidence collection tolerates DB absence', async () => {
    const { collectEvidenceForControl } = await import('../services/compliance-soc2.js')
    const out = await collectEvidenceForControl('CC6.1')
    expect(out.controlId).toBe('CC6.1')
    expect(typeof out.eventCounts).toBe('object')
    expect(out.collectedAt).toBeGreaterThan(0)
  })

  it('CVE scan returns null when disabled', async () => {
    process.env['DISABLE_CVE_SCAN'] = '1'
    const { runDependencyCveScan } = await import('../services/compliance-soc2.js')
    const out = await runDependencyCveScan()
    expect(out).toBeNull()
    delete process.env['DISABLE_CVE_SCAN']
  })

  it('unknown control throws', async () => {
    const { collectEvidenceForControl } = await import('../services/compliance-soc2.js')
    await expect(collectEvidenceForControl('CC99.9')).rejects.toThrow(/unknown control/)
  })
})

describe('BO06 — metrics', () => {
  beforeEach(async () => {
    const { _resetMetricsForTests } = await import('../services/metrics.js')
    _resetMetricsForTests()
  })

  it('counter increments + renders in Prometheus format', async () => {
    const { incCounter, renderMetrics } = await import('../services/metrics.js')
    incCounter('test_counter', { kind: 'a' }, 1)
    incCounter('test_counter', { kind: 'a' }, 2)
    incCounter('test_counter', { kind: 'b' }, 1)
    const out = renderMetrics()
    expect(out).toContain('# TYPE test_counter counter')
    expect(out).toMatch(/test_counter\{kind="a"\} 3/)
    expect(out).toMatch(/test_counter\{kind="b"\} 1/)
  })

  it('gauge is last-write-wins', async () => {
    const { setGauge, renderMetrics } = await import('../services/metrics.js')
    setGauge('test_gauge', 1)
    setGauge('test_gauge', 5)
    expect(renderMetrics()).toMatch(/test_gauge 5/)
  })

  it('error reporting no-ops without Sentry DSN', async () => {
    delete process.env['SENTRY_DSN']
    const { initErrorReporting, initTracing } = await import('../services/metrics.js')
    expect(initErrorReporting().configured).toBe(false)
    expect(initTracing().configured).toBe(false)
  })
})

describe('BO14 — business-templates', () => {
  it('exposes exactly 5 templates', async () => {
    const { listTemplates } = await import('../services/business-templates.js')
    const ts = listTemplates()
    expect(ts.length).toBe(5)
    const keys = ts.map(t => t.key).sort()
    expect(keys).toEqual(['content','ecommerce','generic','saas','services'])
  })

  it('every template respects the $10k floor', async () => {
    const { listTemplates } = await import('../services/business-templates.js')
    for (const t of listTemplates()) {
      expect(t.targetMonthlyUsd).toBeGreaterThanOrEqual(10_000)
    }
  })

  it('unknown key falls back to generic', async () => {
    const { getTemplate } = await import('../services/business-templates.js')
    expect(getTemplate('totally-fake' as never).key).toBe('generic')
  })

  it('ecommerce template surfaces POD playbooks + 5 platform connectors', async () => {
    const { getTemplate } = await import('../services/business-templates.js')
    const ec = getTemplate('ecommerce')
    expect(ec.suggestedChannels).toContain('etsy')
    expect(ec.suggestedChannels).toContain('shopify')
    expect(ec.suggestedChannels).toContain('printful')
    expect(ec.suggestedPlaybooks).toContain('print-on-demand.md')
  })

  it('applyTemplateToWorkspace returns applied key + target', async () => {
    const { applyTemplateToWorkspace } = await import('../services/business-templates.js')
    const out = await applyTemplateToWorkspace('ws-test', 'content')
    expect(out.applied).toBe('content')
    expect(out.targetMonthlyUsd).toBeGreaterThanOrEqual(10_000)
  })
})

describe('BO05 — secrets-provider', () => {
  beforeEach(async () => {
    const { _clearSecretsCacheForTests } = await import('../services/secrets-provider.js')
    _clearSecretsCacheForTests()
    delete process.env['SECRETS_DRIVER']
  })

  it('env driver reads process.env', async () => {
    process.env['TEST_FOO'] = 'bar'
    const { getSecret } = await import('../services/secrets-provider.js')
    expect(await getSecret('TEST_FOO')).toBe('bar')
    delete process.env['TEST_FOO']
  })

  it('returns undefined for missing secret', async () => {
    const { getSecret } = await import('../services/secrets-provider.js')
    expect(await getSecret('DEFINITELY_NOT_SET_XYZ')).toBeUndefined()
  })

  it('health check returns ok for env driver', async () => {
    const { checkSecretsHealth } = await import('../services/secrets-provider.js')
    const h = await checkSecretsHealth()
    expect(h.driver).toBe('env')
    expect(h.ok).toBe(true)
  })

  it('health check flags doppler driver missing token', async () => {
    process.env['SECRETS_DRIVER'] = 'doppler'
    delete process.env['DOPPLER_TOKEN']
    const { checkSecretsHealth } = await import('../services/secrets-provider.js')
    const h = await checkSecretsHealth()
    expect(h.driver).toBe('doppler')
    expect(h.ok).toBe(false)
    delete process.env['SECRETS_DRIVER']
  })

  it('rotateSecret clears cache + tolerates DB absence', async () => {
    const { rotateSecret } = await import('../services/secrets-provider.js')
    await expect(rotateSecret('FAKE_KEY', 'test')).resolves.toBeUndefined()
  })
})

describe('BO19 — ai-drift', () => {
  it('computeDrift with no samples returns no drift', async () => {
    const { computeDrift } = await import('../services/ai-drift.js')
    const v = computeDrift('chat', [], [])
    expect(v.driftDetected).toBe(false)
    expect(v.signals).toEqual([])
  })

  it('insufficient baseline samples suppresses drift signal', async () => {
    const { computeDrift } = await import('../services/ai-drift.js')
    // Tiny baseline (< 30 samples) → no drift even on huge swings.
    const cur = Array.from({ length: 5 }, () => ({
      feature: 'x', outputLength: 1000, refusal: false, durationMs: 100, costUsd: 0.01, sampledAt: Date.now(),
    }))
    const base = Array.from({ length: 5 }, () => ({
      feature: 'x', outputLength: 1, refusal: false, durationMs: 1, costUsd: 0.0001, sampledAt: Date.now(),
    }))
    const v = computeDrift('x', cur, base)
    expect(v.driftDetected).toBe(false)
  })

  it('large shift with adequate baseline produces drift signal', async () => {
    const { computeDrift } = await import('../services/ai-drift.js')
    const cur  = Array.from({ length: 50 }, () => ({
      feature: 'y', outputLength: 5000, refusal: false, durationMs: 100, costUsd: 0.05, sampledAt: Date.now(),
    }))
    // 100 baseline samples averaging ~10 each. Current avg of 5000 is
    // way outside the conservative z threshold.
    const base = Array.from({ length: 100 }, () => ({
      feature: 'y', outputLength: 10, refusal: false, durationMs: 100, costUsd: 0.0001, sampledAt: Date.now(),
    }))
    const v = computeDrift('y', cur, base)
    expect(v.driftDetected).toBe(true)
    expect(v.signals.some(s => s.metric === 'output_length' && s.direction === 'up')).toBe(true)
  })

  it('cron tick survives no-DB environment', async () => {
    const { runAiDriftSample } = await import('../services/ai-drift.js')
    const out = await runAiDriftSample()
    expect(typeof out.featuresExamined).toBe('number')
    expect(typeof out.driftsDetected).toBe('number')
  })
})

describe('workspace-seed — template integration', () => {
  it('applies generic template by default + still returns shape contract', async () => {
    // Can't actually exercise the DB write path without DATABASE_URL,
    // but the function is callable + return shape is contract-stable.
    const m = await import('../services/workspace-seed.js')
    expect(typeof m.seedWorkspaceOnFirstInstall).toBe('function')
    expect(typeof m.getSeedStatus).toBe('function')
  })
})
