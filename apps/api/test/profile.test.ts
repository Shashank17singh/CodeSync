import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { as, createTestApi, createUser, type TestApi } from './helpers.js'

describe('profile', () => {
  let api: TestApi
  let user: string

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  const update = (payload: object, userId = user) =>
    api.app.inject(as(userId, { method: 'PATCH', url: '/me', payload }))

  const read = async (userId = user) =>
    (await api.app.inject(as(userId, { method: 'GET', url: '/me' }))).json().user

  it('returns the signed-in user with default settings and no secrets', async () => {
    user = await createUser(api.prisma, 'Ada')
    const profile = await read()
    expect(profile).toMatchObject({
      id: user,
      displayName: 'Ada',
      theme: 'system',
      editorSettings: { fontSize: 14, tabSize: 4, keybindings: 'default' },
    })
    expect(profile).not.toHaveProperty('passwordHash')
  })

  it('updates display name, avatar and theme', async () => {
    user = await createUser(api.prisma)
    const response = await update({
      displayName: '  Grace  ',
      avatarUrl: 'https://cdn.test/a.png',
      theme: 'dark',
    })
    expect(response.statusCode).toBe(200)
    expect(await read()).toMatchObject({
      displayName: 'Grace',
      avatarUrl: 'https://cdn.test/a.png',
      theme: 'dark',
    })
  })

  it('removes an avatar with null', async () => {
    user = await createUser(api.prisma)
    await update({ avatarUrl: 'https://cdn.test/a.png' })
    await update({ avatarUrl: null })
    expect((await read()).avatarUrl).toBeNull()
  })

  it('syncs settings across devices, as a second session reads the same values', async () => {
    user = await createUser(api.prisma)
    await update({ editorSettings: { keybindings: 'vim' } })
    expect((await read()).editorSettings.keybindings).toBe('vim')
  })

  it('merges a partial settings change with what is stored', async () => {
    user = await createUser(api.prisma)
    await update({ editorSettings: { fontSize: 18 } })
    await update({ editorSettings: { tabSize: 2 } })
    expect((await read()).editorSettings).toEqual({
      fontSize: 18,
      tabSize: 2,
      keybindings: 'default',
    })
  })

  it.each([
    ['a script avatar', { avatarUrl: 'javascript:alert(1)' }],
    ['a data avatar', { avatarUrl: 'data:text/html,<script>alert(1)</script>' }],
    ['a plain http avatar', { avatarUrl: 'http://cdn.test/a.png' }],
    ['an unknown theme', { theme: 'neon' }],
    ['an empty name', { displayName: '   ' }],
    ['a huge font', { editorSettings: { fontSize: 500 } }],
    ['unknown keybindings', { editorSettings: { keybindings: 'nano' } }],
    ['an unknown setting', { editorSettings: { extra: true } }],
  ])('rejects %s', async (_name, payload) => {
    user = await createUser(api.prisma)
    expect((await update(payload)).statusCode).toBe(400)
  })

  it.each([
    ['a role', { role: 'ADMIN' }],
    ['an email', { email: 'new@test.local' }],
    ['a verified flag', { emailVerifiedAt: '2026-01-01' }],
    ['a password hash', { passwordHash: 'x' }],
  ])('refuses to let a user set %s', async (_name, payload) => {
    user = await createUser(api.prisma)
    expect((await update(payload)).statusCode).toBe(400)
    expect((await read()).role).toBe('USER')
  })

  it('only ever touches the signed-in user', async () => {
    const first = await createUser(api.prisma, 'First')
    const second = await createUser(api.prisma, 'Second')
    await update({ displayName: 'Changed' }, first)
    expect((await read(second)).displayName).toBe('Second')
  })

  it('requires an access token', async () => {
    const response = await api.app.inject({ method: 'GET', url: '/api/v1/me' })
    expect(response.statusCode).toBe(401)
  })
})
