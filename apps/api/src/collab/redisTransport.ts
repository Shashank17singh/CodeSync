import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@codesync/db'
import { collabKeys } from '@codesync/shared'
import type { Redis } from 'ioredis'
import type { BridgeTransport } from './bridge.js'

const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

export class RedisBridgeTransport implements BridgeTransport {
  constructor(
    private readonly redis: Redis,
    private readonly prisma: PrismaClient,
  ) {}

  async readLog(projectId: string): Promise<Uint8Array[]> {
    const entries = await this.redis.lrangeBuffer(collabKeys.updates(projectId), 0, -1)
    return entries.map((entry) => new Uint8Array(entry))
  }

  async append(projectId: string, update: Uint8Array): Promise<void> {
    await this.redis.rpush(collabKeys.updates(projectId), Buffer.from(update))
  }

  async deleteLog(projectId: string): Promise<void> {
    await this.redis.del(collabKeys.updates(projectId), collabKeys.slots(projectId))
  }

  async readState(projectId: string): Promise<Uint8Array | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ydocState: true },
    })
    return project?.ydocState ?? null
  }

  async publish(channel: string, payload: Uint8Array): Promise<void> {
    await this.redis.publish(channel, Buffer.from(payload))
  }

  async acquire(name: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID()
    const result = await this.redis.set(collabKeys.lock(name), token, 'PX', ttlMs, 'NX')
    return result === 'OK' ? token : null
  }

  async release(name: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK, 1, collabKeys.lock(name), token)
  }
}
