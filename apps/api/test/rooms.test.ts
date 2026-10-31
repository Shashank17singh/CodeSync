import { COLLAB_TOKEN_AUDIENCE, collabTokenClaimsSchema } from '@codesync/shared'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  as,
  config,
  createRoomFixture,
  createTestApi,
  createUser,
  type RoomFixture,
  type TestApi,
} from './helpers.js'

describe('rooms', () => {
  let api: TestApi

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  const post = (user: string, url: string, payload?: object) =>
    api.app.inject(as(user, { method: 'POST', url, ...(payload ? { payload } : {}) }))

  describe('creation', () => {
    it.each([
      ['PYTHON', ['main.py']],
      ['CPP', ['main.cpp']],
      ['JAVA', ['Main.java']],
      ['JAVASCRIPT', ['main.js']],
      ['BLANK', []],
    ])('starts a %s room with its template files', async (template, expected) => {
      const owner = await createUser(api.prisma)
      const response = await post(owner, '/rooms', { name: 'Room', template })
      expect(response.statusCode).toBe(201)
      const { room } = response.json()
      const files = await api.prisma.file.findMany({ where: { projectId: room.projectId } })
      expect(files.map((file) => file.path)).toEqual(expected)
    })

    it('is private by default and lists the creator as owner', async () => {
      const owner = await createUser(api.prisma)
      await post(owner, '/rooms', { name: 'Mine' })
      const { rooms } = (await api.app.inject(as(owner, { method: 'GET', url: '/rooms' }))).json()
      expect(rooms).toHaveLength(1)
      expect(rooms[0]).toMatchObject({ name: 'Mine', visibility: 'PRIVATE', role: 'owner' })
    })

    it('rejects an empty name and unknown template', async () => {
      const owner = await createUser(api.prisma)
      expect((await post(owner, '/rooms', { name: '  ' })).statusCode).toBe(400)
      const bad = await post(owner, '/rooms', { name: 'x', template: 'COBOL' })
      expect(bad.statusCode).toBe(400)
    })
  })

  describe('ownership', () => {
    let fixture: RoomFixture

    it('transfers ownership and demotes the old owner to editor', async () => {
      fixture = await createRoomFixture(api)
      const { roomId, owner, viewer } = fixture
      const response = await post(owner, `/rooms/${roomId}/transfer`, { userId: viewer })
      expect(response.statusCode).toBe(200)

      const room = await api.prisma.room.findUniqueOrThrow({ where: { id: roomId } })
      expect(room.ownerId).toBe(viewer)
      const members = (
        await api.app.inject(as(viewer, { method: 'GET', url: `/rooms/${roomId}/members` }))
      ).json().members
      expect(members.find((m: { id: string }) => m.id === owner).role).toBe('editor')
      expect(members.find((m: { id: string }) => m.id === viewer).role).toBe('owner')
      expect(api.transport.controlMessages().slice(-2)).toEqual([
        { type: 'role.changed', userId: viewer, role: 'owner' },
        { type: 'role.changed', userId: owner, role: 'editor' },
      ])
    })

    it('stops the old owner acting as owner straight away', async () => {
      fixture = await createRoomFixture(api)
      const { roomId, owner, editor } = fixture
      await post(owner, `/rooms/${roomId}/transfer`, { userId: editor })
      const response = await post(owner, `/rooms/${roomId}/lock`)
      expect(response.statusCode).toBe(403)
    })

    it('rolls back a transfer to someone outside the room', async () => {
      fixture = await createRoomFixture(api)
      const { roomId, owner, outsider } = fixture
      const response = await post(owner, `/rooms/${roomId}/transfer`, { userId: outsider })
      expect(response.statusCode).toBe(422)
      const room = await api.prisma.room.findUniqueOrThrow({ where: { id: roomId } })
      expect(room.ownerId).toBe(owner)
    })

    it('lets only one of two concurrent transfers win', async () => {
      fixture = await createRoomFixture(api)
      const { roomId, owner, editor, viewer } = fixture
      const results = await Promise.all([
        post(owner, `/rooms/${roomId}/transfer`, { userId: editor }),
        post(owner, `/rooms/${roomId}/transfer`, { userId: viewer }),
      ])
      expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1)
    })

    it('makes the owner transfer before leaving', async () => {
      fixture = await createRoomFixture(api)
      const { roomId, owner } = fixture
      const response = await api.app.inject(
        as(owner, { method: 'DELETE', url: `/rooms/${roomId}/members/${owner}` }),
      )
      expect(response.json().error.code).toBe('owner_cannot_leave')
    })

    it('lets a member leave on their own', async () => {
      fixture = await createRoomFixture(api)
      const { roomId, viewer } = fixture
      const response = await api.app.inject(
        as(viewer, { method: 'DELETE', url: `/rooms/${roomId}/members/${viewer}` }),
      )
      expect(response.statusCode).toBe(204)
    })

    it('refuses to change the owner role directly', async () => {
      fixture = await createRoomFixture(api)
      const { roomId, owner } = fixture
      const response = await api.app.inject(
        as(owner, {
          method: 'PATCH',
          url: `/rooms/${roomId}/members/${owner}`,
          payload: { role: 'VIEWER' },
        }),
      )
      expect(response.json().error.code).toBe('owner_role')
    })
  })

  describe('collab notifications', () => {
    it('reports locks, role changes, removals and deletion', async () => {
      const { roomId, owner, editor, viewer } = await createRoomFixture(api)
      const start = api.transport.controlMessages().length
      await post(owner, `/rooms/${roomId}/lock`)
      await post(owner, `/rooms/${roomId}/unlock`)
      await api.app.inject(
        as(owner, {
          method: 'PATCH',
          url: `/rooms/${roomId}/members/${viewer}`,
          payload: { role: 'EDITOR' },
        }),
      )
      await api.app.inject(
        as(owner, { method: 'DELETE', url: `/rooms/${roomId}/members/${editor}` }),
      )
      await api.app.inject(as(owner, { method: 'DELETE', url: `/rooms/${roomId}` }))
      expect(api.transport.controlMessages().slice(start)).toEqual([
        { type: 'room.locked', locked: true },
        { type: 'room.locked', locked: false },
        { type: 'role.changed', userId: viewer, role: 'editor' },
        { type: 'member.removed', userId: editor },
        { type: 'room.deleted' },
      ])
    })

    it('still succeeds when Redis is down', async () => {
      const { roomId, owner } = await createRoomFixture(api)
      const publish = api.transport.publish.bind(api.transport)
      api.transport.publish = async () => {
        throw new Error('redis down')
      }
      const response = await post(owner, `/rooms/${roomId}/lock`)
      api.transport.publish = publish
      expect(response.statusCode).toBe(200)
    })

    it('deletes the shared update log with the room', async () => {
      const { roomId, owner, projectId } = await createRoomFixture(api)
      expect(api.transport.logs.has(projectId)).toBe(true)
      await api.app.inject(as(owner, { method: 'DELETE', url: `/rooms/${roomId}` }))
      expect(api.transport.logs.has(projectId)).toBe(false)
    })
  })

  describe('collab tokens', () => {
    it('issues a 5-minute token the collab server accepts', async () => {
      const { roomId, projectId, viewer } = await createRoomFixture(api)
      const response = await post(viewer, `/rooms/${roomId}/collab-token`, { projectId })
      const { token, expiresIn } = response.json()
      expect(expiresIn).toBe(300)
      const payload = jwt.verify(token, config.collabTokenSecret, {
        algorithms: ['HS256'],
        audience: COLLAB_TOKEN_AUDIENCE,
      }) as jwt.JwtPayload
      expect(collabTokenClaimsSchema.parse(payload)).toMatchObject({
        sub: viewer,
        name: 'Viewer',
        roomId,
        projectId,
        role: 'viewer',
      })
      expect((payload.exp as number) - (payload.iat as number)).toBe(300)
    })

    it('refuses a project from another room', async () => {
      const { roomId, owner } = await createRoomFixture(api)
      const other = await createRoomFixture(api)
      const response = await post(owner, `/rooms/${roomId}/collab-token`, {
        projectId: other.projectId,
      })
      expect(response.statusCode).toBe(404)
    })
  })
})
