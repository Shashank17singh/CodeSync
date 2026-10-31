import { randomUUID } from 'node:crypto'
import { createPrismaClient, type PrismaClient } from '@codesync/db'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryHub } from '../src/storage/memory.js'
import { PrismaCatalog, PrismaDocStore } from '../src/storage/prisma.js'
import { RedisBus, RedisLocks, RedisSlots, RedisUpdateLog } from '../src/storage/redis.js'
import type { Bus, Locks, Slots, UpdateLog } from '../src/storage/types.js'

const redisUrl = process.env['TEST_REDIS_URL']
const databaseUrl = process.env['TEST_DATABASE_URL']

interface SharedServices {
  log: UpdateLog
  locks: Locks
  slots: Slots
  busA: Bus
  busB: Bus
}

// The memory fakes run the same contract, so they cannot drift from the Redis adapters.
function contract(name: string, setup: () => Promise<SharedServices>, teardown: () => void): void {
  describe(name, () => {
    let services: SharedServices
    beforeAll(async () => {
      services = await setup()
    })
    afterAll(teardown)

    it('round-trips binary updates in order and trims from the front', async () => {
      const project = randomUUID()
      const bytes = Uint8Array.of(0, 255, 10, 13, 128)
      expect(await services.log.append(project, bytes)).toBe(1)
      expect(await services.log.append(project, Uint8Array.of(1))).toBe(2)
      expect(await services.log.read(project)).toEqual([bytes, Uint8Array.of(1)])
      await services.log.trim(project, 1)
      expect(await services.log.read(project)).toEqual([Uint8Array.of(1)])
    })

    it('grants a lock to one holder and ignores a stale release', async () => {
      const name = randomUUID()
      const token = await services.locks.acquire(name, 5_000)
      expect(token).not.toBeNull()
      expect(await services.locks.acquire(name, 5_000)).toBeNull()
      await services.locks.release(name, 'not-the-holder')
      expect(await services.locks.acquire(name, 5_000)).toBeNull()
      await services.locks.release(name, token as string)
      expect(await services.locks.acquire(name, 5_000)).not.toBeNull()
    })

    it('expires a lock', async () => {
      const name = randomUUID()
      await services.locks.acquire(name, 30)
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(await services.locks.acquire(name, 5_000)).not.toBeNull()
    })

    it('enforces the slot limit and frees expired slots', async () => {
      const project = randomUUID()
      expect(await services.slots.acquire(project, 'a', 2, 5_000)).toBe(true)
      expect(await services.slots.acquire(project, 'b', 2, 30)).toBe(true)
      expect(await services.slots.acquire(project, 'c', 2, 5_000)).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(await services.slots.acquire(project, 'c', 2, 5_000)).toBe(true)
      await services.slots.release(project, 'a')
      expect(await services.slots.acquire(project, 'd', 2, 5_000)).toBe(true)
    })

    it('delivers binary pub/sub to other instances but not the sender', async () => {
      const channel = randomUUID()
      const received: Uint8Array[] = []
      const echoed: Uint8Array[] = []
      const stopA = await services.busA.subscribe(channel, (payload) => echoed.push(payload))
      const stopB = await services.busB.subscribe(channel, (payload) => received.push(payload))
      await services.busA.publish(channel, Uint8Array.of(0, 255, 7))
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(received).toEqual([Uint8Array.of(0, 255, 7)])
      expect(echoed).toEqual([])
      await stopA()
      await stopB()
    })
  })
}

const hub = new MemoryHub()
contract(
  'memory storage',
  async () => {
    const a = hub.storage()
    return { log: a.log, locks: a.locks, slots: a.slots, busA: a.bus, busB: hub.storage().bus }
  },
  () => undefined,
)

