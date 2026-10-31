import { CHAT_LIMITS, COLLAB_LIMITS, type CollabRole } from '@codesync/shared'
import type { Logger } from 'pino'
import { WebSocket } from 'ws'
import { TokenBucket } from '../limits/tokenBucket.js'

export class Connection {
  readonly messageBucket = new TokenBucket(
    COLLAB_LIMITS.messagesPerSecond,
    COLLAB_LIMITS.messageBurst,
  )
  readonly byteBucket = new TokenBucket(COLLAB_LIMITS.bytesPerSecond, COLLAB_LIMITS.byteBurst)
  readonly awarenessBucket = new TokenBucket(
    COLLAB_LIMITS.awarenessPerSecond,
    COLLAB_LIMITS.awarenessBurst,
  )
  readonly chatBucket = new TokenBucket(CHAT_LIMITS.messagesPerSecond, CHAT_LIMITS.messageBurst)
  readonly typingBucket = new TokenBucket(CHAT_LIMITS.typingPerSecond, 2)
  readonly awarenessClients = new Set<number>()
  readonly yjsClients = new Set<number>()
  deniedWrites = 0
  alive = true

  constructor(
    readonly id: string,
    readonly ws: WebSocket,
    readonly projectId: string,
    readonly userId: string,
    readonly name: string,
    public role: CollabRole,
    private readonly logger: Logger,
  ) {}

  send(frame: Uint8Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    // A reader that stops draining must not grow server memory without bound.
    if (this.ws.bufferedAmount > COLLAB_LIMITS.maxBufferedBytes) {
      this.logger.warn({ connectionId: this.id }, 'terminating slow consumer')
      this.ws.terminate()
      return
    }
    this.ws.send(frame, { binary: true })
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code, reason)
  }
}
