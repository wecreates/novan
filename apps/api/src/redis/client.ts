import { Redis } from 'ioredis'
import { redisRuntimeConfig } from '../runtime-mode.js'

const { url, lazyConnect } = redisRuntimeConfig(process.env)

// API-side Redis: used by Queue producers (BullMQ requires
// maxRetriesPerRequest: null) and by caches/rate-limiter. In
// cloud-api-only mode the clients are created lazily and server startup
// skips Redis/queue initialization entirely.
export const redisClient = new Redis(url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect,
  keepAlive: 30_000,
  retryStrategy: (times) => Math.min(times * 100, 3_000),
})

redisClient.on('error', (err) => console.error('[redis] error:', (err as Error).message))
redisClient.on('connect', () => console.info('[redis] connected'))
redisClient.on('reconnecting', () => console.warn('[redis] reconnecting'))

/** Separate connection for BullMQ subscribers (cannot share with pub/sub). */
export const redisSubscriber = new Redis(url, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect,
  keepAlive: 30_000,
})

redisSubscriber.on('error', (err) => console.error('[redis-subscriber] error:', (err as Error).message))