if (redisUrl) {
  const clients: Redis[] = []
  const connect = (): Redis => {
    const client = new Redis(redisUrl, { maxRetriesPerRequest: null })
    clients.push(client)
    return client
  }
  contract(
    'redis storage',
    async () => {
      const redis = connect()
      return {
        log: new RedisUpdateLog(redis),
        locks: new RedisLocks(redis),
        slots: new RedisSlots(redis),
        busA: new RedisBus(redis, connect()),
        busB: new RedisBus(redis, connect()),
      }
    },
    () => clients.forEach((client) => client.disconnect()),
  )
}

describe.skipIf(!databaseUrl)('prisma storage', () => {
  let prisma: PrismaClient
  let docs: PrismaDocStore
  let catalog: PrismaCatalog
  const ownerId = randomUUID()
  const editorId = randomUUID()
  const viewerId = randomUUID()
  const outsiderId = randomUUID()
  const roomId = randomUUID()
  const otherRoomId = randomUUID()
  const projectId = randomUUID()

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl as string)
    catalog = new PrismaCatalog(prisma)
    docs = new PrismaDocStore(prisma)
    await prisma.user.createMany({
      data: [ownerId, editorId, viewerId, outsiderId].map((id) => ({
        id,
        email: `${id}@test.local`,
        displayName: 'Test',
      })),
    })
    await prisma.room.createMany({
      data: [
        { id: roomId, name: 'room', ownerId },
        { id: otherRoomId, name: 'other', ownerId: outsiderId },
      ],
    })
    await prisma.roomMember.createMany({
      data: [
        { roomId, userId: editorId, role: 'EDITOR' },
        { roomId, userId: viewerId, role: 'VIEWER' },
      ],
    })
    await prisma.project.create({ data: { id: projectId, roomId, name: 'main' } })
    await prisma.file.create({ data: { projectId, path: 'src/main.py' } })
  })

  afterAll(async () => {
    await prisma.room.deleteMany({ where: { id: { in: [roomId, otherRoomId] } } })
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, editorId, viewerId, outsiderId] } },
    })
    await prisma.$disconnect()
  })

  it('resolves roles from the database', async () => {
    expect(await catalog.resolveAccess(roomId, projectId, ownerId)).toEqual({
      role: 'owner',
      locked: false,
    })
    expect((await catalog.resolveAccess(roomId, projectId, editorId))?.role).toBe('editor')
    expect((await catalog.resolveAccess(roomId, projectId, viewerId))?.role).toBe('viewer')
    expect(await catalog.resolveAccess(roomId, projectId, outsiderId)).toBeNull()
  })

  it('rejects a project that belongs to another room', async () => {
    expect(await catalog.resolveAccess(otherRoomId, projectId, outsiderId)).toBeNull()
  })

  it('reports a locked room', async () => {
    await prisma.room.update({ where: { id: roomId }, data: { lockedAt: new Date() } })
    expect((await catalog.resolveAccess(roomId, projectId, editorId))?.locked).toBe(true)
    await prisma.room.update({ where: { id: roomId }, data: { lockedAt: null } })
  })

  it('lists files', async () => {
    expect(await catalog.listFiles(projectId)).toEqual([
      expect.objectContaining({ path: 'src/main.py', kind: 'FILE' }),
    ])
  })

  it('stores unsigned 32-bit client ids and keeps the first owner', async () => {
    const clientId = 4_000_000_000
    await catalog.recordClients(projectId, editorId, [clientId])
    await catalog.recordClients(projectId, viewerId, [clientId])
    const row = await prisma.yjsClient.findUniqueOrThrow({
      where: { projectId_clientId: { projectId, clientId: BigInt(clientId) } },
    })
    expect(row.userId).toBe(editorId)
  })

  it('saves binary state with an optimistic version check', async () => {
    const state = Uint8Array.of(0, 255, 3)
    expect(await docs.save(projectId, state, 0)).toBe(true)
    expect(await docs.save(projectId, Uint8Array.of(9), 0)).toBe(false)
    const stored = await docs.load(projectId)
    expect(stored.version).toBe(1)
    expect(new Uint8Array(stored.state as Uint8Array)).toEqual(state)
  })
})
