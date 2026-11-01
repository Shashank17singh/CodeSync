import { createPrismaClient } from '@codesync/db'
import { Redis } from 'ioredis'
import pino from 'pino'
import { loadConfig } from './config.js'
import { startCollabServer } from './server.js'
import { PrismaCatalog, PrismaChat, PrismaDocStore, PrismaSnapshots } from './storage/prisma.js'
import { RedisBus, RedisLocks, RedisSlots, RedisUpdateLog } from './storage/redis.js'

const config = loadConfig(process.env)
const logger = pino({ level: config.logLevel })

const redis = new Redis(config.redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1 })
const subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null })
redis.on('error', (error) => logger.error({ err: error }, 'redis error'))
subscriber.on('error', (error) => logger.error({ err: error }, 'redis subscriber error'))

const prisma = createPrismaClient(config.databaseUrl)

const server = await startCollabServer({
  config,
  logger,
  port: config.port,
  storage: {
    log: new RedisUpdateLog(redis),
    locks: new RedisLocks(redis),
    slots: new RedisSlots(redis),
    bus: new RedisBus(redis, subscriber),
    docs: new PrismaDocStore(prisma),
    catalog: new PrismaCatalog(prisma),
    chat: new PrismaChat(prisma),
    snapshots: new PrismaSnapshots(prisma),
  },
})

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down')
  server
    .close()
    .then(() => Promise.all([prisma.$disconnect(), redis.quit(), subscriber.quit()]))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error({ err: error }, 'shutdown failed')
      process.exit(1)
    })
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
