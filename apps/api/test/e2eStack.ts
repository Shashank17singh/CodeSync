import { createPrismaClient } from '@codesync/db'
import pino from 'pino'
import { startCollabServer } from '../../collab/src/server.js'
import { MemoryHub } from '../../collab/src/storage/memory.js'
import { PrismaCatalog, PrismaChat, PrismaSnapshots } from '../../collab/src/storage/prisma.js'
import { buildApp } from '../src/app.js'
import { CollabBridge } from '../src/collab/bridge.js'
import { hashPassword } from '../src/modules/auth/passwords.js'
import { MemoryRateLimiter } from '../src/modules/auth/rateLimit.js'
import type { ExecutionQueue, RunJob } from '../src/queue/executionQueue.js'
import setupDatabase from './globalSetup.js'
import { RecordingMailer, config } from './helpers.js'
import { hubTransport } from './hubTransport.js'

// The stack behind the browser tests: the real API and collab server on a real PostgreSQL, with
// Redis replaced by the in-memory hub and the sandbox replaced by a scripted worker.
const API_PORT = Number(process.env['E2E_API_PORT'] ?? 4200)
const COLLAB_PORT = Number(process.env['E2E_COLLAB_PORT'] ?? 4201)
const WEB_ORIGIN = process.env['E2E_WEB_ORIGIN'] ?? 'http://127.0.0.1:5199'
const PASSWORD = 'correct horse battery'
const WORKER_DELAY_MS = 50

const stopDatabase = await setupDatabase()
const prisma = createPrismaClient(process.env['TEST_DATABASE_URL'] as string)
const logger = pino({ level: 'warn' })

const passwordHash = await hashPassword(PASSWORD)
const seedUser = (email: string, displayName: string) =>
  prisma.user.create({
    data: { email, displayName, passwordHash, emailVerifiedAt: new Date() },
  })
const alice = await seedUser('alice@test.local', 'Alice')
await seedUser('bob@test.local', 'Bob')

const problem = await prisma.problem.create({
  data: {
    slug: 'add-two-numbers',
    title: 'Add two numbers',
    difficulty: 'EASY',
    tags: ['math'],
    statementMd: 'Print the **sum** of two integers.',
    inputFormat: 'Two integers.',
    outputFormat: 'One integer.',
    constraints: 'Both fit in 32 bits.',
    limits: {},
    starterCode: { PYTHON: 'a, b = map(int, input().split())\nprint(a + b)\n' },
    publishedAt: new Date(),
    createdById: alice.id,
    testCases: {
      create: { ordinal: 1, input: Buffer.from('1 2\n'), output: Buffer.from('3\n'), isSample: true },
    },
  },
})
const problemSet = await prisma.problemSet.create({
  data: {
    title: 'Warm-up set',
    createdById: alice.id,
    problems: { connect: { id: problem.id } },
  },
})
const contestRoom = await prisma.room.create({
  data: {
    name: 'Contest room',
    ownerId: alice.id,
    members: { create: { userId: alice.id, role: 'EDITOR' } },
  },
})
await prisma.contest.create({
  data: {
    title: 'Friday contest',
    roomId: contestRoom.id,
    problemSetId: problemSet.id,
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 3_600_000),
  },
})

const hub = new MemoryHub()
const bridge = new CollabBridge(hubTransport(hub), logger)

async function playRun(job: RunJob): Promise<void> {
  const internal = (path: string, payload: object) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/internal/executions/${job.execution_id}/${path}`,
      headers: { 'x-service-token': config.internalServiceToken },
      payload,
    })
  await internal('started', { worker_id: 'e2e' })
  const executionId = job.execution_id
  await bridge.publishRoomEvent(job.room_id, {
    type: 'exec.started',
    executionId,
    userId: job.user_id,
    language: job.language,
  })
  const stdout = `hello from ${job.entry_path}\n`
  await bridge.publishRoomEvent(job.room_id, {
    type: 'exec.output',
    executionId,
    stream: 'stdout',
    seq: 1,
    data: stdout,
  })
  await internal('result', {
    status: 'OK',
    exit_code: 0,
    stdout,
    stderr: '',
    compile_output: '',
    time_ms: 12,
    memory_kb: 2048,
    message: null,
  })
}

const queue: ExecutionQueue = {
  enqueueRun: async (job) => {
    setTimeout(() => {
      playRun(job).catch((error: unknown) => logger.error({ err: error }, 'scripted run failed'))
    }, WORKER_DELAY_MS)
  },
  enqueueJudge: async (submissionId) => {
    setTimeout(() => {
      app
        .inject({
          method: 'POST',
          url: `/api/v1/internal/submissions/${submissionId}/result`,
          headers: { 'x-service-token': config.internalServiceToken },
          payload: {
            verdict: 'ACCEPTED',
            failed_ordinal: null,
            time_ms: 20,
            memory_kb: 4096,
            compile_output: '',
            results: [{ ordinal: 1, verdict: 'ACCEPTED', time_ms: 20, memory_kb: 4096 }],
          },
        })
        .catch((error: unknown) => logger.error({ err: error }, 'scripted judge failed'))
    }, WORKER_DELAY_MS)
  },
  enqueueReview: async () => undefined,
  waitingCount: async () => 0,
}

const app = buildApp({
  prisma,
  logger,
  bridge,
  queue,
  oauth: {},
  limiter: new MemoryRateLimiter(),
  mailer: new RecordingMailer(),
  config: { ...config, publicWebUrl: WEB_ORIGIN, publicApiUrl: WEB_ORIGIN, secureCookies: false },
})
await app.listen({ port: API_PORT, host: '127.0.0.1' })

const collab = await startCollabServer({
  logger,
  port: COLLAB_PORT,
  storage: {
    ...hub.storage(),
    catalog: new PrismaCatalog(prisma),
    chat: new PrismaChat(prisma),
    snapshots: new PrismaSnapshots(prisma),
  },
  config: {
    tokenSecret: config.collabTokenSecret,
    allowedOrigins: new Set([WEB_ORIGIN]),
    compactionIntervalMs: 30_000,
    snapshotIntervalMs: 300_000,
    maxPendingUpdates: 500,
  },
})

const shutdown = (): void => {
  void Promise.allSettled([collab.close(), app.close(), prisma.$disconnect()])
    .then(() => stopDatabase())
    .finally(() => process.exit(0))
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
