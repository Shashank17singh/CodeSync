import type { InjectOptions } from 'fastify'
import { zipSync, strToU8 } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ACTIONS, isAllowed, type Action } from '../src/modules/permissions.js'
import { as, createRoomFixture, createTestApi, type RoomFixture, type TestApi } from './helpers.js'

type Actor = 'owner' | 'editor' | 'viewer' | 'outsider'

const ACTORS: readonly Actor[] = ['owner', 'editor', 'viewer', 'outsider']

const NEW_ID = '99999999-9999-4999-8999-999999999999'

interface Case {
  action: Action
  request: (fixture: RoomFixture) => InjectOptions
  allowed: readonly Actor[]
  success: number
}

const zipBody = Buffer.from(zipSync({ 'imported.py': strToU8('x = 1\n') }))

// One row per route. Expected actors are written out by hand here, separately from the table in
// permissions.ts, so a mistake in that table cannot also change what this test expects.
const CASES: readonly Case[] = [
  {
    action: 'room.view',
    request: (f) => ({ method: 'GET', url: `/rooms/${f.roomId}` }),
    allowed: ['owner', 'editor', 'viewer'],
    success: 200,
  },
  {
    action: 'room.update',
    request: (f) => ({ method: 'PATCH', url: `/rooms/${f.roomId}`, payload: { name: 'New' } }),
    allowed: ['owner'],
    success: 200,
  },
  {
    action: 'room.delete',
    request: (f) => ({ method: 'DELETE', url: `/rooms/${f.roomId}` }),
    allowed: ['owner'],
    success: 204,
  },
  {
    action: 'room.lock',
    request: (f) => ({ method: 'POST', url: `/rooms/${f.roomId}/lock` }),
    allowed: ['owner'],
    success: 200,
  },
  {
    action: 'room.transfer',
    request: (f) => ({
      method: 'POST',
      url: `/rooms/${f.roomId}/transfer`,
      payload: { userId: f.editor },
    }),
    allowed: ['owner'],
    success: 200,
  },
  {
    action: 'member.list',
    request: (f) => ({ method: 'GET', url: `/rooms/${f.roomId}/members` }),
    allowed: ['owner', 'editor', 'viewer'],
    success: 200,
  },
  {
    action: 'member.role',
    request: (f) => ({
      method: 'PATCH',
      url: `/rooms/${f.roomId}/members/${f.viewer}`,
      payload: { role: 'EDITOR' },
    }),
    allowed: ['owner'],
    success: 200,
  },
  {
    action: 'member.remove',
    request: (f) => ({ method: 'DELETE', url: `/rooms/${f.roomId}/members/${f.bystander}` }),
    allowed: ['owner'],
    success: 204,
  },
  {
    action: 'invite.manage',
    request: (f) => ({
      method: 'POST',
      url: `/rooms/${f.roomId}/invites`,
      payload: { role: 'VIEWER' },
    }),
    allowed: ['owner'],
    success: 201,
  },
  {
    action: 'project.create',
    request: (f) => ({
      method: 'POST',
      url: `/rooms/${f.roomId}/projects`,
      payload: { name: 'second' },
    }),
    allowed: ['owner', 'editor'],
    success: 201,
  },
  {
    action: 'project.view',
    request: (f) => ({ method: 'GET', url: `/projects/${f.projectId}` }),
    allowed: ['owner', 'editor', 'viewer'],
    success: 200,
  },
  {
    action: 'project.delete',
    request: (f) => ({ method: 'DELETE', url: `/projects/${f.projectId}` }),
    allowed: ['owner'],
    success: 204,
  },
  {
    action: 'file.read',
    request: (f) => ({ method: 'GET', url: `/projects/${f.projectId}/files` }),
    allowed: ['owner', 'editor', 'viewer'],
    success: 200,
  },
  {
    action: 'file.write',
    request: (f) => ({
      method: 'POST',
      url: `/projects/${f.projectId}/files`,
      payload: { path: 'new.py' },
    }),
    allowed: ['owner', 'editor'],
    success: 201,
  },
  {
    action: 'file.write',
    request: (f) => ({
      method: 'PATCH',
      url: `/projects/${f.projectId}/files/${f.fileId}`,
      payload: { path: 'renamed.py' },
    }),
    allowed: ['owner', 'editor'],
    success: 200,
  },
  {
    action: 'file.write',
    request: (f) => ({ method: 'DELETE', url: `/projects/${f.projectId}/files/${f.fileId}` }),
    allowed: ['owner', 'editor'],
    success: 204,
  },
  {
    action: 'file.import',
    request: (f) => ({
      method: 'POST',
      url: `/projects/${f.projectId}/import`,
      headers: { 'content-type': 'application/zip' },
      payload: zipBody,
    }),
    allowed: ['owner', 'editor'],
    success: 201,
  },
  {
    action: 'file.export',
    request: (f) => ({ method: 'GET', url: `/projects/${f.projectId}/export` }),
    allowed: ['owner', 'editor', 'viewer'],
    success: 200,
  },
  {
    action: 'execution.run',
    request: (f) => ({
      method: 'POST',
      url: `/rooms/${f.roomId}/executions`,
      payload: { projectId: f.projectId, entryPath: 'main.py' },
    }),
    allowed: ['owner', 'editor'],
    success: 202,
  },
  {
    action: 'collab.token',
    request: (f) => ({
      method: 'POST',
      url: `/rooms/${f.roomId}/collab-token`,
      payload: { projectId: f.projectId },
    }),
    allowed: ['owner', 'editor', 'viewer'],
    success: 200,
  },
]

