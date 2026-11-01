import { createPrismaClient, pruneSnapshots } from '@codesync/db'
import { EXECUTION_QUEUES, SNAPSHOTS } from '@codesync/shared'
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
import { failExecution } from './modules/executions.js'
import { failSubmission } from './modules/problems.js'
import { BullExecutionQueue, watchQueueFailures } from './queue/executionQueue.js'

const config = loadConfig(process.env)
const logger = pino({ level: config.logLevel })

const prisma = createPrismaClient(config.databaseUrl)
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 })
redis.on('error', (error) => logger.error({ err: error }, 'redis error'))

const oauth: OAuthProviders = {
  ...(config.github ? { github: createGitHubProvider(config.github) } : {}),
  ...(config.google ? { google: createGoogleProvider(config.google) } : {}),
}

const bridge = new CollabBridge(new RedisBridgeTransport(redis, prisma), logger)
const queue = new BullExecutionQueue(redis)
// A job that crashed its worker twice never reaches a worker again, so nothing else would report.
const runFailures = watchQueueFailures(EXECUTION_QUEUES.run, config.redisUrl, (executionId) =>
  failExecution(prisma, bridge, executionId).catch((error: unknown) => {
    logger.error({ err: error, executionId }, 'failed to record a failed run')
  }),
)
const judgeFailures = watchQueueFailures(EXECUTION_QUEUES.judge, config.redisUrl, (submissionId) =>
  failSubmission(prisma, submissionId).catch((error: unknown) => {
    logger.error({ err: error, submissionId }, 'failed to record a failed submission')
  }),
)

const DAY_MS = 24 * 60 * 60 * 1000
const pruner = setInterval(() => {
  pruneSnapshots(prisma, new Date(Date.now() - SNAPSHOTS.retentionDays * DAY_MS)).catch(
    (error: unknown) => logger.error({ err: error }, 'failed to prune snapshots'),
  )
}, SNAPSHOTS.pruneIntervalMs)
pruner.unref()

const app = buildApp({
  prisma,
  config,
  logger,
  oauth,
  queue,
  bridge,
  limiter: new RedisRateLimiter(redis),
  mailer: new SmtpMailer(config.smtpUrl, config.mailFrom),
})

await app.listen({ port: config.port, host: '0.0.0.0' })

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'shutting down')
  clearInterval(pruner)
  app
    .close()
    .then(() => Promise.all([runFailures.close(), judgeFailures.close(), queue.close()]))
    .then(() => Promise.all([prisma.$disconnect(), redis.quit()]))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error({ err: error }, 'shutdown failed')
      process.exit(1)
    })
}

process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
