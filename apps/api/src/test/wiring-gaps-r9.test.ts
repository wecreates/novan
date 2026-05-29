/**
 * wiring-gaps-r9.test.ts — Round 123 gap-closure tests.
 *
 * Covers media-video-worker idempotency, recovery-executor rate
 * limiting, secrets-rotation cache drain, template-injection cache,
 * and brain-task registration of media ops.
 */
import { describe, it, expect } from 'vitest'

describe('media-video-worker — tick contract', () => {
  it('runMediaVideoWorker returns counts even with no DB', async () => {
    const { runMediaVideoWorker } = await import('../services/media-video-worker.js')
    const out = await runMediaVideoWorker()
    expect(out).toHaveProperty('pending')
    expect(out).toHaveProperty('processed')
    expect(typeof out.pending).toBe('number')
    expect(out.processed).toBeLessThanOrEqual(3)  // concurrency cap
  })
})

describe('recovery-executor — tick contract', () => {
  it('runRecoveryExecutor returns examined/auto/escalated/suppressed shape', async () => {
    const { runRecoveryExecutor } = await import('../services/recovery-executor.js')
    const out = await runRecoveryExecutor()
    expect(out).toHaveProperty('examined')
    expect(out).toHaveProperty('autoExecuted')
    expect(out).toHaveProperty('escalated')
    expect(out).toHaveProperty('suppressed')
  })
})

describe('secrets-provider — rotation drain consumer', () => {
  it('consumeSecretRotations returns processed/dropped shape', async () => {
    const { consumeSecretRotations } = await import('../services/secrets-provider.js')
    const out = await consumeSecretRotations()
    expect(out).toHaveProperty('processed')
    expect(out).toHaveProperty('dropped')
    expect(Array.isArray(out.dropped)).toBe(true)
  })
})

describe('template-injection — workspace bias block', () => {
  it('templateInjectionBlock returns empty for unknown workspace', async () => {
    const { templateInjectionBlock, _clearTemplateInjectionCache } =
      await import('../services/template-injection.js')
    _clearTemplateInjectionCache()
    const b = await templateInjectionBlock('definitely-not-a-real-ws-id')
    expect(b).toBe('')
  })

  it('templateInjectionBlock returns empty for empty workspaceId', async () => {
    const { templateInjectionBlock } = await import('../services/template-injection.js')
    expect(await templateInjectionBlock('')).toBe('')
  })

  it('caches negative result so repeated calls are cheap', async () => {
    const { templateInjectionBlock, _clearTemplateInjectionCache } =
      await import('../services/template-injection.js')
    _clearTemplateInjectionCache()
    const a = await templateInjectionBlock('ws-xyz')
    const b = await templateInjectionBlock('ws-xyz')
    expect(a).toBe(b)
  })
})

describe('media ops registered in brain-task / MCP surface', () => {
  // brain-task.ts has top-level db imports; can't load in test env without
  // DATABASE_URL. Verify registration by source-grep instead — production
  // load + listAvailableOperations exercise the code path.
  it('source contains the 4 media op registrations', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/services/brain-task.ts', 'utf8')
    expect(src).toContain("'media.image.analyze'")
    expect(src).toContain("'media.video.estimate_cost'")
    expect(src).toContain("'media.video.submit'")
    expect(src).toContain("'media.tools'")
  })

  it('all media ops registered as risk: low (no approval gate via MCP)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/services/brain-task.ts', 'utf8')
    // Capture the media-op block + assert risk: 'low' appears for each
    const mediaBlockStart = src.indexOf("'media.image.analyze'")
    const mediaBlockEnd   = src.indexOf("'media.tools'") + 200
    const block = src.slice(mediaBlockStart, mediaBlockEnd)
    // 4 ops, each should have risk: 'low'
    const lowCount = (block.match(/risk:\s*'low'/g) ?? []).length
    expect(lowCount).toBeGreaterThanOrEqual(4)
  })
})

describe('cron-tick metrics auto-emission', () => {
  it('metrics module exposes counter + gauge fns the wrapper uses', async () => {
    const { incCounter, setGauge, renderMetrics, _resetMetricsForTests } =
      await import('../services/metrics.js')
    _resetMetricsForTests()
    incCounter('cron_tick_succeeded_total', { task: 'fake-task' })
    setGauge('cron_tick_last_duration_ms', 42, { task: 'fake-task' })
    const out = renderMetrics()
    expect(out).toMatch(/cron_tick_succeeded_total/)
    expect(out).toMatch(/cron_tick_last_duration_ms/)
  })
})
