import { COLLAB_LIMITS, WsCloseCode } from '@codesync/shared'
import * as encoding from 'lib0/encoding'
import jwt from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import type { CollabServer } from '../src/server.js'
import {
  FILE_ID,
  PROJECT_ID,
  ROOM_ID,
  createHarness,
  fileText,
  rawClient,
  waitFor,
  type Harness,
} from './helpers.js'

function syncFrame(subtype: 'step2' | 'update', update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  encoding.writeVarUint(
    encoder,
    subtype === 'step2' ? syncProtocol.messageYjsSyncStep2 : syncProtocol.messageYjsUpdate,
  )
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

function awarenessFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

// Builds a document from the server's state so updates attach to real items.
async function replicaOf(server: CollabServer): Promise<Y.Doc> {
  const room = await server.rooms.acquire(PROJECT_ID, ROOM_ID)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(room.doc))
  server.rooms.release(PROJECT_ID)
  return doc
}

describe('authentication', () => {
  let harness: Harness
  let server: CollabServer

  beforeEach(async () => {
    harness = createHarness()
    server = await harness.start()
  })
  afterEach(() => harness.stop())

  const closeCode = (token: string): Promise<number> => rawClient(server, token).closed

  it('rejects a missing token', async () => {
    expect(await closeCode('')).toBe(WsCloseCode.invalidToken)
  })

  it('rejects a token signed with another key', async () => {
    const token = harness.token(harness.user(), 'editor', {
      secret: 'another-secret-with-at-least-32-characters',
    })
    expect(await closeCode(token)).toBe(WsCloseCode.invalidToken)
  })

  it('rejects an unsigned token', async () => {
    const token = jwt.sign(
      { sub: harness.user(), name: 'x', roomId: ROOM_ID, projectId: PROJECT_ID, role: 'owner' },
      '',
      { algorithm: 'none', audience: 'collab' },
    )
    expect(await closeCode(token)).toBe(WsCloseCode.invalidToken)
  })

  it('rejects the wrong audience', async () => {
    const token = harness.token(harness.user(), 'editor', { audience: 'api' })
    expect(await closeCode(token)).toBe(WsCloseCode.invalidToken)
  })

  it('reports expiry with a code that lets the client reconnect', async () => {
    const token = harness.token(harness.user(), 'editor', { expiresIn: -10 })
    expect(await closeCode(token)).toBe(WsCloseCode.tokenExpired)
  })

  it('rejects a token issued for another project', async () => {
    const token = harness.token(harness.user(), 'editor', {
      projectId: '44444444-4444-4444-8444-444444444444',
    })
    expect(await closeCode(token)).toBe(WsCloseCode.invalidToken)
  })

  it('rejects a user who has lost room access despite a valid token', async () => {
    const userId = harness.user()
    harness.hub.access.delete(userId)
    expect(await closeCode(harness.token(userId))).toBe(WsCloseCode.forbidden)
  })

  it('rejects a cross-site origin before upgrading', async () => {
    const code = await rawClient(server, harness.token(harness.user()), 'https://evil.test').closed
    expect(code).toBe(-1)
    expect(server.connectionCount()).toBe(0)
  })

  it('refreshes an expired token and reconnects', async () => {
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
    const stale = harness.token(harness.user(), 'editor', { expiresIn: -10 })
    session.provider.params['token'] = stale
    session.provider.disconnect()
    session.provider.connect()
    await waitFor(() => session.provider.params['token'] !== stale && session.provider.wsconnected)
  })
})

