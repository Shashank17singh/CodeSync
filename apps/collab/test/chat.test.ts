import { CHAT_LIMITS, maskProfanity } from '@codesync/shared'
import { createAnchor, resolveAnchor, type CollabSession } from '@codesync/collab-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CollabServer } from '../src/server.js'
import { ROOM_ID, createHarness, fileText, waitFor, type Harness } from './helpers.js'

interface ChatMessage {
  id: string
  clientMsgId: string
  authorId: string
  authorName: string
  body: string
  mentionedUserIds: string[]
}

describe('chat', () => {
  let harness: Harness
  let server: CollabServer

  beforeEach(async () => {
    harness = createHarness()
    server = await harness.start()
  })
  afterEach(() => harness.stop())

  const collect = <T>(session: CollabSession, type: string): T[] => {
    const received: T[] = []
    session.channel.on(type, (data) => received.push(data as T))
    return received
  }

  it('delivers a message to everyone, including viewers, and stores it', async () => {
    const author = harness.user()
    const sender = await harness.connect(server, author)
    const viewer = await harness.connect(server, harness.user('viewer'), 'viewer')
    const seenBySender = collect<ChatMessage>(sender, 'chat.message')
    const seenByViewer = collect<ChatMessage>(viewer, 'chat.message')

    sender.channel.sendChat({ clientMsgId: 'c1', body: 'Hello **room**' })

    await waitFor(() => seenBySender.length === 1 && seenByViewer.length === 1)
    expect(seenByViewer[0]).toMatchObject({
      clientMsgId: 'c1',
      authorId: author,
      authorName: `user-${author.slice(0, 4)}`,
      body: 'Hello **room**',
    })
    expect(harness.hub.messages).toHaveLength(1)
    expect(harness.hub.messages[0]?.roomId).toBe(ROOM_ID)
  })

  it('lets a viewer chat, as the spec allows', async () => {
    const viewer = await harness.connect(server, harness.user('viewer'), 'viewer')
    const seen = collect<ChatMessage>(viewer, 'chat.message')
    viewer.channel.sendChat({ clientMsgId: 'c1', body: 'From a viewer' })
    await waitFor(() => seen.length === 1)
  })

  it('reaches users connected to another instance', async () => {
    const second = await harness.start()
    const sender = await harness.connect(server, harness.user())
    const remote = await harness.connect(second, harness.user())
    const seen = collect<ChatMessage>(remote, 'chat.message')
    sender.channel.sendChat({ clientMsgId: 'c1', body: 'Across servers' })
    await waitFor(() => seen.length === 1)
  })

  it('takes identity from the token, whatever the client sends', async () => {
    const author = harness.user()
    const sender = await harness.connect(server, author)
    const seen = collect<ChatMessage>(sender, 'chat.message')
    sender.channel.sendChat({
      clientMsgId: 'c1',
      body: 'x',
      authorId: harness.user(),
    } as never)
    await waitFor(() => seen.length === 1)
    expect(seen[0]?.authorId).toBe(author)
  })

  it('keeps only mentions of real room members and notifies each of them', async () => {
    const member = harness.user()
    const stranger = '99999999-9999-4999-8999-999999999999'
    const author = harness.user()
    const sender = await harness.connect(server, author)
    const mentioned = await harness.connect(server, member)
    const notified = collect<{ userId: string }>(mentioned, 'notify.created')
    const seen = collect<ChatMessage>(sender, 'chat.message')

    sender.channel.sendChat({
      clientMsgId: 'c1',
      body: 'hey @someone',
      mentions: [member, stranger, author],
    })

    await waitFor(() => seen.length === 1 && notified.length === 1)
    expect(seen[0]?.mentionedUserIds).toEqual([member])
  })

  it('tells only the mentioned user about a mention', async () => {
    const member = harness.user()
    const sender = await harness.connect(server, harness.user())
    await harness.connect(server, member)
    const bystander = await harness.connect(server, harness.user())
    const seenByBystander = collect(bystander, 'notify.created')
    const seen = collect(bystander, 'chat.message')
    sender.channel.sendChat({ clientMsgId: 'c1', body: 'x', mentions: [member] })
    await waitFor(() => seen.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(seenByBystander).toEqual([])
  })

  it('masks profanity when the room has the filter on', async () => {
    const sender = await harness.connect(server, harness.user())
    harness.hub.profanityFilter = true
    const seen = collect<ChatMessage>(sender, 'chat.message')
    sender.channel.sendChat({ clientMsgId: 'c1', body: 'this is shit' })
    await waitFor(() => seen.length === 1)
    expect(seen[0]?.body).toBe('this is ****')
    expect(harness.hub.messages[0]?.body).toBe('this is ****')
  })

  it('refuses a sixth message in five seconds, without disconnecting', async () => {
    const sender = await harness.connect(server, harness.user())
    const seen = collect<ChatMessage>(sender, 'chat.message')
    const errors = collect<{ code: string }>(sender, 'error')
    for (let index = 0; index < CHAT_LIMITS.messageBurst + 2; index++) {
      sender.channel.sendChat({ clientMsgId: `c${index}`, body: 'spam' })
    }
    await waitFor(() => errors.length >= 2)
    expect(errors[0]?.code).toBe('chat_rate_limited')
    await waitFor(() => seen.length === CHAT_LIMITS.messageBurst)
    expect(sender.provider.wsconnected).toBe(true)
  })

  it('reports a failed save to the sender, and sends nothing to the room', async () => {
    const storage = harness.hub.storage()
    storage.chat.post = async () => {
      throw new Error('database down')
    }
    const failing = await harness.start({ storage })
    const sender = await harness.connect(failing, harness.user())
    const errors = collect<{ code: string }>(sender, 'error')
    const seen = collect(sender, 'chat.message')
    sender.channel.sendChat({ clientMsgId: 'c1', body: 'x' })
    await waitFor(() => errors.length === 1)
    expect(errors[0]?.code).toBe('chat_failed')
    expect(seen).toEqual([])
  })

  it('refuses an empty or oversized message', async () => {
    const sender = await harness.connect(server, harness.user())
    const errors = collect<{ code: string }>(sender, 'error')
    sender.channel.sendChat({ clientMsgId: 'c1', body: '   ' })
    sender.channel.sendChat({ clientMsgId: 'c2', body: 'x'.repeat(CHAT_LIMITS.maxBodyChars + 1) })
    await waitFor(() => errors.length === 2)
    expect(harness.hub.messages).toEqual([])
  })

  it('shares typing with others, but not back to the typist', async () => {
    const typist = await harness.connect(server, harness.user())
    const other = await harness.connect(server, harness.user())
    const seenByOther = collect<{ typing: boolean }>(other, 'chat.typing')
    const seenByTypist = collect(typist, 'chat.typing')
    typist.channel.sendTyping(true)
    await waitFor(() => seenByOther.length === 1)
    expect(seenByOther[0]?.typing).toBe(true)
    expect(seenByTypist).toEqual([])
  })
})

describe('comment anchors', () => {
  let harness: Harness
  let server: CollabServer

  beforeEach(async () => {
    harness = createHarness()
    server = await harness.start()
  })
  afterEach(() => harness.stop())

  async function twoEditors(): Promise<[CollabSession, CollabSession]> {
    const first = await harness.connect(server, harness.user())
    const second = await harness.connect(server, harness.user())
    await waitFor(() => fileText(first.doc) !== undefined && fileText(second.doc) !== undefined)
    fileText(first.doc).insert(0, 'line one\nline two\nline three\n')
    await waitFor(() => fileText(second.doc).length === fileText(first.doc).length)
    return [first, second]
  }

  it('stays on the right line after insertions above it', async () => {
    const [first, second] = await twoEditors()
    const text = fileText(first.doc)
    const start = text.toString().indexOf('line three')
    const anchor = createAnchor(text, start, start + 'line three'.length)
    expect(resolveAnchor(text, anchor)?.line).toBe(3)

    // Another person adds lines above the commented code.
    fileText(second.doc).insert(0, 'new first\nnew second\n')
    await waitFor(() => text.toString().startsWith('new first'))

    const moved = resolveAnchor(text, anchor)
    expect(moved?.line).toBe(5)
    expect(text.toString().slice(moved?.start, moved?.end)).toBe('line three')
  })

  it('stays correct for a user who loads the file later', async () => {
    const [first, second] = await twoEditors()
    const text = fileText(first.doc)
    const start = text.toString().indexOf('line two')
    const anchor = createAnchor(text, start, start + 'line two'.length)
    fileText(second.doc).insert(0, 'above\n')
    await waitFor(() => text.toString().startsWith('above'))

    const late = await harness.connect(server, harness.user())
    await waitFor(() => fileText(late.doc)?.toString() === text.toString())
    expect(resolveAnchor(fileText(late.doc), anchor)?.line).toBe(3)
  })

  it('does not grow when someone types right after the commented code', async () => {
    const [first] = await twoEditors()
    const text = fileText(first.doc)
    const anchor = createAnchor(text, 0, 'line one'.length)
    text.insert('line one'.length, ' more')
    const moved = resolveAnchor(text, anchor)
    expect(text.toString().slice(moved?.start, moved?.end)).toBe('line one')
  })

  it('reports nothing once the commented code is deleted, instead of pointing at the wrong line', async () => {
    const [first] = await twoEditors()
    const text = fileText(first.doc)
    const anchor = createAnchor(text, 0, 'line one'.length)
    text.delete(0, text.length)
    const moved = resolveAnchor(text, anchor)
    expect(moved === null || moved.start === moved.end).toBe(true)
  })

  it('ignores a corrupted anchor', async () => {
    const [first] = await twoEditors()
    expect(resolveAnchor(fileText(first.doc), { start: 'AAAA', end: '!!!' })).toBeNull()
  })
})

describe('maskProfanity', () => {
  it('masks whole words and leaves innocent words alone', () => {
    expect(maskProfanity('Well SHIT')).toBe('Well ****')
    expect(maskProfanity('The dickens in Scunthorpe')).toBe('The dickens in Scunthorpe')
  })
})
