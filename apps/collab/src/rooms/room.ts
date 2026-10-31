import {
  COLLAB_LIMITS,
  WsCloseCode,
  WsMessageType,
  YDOC_ROOTS,
  appEnvelopeSchema,
  clientPresenceSchema,
  colorForUser,
  initialsFor,
  roomControlSchema,
  type PresenceState,
  type RoomControl,
  type TreeEntry,
} from '@codesync/shared'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { Logger } from 'pino'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import {
  ProtocolError,
  decodeAwarenessUpdate,
  encodeApp,
  encodeAwareness,
  encodeAwarenessEntries,
  encodePermissionDenied,
  encodeSyncStep1,
  encodeSyncUpdate,
} from '../protocol/frames.js'
import { channels, type Storage } from '../storage/types.js'
import { Connection } from './connection.js'

const SERVER_ORIGIN = Symbol('server')
const REMOTE_ORIGIN = Symbol('remote')
const REPLAY_ORIGIN = Symbol('replay')

const LOCK_TTL_MS = 15_000
const LOCK_ATTEMPTS = 20
const LOCK_RETRY_MS = 50

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface RoomOptions {
  projectId: string
  roomId: string
  storage: Storage
  logger: Logger
  compactionIntervalMs: number
  maxPendingUpdates: number
}

export class Room {
  readonly projectId: string
  readonly roomId: string
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  readonly connections = new Set<Connection>()

  private readonly files = this.doc.getMap<Y.Text>(YDOC_ROOTS.files)
  private readonly tree = this.doc.getMap<TreeEntry>(YDOC_ROOTS.tree)
  private readonly storage: Storage
  private readonly logger: Logger
  private readonly options: RoomOptions
  private readonly awarenessOwners = new Map<number, Connection>()
  private canonicalTree = new Map<string, TreeEntry>()
  private unsubscribers: Array<() => Promise<void>> = []
  private timer: NodeJS.Timeout | undefined
  private appends: Promise<void> = Promise.resolve()
  private compacting: Promise<boolean> | null = null
  private appendFailed = false
  private dirty = false
  private locked = false

  private constructor(options: RoomOptions) {
    this.options = options
    this.projectId = options.projectId
    this.roomId = options.roomId
    this.storage = options.storage
    this.logger = options.logger.child({ projectId: options.projectId })
    this.awareness.setLocalState(null)
    this.doc.on('afterTransaction', this.guardTransaction)
    this.doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
  }

  static async open(options: RoomOptions): Promise<Room> {
    const room = new Room(options)
    try {
      await room.subscribe()
      await room.load()
      await room.reconcileTree()
      room.timer = setInterval(() => void room.tick(), options.compactionIntervalMs)
      room.timer.unref()
      return room
    } catch (error) {
      await room.destroy()
      throw error
    }
  }

