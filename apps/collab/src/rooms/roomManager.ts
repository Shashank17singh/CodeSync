import type { Logger } from 'pino'
import type { ServerConfig } from '../config.js'
import type { Storage } from '../storage/types.js'
import { Room } from './room.js'

interface Entry {
  room: Promise<Room>
  references: number
}

export class RoomManager {
  private readonly entries = new Map<string, Entry>()
  private readonly closing = new Set<string>()
  private readonly sweeper: NodeJS.Timeout

  constructor(
    private readonly storage: Storage,
    private readonly config: ServerConfig,
    private readonly logger: Logger,
  ) {
    // Retries rooms whose final compaction failed, so their state is not dropped from memory.
    this.sweeper = setInterval(() => this.sweep(), config.compactionIntervalMs)
    this.sweeper.unref()
  }

  async acquire(projectId: string, roomId: string): Promise<Room> {
    let entry = this.entries.get(projectId)
    if (!entry) {
      entry = {
        references: 0,
        room: Room.open({
          projectId,
          roomId,
          storage: this.storage,
          logger: this.logger,
          compactionIntervalMs: this.config.compactionIntervalMs,
          snapshotIntervalMs: this.config.snapshotIntervalMs,
          maxPendingUpdates: this.config.maxPendingUpdates,
        }),
      }
      this.entries.set(projectId, entry)
    }
    // Counted before awaiting, so a concurrent close cannot unload a room being joined.
    entry.references += 1
    try {
      return await entry.room
    } catch (error) {
      if (this.entries.get(projectId) === entry) this.entries.delete(projectId)
      throw error
    }
  }

  release(projectId: string): void {
    const entry = this.entries.get(projectId)
    if (!entry) return
    entry.references -= 1
    if (entry.references === 0) void this.closeIfIdle(projectId)
  }

  private sweep(): void {
    for (const [projectId, entry] of this.entries) {
      if (entry.references === 0) void this.closeIfIdle(projectId)
    }
  }

  private async closeIfIdle(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId)
    if (!entry || this.closing.has(projectId)) return
    this.closing.add(projectId)
    try {
      const room = await entry.room
      const compacted = await room.compact()
      if (!compacted || entry.references > 0) return
      this.entries.delete(projectId)
      await room.destroy()
    } catch (error) {
      this.logger.error({ err: error, projectId }, 'failed to close room')
    } finally {
      this.closing.delete(projectId)
    }
  }

  get activeRooms(): number {
    return this.entries.size
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper)
    const entries = [...this.entries.values()]
    this.entries.clear()
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const room = await entry.room
        await room.compact()
        await room.destroy()
      }),
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error({ err: result.reason }, 'failed to close room during shutdown')
      }
    }
  }
}