describe('viewer enforcement', () => {
  let harness: Harness
  let server: CollabServer

  beforeEach(async () => {
    harness = createHarness()
    server = await harness.start()
  })
  afterEach(() => harness.stop())

  async function hostileUpdate(): Promise<Uint8Array> {
    const doc = await replicaOf(server)
    fileText(doc).insert(0, 'viewer write')
    return Y.encodeStateAsUpdate(doc)
  }

  it.each(['update', 'step2'] as const)('rejects a %s message from a viewer', async (subtype) => {
    const editor = await harness.connect(server, harness.user())
    await waitFor(() => fileText(editor.doc) !== undefined)
    const update = await hostileUpdate()
    const viewer = rawClient(server, harness.token(harness.user('viewer'), 'viewer'))
    await viewer.opened

    for (let attempt = 0; attempt < COLLAB_LIMITS.maxDeniedWrites; attempt++) {
      viewer.ws.send(syncFrame(subtype, update))
    }

    expect(await viewer.closed).toBe(WsCloseCode.forbidden)
    expect(viewer.frames.some((frame) => frame[0] === 2)).toBe(true)
    expect(fileText(editor.doc).toString()).toBe('')
  })

  it('treats a token claiming editor as a viewer when the database says viewer', async () => {
    const update = await hostileUpdate()
    const viewerId = harness.user('viewer')
    const client = rawClient(server, harness.token(viewerId, 'editor'))
    await client.opened
    for (let attempt = 0; attempt < COLLAB_LIMITS.maxDeniedWrites; attempt++) {
      client.ws.send(syncFrame('update', update))
    }
    expect(await client.closed).toBe(WsCloseCode.forbidden)
  })

  it('gives a viewer the document and presence but sends no sync step 1', async () => {
    const editor = await harness.connect(server, harness.user())
    await waitFor(() => fileText(editor.doc) !== undefined)
    fileText(editor.doc).insert(0, 'shared')
    const viewer = await harness.connect(server, harness.user('viewer'), 'viewer')
    await waitFor(() => fileText(viewer.doc)?.toString() === 'shared')
    fileText(viewer.doc).insert(0, 'local only')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fileText(editor.doc).toString()).toBe('shared')
  })

  it('applies a live demotion and blocks the next write', async () => {
    const userId = harness.user()
    const session = await harness.connect(server, userId)
    await waitFor(() => fileText(session.doc) !== undefined)
    const observer = await harness.connect(server, harness.user())
    await waitFor(() => fileText(observer.doc) !== undefined)

    const room = await server.rooms.acquire(PROJECT_ID, ROOM_ID)
    room.applyControl({ type: 'role.changed', userId, role: 'viewer' })
    server.rooms.release(PROJECT_ID)

    fileText(session.doc).insert(0, 'after demotion')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fileText(observer.doc).toString()).toBe('')
  })

  it('makes everyone read-only while locked and restores on unlock', async () => {
    const ownerId = harness.user('owner')
    const owner = await harness.connect(server, ownerId, 'owner')
    await waitFor(() => fileText(owner.doc) !== undefined)
    const observer = await harness.connect(server, harness.user('viewer'), 'viewer')
    await waitFor(() => fileText(observer.doc) !== undefined)

    const room = await server.rooms.acquire(PROJECT_ID, ROOM_ID)
    room.applyControl({ type: 'room.locked', locked: true })
    fileText(owner.doc).insert(0, 'during lock')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fileText(observer.doc).toString()).toBe('')

    room.applyControl({ type: 'room.locked', locked: false })
    server.rooms.release(PROJECT_ID)
    fileText(owner.doc).insert(0, 'after unlock ')
    await waitFor(() => fileText(observer.doc).toString().includes('after unlock'))
  })
})

