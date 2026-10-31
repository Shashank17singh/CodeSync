import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { as, createRoomFixture, createTestApi, type RoomFixture, type TestApi } from './helpers.js'

const ANCHOR = { anchorStart: Buffer.from([1, 2, 3]).toString('base64'), anchorEnd: 'AQID' }

describe('chat and comments', () => {
  let api: TestApi
  let fixture: RoomFixture

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  const message = (authorId: string, body: string, createdAt = new Date()) =>
    api.prisma.chatMessage.create({
      data: { roomId: fixture.roomId, authorId, body, createdAt },
    })

  const comment = async (user = fixture.viewer) => {
    const response = await api.app.inject(
      as(user, {
        method: 'POST',
        url: `/files/${fixture.fileId}/comments`,
        payload: { body: 'Check this', ...ANCHOR },
      }),
    )
    expect(response.statusCode).toBe(201)
    return response.json<{ comment: { id: string } }>().comment.id
  }

  const roomEvents = () =>
    api.transport.published
      .filter(({ channel }) => channel === `room:${fixture.roomId}:events`)
      .map(({ payload }) => JSON.parse(Buffer.from(payload.subarray(16)).toString()))

  describe('history', () => {
    it('pages backwards, newest first', async () => {
      fixture = await createRoomFixture(api)
      const now = Date.now()
      for (let index = 0; index < 55; index++) {
        await message(fixture.editor, `m${index}`, new Date(now + index * 1000))
      }
      const read = async (query = '') =>
        (
          await api.app.inject(
            as(fixture.viewer, { method: 'GET', url: `/rooms/${fixture.roomId}/messages${query}` }),
          )
        ).json<{ messages: Array<{ body: string; createdAt: string }> }>().messages
      const first = await read()
      expect(first).toHaveLength(50)
      expect(first[0]?.body).toBe('m54')
      const before = encodeURIComponent(first.at(-1)?.createdAt as string)
      const second = await read(`?before=${before}`)
      expect(second.map((item) => item.body)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0'])
    })

    it('is closed to outsiders', async () => {
      fixture = await createRoomFixture(api)
      const response = await api.app.inject(
        as(fixture.outsider, { method: 'GET', url: `/rooms/${fixture.roomId}/messages` }),
      )
      expect(response.statusCode).toBe(404)
    })
  })

  describe('moderation', () => {
    it('lets the owner delete a message, hides its text and tells the room', async () => {
      fixture = await createRoomFixture(api)
      const { id } = await message(fixture.editor, 'rude text')
      const response = await api.app.inject(
        as(fixture.owner, { method: 'DELETE', url: `/rooms/${fixture.roomId}/messages/${id}` }),
      )
      expect(response.statusCode).toBe(204)
      expect(roomEvents()).toContainEqual({ type: 'chat.deleted', id })
      const history = await api.app.inject(
        as(fixture.viewer, { method: 'GET', url: `/rooms/${fixture.roomId}/messages` }),
      )
      expect(history.body).not.toContain('rude text')
    })

    it('refuses anyone else', async () => {
      fixture = await createRoomFixture(api)
      const { id } = await message(fixture.editor, 'text')
      const response = await api.app.inject(
        as(fixture.editor, { method: 'DELETE', url: `/rooms/${fixture.roomId}/messages/${id}` }),
      )
      expect(response.statusCode).toBe(403)
    })

    it('cannot reach a message from another room', async () => {
      fixture = await createRoomFixture(api)
      const { id } = await message(fixture.editor, 'text')
      const other = await createRoomFixture(api)
      const response = await api.app.inject(
        as(other.owner, { method: 'DELETE', url: `/rooms/${other.roomId}/messages/${id}` }),
      )
      expect(response.statusCode).toBe(404)
    })
  })

  describe('unread counts', () => {
    it('counts other people messages since the last read', async () => {
      fixture = await createRoomFixture(api)
      const unread = async () =>
        (
          await api.app.inject(
            as(fixture.viewer, { method: 'GET', url: `/rooms/${fixture.roomId}/unread` }),
          )
        ).json<{ unread: number }>().unread
      await new Promise((resolve) => setTimeout(resolve, 5))
      await message(fixture.editor, 'one')
      await message(fixture.editor, 'two')
      await message(fixture.viewer, 'my own')
      expect(await unread()).toBe(2)

      await api.app.inject(
        as(fixture.viewer, { method: 'POST', url: `/rooms/${fixture.roomId}/read` }),
      )
      expect(await unread()).toBe(0)
    })
  })

  describe('comments', () => {
    it('stores the anchor bytes and returns them', async () => {
      fixture = await createRoomFixture(api)
      await comment()
      const { comments } = (
        await api.app.inject(
          as(fixture.editor, { method: 'GET', url: `/files/${fixture.fileId}/comments` }),
        )
      ).json()
      expect(comments[0]).toMatchObject(ANCHOR)
    })

    it('tells the room when a thread changes', async () => {
      fixture = await createRoomFixture(api)
      const id = await comment()
      expect(roomEvents()).toContainEqual({
        type: 'comment.changed',
        fileId: fixture.fileId,
        threadId: id,
        action: 'created',
      })
    })

    it('notifies the author of a reply, but not when they reply to themselves', async () => {
      fixture = await createRoomFixture(api)
      const id = await comment(fixture.viewer)
      const reply = (user: string) =>
        api.app.inject(
          as(user, {
            method: 'POST',
            url: `/comments/${id}/replies`,
            payload: { body: 'Agreed' },
          }),
        )
      await reply(fixture.viewer)
      await reply(fixture.editor)
      const notifications = await api.prisma.notification.findMany({
        where: { userId: fixture.viewer },
      })
      expect(notifications).toHaveLength(1)
      expect(notifications[0]?.kind).toBe('COMMENT_REPLY')
    })

    it('refuses a reply to a reply', async () => {
      fixture = await createRoomFixture(api)
      const id = await comment()
      const first = await api.app.inject(
        as(fixture.editor, {
          method: 'POST',
          url: `/comments/${id}/replies`,
          payload: { body: 'r' },
        }),
      )
      const nested = await api.app.inject(
        as(fixture.editor, {
          method: 'POST',
          url: `/comments/${first.json().comment.id}/replies`,
          payload: { body: 'r' },
        }),
      )
      expect(nested.json().error.code).toBe('nested_reply')
    })

    it('resolves and reopens a thread', async () => {
      fixture = await createRoomFixture(api)
      const id = await comment()
      const set = (resolved: boolean) =>
        api.app.inject(
          as(fixture.editor, { method: 'PATCH', url: `/comments/${id}`, payload: { resolved } }),
        )
      expect((await set(true)).json().comment.resolvedById).toBe(fixture.editor)
      expect((await set(false)).json().comment.resolvedAt).toBeNull()
    })

    it('lets only the author edit what a comment says', async () => {
      fixture = await createRoomFixture(api)
      const id = await comment(fixture.viewer)
      const edit = (user: string) =>
        api.app.inject(
          as(user, { method: 'PATCH', url: `/comments/${id}`, payload: { body: 'New' } }),
        )
      expect((await edit(fixture.owner)).statusCode).toBe(403)
      expect((await edit(fixture.viewer)).statusCode).toBe(200)
    })

    it('lets the author or the owner delete a comment', async () => {
      fixture = await createRoomFixture(api)
      const id = await comment(fixture.viewer)
      const remove = (user: string) =>
        api.app.inject(as(user, { method: 'DELETE', url: `/comments/${id}` }))
      expect((await remove(fixture.editor)).statusCode).toBe(403)
      expect((await remove(fixture.owner)).statusCode).toBe(204)
    })

    it('is closed to outsiders', async () => {
      fixture = await createRoomFixture(api)
      const response = await api.app.inject(
        as(fixture.outsider, { method: 'GET', url: `/files/${fixture.fileId}/comments` }),
      )
      expect(response.statusCode).toBe(404)
    })

    it('refuses an anchor that is not base64', async () => {
      fixture = await createRoomFixture(api)
      const response = await api.app.inject(
        as(fixture.editor, {
          method: 'POST',
          url: `/files/${fixture.fileId}/comments`,
          payload: { body: 'x', anchorStart: '<script>', anchorEnd: 'AQID' },
        }),
      )
      expect(response.statusCode).toBe(400)
    })
  })

  describe('notifications', () => {
    it('marks only your own as read', async () => {
      fixture = await createRoomFixture(api)
      const notification = await api.prisma.notification.create({
        data: { userId: fixture.viewer, kind: 'MENTION' },
      })
      const read = (user: string) =>
        api.app.inject(
          as(user, { method: 'POST', url: `/me/notifications/${notification.id}/read` }),
        )
      expect((await read(fixture.editor)).statusCode).toBe(404)
      expect((await read(fixture.viewer)).statusCode).toBe(204)
    })
  })
})
