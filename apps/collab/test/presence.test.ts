import {
  COLLAB_LIMITS,
  PRESENCE_PALETTE,
  PRESENCE_TIMINGS,
  WsCloseCode,
  colorForUser,
  initialsFor,
  type PresenceCursor,
} from '@codesync/shared'
import {
  FollowController,
  PresenceTracker,
  createCursor,
  resolveCursor,
  type CollabSession,
} from '@codesync/collab-client'
import * as encoding from 'lib0/encoding'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { CollabServer } from '../src/server.js'
import {
  FILE_ID,
  PROJECT_ID,
  createHarness,
  fileText,
  rawClient,
  waitFor,
  type Harness,
} from './helpers.js'

const SECOND_FILE_ID = '66666666-6666-4666-8666-666666666666'
const MEMBER_ID = '77777777-7777-4777-8777-777777777777'

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
  const [r, g, b] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('identity helpers', () => {
  it('gives every palette color at least 4.5:1 contrast with white text', () => {
    for (const color of PRESENCE_PALETTE) {
      expect((1 + 0.05) / (relativeLuminance(color) + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('assigns a stable color from the user id', () => {
    expect(colorForUser(MEMBER_ID)).toBe(colorForUser(MEMBER_ID))
    expect(PRESENCE_PALETTE).toContain(colorForUser(MEMBER_ID))
  })

  it('spreads users across the palette', () => {
    const ids = Array.from({ length: 200 }, (_value, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    )
    expect(new Set(ids.map(colorForUser)).size).toBe(PRESENCE_PALETTE.length)
  })

  it.each([
    ['Ada Lovelace', 'AL'],
    ['ada', 'A'],
    ['  grace   brewster  hopper ', 'GH'],
    ['आदित्य शर्मा', 'आश'],
    ['😀 Smile', '😀S'],
    ['   ', '?'],
  ])('derives initials from %j', (name, expected) => {
    expect(initialsFor(name)).toBe(expected)
  })
})

describe('presence through the server', () => {
  let harness: Harness
  let server: CollabServer

  beforeEach(async () => {
    harness = createHarness()
    harness.hub.files.get(PROJECT_ID)?.push({
      id: SECOND_FILE_ID,
      path: 'util.py',
      kind: 'FILE',
    })
    server = await harness.start()
  })
  afterEach(() => harness.stop())

  async function joined(count: number): Promise<CollabSession[]> {
    const sessions: CollabSession[] = []
    for (let index = 0; index < count; index++) {
      sessions.push(await harness.connect(server, harness.user()))
    }
    await waitFor(() =>
      sessions.every(
        (session) =>
          fileText(session.doc) !== undefined &&
          session.presence.getPeers().length === sessions.length - 1,
      ),
    )
    return sessions
  }

  it('stamps identity from the token and never from the client', async () => {
    const userId = harness.user()
    const session = await harness.connect(server, userId)
    const observer = await harness.connect(server, harness.user())
    session.provider.awareness.setLocalState({
      status: 'active',
      userId: MEMBER_ID,
      name: 'Administrator',
      color: 'url(evil)',
    })
    await waitFor(() => observer.presence.getPeers()[0]?.status === 'active')
    const peer = observer.presence.getPeers()[0]
    expect(peer?.userId).toBe(userId)
    expect(peer?.name).toBe(`user-${userId.slice(0, 4)}`)
    expect(peer?.color).toBe(colorForUser(userId))
    expect(peer?.initials).toBe(initialsFor(`user-${userId.slice(0, 4)}`))
  })

  it('shows a user as soon as they connect, before they do anything', async () => {
    const [first, second] = await joined(2)
    expect(first?.presence.getPeers()).toHaveLength(1)
    expect(second?.presence.getPeers()[0]?.status).toBe('active')
  })

  it('shares the current file and a cursor that follows edits above it', async () => {
    const [writer, reader] = (await joined(2)) as [CollabSession, CollabSession]
    const text = fileText(writer.doc)
    text.insert(0, 'line one\nline two\n')
    await waitFor(() => fileText(reader.doc).length === text.length)

    writer.presence.setFile(FILE_ID)
    writer.presence.setCursor(createCursor(text, 9, 13))
    await waitFor(() => reader.presence.getPeers()[0]?.cursor != null)
    const peer = reader.presence.getPeers()[0]
    expect(peer?.fileId).toBe(FILE_ID)
    const readerText = fileText(reader.doc)
    expect(resolveCursor(readerText, peer?.cursor as PresenceCursor)).toEqual({
      anchor: 9,
      head: 13,
    })

    text.insert(0, 'inserted\n')
    await waitFor(() => readerText.toString().startsWith('inserted'))
    expect(resolveCursor(readerText, peer?.cursor as PresenceCursor)).toEqual({
      anchor: 18,
      head: 22,
    })
  })

  it('resolves no position for a cursor from another file', async () => {
    const [session] = (await joined(1)) as [CollabSession]
    const cursor = createCursor(session.files.get(FILE_ID) as Y.Text, 0, 0)
    expect(resolveCursor(session.files.get(SECOND_FILE_ID) as Y.Text, cursor)).toBeNull()
  })

  it('removes a user whose socket dies without closing cleanly', async () => {
    const [observer] = (await joined(1)) as [CollabSession]
    const client = rawClient(server, harness.token(harness.user()))
    await client.opened
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    awareness.setLocalState({ status: 'active' })
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [doc.clientID]))
    client.ws.send(encoding.toUint8Array(encoder))
    await waitFor(() => observer.presence.getPeers().length === 1)

    client.ws.terminate()
    await waitFor(() => observer.presence.getPeers().length === 0)
    awareness.destroy()
    doc.destroy()
  })

  it('shows a user again straight after they reconnect to the same server', async () => {
    const [observer, mover] = (await joined(2)) as [CollabSession, CollabSession]
    mover.provider.disconnect()
    await waitFor(() => observer.presence.getPeers().length === 0)
    mover.provider.connect()
    await waitFor(() => observer.presence.getPeers().length === 1, 2_000)
  })

  it('lets a user reclaim presence from a socket the server has not seen die', async () => {
    const userId = harness.user()
    const observer = await harness.connect(server, harness.user())
    const first = await harness.connect(server, userId)
    await waitFor(() => observer.presence.getPeers().length === 1)

    const replacement = new Y.Doc()
    replacement.clientID = first.doc.clientID
    const awareness = new Awareness(replacement)
    awareness.setLocalState({ status: 'active' })
    for (let index = 0; index < 20; index++) awareness.setLocalState({ status: 'away' })
    const second = rawClient(server, harness.token(userId))
    await second.opened
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [replacement.clientID]))
    second.ws.send(encoding.toUint8Array(encoder))

    await waitFor(() => observer.presence.getPeers()[0]?.status === 'away')
    second.ws.close()
    awareness.destroy()
    replacement.destroy()
  })

  it.each([
    ['an unknown status', { status: 'invisible' }],
    ['a file id that is not a uuid', { fileId: '../secret' }],
    ['a malformed cursor', { cursor: { anchor: 'x', head: 1 } }],
    ['a negative position clock', { cursor: { anchor: { item: { client: 1, clock: -1 } }, head: {} } }],
  ])('disconnects a client that sends %s', async (_name, state) => {
    const client = rawClient(server, harness.token(harness.user()))
    await client.opened
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    awareness.setLocalState(state)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [doc.clientID]))
    client.ws.send(encoding.toUint8Array(encoder))
    expect(await client.closed).toBe(WsCloseCode.malformed)
    awareness.destroy()
    doc.destroy()
  })

  it('drops excess presence updates without disconnecting the client', async () => {
    const observer = await harness.connect(server, harness.user())
    const client = rawClient(server, harness.token(harness.user()))
    await client.opened
    const doc = new Y.Doc()
    const awareness = new Awareness(doc)
    let received = 0
    observer.provider.awareness.on('update', () => {
      received += 1
    })
    const updates = COLLAB_LIMITS.awarenessBurst + 40
    for (let index = 0; index < updates; index++) {
      awareness.setLocalState({ status: index % 2 === 0 ? 'idle' : 'away' })
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 1)
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [doc.clientID]))
      client.ws.send(encoding.toUint8Array(encoder))
    }
    await waitFor(() => received >= COLLAB_LIMITS.awarenessBurst)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(received).toBeLessThan(updates)
    expect(client.ws.readyState).toBe(client.ws.OPEN)
    client.ws.close()
    awareness.destroy()
    doc.destroy()
  })

  describe('follow mode', () => {
    interface Followed {
      leader: CollabSession
      follower: CollabSession
      controller: FollowController
      opened: string[]
      revealed: PresenceCursor[]
    }

    async function following(): Promise<Followed> {
      const [leader, follower] = (await joined(2)) as [CollabSession, CollabSession]
      const opened: string[] = []
      const revealed: PresenceCursor[] = []
      const controller = new FollowController({
        doc: follower.doc,
        presence: follower.presence,
        onOpenFile: (fileId) => opened.push(fileId),
        onReveal: (_fileId, cursor) => revealed.push(cursor),
      })
      controller.follow(leader.doc.clientID)
      return { leader, follower, controller, opened, revealed }
    }

    it('jumps to the file the followed user is in', async () => {
      const { leader, opened, controller } = await following()
      leader.presence.setFile(FILE_ID)
      await waitFor(() => opened.at(-1) === FILE_ID)
      leader.presence.setFile(SECOND_FILE_ID)
      await waitFor(() => opened.at(-1) === SECOND_FILE_ID)
      controller.destroy()
    })

    it('opens the current file immediately when following starts', async () => {
      const [leader, follower] = (await joined(2)) as [CollabSession, CollabSession]
      leader.presence.setFile(FILE_ID)
      await waitFor(() => follower.presence.getPeers()[0]?.fileId === FILE_ID)
      const opened: string[] = []
      const controller = new FollowController({
        doc: follower.doc,
        presence: follower.presence,
        onOpenFile: (fileId) => opened.push(fileId),
        onReveal: () => undefined,
      })
      controller.follow(leader.doc.clientID)
      expect(opened).toEqual([FILE_ID])
      controller.destroy()
    })

    it('scrolls with each cursor move', async () => {
      const { leader, revealed, controller } = await following()
      const text = fileText(leader.doc)
      text.insert(0, 'abcdef')
      leader.presence.setFile(FILE_ID)
      leader.presence.setCursor(createCursor(text, 1, 1))
      await waitFor(() => revealed.length === 1)
      await new Promise((resolve) => setTimeout(resolve, PRESENCE_TIMINGS.cursorThrottleMs + 5))
      leader.presence.setCursor(createCursor(text, 4, 4))
      await waitFor(() => revealed.length === 2)
      controller.destroy()
    })

    it('keeps following while the followed user types', async () => {
      const { leader, follower, controller } = await following()
      leader.presence.setFile(FILE_ID)
      fileText(leader.doc).insert(0, 'remote text')
      await waitFor(() => fileText(follower.doc).length === 11)
      expect(controller.following).toBe(leader.doc.clientID)
      controller.destroy()
    })

    it('stops when the follower types', async () => {
      const { leader, follower, controller } = await following()
      const events: Array<number | null> = []
      controller.subscribe(() => events.push(controller.following))
      fileText(follower.doc).insert(0, 'x')
      expect(controller.following).toBeNull()
      expect(events).toEqual([null])

      leader.presence.setFile(SECOND_FILE_ID)
      await new Promise((resolve) => setTimeout(resolve, 50))
      controller.destroy()
    })

    it('ignores the followed user after following stops', async () => {
      const { leader, opened, controller } = await following()
      controller.stop()
      leader.presence.setFile(FILE_ID)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(opened).toEqual([])
      controller.destroy()
    })

    it('stops when the followed user leaves', async () => {
      const { leader, controller } = await following()
      leader.provider.disconnect()
      await waitFor(() => controller.following === null)
      controller.destroy()
    })
  })
})

