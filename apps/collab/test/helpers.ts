import { randomUUID } from 'node:crypto'
import { COLLAB_TOKEN_AUDIENCE, type CollabRole } from '@codesync/shared'
import { createCollabSession, type CollabSession } from '@codesync/collab-client'
import jwt from 'jsonwebtoken'
import pino from 'pino'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { startCollabServer, type CollabServer } from '../src/server.js'
import { MemoryHub } from '../src/storage/memory.js'
import type { Storage } from '../src/storage/types.js'

export const SECRET = 'test-secret-with-at-least-32-characters'
export const ORIGIN = 'http://localhost:5173'
export const ROOM_ID = '11111111-1111-4111-8111-111111111111'
export const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
export const FILE_ID = '33333333-3333-4333-8333-333333333333'

const logger = pino({ level: 'silent' })

export class OriginWebSocket extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols, { origin: ORIGIN })
  }
}

export interface Harness {
  hub: MemoryHub
  servers: CollabServer[]
  start: (overrides?: Partial<ServerTuning> & { storage?: Storage }) => Promise<CollabServer>
  user: (role?: CollabRole) => string
  token: (userId: string, role?: CollabRole, overrides?: TokenOverrides) => string
  connect: (server: CollabServer, userId: string, role?: CollabRole) => Promise<CollabSession>
  stop: () => Promise<void>
}

interface ServerTuning {
  compactionIntervalMs: number
  snapshotIntervalMs: number
  maxPendingUpdates: number
}

interface TokenOverrides {
  projectId?: string
  expiresIn?: number
  audience?: string
  secret?: string
}

export function createHarness(): Harness {
  const hub = new MemoryHub()
  hub.files.set(PROJECT_ID, [{ id: FILE_ID, path: 'main.py', kind: 'FILE' }])
  const servers: CollabServer[] = []
  const sessions: CollabSession[] = []

  const harness: Harness = {
    hub,
    servers,
    start: async (overrides = {}) => {
      const server = await startCollabServer({
        logger,
        port: 0,
        storage: overrides.storage ?? hub.storage(),
        config: {
          tokenSecret: SECRET,
          allowedOrigins: new Set([ORIGIN]),
          compactionIntervalMs: overrides.compactionIntervalMs ?? 60_000,
          snapshotIntervalMs: overrides.snapshotIntervalMs ?? 300_000,
          maxPendingUpdates: overrides.maxPendingUpdates ?? 500,
        },
      })
      servers.push(server)
      return server
    },
    user: (role = 'editor') => {
      const userId = randomUUID()
      hub.setAccess(userId, { role, locked: false })
      return userId
    },
    token: (userId, role = 'editor', overrides = {}) =>
      jwt.sign(
        {
          sub: userId,
          name: `user-${userId.slice(0, 4)}`,
          roomId: ROOM_ID,
          projectId: overrides.projectId ?? PROJECT_ID,
          role,
        },
        overrides.secret ?? SECRET,
        {
          algorithm: 'HS256',
          audience: overrides.audience ?? COLLAB_TOKEN_AUDIENCE,
          expiresIn: overrides.expiresIn ?? 300,
        },
      ),
    connect: async (server, userId, role = 'editor') => {
      const session = await createCollabSession({
        serverUrl: `ws://127.0.0.1:${server.port}/collab`,
        projectId: PROJECT_ID,
        getToken: async () => harness.token(userId, role),
        offline: false,
        webSocket: OriginWebSocket as never,
        disableBroadcastChannel: true,
      })
      sessions.push(session)
      const closeCodes: number[] = []
      session.provider.on('connection-close', (event) => {
        if (event) closeCodes.push(event.code)
      })
      // A permanent close code leaves a client unsynced for good, so a timeout must say why.
      await waitFor(() => session.provider.synced).catch(() => {
        const { wsconnected, wsconnecting } = session.provider
        throw new Error(
          `client did not sync: ${JSON.stringify({ wsconnected, wsconnecting, closeCodes })}`,
        )
      })
      return session
    },
    stop: async () => {
      await Promise.all(sessions.splice(0).map((session) => session.destroy()))
      await Promise.all(servers.splice(0).map((server) => server.close()))
    },
  }
  return harness
}

export async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export interface RawClient {
  ws: WebSocket
  frames: Uint8Array[]
  closed: Promise<number>
  opened: Promise<void>
}

export function rawClient(server: CollabServer, token: string, origin = ORIGIN): RawClient {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/collab/${PROJECT_ID}?token=${token}`, {
    origin,
  })
  const frames: Uint8Array[] = []
  ws.on('message', (data: Buffer) => frames.push(new Uint8Array(data)))
  const closed = new Promise<number>((resolve) => {
    ws.on('close', (code) => resolve(code))
    ws.on('error', () => resolve(-1))
  })
  const opened = new Promise<void>((resolve) => ws.on('open', () => resolve()))
  return { ws, frames, closed, opened }
}

export const fileText = (doc: Y.Doc): Y.Text => doc.getMap<Y.Text>('files').get(FILE_ID) as Y.Text
