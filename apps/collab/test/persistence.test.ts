import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { FILE_ID, PROJECT_ID, createHarness, fileText, waitFor, type Harness } from './helpers.js'

function storedText(harness: Harness): string {
  const stored = harness.hub.docs.get(PROJECT_ID)
  if (!stored?.state) return ''
  const doc = new Y.Doc()
  Y.applyUpdate(doc, stored.state)
  return fileText(doc).toString()
}

const pendingCount = (harness: Harness): number => harness.hub.updates.get(PROJECT_ID)?.length ?? 0

describe('persistence', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })
  afterEach(() => harness.stop())

  it('stores incremental updates in the log', async () => {
    const server = await harness.start()
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    const before = pendingCount(harness)
    fileText(session.doc).insert(0, 'a')
    await waitFor(() => pendingCount(harness) > before)
    expect(harness.hub.docs.get(PROJECT_ID)?.state ?? null).toBeNull()
  })

  it('compacts on the interval', async () => {
    const server = await harness.start({ compactionIntervalMs: 50 })
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    fileText(session.doc).insert(0, 'timed')
    await waitFor(() => storedText(harness) === 'timed' && pendingCount(harness) === 0)
  })

  it('compacts when the update threshold is reached', async () => {
    const server = await harness.start({ maxPendingUpdates: 20 })
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    for (let index = 0; index < 25; index++) fileText(session.doc).insert(index, 'x')
    await waitFor(() => storedText(harness).length >= 20)
  })

  it('compacts and unloads when the last user leaves', async () => {
    const server = await harness.start()
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    fileText(session.doc).insert(0, 'goodbye')
    await waitFor(() => pendingCount(harness) > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    session.provider.disconnect()
    await waitFor(() => server.rooms.activeRooms === 0)
    expect(storedText(harness)).toBe('goodbye')
    expect(pendingCount(harness)).toBe(0)
  })

  it('keeps a room in memory when its final compaction fails', async () => {
    const storage = harness.hub.storage()
    const save = storage.docs.save.bind(storage.docs)
    let failing = true
    storage.docs.save = async (...args) => {
      if (failing) throw new Error('database down')
      return save(...args)
    }
    const server = await harness.start({ storage, compactionIntervalMs: 50 })
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    fileText(session.doc).insert(0, 'precious')
    await new Promise((resolve) => setTimeout(resolve, 20))
    session.provider.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(server.rooms.activeRooms).toBe(1)

    failing = false
    await waitFor(() => server.rooms.activeRooms === 0)
    expect(storedText(harness)).toBe('precious')
  })

  it('restores from PostgreSQL plus pending updates after a crash', async () => {
    const server = await harness.start()
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    fileText(session.doc).insert(0, 'compacted ')
    await waitFor(() => pendingCount(harness) > 0)
    const [{ rooms }] = [server]
    const room = await rooms.acquire(PROJECT_ID, '11111111-1111-4111-8111-111111111111')
    await room.compact()
    rooms.release(PROJECT_ID)
    fileText(session.doc).insert(10, 'pending')
    await waitFor(() => pendingCount(harness) > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A second instance loads from storage alone, as it would after the first one crashed.
    const replacement = await harness.start()
    const restored = await harness.connect(replacement, harness.user())
    await waitFor(() => fileText(restored.doc)?.toString() === 'compacted pending')
    expect(fileText(restored.doc).length).toBe(17)
  })

  it('merges updates a peer logged that this instance has not received', async () => {
    const server = await harness.start()
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)

    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(session.doc))
    fileText(peer).insert(0, 'from peer')
    const storage = harness.hub.storage()
    await storage.log.append(PROJECT_ID, Y.encodeStateAsUpdate(peer))

    const room = await server.rooms.acquire(PROJECT_ID, '11111111-1111-4111-8111-111111111111')
    await room.compact()
    server.rooms.release(PROJECT_ID)
    expect(storedText(harness)).toBe('from peer')
  })

  it('does not overwrite a newer compaction', async () => {
    const storage = harness.hub.storage()
    await storage.docs.save(PROJECT_ID, new Uint8Array([1]), 0)
    expect(await storage.docs.save(PROJECT_ID, new Uint8Array([2]), 0)).toBe(false)
    expect(harness.hub.docs.get(PROJECT_ID)?.state).toEqual(new Uint8Array([1]))
  })

  it('records which user owns each Yjs client id', async () => {
    const server = await harness.start()
    const userId = harness.user()
    const session = await harness.connect(server, userId)
    await waitFor(() => fileText(session.doc) !== undefined)
    fileText(session.doc).insert(0, 'a')
    await waitFor(() => harness.hub.clients.get(`${PROJECT_ID}:${session.doc.clientID}`) === userId)
  })

  it('adds a file created through the API to connected clients', async () => {
    const server = await harness.start()
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    const id = '55555555-5555-4555-8555-555555555555'
    harness.hub.files.get(PROJECT_ID)?.push({ id, path: 'util.py', kind: 'FILE' })

    const room = await server.rooms.acquire(PROJECT_ID, '11111111-1111-4111-8111-111111111111')
    room.applyControl({ type: 'tree.changed', projectId: PROJECT_ID })
    server.rooms.release(PROJECT_ID)

    await waitFor(() => session.tree.get(id)?.path === 'util.py' && session.files.has(id))
    expect(session.tree.get(FILE_ID)?.path).toBe('main.py')
  })
})