// Blocked for everyone during a lock, including the owner.
const WRITES = new Set<Action>([
  'project.create',
  'project.delete',
  'file.write',
  'file.import',
  'execution.run',
])

describe('permission matrix', () => {
  let api: TestApi

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  describe.each(CASES)('$action $success', (entry) => {
    it.each(ACTORS)('%s in an unlocked private room', async (actor) => {
      const fixture = await createRoomFixture(api)
      const response = await api.app.inject(as(fixture[actor], entry.request(fixture)))
      if (entry.allowed.includes(actor)) expect(response.statusCode).toBe(entry.success)
      // A private room must look absent to outsiders, not forbidden.
      else expect(response.statusCode).toBe(actor === 'outsider' ? 404 : 403)
    })

    it.each(ACTORS)('%s in a locked private room', async (actor) => {
      const fixture = await createRoomFixture(api, { locked: true })
      const response = await api.app.inject(as(fixture[actor], entry.request(fixture)))
      const allowed = entry.allowed.includes(actor) && !WRITES.has(entry.action)
      if (allowed) expect(response.statusCode).toBe(entry.success)
      else expect(response.statusCode).toBe(actor === 'outsider' ? 404 : 403)
    })
  })

  it('lets an outsider see and join a public room but nothing inside it', async () => {
    const fixture = await createRoomFixture(api, { visibility: 'PUBLIC' })
    const { outsider, roomId, projectId } = fixture
    const inject = (options: InjectOptions) => api.app.inject(as(outsider, options))

    expect((await inject({ method: 'GET', url: `/rooms/${roomId}` })).statusCode).toBe(200)
    expect((await inject({ method: 'GET', url: `/rooms/${roomId}/members` })).statusCode).toBe(403)
    expect((await inject({ method: 'GET', url: `/projects/${projectId}/files` })).statusCode).toBe(
      404,
    )

    expect((await inject({ method: 'POST', url: `/rooms/${roomId}/join` })).json()).toEqual({
      role: 'viewer',
    })
    expect((await inject({ method: 'GET', url: `/projects/${projectId}/files` })).statusCode).toBe(
      200,
    )
  })

  it('does not let an outsider join a private room', async () => {
    const { outsider, roomId } = await createRoomFixture(api)
    const response = await api.app.inject(
      as(outsider, { method: 'POST', url: `/rooms/${roomId}/join` }),
    )
    expect(response.statusCode).toBe(404)
  })

  it('never downgrades a member who calls join', async () => {
    const { editor, roomId } = await createRoomFixture(api, { visibility: 'PUBLIC' })
    const response = await api.app.inject(
      as(editor, { method: 'POST', url: `/rooms/${roomId}/join` }),
    )
    expect(response.json()).toEqual({ role: 'editor' })
  })

  it('refuses every room route without a valid access token', async () => {
    const { roomId } = await createRoomFixture(api)
    const response = await api.app.inject({ method: 'GET', url: `/api/v1/rooms/${roomId}` })
    expect(response.statusCode).toBe(401)
    const forged = await api.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      headers: { authorization: 'Bearer not.a.token' },
    })
    expect(forged.statusCode).toBe(401)
  })

  it('returns 404 for a project that does not exist', async () => {
    const { owner } = await createRoomFixture(api)
    const response = await api.app.inject(as(owner, { method: 'GET', url: `/projects/${NEW_ID}` }))
    expect(response.statusCode).toBe(404)
  })
})

describe('permission table', () => {
  it('covers every action with a route, or lists why it has none', () => {
    const routed = new Set(CASES.map((entry) => entry.action))
    // room.join has its own tests above. chat.send arrives with chat in 3.9.
    const noRouteYet = new Set<Action>(['room.join', 'chat.send'])
    for (const action of ACTIONS) expect(routed.has(action) || noRouteYet.has(action)).toBe(true)
  })

  it.each([
    ['execution.run', 'editor', false, true],
    ['execution.run', 'viewer', false, false],
    ['execution.run', 'owner', true, false],
    ['chat.send', 'viewer', false, true],
    ['chat.send', 'viewer', true, true],
  ] as const)('%s for %s (locked %s) is %s', (action, role, locked, expected) => {
    expect(isAllowed(action, { role, locked, isPublic: false })).toBe(expected)
  })
})
