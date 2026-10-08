import { describe, it, expect } from 'vitest'
import { runtimeModeConfig } from '../runtime-mode.js'

describe('runtimeModeConfig', () => {
  it('disables Redis queues in cloud-api-only mode', () => {
    expect(runtimeModeConfig({ RUNTIME_MODE: 'cloud-api-only' })).toEqual({
      mode: 'cloud-api-only',
      redisRequired: false,
      queuesEnabled: false,
      autonomousWorkerEnabled: false,
    })
  })

  it('keeps the full runtime stack enabled by default', () => {
    expect(runtimeModeConfig({})).toEqual({
      mode: 'full',
      redisRequired: true,
      queuesEnabled: true,
      autonomousWorkerEnabled: true,
    })
  })
})
