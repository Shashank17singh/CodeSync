import { randomUUID } from 'node:crypto'
import { createPrismaClient, type PrismaClient } from '@codesync/db'
import type { FastifyBaseLogger, FastifyInstance, InjectOptions } from 'fastify'
import jwt from 'jsonwebtoken'
import pino from 'pino'
import { buildApp } from '../src/app.js'
import { CollabBridge, type BridgeTransport } from '../src/collab/bridge.js'
import type { ApiConfig } from '../src/config.js'
import type { InviteEmail, LinkEmail, Mailer } from '../src/mailer.js'
import type { OAuthProviders } from '../src/modules/auth/providers.js'
import { MemoryRateLimiter, type RateLimiter } from '../src/modules/auth/rateLimit.js'
import type { ExecutionQueue, ReviewJob, RunJob } from '../src/queue/executionQueue.js'

export const config: ApiConfig = {
  accessTokenSecret: 'access-secret-with-at-least-32-characters',
  collabTokenSecret: 'collab-secret-with-at-least-32-characters',
  inviteTokenSecret: 'invite-secret-with-at-least-32-characters',
  oauthStateSecret: 'oauth-state-secret-with-at-least-32-characters',
  internalServiceToken: 'internal-service-token-with-at-least-32-chars',
  publicWebUrl: 'http://localhost:5173',
  publicApiUrl: 'http://localhost:3000',
  secureCookies: true,
  trustProxyHops: 0,
}

export class MemoryTransport implements BridgeTransport {
  readonly logs = new Map<string, Uint8Array[]>()
  readonly published: Array<{ channel: string; payload: Uint8Array }> = []
  readonly locks = new Set<string>()

  async readLog(projectId: string): Promise<Uint8Array[]> {
    return [...(this.logs.get(projectId) ?? [])]
  }

  async append(projectId: string, update: Uint8Array): Promise<void> {
    this.logs.set(projectId, [...(this.logs.get(projectId) ?? []), update])
  }

  async deleteLog(projectId: string): Promise<void> {
    this.logs.delete(projectId)
  }

  async readState(): Promise<Uint8Array | null> {
    return null
  }

  async publish(channel: string, payload: Uint8Array): Promise<void> {
    this.published.push({ channel, payload })
  }

  async acquire(name: string): Promise<string | null> {
    if (this.locks.has(name)) return null
    this.locks.add(name)
    return name
  }

  async release(name: string): Promise<void> {
    this.locks.delete(name)
  }

  controlMessages(): Array<{ type: string }> {
    return this.published
      .filter(({ channel }) => channel.endsWith(':control'))
      .map(({ payload }) => JSON.parse(Buffer.from(payload.subarray(16)).toString('utf8')))
  }
}

export class MemoryExecutionQueue implements ExecutionQueue {
  readonly jobs: RunJob[] = []
  readonly judgeJobs: string[] = []
  readonly reviewJobs: ReviewJob[] = []
  failure: Error | null = null
  waiting: number | null = null

  async enqueueRun(job: RunJob): Promise<void> {
    if (this.failure) throw this.failure
    this.jobs.push(job)
  }

  async enqueueJudge(submissionId: string): Promise<void> {
    if (this.failure) throw this.failure
    this.judgeJobs.push(submissionId)
  }

  async enqueueReview(job: ReviewJob): Promise<void> {
    if (this.failure) throw this.failure
    this.reviewJobs.push(job)
  }

  async waitingCount(): Promise<number> {
    return this.waiting ?? this.jobs.length
  }
}

export class RecordingMailer implements Mailer {
  readonly sent: InviteEmail[] = []
  readonly verifications: LinkEmail[] = []
  readonly resets: LinkEmail[] = []

  async sendInvite(email: InviteEmail): Promise<void> {
    this.sent.push(email)
  }

  async sendVerification(email: LinkEmail): Promise<void> {
    this.verifications.push(email)
  }

  async sendPasswordReset(email: LinkEmail): Promise<void> {
    this.resets.push(email)
  }
}

export interface TestApi {
  app: FastifyInstance
  prisma: PrismaClient
  transport: MemoryTransport
  mailer: RecordingMailer
  limiter: RateLimiter
  queue: MemoryExecutionQueue
  close: () => Promise<void>
}

export interface TestApiOptions {
  oauth?: OAuthProviders
  limiter?: RateLimiter
  trustProxyHops?: number
  logger?: FastifyBaseLogger
}

export async function createTestApi(
  transport = new MemoryTransport(),
  options: TestApiOptions = {},
): Promise<TestApi> {
  const prisma = createPrismaClient(process.env['TEST_DATABASE_URL'] as string)
  const logger = options.logger ?? pino({ level: 'silent' })
  const mailer = new RecordingMailer()
  const limiter = options.limiter ?? new MemoryRateLimiter()
  const queue = new MemoryExecutionQueue()
  const app = buildApp({
    prisma,
    config: { ...config, trustProxyHops: options.trustProxyHops ?? 0 },
    logger,
    mailer,
    limiter,
    queue,
    oauth: options.oauth ?? {},
    bridge: new CollabBridge(transport, logger),
  })
  await app.ready()
  return {
    app,
    prisma,
    transport,
    mailer,
    limiter,
    queue,
    close: async () => {
      await app.close()
      await prisma.$disconnect()
    },
  }
}

export async function createUser(prisma: PrismaClient, name = 'Test User'): Promise<string> {
  const id = randomUUID()
  await prisma.user.create({
    data: { id, email: `${id}@test.local`, displayName: name },
  })
  return id
}

export const accessToken = (userId: string): string =>
  jwt.sign({}, config.accessTokenSecret, {
    algorithm: 'HS256',
    subject: userId,
    audience: 'api',
    expiresIn: 900,
  })

export function as(userId: string, options: InjectOptions): InjectOptions {
  return {
    ...options,
    url: `/api/v1${options.url}`,
    headers: { ...options.headers, authorization: `Bearer ${accessToken(userId)}` },
  }
}

export interface RoomFixture {
  roomId: string
  projectId: string
  fileId: string
  owner: string
  editor: string
  viewer: string
  bystander: string
  outsider: string
}

export async function createRoomFixture(
  api: TestApi,
  { visibility = 'PRIVATE', locked = false } = {},
): Promise<RoomFixture> {
  const { app, prisma } = api
  const owner = await createUser(prisma, 'Owner')
  const editor = await createUser(prisma, 'Editor')
  const viewer = await createUser(prisma, 'Viewer')
  const bystander = await createUser(prisma, 'Bystander')
  const outsider = await createUser(prisma, 'Outsider')
  const created = await app.inject(
    as(owner, {
      method: 'POST',
      url: '/rooms',
      payload: { name: 'Fixture', visibility, template: 'PYTHON' },
    }),
  )
  const { room } = created.json<{ room: { id: string; projectId: string } }>()
  await prisma.roomMember.createMany({
    data: [
      { roomId: room.id, userId: editor, role: 'EDITOR' },
      { roomId: room.id, userId: viewer, role: 'VIEWER' },
      { roomId: room.id, userId: bystander, role: 'VIEWER' },
    ],
  })
  if (locked) {
    await prisma.room.update({ where: { id: room.id }, data: { lockedAt: new Date() } })
  }
  const file = await prisma.file.findFirstOrThrow({ where: { projectId: room.projectId } })
  return {
    roomId: room.id,
    projectId: room.projectId,
    fileId: file.id,
    owner,
    editor,
    viewer,
    bystander,
    outsider,
  }
}