describe('hostile documents', () => {
  let harness: Harness
  let server: CollabServer

  beforeEach(async () => {
    harness = createHarness()
    server = await harness.start()
  })
  afterEach(() => harness.stop())

  async function attack(mutate: (doc: Y.Doc) => void): Promise<{ code: number; state: Y.Doc }> {
    const observer = await harness.connect(server, harness.user())
    await waitFor(() => fileText(observer.doc) !== undefined)
    const doc = await replicaOf(server)
    const attacker = rawClient(server, harness.token(harness.user()))
    await attacker.opened
    const before = Y.encodeStateVector(doc)
    mutate(doc)
    attacker.ws.send(syncFrame('update', Y.encodeStateAsUpdate(doc, before)))
    return { code: await attacker.closed, state: observer.doc }
  }

  it('reverts a client write to the file tree and disconnects the writer', async () => {
    const { code, state } = await attack((doc) => {
      doc.getMap('tree').set(FILE_ID, { path: '../../etc/passwd', kind: 'FILE' })
      doc.getMap('tree').set('injected', { path: 'evil', kind: 'FILE' })
    })
    expect(code).toBe(WsCloseCode.forbidden)
    const tree = state.getMap<{ path: string }>('tree')
    await waitFor(() => tree.get(FILE_ID)?.path === 'main.py' && !tree.has('injected'))
  })

  it('restores a file deleted through the files map', async () => {
    const { code, state } = await attack((doc) => doc.getMap('files').delete(FILE_ID))
    expect(code).toBe(WsCloseCode.forbidden)
    await waitFor(() => state.getMap('files').get(FILE_ID) instanceof Y.Text)
  })

  it('removes content written to an unknown root type', async () => {
    const { code } = await attack((doc) => doc.getText('junk').insert(0, 'x'.repeat(1000)))
    expect(code).toBe(WsCloseCode.forbidden)
    const room = await server.rooms.acquire(PROJECT_ID, ROOM_ID)
    expect(room.doc.getText('junk').length).toBe(0)
    server.rooms.release(PROJECT_ID)
  })

  it('truncates a file over the size limit and disconnects the writer', async () => {
    const { code, state } = await attack((doc) => {
      fileText(doc).insert(0, 'x'.repeat(COLLAB_LIMITS.maxFileChars + 10))
    })
    expect(code).toBe(WsCloseCode.frameTooLarge)
    await waitFor(() => fileText(state).length === COLLAB_LIMITS.maxFileChars)
  })

  it.each([
    ['a text frame', 'hello'],
    ['an unknown message type', Uint8Array.of(99)],
    ['an empty frame', new Uint8Array()],
    ['a truncated sync frame', Uint8Array.of(0)],
    ['an unknown sync subtype', Uint8Array.of(0, 9)],
    ['a garbage update', Uint8Array.of(0, 2, 4, 255, 255, 255, 255)],
  ])('closes the connection on %s', async (_name, frame) => {
    const client = rawClient(server, harness.token(harness.user()))
    await client.opened
    client.ws.send(frame)
    expect(await client.closed).toBe(WsCloseCode.malformed)
  })

  it('stays available after malformed frames', async () => {
    const client = rawClient(server, harness.token(harness.user()))
    await client.opened
    client.ws.send(Uint8Array.of(0, 2, 4, 255, 255, 255, 255))
    await client.closed
    const session = await harness.connect(server, harness.user())
    await waitFor(() => fileText(session.doc) !== undefined)
  })
})

