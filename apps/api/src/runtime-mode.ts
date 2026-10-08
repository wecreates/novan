export interface RuntimeModeConfig {
  mode: 'full' | 'cloud-api-only'
  redisRequired: boolean
  queuesEnabled: boolean
  autonomousWorkerEnabled: boolean
}

export function runtimeModeConfig(env: Record<string, string | undefined> = process.env): RuntimeModeConfig {
  const cloudApiOnly = env['RUNTIME_MODE'] === 'cloud-api-only'
  if (cloudApiOnly) {
    return {
      mode: 'cloud-api-only',
      redisRequired: false,
      queuesEnabled: false,
      autonomousWorkerEnabled: false,
    }
  }
  return {
    mode: 'full',
    redisRequired: true,
    queuesEnabled: true,
    autonomousWorkerEnabled: true,
  }
}
