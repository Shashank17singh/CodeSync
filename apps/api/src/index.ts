import { createPrismaClient } from '@codesync/db'
import { Redis } from 'ioredis'
import pino from 'pino'
import { buildApp } from './app.js'
import { CollabBridge } from './collab/bridge.js'
import { RedisBridgeTransport } from './collab/redisTransport.js'
import { loadConfig } from './config.js'
import { SmtpMailer } from './mailer.js'
import {
  createGitHubProvider,
  createGoogleProvider,
  type OAuthProviders,
} from './modules/auth/providers.js'
import { RedisRateLimiter } from './modules/auth/rateLimit.js'

const config = loadConfig(process.env)
const logger = pino({ level: config.logLevel })

const prisma = createPrismaClient(config.databaseUrl)
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 })
redis.on('error', (error) => logger.error({ err: error }, 'redis error'))

const oauth: OAuthProviders = {
  ...(config.github ? { github: createGitHubProvider(config.github) } : {}),
  ...(config.google ? { google: createGoogleProvider(config.google) } : {}),
}

const app = buildApp({
  prisma,
  config,
  logger,
  oauth,
  bridge: new CollabBridge(new RedisBridgeTransport(redis, prisma), logger),
  limiter: new RedisRateLimiter(redis),
  mailer: new SmtpMailer(config.smtpUrl, config.mailFrom),
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
