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

describe('invites', () => {
  let api: TestApi
  let fixture: RoomFixture

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  const invite = async (payload: object): Promise<string> => {
    const response = await api.app.inject(
      as(fixture.owner, { method: 'POST', url: `/rooms/${fixture.roomId}/invites`, payload }),
    )
    expect(response.statusCode).toBe(201)
    return (response.json().inviteUrl as string).split('#token=')[1] as string
  }

  const accept = (userId: string, token: string) =>
    api.app.inject(as(userId, { method: 'POST', url: '/invites/accept', payload: { token } }))

  const roleOf = async (userId: string): Promise<string | undefined> => {
    const member = await api.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: fixture.roomId, userId } },
    })
    return member?.role
  }

  it('adds a user with the invited role', async () => {
    fixture = await createRoomFixture(api)
    const token = await invite({ role: 'EDITOR' })
    const user = await createUser(api.prisma)
    expect((await accept(user, token)).json()).toEqual({ roomId: fixture.roomId, joined: true })
    expect(await roleOf(user)).toBe('EDITOR')
  })

  it('stores only a hash of the token', async () => {
    fixture = await createRoomFixture(api)
    const token = await invite({ role: 'VIEWER' })
    const row = await api.prisma.invite.findFirstOrThrow({ where: { roomId: fixture.roomId } })
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.tokenHash).not.toContain(token)
  })

  it('leaves the token out of invite listings', async () => {
    fixture = await createRoomFixture(api)
    await invite({ role: 'VIEWER' })
    const response = await api.app.inject(
      as(fixture.owner, { method: 'GET', url: `/rooms/${fixture.roomId}/invites` }),
    )
    expect(response.body).not.toContain('tokenHash')
  })

  it('stops at max uses', async () => {
    fixture = await createRoomFixture(api)
    const token = await invite({ role: 'VIEWER', maxUses: 1 })
    expect((await accept(await createUser(api.prisma), token)).statusCode).toBe(200)
    expect((await accept(await createUser(api.prisma), token)).statusCode).toBe(410)
  })

  it('allows only max uses under concurrent accepts', async () => {
    fixture = await createRoomFixture(api)
    const token = await invite({ role: 'VIEWER', maxUses: 2 })
    const users = await Promise.all(
      Array.from({ length: 6 }, () => createUser(api.prisma)),
    )
    const results = await Promise.all(users.map((user) => accept(user, token)))
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(2)
    const row = await api.prisma.invite.findFirstOrThrow({ where: { roomId: fixture.roomId } })
    expect(row.uses).toBe(2)
  })

  it('refuses an expired invite', async () => {
    fixture = await createRoomFixture(api)
    const token = await invite({ role: 'VIEWER', expiresInHours: 1 })
    await api.prisma.invite.updateMany({
      where: { roomId: fixture.roomId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect((await accept(await createUser(api.prisma), token)).statusCode).toBe(410)
  })

  it('refuses a revoked invite', async () => {
    fixture = await createRoomFixture(api)
    const token = await invite({ role: 'VIEWER' })
    const row = await api.prisma.invite.findFirstOrThrow({ where: { roomId: fixture.roomId } })
    await api.app.inject(
      as(fixture.owner, {
        method: 'DELETE',
        url: `/rooms/${fixture.roomId}/invites/${row.id}`,
      }),
    )
    expect((await accept(await createUser(api.prisma), token)).statusCode).toBe(410)
  })

  it('refuses a forged token, even for a real invite id', async () => {
    fixture = await createRoomFixture(api)
    await invite({ role: 'VIEWER' })
    const row = await api.prisma.invite.findFirstOrThrow({ where: { roomId: fixture.roomId } })
    const forged = jwt.sign({ inviteId: row.id }, 'attacker-secret-with-at-least-32-chars', {
      algorithm: 'HS256',
      audience: 'invite',
    })
    expect((await accept(await createUser(api.prisma), forged)).statusCode).toBe(410)
    const unknown = jwt.sign({ inviteId: row.id }, config.inviteTokenSecret, {
      algorithm: 'HS256',
      audience: 'invite',
      expiresIn: 3600,
    })
    expect((await accept(await createUser(api.prisma), unknown)).statusCode).toBe(410)
  })

  it('does not let a role be raised by editing the token', async () => {
    fixture = await createRoomFixture(api)
    const token = await invite({ role: 'VIEWER' })
    const user = await createUser(api.prisma)
    const [header, , signature] = token.split('.')
    const body = Buffer.from(JSON.stringify({ role: 'EDITOR' })).toString('base64url')
    expect((await accept(user, `${header}.${body}.${signature}`)).statusCode).toBe(410)
    expect(await roleOf(user)).toBeUndefined()
  })

  it('never downgrades an existing member or spends a use on them', async () => {
    fixture = await createRoomFixture(api)
    const token = await invite({ role: 'VIEWER', maxUses: 1 })
    expect((await accept(fixture.editor, token)).json().joined).toBe(false)
    expect(await roleOf(fixture.editor)).toBe('EDITOR')
    expect((await accept(await createUser(api.prisma), token)).statusCode).toBe(200)
  })

  it('emails an invite and limits it to that address', async () => {
    fixture = await createRoomFixture(api)
    const invited = await createUser(api.prisma)
    const email = `${invited}@test.local`
    const token = await invite({ role: 'EDITOR', email: email.toUpperCase() })
    expect(api.mailer.sent.at(-1)).toMatchObject({ to: email, roomName: 'Fixture' })

    const other = await createUser(api.prisma)
    expect((await accept(other, token)).statusCode).toBe(403)
    expect((await accept(invited, token)).statusCode).toBe(200)
    expect(await roleOf(invited)).toBe('EDITOR')
  })

  it('refuses to invite anyone as owner', async () => {
    fixture = await createRoomFixture(api)
    const response = await api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/rooms/${fixture.roomId}/invites`,
        payload: { role: 'OWNER' },
      }),
    )
    expect(response.statusCode).toBe(400)
  })
})
