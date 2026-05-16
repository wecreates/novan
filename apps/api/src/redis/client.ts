import { Redis } from 'ioredis'

const url = process.env['REDIS_URL']
if (!url) throw new Error('REDIS_URL is required')

export const redisClient = new Redis(url, {
  maxRetriesPerRequest: null,   // required by BullMQ
  enableReadyCheck:     true,
  lazyConnect:          false,
  retryStrategy: (times) => Math.min(times * 100, 3_000),
})

redisClient.on('error',     (err) => console.error('Redis error:', err))
redisClient.on('connect',   ()    => console.info('Redis connected'))
redisClient.on('reconnecting', () => console.warn('Redis reconnecting'))

/** Separate connection for BullMQ subscribers (cannot share with pub/sub). */
export const redisSubscriber = new Redis(url, {
  maxRetriesPerRequest: null,
  enableReadyCheck:     true,
  lazyConnect:          false,
})