describe('PresenceTracker timing', () => {
  let doc: Y.Doc
  let awareness: Awareness
  let tracker: PresenceTracker
  let sends: number

  beforeEach(() => {
    vi.useFakeTimers()
    doc = new Y.Doc()
    awareness = new Awareness(doc)
    tracker = new PresenceTracker(awareness)
    tracker.start()
    sends = 0
    awareness.on('update', () => {
      sends += 1
    })
  })

  afterEach(() => {
    tracker.destroy()
    awareness.destroy()
    doc.destroy()
    vi.useRealTimers()
  })

  const status = (): unknown => awareness.getLocalState()?.['status']
  const cursorAt = (index: number): PresenceCursor => ({
    anchor: { assoc: index },
    head: { assoc: index },
  })

  it('limits cursor updates to 20 per second and keeps the newest', () => {
    for (let index = 0; index < 1000; index++) {
      tracker.setCursor(cursorAt(index))
      vi.advanceTimersByTime(1)
    }
    expect(sends).toBeLessThanOrEqual(21)
    expect(sends).toBeGreaterThanOrEqual(19)
    vi.advanceTimersByTime(PRESENCE_TIMINGS.cursorThrottleMs)
    expect(awareness.getLocalState()?.['cursor']).toEqual(cursorAt(999))
  })

  it('sends the first cursor move without delay', () => {
    tracker.setCursor(cursorAt(1))
    expect(sends).toBe(1)
  })

  it('does not let a delayed cursor land in the next file', () => {
    tracker.setFile(FILE_ID)
    tracker.setCursor(cursorAt(1))
    tracker.setCursor(cursorAt(2))
    tracker.setFile(SECOND_FILE_ID)
    vi.advanceTimersByTime(PRESENCE_TIMINGS.cursorThrottleMs * 2)
    expect(awareness.getLocalState()).toMatchObject({ fileId: SECOND_FILE_ID, cursor: null })
  })

  it('goes idle after 60 seconds without activity and returns on activity', () => {
    vi.advanceTimersByTime(PRESENCE_TIMINGS.idleAfterMs - 1)
    expect(status()).toBe('active')
    vi.advanceTimersByTime(1)
    expect(status()).toBe('idle')
    tracker.noteActivity()
    expect(status()).toBe('active')
  })

  it('stays active while activity continues', () => {
    for (let elapsed = 0; elapsed < 5; elapsed++) {
      vi.advanceTimersByTime(PRESENCE_TIMINGS.idleAfterMs - 1)
      tracker.noteActivity()
    }
    expect(status()).toBe('active')
  })

  it('reports away while hidden and stays away past the idle timeout', () => {
    tracker.setVisible(false)
    expect(status()).toBe('away')
    vi.advanceTimersByTime(PRESENCE_TIMINGS.idleAfterMs * 2)
    expect(status()).toBe('away')
    tracker.noteActivity()
    expect(status()).toBe('away')
    tracker.setVisible(true)
    expect(status()).toBe('active')
  })
})
