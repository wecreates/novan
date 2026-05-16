/**
 * Redis connection factory — creates isolated Redis connections for workers.
 * BullMQ requires maxRetriesPerRequest: null for blocking commands.
 */
import { Redis, type RedisOptions } from 'ioredis'

export interface RedisConnectionConfig {
  url?:      string | undefined
  host?:     string | undefined
  port?:     number | undefined
  password?: string | undefined
  db?:       number | undefined
}

export function createRedisConnection(
  config: RedisConnectionConfig | string,
  overrides?: Partial<RedisOptions>,
): Redis {
  const baseOptions: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck:     false,
    lazyConnect:          false,
    retryStrategy:        (times: number) => Math.min(times * 500, 5_000),
    ...overrides,
  }
  if (typeof config === 'string') return new Redis(config, baseOptions)
  if (config.url)                 return new Redis(config.url, baseOptions)
  const connOpts: RedisOptions = {
    host:     config.host ?? 'localhost',
    port:     config.port ?? 6379,
    db:       config.db   ?? 0,
    ...baseOptions,
  }
  if (config.password !== undefined) connOpts.password = config.password
  return new Redis(connOpts)
}

export function createRedisFromEnv(overrides?: Partial<RedisOptions>): Redis {
  const url = process.env['REDIS_URL']
  if (url) return createRedisConnection(url, overrides)
  const cfg: RedisConnectionConfig = {
    host: process.env['REDIS_HOST'] ?? 'localhost',
    port: Number(process.env['REDIS_PORT'] ?? 6379),
    db:   Number(process.env['REDIS_DB']   ?? 0),
  }
  const pw = process.env['REDIS_PASSWORD']
  if (pw !== undefined) cfg.password = pw
  return createRedisConnection(cfg, overrides)
}
