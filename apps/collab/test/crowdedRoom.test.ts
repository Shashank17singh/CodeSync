import type { CollabSession } from '@codesync/collab-client'
import { COLLAB_LIMITS } from '@codesync/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProtocolError, decodeAwarenessUpdate, encodeAwarenessEntries } from '../src/protocol/frames.js'
import { createHarness, fileText, waitFor, type Harness } from './helpers.js'

describe('a room with many people', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })
  afterEach(() => harness.stop())

  const framesHandled = async (port: number): Promise<number> => {
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()
    return Number(/^codesync_collab_frames_total (\S+)$/m.exec(text)?.[1])
  }

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

  // Arrivals one at a time, so each newcomer receives everyone already there in one message.
  it('lets people keep joining after the first few', async () => {
    const server = await harness.start()
    const sessions: CollabSession[] = []
    for (let index = 0; index < 12; index++) {
      const session = await harness.connect(server, harness.user())
      await waitFor(() => session.presence.getPeers().length === index)
      sessions.push(session)
    }
    await settle()
    expect(sessions.every((session) => session.provider.wsconnected)).toBe(true)

    fileText(sessions[11]!.doc).insert(0, 'from the last to join')
    await waitFor(() => fileText(sessions[0]!.doc).toString().includes('from the last to join'))
  })

  it('sends one message for a cursor move, not one from everyone who saw it', async () => {
    const server = await harness.start()
    const sessions: CollabSession[] = []
    for (let index = 0; index < 4; index++) {
      sessions.push(await harness.connect(server, harness.user()))
    }
    await settle()

    const before = await framesHandled(server.port)
    sessions[0]!.presence.setFile('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    await waitFor(() =>
      sessions[3]!.presence
        .getPeers()
        .some((peer) => peer.fileId === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    )
    await settle()
    expect((await framesHandled(server.port)) - before).toBe(1)
  })

  it('still refuses a frame with more entries than a full room could need', () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_item, index) => ({
        clientId: index + 1,
        clock: 1,
        state: {},
      }))
    const limit = COLLAB_LIMITS.maxAwarenessEntriesPerFrame
    expect(limit).toBeGreaterThanOrEqual(COLLAB_LIMITS.maxUsersPerRoom)
    expect(decodeAwarenessUpdate(encodeAwarenessEntries(entries(limit)))).toHaveLength(limit)
    expect(() => decodeAwarenessUpdate(encodeAwarenessEntries(entries(limit + 1)))).toThrow(
      ProtocolError,
    )
  })

  it('keeps everyone connected when the whole room moves at once', async () => {
    const server = await harness.start()
    const sessions: CollabSession[] = []
    for (let index = 0; index < 12; index++) {
      sessions.push(await harness.connect(server, harness.user()))
    }
    for (let round = 0; round < 10; round++) {
      sessions.forEach((session, index) => {
        session.presence.setFile(`aaaaaaaa-aaaa-4aaa-8aaa-${String(round * 100 + index).padStart(12, '0')}`)
      })
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    await settle()
    expect(sessions.every((session) => session.provider.wsconnected)).toBe(true)
  })
})
