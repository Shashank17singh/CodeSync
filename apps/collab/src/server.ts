import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { COLLAB_LIMITS, WsCloseCode, type CollabTokenClaims } from '@codesync/shared'
import type { Logger } from 'pino'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { verifyCollabToken } from './auth/token.js'
import type { ServerConfig } from './config.js'
import { CollabMetrics } from './metrics.js'
import { Connection } from './rooms/connection.js'
import type { Room } from './rooms/room.js'
import { RoomManager } from './rooms/roomManager.js'
import type { Storage } from './storage/types.js'

const PATH_PATTERN =
  /^\/collab\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i
const HEARTBEAT_MS = 15_000
const SLOT_TTL_MS = 45_000
const SERVER_ERROR_CLOSE = 1011

export interface CollabServer {
  port: number
  rooms: RoomManager
  connectionCount: () => number
  close: () => Promise<void>
}

export interface CollabServerOptions {
  config: ServerConfig
  storage: Storage
  logger: Logger
  port: number
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
}

export async function startCollabServer(options: CollabServerOptions): Promise<CollabServer> {
  const { config, storage, logger } = options
  const rooms = new RoomManager(storage, config, logger)
  const connections = new Map<WebSocket, Connection>()
  const metrics = new CollabMetrics({
    activeRooms: () => rooms.activeRooms,
    connections: () => connections.size,
  })

  // Nginx routes only /collab here, so /metrics is reachable from the private network alone.
  const http: Server = createServer((request, response) => {
    if (request.url === '/metrics') {
      metrics.registry
        .metrics()
        .then((body) => {
          response.writeHead(200, { 'content-type': metrics.registry.contentType })
          response.end(body)
        })
        .catch((error: unknown) => {
          logger.error({ err: error }, 'failed to render metrics')
          response.writeHead(500).end()
        })
      return
    }
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', rooms: rooms.activeRooms }))
      return
    }
    response.writeHead(404).end()
  })

  // ws closes frames above maxPayload with 1009, which clients retry. Allowing up to double
  // the limit lets oversized frames reach the handler and get the permanent 4413 instead.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: COLLAB_LIMITS.maxFrameBytes * 2,
    perMessageDeflate: false,
  })

  const rejectUpgrade = (socket: Duplex, status: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
  }

  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://collab.internal')
    const projectId = PATH_PATTERN.exec(url.pathname)?.[1]?.toLowerCase()
    if (!projectId) {
      rejectUpgrade(socket, '404 Not Found')
      return
    }
    // Browsers attach cookies and Origin to cross-site sockets, so this blocks hijacking.
    if (!config.allowedOrigins.has(request.headers.origin ?? '')) {
      rejectUpgrade(socket, '403 Forbidden')
      return
    }
    // Token failures are reported after the upgrade: a failed HTTP upgrade reaches the
    // browser only as code 1006, which would hide the reason from the client.
    wss.handleUpgrade(request, socket, head, (ws) => {
      onConnection(ws, projectId, url.searchParams.get('token'))
    })
  })

  const onConnection = (ws: WebSocket, projectId: string, token: string | null): void => {
    ws.on('error', (error) => logger.warn({ err: error }, 'socket error'))

    // Verified synchronously, so nothing is buffered for an unauthenticated peer.
    const result = verifyCollabToken(token, config.tokenSecret)
    if (!result.ok) {
      const expired = result.reason === 'expired'
      ws.close(expired ? WsCloseCode.tokenExpired : WsCloseCode.invalidToken, result.reason)
      return
    }
    if (result.claims.projectId !== projectId) {
      ws.close(WsCloseCode.invalidToken, 'token is for another project')
      return
    }

    const { claims } = result
    const connection = new Connection(
      randomUUID(),
      ws,
      projectId,
      claims.sub,
      claims.name,
      claims.role,
      logger,
    )
    connections.set(ws, connection)

    let joined = join(connection, claims)

    ws.on('pong', () => {
      connection.alive = true
    })

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const frame = toBuffer(data)
      if (!isBinary) {
        metrics.rejected.inc({ reason: 'not_binary' })
        connection.close(WsCloseCode.malformed, 'binary frames only')
      } else if (frame.byteLength > COLLAB_LIMITS.maxFrameBytes) {
        metrics.rejected.inc({ reason: 'too_large' })
        connection.close(WsCloseCode.frameTooLarge, 'frame too large')
      } else if (
        !connection.messageBucket.take() ||
        !connection.byteBucket.take(frame.byteLength)
      ) {
        logger.warn({ userId: connection.userId }, 'rate limit exceeded')
        metrics.rejected.inc({ reason: 'rate_limited' })
        connection.close(WsCloseCode.rateLimited, 'rate limit exceeded')
      } else {
        joined = joined.then((room) => {
          if (room) {
            const stop = metrics.frameSeconds.startTimer()
            room.handleFrame(connection, frame)
            stop()
            metrics.frames.inc()
          }
          return room
        })
      }
    })

    ws.on('close', () => {
      connections.delete(ws)
      void joined
        .then((room) => {
          if (!room) return
          room.removeConnection(connection)
          rooms.release(projectId)
        })
        .then(() => storage.slots.release(projectId, connection.id))
        .catch((error: unknown) => logger.error({ err: error }, 'connection cleanup failed'))
    })
  }

  const join = async (connection: Connection, claims: CollabTokenClaims): Promise<Room | null> => {
    const { projectId, roomId } = claims
    try {
      const hasSlot = await storage.slots.acquire(
        projectId,
        connection.id,
        COLLAB_LIMITS.maxUsersPerRoom,
        SLOT_TTL_MS,
      )
      if (!hasSlot) {
        connection.close(WsCloseCode.roomFull, 'room is full')
        return null
      }
      // Re-checked against the database: a role in a 5-minute token can already be stale.
      const access = await storage.catalog.resolveAccess(roomId, projectId, connection.userId)
      if (!access) {
        connection.close(WsCloseCode.forbidden, 'not a member of this room')
        return null
      }
      connection.role = access.role
      const room = await rooms.acquire(projectId, roomId)
      room.setLocked(access.locked)
      if (connection.ws.readyState !== WebSocket.OPEN) {
        rooms.release(projectId)
        return null
      }
      room.addConnection(connection)
      return room
    } catch (error) {
      logger.error({ err: error, projectId }, 'failed to join room')
      connection.close(SERVER_ERROR_CLOSE, 'server error')
      return null
    }
  }

  const heartbeat = setInterval(() => {
    for (const [ws, connection] of connections) {
      if (!connection.alive) {
        ws.terminate()
        continue
      }
      connection.alive = false
      ws.ping()
      storage.slots
        .renew(connection.projectId, connection.id, SLOT_TTL_MS)
        .catch((error: unknown) => logger.error({ err: error }, 'failed to renew slot'))
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()

  await new Promise<void>((resolve) => http.listen(options.port, resolve))
  const { port } = http.address() as AddressInfo
  logger.info({ port }, 'collab server listening')

  return {
    port,
    rooms,
    connectionCount: () => connections.size,
    close: async () => {
      clearInterval(heartbeat)
      for (const connection of connections.values()) {
        connection.close(WsCloseCode.serverDraining, 'server restarting')
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await rooms.shutdown()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}
