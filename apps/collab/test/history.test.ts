import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileText, createHarness, waitFor, type Harness } from './helpers.js'

describe('automatic snapshots', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })
  afterEach(() => harness.stop())

  const connect = async (interval: number) => {
    const server = await harness.start({ snapshotIntervalMs: interval })
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    return { server, session }
  }

  it('takes one while people are editing', async () => {
    const { session } = await connect(30)
    fileText(session.doc).insert(0, 'typed')
    await waitFor(() => harness.hub.snapshots.length >= 1)
  })

  it('takes none while nobody edits', async () => {
    await connect(20)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.hub.snapshots).toEqual([])
  })

  it('does not repeat itself once the editing stops', async () => {
    const { session } = await connect(20)
    fileText(session.doc).insert(0, 'typed')
    await waitFor(() => harness.hub.snapshots.length >= 1)
    const taken = harness.hub.snapshots.length
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(harness.hub.snapshots.length).toBe(taken)
  })

  it('takes a single snapshot per interval across two servers', async () => {
    const first = await harness.start({ snapshotIntervalMs: 100 })
    const second = await harness.start({ snapshotIntervalMs: 100 })
    const a = await harness.connect(first, harness.user())
    const b = await harness.connect(second, harness.user())
    await waitFor(() => fileText(a.doc) !== undefined && fileText(b.doc) !== undefined)
    fileText(a.doc).insert(0, 'typed')
    await waitFor(() => fileText(b.doc).length > 0)
    await waitFor(() => harness.hub.snapshots.length >= 1)
    // Both rooms saw the edit. Their timers fire close together, and the lock lasts 90 ms.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(harness.hub.snapshots).toHaveLength(1)
  })

  it('takes a last one when the room closes, so a short session is not lost', async () => {
    const { server, session } = await connect(60_000)
    fileText(session.doc).insert(0, 'short session')
    await waitFor(() => harness.hub.updates.size > 0)
    await session.destroy()
    await waitFor(() => server.rooms.activeRooms === 0, 15_000)
    expect(harness.hub.snapshots).toHaveLength(1)
  }, 20_000)

  it('keeps the room alive when a snapshot cannot be saved', async () => {
    const storage = harness.hub.storage()
    let failed = 0
    storage.snapshots.capture = async () => {
      failed++
      throw new Error('database down')
    }
    const server = await harness.start({ storage, snapshotIntervalMs: 20 })
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    fileText(session.doc).insert(0, 'typed')
    await waitFor(() => failed >= 2)
    expect(session.provider.wsconnected).toBe(true)
  })
})
