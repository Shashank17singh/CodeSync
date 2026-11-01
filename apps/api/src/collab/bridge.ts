import { randomBytes } from 'node:crypto'
import {
  BUS_SENDER_ID_BYTES,
  YDOC_ROOTS,
  collabKeys,
  type RoomEvent,
  type RoomControl,
} from '@codesync/shared'
import type { FastifyBaseLogger } from 'fastify'
import { simpleDiffString } from 'lib0/diff'
import * as Y from 'yjs'
import { ApiError } from '../lib/errors.js'

const LOCK_TTL_MS = 15_000
const LOCK_ATTEMPTS = 40
const LOCK_RETRY_MS = 50

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface BridgeTransport {
  readLog(projectId: string): Promise<Uint8Array[]>
  append(projectId: string, update: Uint8Array): Promise<void>
  deleteLog(projectId: string): Promise<void>
  readState(projectId: string): Promise<Uint8Array | null>
  publish(channel: string, payload: Uint8Array): Promise<void>
  acquire(name: string, ttlMs: number): Promise<string | null>
  release(name: string, token: string): Promise<void>
}

export interface SeedFile {
  id: string
  content: string
}

// The API's side of the shared project document. File content has no copy in PostgreSQL, so
// reads and writes follow the same rules as the collab server: log before state on load, and
// the tree lock around creating a file.
export class CollabBridge {
  private readonly senderId = randomBytes(BUS_SENDER_ID_BYTES)

  constructor(
    private readonly transport: BridgeTransport,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async withTreeLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const name = collabKeys.treeLock(projectId)
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      const token = await this.transport.acquire(name, LOCK_TTL_MS)
      if (token) {
        try {
          return await task()
        } finally {
          await this.transport.release(name, token)
        }
      }
      await sleep(LOCK_RETRY_MS)
    }
    throw new ApiError(503, 'project_busy', 'The project is busy, try again in a moment')
  }

  private async loadDoc(projectId: string): Promise<Y.Doc> {
    const pending = await this.transport.readLog(projectId)
    const state = await this.transport.readState(projectId)
    const doc = new Y.Doc()
    if (state) Y.applyUpdate(doc, state)
    for (const update of pending) Y.applyUpdate(doc, update)
    return doc
  }

  // Must run inside withTreeLock, so collab cannot create a competing Y.Text for the same id.
  async seedFiles(projectId: string, files: SeedFile[]): Promise<void> {
    if (files.length === 0) return
    const doc = await this.loadDoc(projectId)
    try {
      const before = Y.encodeStateVector(doc)
      const map = doc.getMap<Y.Text>(YDOC_ROOTS.files)
      doc.transact(() => {
        for (const file of files) {
          if (!map.has(file.id)) map.set(file.id, new Y.Text(file.content))
        }
      })
      const update = Y.encodeStateAsUpdate(doc, before)
      await this.transport.append(projectId, update)
      await this.transport.publish(collabKeys.sync(projectId), this.frame(update))
    } finally {
      doc.destroy()
    }
  }

  async readFiles(projectId: string): Promise<Map<string, string>> {
    const doc = await this.loadDoc(projectId)
    try {
      const contents = new Map<string, string>()
      doc.getMap<Y.Text>(YDOC_ROOTS.files).forEach((text, id) => {
        contents.set(id, text.toString())
      })
      return contents
    } finally {
      doc.destroy()
    }
  }

  async encodeState(projectId: string): Promise<Uint8Array> {
    const doc = await this.loadDoc(projectId)
    try {
      return Y.encodeStateAsUpdate(doc)
    } finally {
      doc.destroy()
    }
  }

  // Must run inside withTreeLock. Only the changed span is rewritten, so anchors and cursors
  // outside it survive. Returns the Yjs client that made the edit, or null if nothing changed.
  async writeFiles(projectId: string, files: SeedFile[]): Promise<number | null> {
    const doc = await this.loadDoc(projectId)
    try {
      const before = Y.encodeStateVector(doc)
      const map = doc.getMap<Y.Text>(YDOC_ROOTS.files)
      let changed = false
      doc.transact(() => {
        for (const { id, content } of files) {
          const text = map.get(id)
          if (!text) {
            map.set(id, new Y.Text(content))
            changed = true
            continue
          }
          const current = text.toString()
          if (current === content) continue
          const { index, remove, insert } = simpleDiffString(current, content)
          if (remove > 0) text.delete(index, remove)
          if (insert.length > 0) text.insert(index, insert)
          changed = true
        }
      })
      if (!changed) return null
      const update = Y.encodeStateAsUpdate(doc, before)
      await this.transport.append(projectId, update)
      await this.transport.publish(collabKeys.sync(projectId), this.frame(update))
      return doc.clientID
    } finally {
      doc.destroy()
    }
  }

  // The database change is already committed, so a Redis failure must not fail the request.
  // Collab re-reads roles on connect and the file list on the next room load.
  async notify(roomId: string, message: RoomControl): Promise<void> {
    try {
      const payload = new TextEncoder().encode(JSON.stringify(message))
      await this.transport.publish(collabKeys.control(roomId), this.frame(payload))
    } catch (error) {
      this.logger.error({ err: error, roomId, type: message.type }, 'failed to notify collab')
    }
  }

  // Only live display depends on this, so a lost event must not fail the caller.
  async publishRoomEvent(roomId: string, event: RoomEvent): Promise<void> {
    try {
      const payload = new TextEncoder().encode(JSON.stringify(event))
      await this.transport.publish(collabKeys.events(roomId), this.frame(payload))
    } catch (error) {
      this.logger.error({ err: error, roomId, type: event.type }, 'failed to publish event')
    }
  }

  async forgetProject(projectId: string): Promise<void> {
    try {
      await this.transport.deleteLog(projectId)
    } catch (error) {
      this.logger.error({ err: error, projectId }, 'failed to delete project log')
    }
  }

  private frame(payload: Uint8Array): Uint8Array {
    return Buffer.concat([this.senderId, payload])
  }
}