  // Subscribing first means an update published during load is delivered, not lost.
  private async subscribe(): Promise<void> {
    const { bus } = this.storage
    this.unsubscribers = await Promise.all([
      bus.subscribe(channels.sync(this.projectId), (update) => {
        this.applyTrusted(update, REMOTE_ORIGIN)
      }),
      bus.subscribe(channels.awareness(this.projectId), (update) => {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, REMOTE_ORIGIN)
      }),
      bus.subscribe(channels.control(this.roomId), (payload) => this.onControl(payload)),
    ])
  }

  // The log is read before the document. A compaction landing between the two reads only
  // duplicates updates, which Yjs ignores. The reverse order could miss a trimmed update.
  private async load(): Promise<void> {
    const pending = await this.storage.log.read(this.projectId)
    const stored = await this.storage.docs.load(this.projectId)
    this.doc.transact(() => {
      if (stored.state) Y.applyUpdate(this.doc, stored.state, REPLAY_ORIGIN)
      for (const update of pending) Y.applyUpdate(this.doc, update, REPLAY_ORIGIN)
    }, REPLAY_ORIGIN)
  }

  private applyTrusted(update: Uint8Array, origin: symbol): void {
    try {
      Y.applyUpdate(this.doc, update, origin)
    } catch (error) {
      this.logger.error({ err: error }, 'failed to apply stored or remote update')
    }
  }

  private async withLock<T>(name: string, task: () => Promise<T>): Promise<T | null> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      const token = await this.storage.locks.acquire(name, LOCK_TTL_MS)
      if (token) {
        try {
          return await task()
        } finally {
          await this.storage.locks.release(name, token)
        }
      }
      await sleep(LOCK_RETRY_MS)
    }
    return null
  }

  // Runs under a lock because two instances creating the same Y.Text would produce two
  // competing types, and edits to the losing one would vanish.
  async reconcileTree(): Promise<void> {
    const files = await this.storage.catalog.listFiles(this.projectId)
    this.canonicalTree = new Map(
      files.map((file) => [file.id, { path: file.path, kind: file.kind }]),
    )
    const done = await this.withLock(`tree:${this.projectId}`, async () => {
      await this.catchUp()
      this.doc.transact(() => this.applyCanonicalTree(), SERVER_ORIGIN)
      await this.appends
      return true
    })
    if (!done) this.logger.warn('tree lock busy, leaving reconcile to its holder')
  }

  private applyCanonicalTree(): void {
    for (const [id, entry] of this.canonicalTree) {
      const current = this.tree.get(id)
      if (current?.path !== entry.path || current?.kind !== entry.kind) this.tree.set(id, entry)
      if (entry.kind === 'FILE' && !(this.files.get(id) instanceof Y.Text)) {
        this.files.set(id, new Y.Text())
      }
    }
    for (const id of [...this.tree.keys()]) {
      if (!this.canonicalTree.has(id)) this.tree.delete(id)
    }
    for (const id of [...this.files.keys()]) {
      if (this.canonicalTree.get(id)?.kind !== 'FILE') this.files.delete(id)
    }
  }

  // A CRDT update cannot be inspected reliably before it is applied, because most items name a
  // neighbour instead of their parent. So writes are checked after applying and repaired with
  // ordinary edits, which every replica converges on. Clients may only edit file text.
  private readonly guardTransaction = (transaction: Y.Transaction): void => {
    const connection = transaction.origin
    if (!(connection instanceof Connection)) return

    const illegal: Array<Y.AbstractType<any>> = []
    const oversized: Y.Text[] = []
    for (const type of transaction.changed.keys()) {
      if (type instanceof Y.Text && type.parent === this.files) {
        if (type.length > COLLAB_LIMITS.maxFileChars) oversized.push(type)
      } else {
        illegal.push(type)
      }
    }
    if (illegal.length === 0 && oversized.length === 0) return

    this.doc.transact((repair) => {
      for (const type of illegal) {
        if (type === this.tree || type === this.files) continue
        if (type._item) {
          type._item.delete(repair)
        } else {
          for (let item = type._start; item; item = item.right) item.delete(repair)
          type._map.forEach((item) => item.delete(repair))
        }
      }
      for (const text of oversized) {
        text.delete(COLLAB_LIMITS.maxFileChars, text.length - COLLAB_LIMITS.maxFileChars)
      }
      this.applyCanonicalTree()
    }, SERVER_ORIGIN)

    this.logger.warn({ userId: connection.userId, illegal: illegal.length }, 'repaired client write')
    if (illegal.length > 0) connection.close(WsCloseCode.forbidden, 'illegal document write')
    else connection.close(WsCloseCode.frameTooLarge, 'file size limit exceeded')
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    this.dirty = true
    const frame = encodeSyncUpdate(update)
    for (const connection of this.connections) {
      if (connection !== origin) connection.send(frame)
    }
    if (origin === REMOTE_ORIGIN || origin === REPLAY_ORIGIN) return
    this.appends = this.appends.then(() => this.persist(update))
  }

  // The log append comes first so a peer that sees the update can also find it in the log.
  private async persist(update: Uint8Array): Promise<void> {
    try {
      const pending = await this.storage.log.append(this.projectId, update)
      await this.storage.bus.publish(channels.sync(this.projectId), update)
      if (pending >= this.options.maxPendingUpdates) void this.compact()
    } catch (error) {
      // The update is still in memory, and compaction writes that state to PostgreSQL.
      this.appendFailed = true
      this.logger.error({ err: error }, 'failed to append update')
    }
  }

  private readonly onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const clients = [...change.added, ...change.updated, ...change.removed]
    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients)
    // The sender gets its own state back: y-websocket reconnects after 45 seconds without
    // traffic, and this echo is all a lone client receives.
    const frame = encodeAwareness(update)
    for (const connection of this.connections) connection.send(frame)
    if (origin === REMOTE_ORIGIN) return
    this.storage.bus.publish(channels.awareness(this.projectId), update).catch((error: unknown) => {
      this.logger.error({ err: error }, 'failed to publish awareness')
    })
  }

  private onControl(payload: Uint8Array): void {
    let message: RoomControl
    try {
      message = roomControlSchema.parse(JSON.parse(Buffer.from(payload).toString('utf8')))
    } catch (error) {
      this.logger.error({ err: error }, 'dropped invalid control message')
      return
    }
    this.applyControl(message)
  }

  applyControl(message: RoomControl): void {
    switch (message.type) {
      case 'role.changed':
        for (const connection of this.connections) {
          if (connection.userId !== message.userId) continue
          const couldWrite = this.canWrite(connection)
          connection.role = message.role
          if (!couldWrite && this.canWrite(connection)) {
            connection.send(encodeSyncStep1(this.doc))
          }
        }
        break
      case 'member.removed':
        for (const connection of this.connections) {
          if (connection.userId === message.userId) {
            connection.close(WsCloseCode.forbidden, 'removed from room')
          }
        }
        break
      case 'room.locked':
        this.setLocked(message.locked)
        break
      case 'tree.changed':
        if (message.projectId !== this.projectId) break
        this.reconcileTree().catch((error: unknown) => {
          this.logger.error({ err: error }, 'tree reconcile failed')
        })
        break
    }
  }

  setLocked(locked: boolean): void {
    const wasLocked = this.locked
    this.locked = locked
    if (!wasLocked || locked) return
    for (const connection of this.connections) {
      if (this.canWrite(connection)) connection.send(encodeSyncStep1(this.doc))
    }
  }

  private canWrite(connection: Connection): boolean {
    return connection.role !== 'viewer' && !this.locked
  }

  addConnection(connection: Connection): void {
    this.connections.add(connection)
    // Viewers get no step 1, because step 1 asks the receiver to send back its updates.
    if (this.canWrite(connection)) connection.send(encodeSyncStep1(this.doc))
    if (this.awareness.getStates().size > 0) {
      connection.send(encodeAwareness(this.encodeAllAwareness()))
    }
  }

  removeConnection(connection: Connection): void {
    this.connections.delete(connection)
    const owned = [...connection.awarenessClients]
    for (const clientId of owned) this.awarenessOwners.delete(clientId)
    awarenessProtocol.removeAwarenessStates(this.awareness, owned, connection)
  }

  private encodeAllAwareness(): Uint8Array {
    return awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
      ...this.awareness.getStates().keys(),
    ])
  }

  handleFrame(connection: Connection, frame: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(frame)
      const type = decoding.readVarUint(decoder)
      switch (type) {
        case WsMessageType.sync:
          this.handleSync(connection, decoder)
          break
        case WsMessageType.awareness:
          this.handleAwareness(connection, decoder)
          break
        case WsMessageType.queryAwareness:
          connection.send(encodeAwareness(this.encodeAllAwareness()))
          break
        case WsMessageType.app:
          this.handleApp(connection, decoder)
          break
        default:
          throw new ProtocolError(WsCloseCode.malformed, 'unknown message type')
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        connection.close(error.closeCode, error.message)
      } else {
        this.logger.warn({ err: error, userId: connection.userId }, 'malformed frame')
        connection.close(WsCloseCode.malformed, 'malformed frame')
      }
    }
  }

  private handleSync(connection: Connection, decoder: decoding.Decoder): void {
    const subtype = decoding.readVarUint(decoder)
    if (subtype === syncProtocol.messageYjsSyncStep1) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, WsMessageType.sync)
      syncProtocol.readSyncStep1(decoder, encoder, this.doc)
      connection.send(encoding.toUint8Array(encoder))
      return
    }
    if (subtype !== syncProtocol.messageYjsSyncStep2 && subtype !== syncProtocol.messageYjsUpdate) {
      throw new ProtocolError(WsCloseCode.malformed, 'unknown sync message')
    }
    // Both subtypes carry document updates, so both must be gated.
    if (!this.canWrite(connection)) {
      this.denyWrite(connection)
      return
    }
    const update = decoding.readVarUint8Array(decoder)
    this.trackClients(connection, Y.parseUpdateMeta(update))
    Y.applyUpdate(this.doc, update, connection)
    // Updates with missing dependencies wait in memory, which a hostile client could exploit.
    const pending = this.doc.store.pendingStructs?.update.byteLength ?? 0
    if (pending > COLLAB_LIMITS.maxPendingUpdateBytes) {
      this.doc.store.pendingStructs = null
      throw new ProtocolError(WsCloseCode.frameTooLarge, 'too many unresolved updates')
    }
  }

  private denyWrite(connection: Connection): void {
    connection.deniedWrites += 1
    connection.send(encodePermissionDenied('read-only'))
    if (connection.deniedWrites >= COLLAB_LIMITS.maxDeniedWrites) {
      throw new ProtocolError(WsCloseCode.forbidden, 'write not permitted')
    }
  }

  private trackClients(
    connection: Connection,
    meta: { from: Map<number, number>; to: Map<number, number> },
  ): void {
    const fresh = [...meta.to.keys()].filter((clientId) => !connection.yjsClients.has(clientId))
    if (fresh.length === 0) return
    for (const clientId of fresh) connection.yjsClients.add(clientId)
    if (connection.yjsClients.size > COLLAB_LIMITS.maxYjsClientsPerConnection) {
      throw new ProtocolError(WsCloseCode.forbidden, 'too many client ids')
    }
    this.storage.catalog
      .recordClients(this.projectId, connection.userId, fresh)
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'failed to record yjs clients')
      })
  }

  private handleAwareness(connection: Connection, decoder: decoding.Decoder): void {
    const entries = decodeAwarenessUpdate(decoding.readVarUint8Array(decoder))
    // Every state fans out to the whole room, so excess updates are dropped, not disconnected.
    if (!connection.awarenessBucket.take()) return
    const accepted = entries.flatMap((entry) => {
      if (!this.claimAwarenessClient(connection, entry.clientId)) return []
      return [{ ...entry, state: entry.state && this.serverPresence(connection, entry.state) }]
    })
    if (accepted.length === 0) return
    awarenessProtocol.applyAwarenessUpdate(
      this.awareness,
      encodeAwarenessEntries(accepted),
      connection,
    )
  }

  // Identity comes from the verified token, never from the client.
  private serverPresence(connection: Connection, state: unknown): PresenceState {
    const parsed = clientPresenceSchema.safeParse(state)
    if (!parsed.success) throw new ProtocolError(WsCloseCode.malformed, 'invalid presence state')
    return {
      ...parsed.data,
      userId: connection.userId,
      name: connection.name,
      initials: initialsFor(connection.name),
      color: colorForUser(connection.userId),
    }
  }

  private claimAwarenessClient(connection: Connection, clientId: number): boolean {
    const owner = this.awarenessOwners.get(clientId)
    if (owner === connection) return true
    // A reconnecting user takes over from a socket the server has not seen die yet.
    if (owner && owner.userId !== connection.userId) return false
    if (!owner) {
      // A state with no local owner belongs to a user on another instance.
      const state = this.awareness.getStates().get(clientId)
      if (state && state['userId'] !== connection.userId) return false
    }
    if (connection.awarenessClients.size >= COLLAB_LIMITS.maxAwarenessClientsPerConnection) {
      return false
    }
    owner?.awarenessClients.delete(clientId)
    connection.awarenessClients.add(clientId)
    this.awarenessOwners.set(clientId, connection)
    return true
  }

  // Chat and execution events arrive in later features, so nothing is accepted yet.
  private handleApp(connection: Connection, decoder: decoding.Decoder): void {
    const envelope = appEnvelopeSchema.parse(JSON.parse(decoding.readVarString(decoder)))
    connection.send(
      encodeApp({
        v: 1,
        t: 'error',
        ...(envelope.id ? { id: envelope.id } : {}),
        d: { code: 'unsupported_event', message: `unsupported event ${envelope.t}` },
      }),
    )
  }

  // Pulls in anything a dropped pub/sub message left out. Replayed updates reach local clients.
  private async catchUp(): Promise<void> {
    for (const update of await this.storage.log.read(this.projectId)) {
      this.applyTrusted(update, REPLAY_ORIGIN)
    }
  }

  private async tick(): Promise<void> {
    try {
      if (this.connections.size > 0) await this.catchUp()
      if (this.dirty) await this.compact()
    } catch (error) {
      this.logger.error({ err: error }, 'room tick failed')
    }
  }

  compact(): Promise<boolean> {
    if (this.compacting) return this.compacting
    this.compacting = this.runCompaction()
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'compaction failed')
        return false
      })
      .finally(() => {
        this.compacting = null
      })
    return this.compacting
  }

  private async runCompaction(): Promise<boolean> {
    await this.appends
    const hadFailedAppends = this.appendFailed
    this.dirty = false
    const saved = await this.withLock(`compact:${this.projectId}`, async () => {
      const updates = await this.storage.log.read(this.projectId)
      if (updates.length === 0 && !hadFailedAppends) return true
      const stored = await this.storage.docs.load(this.projectId)

      // Built from the shared log, not just this.doc, which can lag behind other instances.
      const merged = new Y.Doc()
      try {
        if (stored.state) Y.applyUpdate(merged, stored.state)
        for (const update of updates) Y.applyUpdate(merged, update)
        Y.applyUpdate(merged, Y.encodeStateAsUpdate(this.doc))
        const state = Y.encodeStateAsUpdate(merged)
        if (!(await this.storage.docs.save(this.projectId, state, stored.version))) return false
      } finally {
        merged.destroy()
      }
      // A crash before this trim only replays updates that Yjs will ignore.
      await this.storage.log.trim(this.projectId, updates.length)
      if (hadFailedAppends) this.appendFailed = false
      return true
    })
    if (saved === true) return true
    this.dirty = true
    // A busy lock is safe when this instance's updates are already in the shared log.
    return saved === null && !hadFailedAppends
  }

  async destroy(): Promise<void> {
    clearInterval(this.timer)
    await Promise.allSettled(this.unsubscribers.map((unsubscribe) => unsubscribe()))
    this.doc.off('afterTransaction', this.guardTransaction)
    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    this.awareness.destroy()
    this.doc.destroy()
  }
}
