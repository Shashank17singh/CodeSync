import type { MemoryHub } from '../../collab/src/storage/memory.js'
import type { BridgeTransport } from '../src/collab/bridge.js'

const SENDER_BYTES = 16

// The real API and the real collab server, sharing one stand-in for Redis.
export function hubTransport(hub: MemoryHub): BridgeTransport {
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
