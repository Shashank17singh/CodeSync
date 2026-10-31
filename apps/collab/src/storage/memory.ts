import { randomUUID } from 'node:crypto'
import type {
  Bus,
  Catalog,
  CatalogFile,
  DocStore,
  Locks,
  RoomAccess,
  Slots,
  Storage,
  StoredDoc,
  UpdateLog,
} from './types.js'

// One hub stands in for the Redis and PostgreSQL shared by several collab instances.
export class MemoryHub {
  readonly updates = new Map<string, Uint8Array[]>()
  readonly docs = new Map<string, StoredDoc>()
  readonly files = new Map<string, CatalogFile[]>()
  readonly access = new Map<string, RoomAccess>()
  readonly clients = new Map<string, string>()
  readonly locks = new Map<string, { token: string; expiresAt: number }>()
  readonly slots = new Map<string, Map<string, number>>()
  readonly listeners = new Map<string, Set<(payload: Uint8Array) => void>>()

  setAccess(userId: string, access: RoomAccess): void {
    this.access.set(userId, access)
  }

  storage(): Storage {
    return {
      log: new MemoryUpdateLog(this),
      locks: new MemoryLocks(this),
      bus: new MemoryBus(this),
      slots: new MemorySlots(this),
      docs: new MemoryDocStore(this),
      catalog: new MemoryCatalog(this),
    }
  }
}

class MemoryUpdateLog implements UpdateLog {
  constructor(private readonly hub: MemoryHub) {}

  async append(projectId: string, update: Uint8Array): Promise<number> {
    const list = this.hub.updates.get(projectId) ?? []
    list.push(update)
    this.hub.updates.set(projectId, list)
    return list.length
  }

  async read(projectId: string): Promise<Uint8Array[]> {
    return [...(this.hub.updates.get(projectId) ?? [])]
  }

  async trim(projectId: string, count: number): Promise<void> {
    this.hub.updates.get(projectId)?.splice(0, count)
  }
}

class MemoryLocks implements Locks {
  constructor(private readonly hub: MemoryHub) {}

  async acquire(name: string, ttlMs: number): Promise<string | null> {
    const held = this.hub.locks.get(name)
    if (held && held.expiresAt > Date.now()) return null
    const token = randomUUID()
    this.hub.locks.set(name, { token, expiresAt: Date.now() + ttlMs })
    return token
  }

  async release(name: string, token: string): Promise<void> {
    if (this.hub.locks.get(name)?.token === token) this.hub.locks.delete(name)
  }
}

// Delivery skips the publishing instance, matching RedisBus.
class MemoryBus implements Bus {
  private readonly own = new Set<(payload: Uint8Array) => void>()

  constructor(private readonly hub: MemoryHub) {}

  async subscribe(
    channel: string,
    handler: (payload: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    const set = this.hub.listeners.get(channel) ?? new Set()
    set.add(handler)
    this.own.add(handler)
    this.hub.listeners.set(channel, set)
    return async () => {
      set.delete(handler)
      this.own.delete(handler)
    }
  }

  async publish(channel: string, payload: Uint8Array): Promise<void> {
    for (const handler of this.hub.listeners.get(channel) ?? []) {
      if (!this.own.has(handler)) queueMicrotask(() => handler(payload))
    }
  }
}

class MemorySlots implements Slots {
  constructor(private readonly hub: MemoryHub) {}

  private live(projectId: string): Map<string, number> {
    const slots = this.hub.slots.get(projectId) ?? new Map<string, number>()
    for (const [id, expiresAt] of slots) if (expiresAt <= Date.now()) slots.delete(id)
    this.hub.slots.set(projectId, slots)
    return slots
  }

  async acquire(
    projectId: string,
    connectionId: string,
    max: number,
    ttlMs: number,
  ): Promise<boolean> {
    const slots = this.live(projectId)
    if (slots.size >= max) return false
    slots.set(connectionId, Date.now() + ttlMs)
    return true
  }

  async renew(projectId: string, connectionId: string, ttlMs: number): Promise<void> {
    this.live(projectId).set(connectionId, Date.now() + ttlMs)
  }

  async release(projectId: string, connectionId: string): Promise<void> {
    this.live(projectId).delete(connectionId)
  }
}

class MemoryDocStore implements DocStore {
  constructor(private readonly hub: MemoryHub) {}

  async load(projectId: string): Promise<StoredDoc> {
    return this.hub.docs.get(projectId) ?? { state: null, version: 0 }
  }

  async save(projectId: string, state: Uint8Array, expectedVersion: number): Promise<boolean> {
    if ((this.hub.docs.get(projectId)?.version ?? 0) !== expectedVersion) return false
    this.hub.docs.set(projectId, { state, version: expectedVersion + 1 })
    return true
  }
}

class MemoryCatalog implements Catalog {
  constructor(private readonly hub: MemoryHub) {}

  async resolveAccess(
    _roomId: string,
    _projectId: string,
    userId: string,
  ): Promise<RoomAccess | null> {
    return this.hub.access.get(userId) ?? null
  }

  async listFiles(projectId: string): Promise<CatalogFile[]> {
    return this.hub.files.get(projectId) ?? []
  }

  async recordClients(projectId: string, userId: string, clientIds: number[]): Promise<void> {
    for (const id of clientIds) {
      const key = `${projectId}:${id}`
      if (!this.hub.clients.has(key)) this.hub.clients.set(key, userId)
    }
  }
}