describe('limits', () => {
  let harness: Harness
  let server: CollabServer

  beforeEach(async () => {
    harness = createHarness()
    server = await harness.start()
  })
  afterEach(() => harness.stop())

  it('rejects the 51st connection to a room', async () => {
    const clients = Array.from({ length: COLLAB_LIMITS.maxUsersPerRoom }, () =>
      rawClient(server, harness.token(harness.user())),
    )
    await Promise.all(clients.map((client) => client.opened))
    await waitFor(() => server.connectionCount() === COLLAB_LIMITS.maxUsersPerRoom)
    const extra = rawClient(server, harness.token(harness.user()))
    expect(await extra.closed).toBe(WsCloseCode.roomFull)
    clients.forEach((client) => client.ws.close())
    await Promise.all(clients.map((client) => client.closed))
  })

  it('counts the room limit across instances', async () => {
    const second = await harness.start()
    const clients = Array.from({ length: COLLAB_LIMITS.maxUsersPerRoom }, (_value, index) =>
      rawClient(index % 2 === 0 ? server : second, harness.token(harness.user())),
    )
    await Promise.all(clients.map((client) => client.opened))
    await waitFor(
      () =>
        server.connectionCount() + second.connectionCount() === COLLAB_LIMITS.maxUsersPerRoom,
    )
    const extra = rawClient(second, harness.token(harness.user()))
    expect(await extra.closed).toBe(WsCloseCode.roomFull)
    clients.forEach((client) => client.ws.close())
    await Promise.all(clients.map((client) => client.closed))
  })

  it('frees a slot when a user leaves', async () => {
    const first = rawClient(server, harness.token(harness.user()))
    await first.opened
    first.ws.close()
    await first.closed
    await waitFor(() => harness.hub.slots.get(PROJECT_ID)?.size === 0)
  })

  it('rejects an oversized frame with a permanent code', async () => {
    const client = rawClient(server, harness.token(harness.user()))
    await client.opened
    client.ws.send(new Uint8Array(COLLAB_LIMITS.maxFrameBytes + 1))
    expect(await client.closed).toBe(WsCloseCode.frameTooLarge)
  })

  it('disconnects a client that floods messages', async () => {
    const client = rawClient(server, harness.token(harness.user()))
    await client.opened
    for (let index = 0; index < COLLAB_LIMITS.messageBurst * 2; index++) {
      client.ws.send(Uint8Array.of(3))
    }
    expect(await client.closed).toBe(WsCloseCode.rateLimited)
  })

  it('answers application frames with an error instead of dropping them', async () => {
    const client = rawClient(server, harness.token(harness.user()))
    await client.opened
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 4)
    encoding.writeVarString(encoder, JSON.stringify({ v: 1, t: 'chat.send', id: 'a1' }))
    client.ws.send(encoding.toUint8Array(encoder))
    await waitFor(() => client.frames.some((frame) => frame[0] === 4))
    client.ws.close()
  })
})

describe('awareness', () => {
  let harness: Harness
  let server: CollabServer

  beforeEach(async () => {
    harness = createHarness()
    server = await harness.start()
  })
  afterEach(() => harness.stop())

  it('removes a user from presence on disconnect, across instances', async () => {
    const second = await harness.start()
    const stays = await harness.connect(server, harness.user())
    const leaves = await harness.connect(second, harness.user())
    await waitFor(() => stays.provider.awareness.getStates().has(leaves.doc.clientID))
    leaves.provider.disconnect()
    await waitFor(() => !stays.provider.awareness.getStates().has(leaves.doc.clientID))
  })

  it('overwrites a spoofed identity with the token identity', async () => {
    const userId = harness.user()
    const observer = await harness.connect(server, harness.user())
    const spoofer = await harness.connect(server, userId)
    spoofer.provider.awareness.setLocalState({ userId: 'someone-else', name: 'Admin' })
    await waitFor(() => observer.provider.awareness.getStates().get(spoofer.doc.clientID) !== undefined)
    await waitFor(
      () => observer.provider.awareness.getStates().get(spoofer.doc.clientID)?.['userId'] === userId,
    )
  })

  it('ignores an update for a client id owned by another connection', async () => {
    const victim = await harness.connect(server, harness.user())
    await new Promise((resolve) => setTimeout(resolve, 50))

    const attacker = rawClient(server, harness.token(harness.user()))
    await attacker.opened
    const forged = new Y.Doc()
    forged.clientID = victim.doc.clientID
    const awareness = new awarenessProtocol.Awareness(forged)
    awareness.setLocalState(null)
    for (let index = 0; index < 5; index++) awareness.setLocalState({ status: 'away' })
    attacker.ws.send(
      awarenessFrame(awarenessProtocol.encodeAwarenessUpdate(awareness, [forged.clientID])),
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    awareness.destroy()
    forged.destroy()

    const room = await server.rooms.acquire(PROJECT_ID, ROOM_ID)
    expect(room.awareness.getStates().get(victim.doc.clientID)?.['status']).toBe('active')
    server.rooms.release(PROJECT_ID)
    attacker.ws.close()
  })

  it('echoes awareness to the sender so a lone client stays connected', async () => {
    const session = await harness.connect(server, harness.user())
    const before = session.provider.wsLastMessageReceived
    await new Promise((resolve) => setTimeout(resolve, 20))
    session.provider.awareness.setLocalStateField('status', 'idle')
    await waitFor(() => session.provider.wsLastMessageReceived > before)
  })
})
