import { describe, it, expect } from 'vitest'
import { runtimeModeConfig, redisRuntimeConfig } from '../runtime-mode.js'

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


describe('redisRuntimeConfig', () => {
  it('uses a lazy placeholder without requiring REDIS_URL in cloud-api-only mode', () => {
    expect(redisRuntimeConfig({ RUNTIME_MODE: 'cloud-api-only' })).toEqual({
      url: 'redis://127.0.0.1:6379',
      lazyConnect: true,
    })
  })

  it('fails fast without REDIS_URL in full mode', () => {
    expect(() => redisRuntimeConfig({})).toThrow('REDIS_URL is required')
  })
})
