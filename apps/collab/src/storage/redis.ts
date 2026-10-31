import { randomBytes, randomUUID } from 'node:crypto'
import { BUS_SENDER_ID_BYTES, collabKeys } from '@codesync/shared'
import { Redis } from 'ioredis'
import type { Bus, Locks, Slots, UpdateLog } from './types.js'

const INSTANCE_ID_BYTES = BUS_SENDER_ID_BYTES

const logKey = collabKeys.updates
const slotsKey = collabKeys.slots

const ACQUIRE_SLOT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
`

const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

export class RedisUpdateLog implements UpdateLog {
  constructor(private readonly redis: Redis) {}

  append(projectId: string, update: Uint8Array): Promise<number> {
    return this.redis.rpush(logKey(projectId), Buffer.from(update))
  }

  async read(projectId: string): Promise<Uint8Array[]> {
    const entries = await this.redis.lrangeBuffer(logKey(projectId), 0, -1)
    return entries.map((entry) => new Uint8Array(entry))
  }

  async trim(projectId: string, count: number): Promise<void> {
    if (count > 0) await this.redis.ltrim(logKey(projectId), count, -1)
  }
}

export class RedisLocks implements Locks {
  constructor(private readonly redis: Redis) {}

  async acquire(name: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID()
    const result = await this.redis.set(collabKeys.lock(name), token, 'PX', ttlMs, 'NX')
    return result === 'OK' ? token : null
  }

  async release(name: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK, 1, collabKeys.lock(name), token)
  }
}

export class RedisSlots implements Slots {
  constructor(private readonly redis: Redis) {}

  async acquire(
    projectId: string,
    connectionId: string,
    max: number,
    ttlMs: number,
  ): Promise<boolean> {
    const now = Date.now()
    const result = await this.redis.eval(
      ACQUIRE_SLOT,
      1,
      slotsKey(projectId),
      max,
      connectionId,
      now,
      now + ttlMs,
      ttlMs * 2,
    )
    return result === 1
  }

  async renew(projectId: string, connectionId: string, ttlMs: number): Promise<void> {
    await this.redis.zadd(slotsKey(projectId), Date.now() + ttlMs, connectionId)
  }

  async release(projectId: string, connectionId: string): Promise<void> {
    await this.redis.zrem(slotsKey(projectId), connectionId)
  }
}

// Redis echoes a publish back to its sender, so each payload is prefixed with the instance id.
export class RedisBus implements Bus {
  private readonly instanceId = randomBytes(INSTANCE_ID_BYTES)
  private readonly handlers = new Map<string, Set<(payload: Uint8Array) => void>>()

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {
    subscriber.on('messageBuffer', (channel: Buffer, message: Buffer) => {
      if (message.subarray(0, INSTANCE_ID_BYTES).equals(this.instanceId)) return
      const payload = new Uint8Array(message.subarray(INSTANCE_ID_BYTES))
      for (const handler of this.handlers.get(channel.toString()) ?? []) handler(payload)
    })
  }

  async subscribe(
    channel: string,
    handler: (payload: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    const handlers = this.handlers.get(channel) ?? new Set()
    handlers.add(handler)
    this.handlers.set(channel, handlers)
    if (handlers.size === 1) await this.subscriber.subscribe(channel)
    return async () => {
      handlers.delete(handler)
      if (handlers.size > 0) return
      this.handlers.delete(channel)
      await this.subscriber.unsubscribe(channel)
    }
  }

  async publish(channel: string, payload: Uint8Array): Promise<void> {
    await this.publisher.publish(channel, Buffer.concat([this.instanceId, payload]))
  }
}
