import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, fileText, waitFor, type Harness } from './helpers.js'

describe('convergence', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })
  afterEach(() => harness.stop())

  async function concurrentEdits(clientCount: number, editsPerClient: number): Promise<void> {
    const server = await harness.start()
    const sessions = await Promise.all(
      Array.from({ length: clientCount }, () => harness.connect(server, harness.user())),
    )
    await waitFor(() => sessions.every((session) => fileText(session.doc) !== undefined))

    for (let round = 0; round < editsPerClient; round++) {
      sessions.forEach((session, index) => {
        const text = fileText(session.doc)
        text.insert(Math.floor(text.length / 2), `[${index}:${round}]`)
      })
      await new Promise((resolve) => setImmediate(resolve))
    }

    const expectedLength = sessions.reduce((total, _session, index) => {
      let length = total
      for (let round = 0; round < editsPerClient; round++) {
        length += `[${index}:${round}]`.length
      }
      return length
    }, 0)
    await waitFor(() =>
      sessions.every((session) => fileText(session.doc).length === expectedLength),
    )
    const contents = new Set(sessions.map((session) => fileText(session.doc).toString()))
    expect(contents.size).toBe(1)
  }

  it('converges with two clients editing concurrently', () => concurrentEdits(2, 50))
  it('converges with ten clients editing concurrently', () => concurrentEdits(10, 20))

  it('merges edits made offline after reconnecting', async () => {
    const server = await harness.start()
    const online = await harness.connect(server, harness.user())
    const offline = await harness.connect(server, harness.user())
    await waitFor(() => fileText(offline.doc) !== undefined && fileText(online.doc) !== undefined)

    fileText(online.doc).insert(0, 'base\n')
    await waitFor(() => fileText(offline.doc).toString() === 'base\n')

    offline.provider.disconnect()
    await waitFor(() => !offline.provider.wsconnected)
    fileText(offline.doc).insert(5, 'offline\n')
    fileText(online.doc).insert(0, 'online\n')
    expect(fileText(online.doc).toString()).not.toContain('offline')

    offline.provider.connect()
    await waitFor(
      () =>
        fileText(online.doc).toString().includes('offline') &&
        fileText(offline.doc).toString().includes('online'),
    )
    expect(fileText(online.doc).toString()).toBe(fileText(offline.doc).toString())
  })

  it('syncs users connected to different instances', async () => {
    const first = await harness.start()
    const second = await harness.start()
    const left = await harness.connect(first, harness.user())
    const right = await harness.connect(second, harness.user())
    await waitFor(() => fileText(left.doc) !== undefined && fileText(right.doc) !== undefined)

    fileText(left.doc).insert(0, 'from left')
    await waitFor(() => fileText(right.doc).toString() === 'from left')
    fileText(right.doc).insert(9, ' and right')
    await waitFor(() => fileText(left.doc).toString() === 'from left and right')
  })

  it('creates one shared file type when two instances open a room together', async () => {
    const first = await harness.start()
    const second = await harness.start()
    const [left, right] = await Promise.all([
      harness.connect(first, harness.user()),
      harness.connect(second, harness.user()),
    ])
    await waitFor(() => fileText(left.doc) !== undefined && fileText(right.doc) !== undefined)
    await new Promise((resolve) => setTimeout(resolve, 100))

    fileText(left.doc).insert(0, 'a')
    fileText(right.doc).insert(0, 'b')
    await waitFor(() => fileText(left.doc).length === 2 && fileText(right.doc).length === 2)
    expect(fileText(left.doc).toString()).toBe(fileText(right.doc).toString())
  })

  it('heals a dropped pub/sub message from the shared log', async () => {
    const healing = await harness.start({ compactionIntervalMs: 50 })
    const silent = harness.hub.storage()
    silent.bus.publish = async () => undefined
    const muted = await harness.start({ storage: silent })
    const reader = await harness.connect(healing, harness.user())
    const writer = await harness.connect(muted, harness.user())
    await waitFor(() => fileText(reader.doc) !== undefined && fileText(writer.doc) !== undefined)

    fileText(writer.doc).insert(0, 'never published')
    await waitFor(() => fileText(reader.doc).toString() === 'never published')
  })
})
