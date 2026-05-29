import { Redis } from 'ioredis'

const url = process.env['REDIS_URL']
if (!url) throw new Error('REDIS_URL is required')

// API-side Redis: used by Queue producers (BullMQ requires
// maxRetriesPerRequest: null) and by caches/rate-limiter (which benefit
// from enableReadyCheck so they don't issue commands against a half-open
// socket during failover). The repo's Workers use a separate connection
// from runtime-kernel.createRedisConnection() which sets
// enableReadyCheck: false — that's the BullMQ-Worker requirement.
export const redisClient = new Redis(url, {
  maxRetriesPerRequest: null,   // required by BullMQ
  enableReadyCheck:     true,
  lazyConnect:          false,
  // Keep the socket warm across NAT/idle disconnects (common in cloud
  // Redis providers that timeout after ~5 min of silence).
  keepAlive:            30_000,
  retryStrategy: (times) => Math.min(times * 100, 3_000),
})

// Log only the error message — ioredis error objects can carry the full
// connection options including the URL (which embeds the password).
redisClient.on('error',     (err) => console.error('[redis] error:', (err as Error).message))
redisClient.on('connect',   ()    => console.info('[redis] connected'))
redisClient.on('reconnecting', () => console.warn('[redis] reconnecting'))

/** Separate connection for BullMQ subscribers (cannot share with pub/sub). */
export const redisSubscriber = new Redis(url, {
  maxRetriesPerRequest: null,
  enableReadyCheck:     true,
  lazyConnect:          false,
  keepAlive:            30_000,
})

// Without an 'error' listener, an ioredis connection error is emitted as
// an unhandled 'error' event → crashes the process. The subscriber
// previously had none.
redisSubscriber.on('error', (err) => console.error('[redis-subscriber] error:', (err as Error).message))
