import { createPrismaClient } from '@codesync/db'
import { Redis } from 'ioredis'
import pino from 'pino'
import { buildApp } from './app.js'
import { CollabBridge } from './collab/bridge.js'
import { RedisBridgeTransport } from './collab/redisTransport.js'
import { loadConfig } from './config.js'
import { LogMailer } from './mailer.js'

const config = loadConfig(process.env)
const logger = pino({ level: config.logLevel })

const prisma = createPrismaClient(config.databaseUrl)
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 })
redis.on('error', (error) => logger.error({ err: error }, 'redis error'))

const app = buildApp({
  prisma,
  config,
  logger,
  bridge: new CollabBridge(new RedisBridgeTransport(redis, prisma), logger),
  mailer: new LogMailer(logger),
})

await app.listen({ port: config.port, host: '0.0.0.0' })

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down')
  app
    .close()
    .then(() => Promise.all([prisma.$disconnect(), redis.quit()]))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error({ err: error }, 'shutdown failed')
      process.exit(1)
    })
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
