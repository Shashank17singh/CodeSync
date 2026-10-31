import { createCollabSession, type CollabSession } from '@codesync/collab-client'
import { COLLAB_TOKEN_AUDIENCE } from '@codesync/shared'
import pino from 'pino'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { startCollabServer, type CollabServer } from '../../collab/src/server.js'
import { MemoryHub } from '../../collab/src/storage/memory.js'
import type { BridgeTransport } from '../src/collab/bridge.js'
import { as, config, createRoomFixture, createTestApi, type RoomFixture, type TestApi } from './helpers.js'

const ORIGIN = 'http://localhost:5173'
const SENDER_BYTES = 16

class OriginWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols, { origin: ORIGIN })
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// The real API and the real collab server, sharing one stand-in for Redis.
function hubTransport(hub: MemoryHub): BridgeTransport {
  const storage = hub.storage()
  return {
    readLog: (projectId) => storage.log.read(projectId),
    append: async (projectId, update) => {
      await storage.log.append(projectId, update)
    },
    deleteLog: async (projectId) => {
      hub.updates.delete(projectId)
    },
    readState: async (projectId) => (await storage.docs.load(projectId)).state,
    publish: (channel, payload) => storage.bus.publish(channel, payload.subarray(SENDER_BYTES)),
    acquire: (name, ttlMs) => storage.locks.acquire(name, ttlMs),
    release: (name, token) => storage.locks.release(name, token),
  }
}

describe('API and collab server together', () => {
  let api: TestApi
  let hub: MemoryHub
  let collab: CollabServer
  let fixture: RoomFixture
  const sessions: CollabSession[] = []

  beforeAll(async () => {
    hub = new MemoryHub()
    api = await createTestApi(hubTransport(hub) as never)
    const storage = hub.storage()
    storage.catalog.resolveAccess = async () => ({ role: 'editor', locked: false })
    storage.catalog.listFiles = async (projectId) => {
      const files = await api.prisma.file.findMany({
        where: { projectId },
        select: { id: true, path: true, kind: true },
      })
      return files
    }
    collab = await startCollabServer({
      port: 0,
      storage,
      logger: pino({ level: 'silent' }),
      config: {
        tokenSecret: config.collabTokenSecret,
        allowedOrigins: new Set([ORIGIN]),
        compactionIntervalMs: 60_000,
        maxPendingUpdates: 500,
      },
    })
  })

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.destroy()))
    await waitFor(() => collab.rooms.activeRooms === 0)
  })

  afterAll(async () => {
    await collab.close()
    await api.close()
  })

  async function connect(): Promise<CollabSession> {
    const response = await api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/rooms/${fixture.roomId}/collab-token`,
        payload: { projectId: fixture.projectId },
      }),
    )
    expect(COLLAB_TOKEN_AUDIENCE).toBe('collab')
    const { token } = response.json<{ token: string }>()
    const session = await createCollabSession({
      serverUrl: `ws://127.0.0.1:${collab.port}/collab`,
      projectId: fixture.projectId,
      getToken: async () => token,
      offline: false,
      webSocket: OriginWebSocket as never,
      disableBroadcastChannel: true,
    })
    sessions.push(session)
    await waitFor(() => session.provider.synced)
    return session
  }

  const text = (session: CollabSession, id: string): string =>
    (session.files.get(id) as Y.Text | undefined)?.toString() ?? ''

  it('shows template content to the first client, using an API-issued token', async () => {
    fixture = await createRoomFixture(api)
    const session = await connect()
    await waitFor(() => text(session, fixture.fileId).startsWith('print('))
    expect(session.tree.get(fixture.fileId)?.path).toBe('main.py')
  })

  it('delivers a file created through the API to a connected client with its content', async () => {
    fixture = await createRoomFixture(api)
    const session = await connect()
    const response = await api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/projects/${fixture.projectId}/files`,
        payload: { path: 'util.py', content: 'y = 2\n' },
      }),
    )
    const { id } = response.json<{ file: { id: string } }>().file
    await waitFor(() => text(session, id) === 'y = 2\n' && session.tree.has(id))
  })

  it('exports what a user typed, including edits not yet compacted', async () => {
    fixture = await createRoomFixture(api)
    const session = await connect()
    await waitFor(() => session.files.has(fixture.fileId))
    const file = session.files.get(fixture.fileId) as Y.Text
    file.delete(0, file.length)
    file.insert(0, 'typed live\n')
    await waitFor(() => (hub.updates.get(fixture.projectId)?.length ?? 0) > 1)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const { unzipSync, strFromU8 } = await import('fflate')
    const response = await api.app.inject(
      as(fixture.owner, { method: 'GET', url: `/projects/${fixture.projectId}/export` }),
    )
    expect(strFromU8(unzipSync(response.rawPayload)['main.py'] as Uint8Array)).toBe('typed live\n')
  })

  it('removes a file deleted through the API from connected clients', async () => {
    fixture = await createRoomFixture(api)
    const session = await connect()
    await waitFor(() => session.tree.has(fixture.fileId))
    await api.app.inject(
      as(fixture.owner, {
        method: 'DELETE',
        url: `/projects/${fixture.projectId}/files/${fixture.fileId}`,
      }),
    )
    await waitFor(() => !session.tree.has(fixture.fileId) && !session.files.has(fixture.fileId))
  })

  it('keeps every imported file when collab reconciles during the import', async () => {
    fixture = await createRoomFixture(api)
    const session = await connect()
    const { zipSync, strToU8 } = await import('fflate')
    const entries = Object.fromEntries(
      Array.from({ length: 30 }, (_value, index) => [`f${index}.py`, strToU8(`# ${index}\n`)]),
    )
    await Promise.all(
      Array.from({ length: 3 }, (_value, attempt) =>
        api.app.inject(
          as(fixture.owner, {
            method: 'POST',
            url: `/projects/${fixture.projectId}/files`,
            payload: { path: `extra${attempt}.py`, content: 'x' },
          }),
        ),
      ),
    )
    await api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/projects/${fixture.projectId}/import`,
        headers: { 'content-type': 'application/zip' },
        payload: Buffer.from(zipSync(entries)),
      }),
    )
    const rows = await api.prisma.file.findMany({
      where: { projectId: fixture.projectId, path: { startsWith: 'f' } },
    })
    expect(rows).toHaveLength(30)
    await waitFor(() => rows.every((row) => text(session, row.id).startsWith('# ')))
  })

  it('disconnects clients when the room is deleted', async () => {
    fixture = await createRoomFixture(api)
    const session = await connect()
    await api.app.inject(as(fixture.owner, { method: 'DELETE', url: `/rooms/${fixture.roomId}` }))
    await waitFor(() => !session.provider.wsconnected)
    await waitFor(() => collab.rooms.activeRooms === 0)
    expect(hub.updates.has(fixture.projectId)).toBe(false)
  })
})
