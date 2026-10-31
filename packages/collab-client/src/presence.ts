import {
  PRESENCE_TIMINGS,
  presenceStateSchema,
  type ClientPresence,
  type PresenceCursor,
  type PresenceState,
  type PresenceStatus,
} from '@codesync/shared'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'

export interface PresencePeer extends PresenceState {
  clientId: number
}

export function createCursor(text: Y.Text, anchor: number, head: number): PresenceCursor {
  return {
    anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, anchor)),
    head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, head)),
  }
}

export interface ResolvedCursor {
  anchor: number
  head: number
}

// Returns null for a position that no longer exists or belongs to another file.
export function resolveCursor(text: Y.Text, cursor: PresenceCursor): ResolvedCursor | null {
  const { doc } = text
  if (!doc) return null
  const resolve = (position: PresenceCursor['anchor']): number | null => {
    const relative = Y.createRelativePositionFromJSON(position)
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc)
    return absolute?.type === text ? absolute.index : null
  }
  try {
    const anchor = resolve(cursor.anchor)
    const head = resolve(cursor.head)
    return anchor === null || head === null ? null : { anchor, head }
  } catch {
    return null
  }
}

export class PresenceTracker {
  private peers: readonly PresencePeer[] = []
  private readonly listeners = new Set<() => void>()
  private pendingCursor: PresenceCursor | null | undefined
  private cursorTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private lastCursorSentAt = Number.NEGATIVE_INFINITY
  private visible = true

  constructor(private readonly awareness: Awareness) {
    awareness.on('change', this.onChange)
  }

  // y-protocols ignores a client's untouched initial state, so this must run on connect.
  start(): void {
    this.write({ fileId: null, cursor: null, status: 'active' })
    this.armIdleTimer()
  }

  // A reconnect resends the same clock, which a server that kept it would ignore.
  announce(): void {
    const state = this.awareness.getLocalState()
    if (state) this.awareness.setLocalState(state)
  }

  private write(patch: ClientPresence): void {
    this.awareness.setLocalState({ ...this.awareness.getLocalState(), ...patch })
  }

  setFile(fileId: string | null): void {
    this.dropPendingCursor()
    this.write({ fileId, cursor: null })
  }

  setCursor(cursor: PresenceCursor | null): void {
    const elapsed = performance.now() - this.lastCursorSentAt
    if (elapsed >= PRESENCE_TIMINGS.cursorThrottleMs) {
      this.sendCursor(cursor)
      return
    }
    // Only the newest position matters, so it replaces anything already waiting.
    this.pendingCursor = cursor
    this.cursorTimer ??= setTimeout(() => {
      this.cursorTimer = undefined
      const pending = this.pendingCursor
      this.pendingCursor = undefined
      if (pending !== undefined) this.sendCursor(pending)
    }, PRESENCE_TIMINGS.cursorThrottleMs - elapsed)
  }

  private sendCursor(cursor: PresenceCursor | null): void {
    this.lastCursorSentAt = performance.now()
    this.write({ cursor })
  }

  private dropPendingCursor(): void {
    clearTimeout(this.cursorTimer)
    this.cursorTimer = undefined
    this.pendingCursor = undefined
  }

  noteActivity(): void {
    this.armIdleTimer()
    if (this.visible) this.setStatus('active')
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) this.noteActivity()
    else this.setStatus('away')
  }

  private armIdleTimer(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.visible) this.setStatus('idle')
    }, PRESENCE_TIMINGS.idleAfterMs)
  }

  private setStatus(status: PresenceStatus): void {
    if (this.awareness.getLocalState()?.['status'] !== status) this.write({ status })
  }

  get clientId(): number {
    return this.awareness.clientID
  }

  getPeers = (): readonly PresencePeer[] => this.peers

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private readonly onChange = (): void => {
    const peers: PresencePeer[] = []
    this.awareness.getStates().forEach((state, clientId) => {
      if (clientId === this.awareness.clientID) return
      // Skips the moment before the server has stamped a peer's identity onto its state.
      const parsed = presenceStateSchema.safeParse(state)
      if (parsed.success) peers.push({ ...parsed.data, clientId })
    })
    this.peers = peers.sort((a, b) => a.name.localeCompare(b.name) || a.clientId - b.clientId)
    for (const listener of this.listeners) listener()
  }

  destroy(): void {
    this.dropPendingCursor()
    clearTimeout(this.idleTimer)
    this.awareness.off('change', this.onChange)
    this.listeners.clear()
  }
}

export interface FollowOptions {
  doc: Y.Doc
  presence: PresenceTracker
  onOpenFile: (fileId: string) => void
  onReveal: (fileId: string, cursor: PresenceCursor) => void
}

export class FollowController {
  private target: number | null = null
  private fileId: string | null = null
  private cursor: string | null = null
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void

  constructor(private readonly options: FollowOptions) {
    this.unsubscribe = options.presence.subscribe(this.onPeers)
    options.doc.on('afterTransaction', this.onTransaction)
  }

  get following(): number | null {
    return this.target
  }

  getFollowing = (): number | null => this.target

  follow(clientId: number): void {
    this.fileId = null
    this.cursor = null
    this.target = clientId
    this.notify()
    this.onPeers()
  }

  stop(): void {
    if (this.target === null) return
    this.target = null
    this.notify()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private readonly onPeers = (): void => {
    if (this.target === null) return
    const peer = this.options.presence.getPeers().find((item) => item.clientId === this.target)
    if (!peer) {
      this.stop()
      return
    }
    if (!peer.fileId) return
    if (peer.fileId !== this.fileId) {
      this.fileId = peer.fileId
      this.options.onOpenFile(peer.fileId)
    }
    const cursor = peer.cursor ? JSON.stringify(peer.cursor.head) : null
    if (peer.cursor && cursor !== this.cursor) this.options.onReveal(peer.fileId, peer.cursor)
    this.cursor = cursor
  }

  // Local transactions are this user's own edits. Remote updates arrive as non-local ones,
  // so watching the document separates typing from text the followed user is writing.
  private readonly onTransaction = (transaction: Y.Transaction): void => {
    if (transaction.local && transaction.changed.size > 0) this.stop()
  }

  destroy(): void {
    this.unsubscribe()
    this.options.doc.off('afterTransaction', this.onTransaction)
    this.listeners.clear()
  }
}
