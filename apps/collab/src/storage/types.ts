import { collabKeys, type CollabRole, type TreeEntry } from '@codesync/shared'

export interface StoredDoc {
  state: Uint8Array | null
  version: number
}

export interface RoomAccess {
  role: CollabRole
  locked: boolean
}

export interface CatalogFile extends TreeEntry {
  id: string
}

// Pending updates between compactions. Shared by every collab instance.
export interface UpdateLog {
  append(projectId: string, update: Uint8Array): Promise<number>
  read(projectId: string): Promise<Uint8Array[]>
  trim(projectId: string, count: number): Promise<void>
}

export interface Locks {
  acquire(name: string, ttlMs: number): Promise<string | null>
  release(name: string, token: string): Promise<void>
}

export interface Bus {
  subscribe(channel: string, handler: (payload: Uint8Array) => void): Promise<() => Promise<void>>
  publish(channel: string, payload: Uint8Array): Promise<void>
}

// Connection slots are counted across instances so the room limit holds when scaled out.
export interface Slots {
  acquire(projectId: string, connectionId: string, max: number, ttlMs: number): Promise<boolean>
  renew(projectId: string, connectionId: string, ttlMs: number): Promise<void>
  release(projectId: string, connectionId: string): Promise<void>
}

export interface DocStore {
  load(projectId: string): Promise<StoredDoc>
  // Returns false when expectedVersion is stale, so a slower compactor cannot overwrite a newer one.
  save(projectId: string, state: Uint8Array, expectedVersion: number): Promise<boolean>
}

export interface Catalog {
  resolveAccess(roomId: string, projectId: string, userId: string): Promise<RoomAccess | null>
  listFiles(projectId: string): Promise<CatalogFile[]>
  recordClients(projectId: string, userId: string, clientIds: number[]): Promise<void>
}

export interface ChatPost {
  roomId: string
  authorId: string
  body: string
  mentions: string[]
}

export interface StoredChatMessage {
  id: string
  body: string
  mentionedUserIds: string[]
  createdAt: Date
  // Notification rows made for this message, one per mentioned user.
  notifications: Array<{ id: string; userId: string }>
}

export interface ChatStore {
  // Applies the room's profanity setting and keeps only mentions of real members.
  post(message: ChatPost): Promise<StoredChatMessage>
}

export interface Storage {
  log: UpdateLog
  locks: Locks
  bus: Bus
  slots: Slots
  docs: DocStore
  catalog: Catalog
  chat: ChatStore
}

export const channels = {
  sync: collabKeys.sync,
  awareness: collabKeys.awareness,
  control: collabKeys.control,
  events: collabKeys.events,
}
