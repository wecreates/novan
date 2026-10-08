import { describe, it, expect } from 'vitest'
import { runtimeModeConfig, readinessDependencies } from './runtime-mode.js'

describe('cloud-api-only free runtime', () => {
  it('does not require Redis or queues for readiness', () => {
    const mode = runtimeModeConfig({ RUNTIME_MODE: 'cloud-api-only' })
    expect(mode.redisRequired).toBe(false)
    expect(mode.queuesEnabled).toBe(false)

    const deps = readinessDependencies({ RUNTIME_MODE: 'cloud-api-only' })
    expect(deps).toEqual({
      databaseRequired: true,
      redisRequired: false,
      queueMetricsRequired: false,
    })
  })

  it('keeps full runtime dependencies in normal mode', () => {
    expect(readinessDependencies({})).toEqual({
      databaseRequired: true,
      redisRequired: true,
      queueMetricsRequired: true,
    })
  })
})
