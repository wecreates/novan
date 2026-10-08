export interface RuntimeModeConfig {
  mode: 'full' | 'cloud-api-only'
  redisRequired: boolean
  queuesEnabled: boolean
  autonomousWorkerEnabled: boolean
  backgroundAutomationEnabled: boolean
}

export function runtimeModeConfig(env: Record<string, string | undefined> = process.env): RuntimeModeConfig {
  const cloudApiOnly = env['RUNTIME_MODE'] === 'cloud-api-only'
  if (cloudApiOnly) {
    return {
      mode: 'cloud-api-only',
      redisRequired: false,
      queuesEnabled: false,
      autonomousWorkerEnabled: false,
      backgroundAutomationEnabled: false,
    }
  }
  return {
    mode: 'full',
    redisRequired: true,
    queuesEnabled: true,
    autonomousWorkerEnabled: true,
    backgroundAutomationEnabled: true,
  }
}

export function redisRuntimeConfig(env: Record<string, string | undefined> = process.env): { url: string; lazyConnect: boolean } {
  const mode = runtimeModeConfig(env)
  const configured = env['REDIS_URL']
  if (configured) return { url: configured, lazyConnect: false }
  if (mode.mode === 'cloud-api-only') {
    return { url: 'redis://127.0.0.1:6379', lazyConnect: true }
  }
  throw new Error('REDIS_URL is required')
}
