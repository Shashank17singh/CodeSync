import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import jwt from 'jsonwebtoken'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../src/modules/auth/passwords.js'
import {
  createGitHubProvider,
  createGoogleProvider,
  type CodeExchange,
  type Fetch,
  type OAuthProfile,
  type OAuthProvider,
} from '../src/modules/auth/providers.js'
import { PASSWORD, login, refresh, sessionFrom, signedIn, uniqueEmail } from './authHelpers.js'
import { REFRESH_COOKIE } from '../src/modules/auth/cookies.js'
import { config, createTestApi, type TestApi } from './helpers.js'

const FAILED = `${config.publicWebUrl}/login?error=oauth_failed`
const SUCCESS = `${config.publicWebUrl}/auth/callback`

class FakeProvider implements OAuthProvider {
  profile: OAuthProfile = {
    providerAccountId: crypto.randomUUID(),
    email: uniqueEmail(),
    emailVerified: true,
    displayName: 'OAuth User',
    avatarUrl: null,
  }
  exchanges: CodeExchange[] = []
  failure: Error | null = null

  authorizeUrl({ state, codeChallenge, redirectUri }: Parameters<OAuthProvider['authorizeUrl']>[0]) {
    const query = new URLSearchParams({ state, codeChallenge, redirectUri })
    return `https://provider.test/authorize?${query}`
  }

  async fetchProfile(exchange: CodeExchange): Promise<OAuthProfile> {
    if (this.failure) throw this.failure
    this.exchanges.push(exchange)
    return this.profile
  }
}

describe('OAuth login', () => {
  let api: TestApi
  let provider: FakeProvider

  beforeAll(async () => {
    provider = new FakeProvider()
    api = await createTestApi(undefined, { oauth: { github: provider } })
  })
  beforeEach(() => {
    provider.profile = {
      providerAccountId: crypto.randomUUID(),
      email: uniqueEmail(),
      emailVerified: true,
      displayName: 'OAuth User',
      avatarUrl: null,
    }
    provider.exchanges = []
    provider.failure = null
  })
  afterAll(() => api.close())

  const start = async () => {
    const response = await api.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github' })
    const location = new URL(response.headers.location as string)
    const cookie = response.cookies.find((item) => item.name === 'codesync_oauth')
    return {
      response,
      state: location.searchParams.get('state') as string,
      challenge: location.searchParams.get('codeChallenge') as string,
      cookie: cookie?.value as string,
    }
  }

  const callback = (query: Record<string, string>, cookie?: string, provider = 'github') =>
    api.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/${provider}/callback`,
      query,
      ...(cookie ? { cookies: { codesync_oauth: cookie } } : {}),
    })

  const complete = async () => {
    const { state, cookie } = await start()
    return callback({ code: 'provider-code', state }, cookie)
  }

  describe('starting', () => {
    it('redirects with a state and a PKCE S256 challenge', async () => {
      const { response, state, challenge } = await start()
      expect(response.statusCode).toBe(302)
      expect(state.length).toBeGreaterThan(30)
      expect(challenge).toMatch(/^[\w-]{43}$/)
    })

    it('keeps the state in an httpOnly cookie for this callback path only', async () => {
      const { response } = await start()
      const cookie = response.cookies.find((item) => item.name === 'codesync_oauth')
      expect(cookie).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/api/v1/auth/oauth',
      })
    })

    it('returns 404 for a provider that is not configured', async () => {
      const response = await api.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/google' })
      expect(response.statusCode).toBe(404)
    })
  })

  describe('callback', () => {
    it('creates a verified account and a session, with no token in the redirect', async () => {
      const { state, cookie } = await start()
      const response = await callback({ code: 'provider-code', state }, cookie)
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe(SUCCESS)

      const user = await api.prisma.user.findUniqueOrThrow({
        where: { email: provider.profile.email as string },
        include: { oauthAccounts: true },
      })
      expect(user.emailVerifiedAt).not.toBeNull()
      expect(user.passwordHash).toBeNull()
      expect(user.oauthAccounts[0]).toMatchObject({
        provider: 'GITHUB',
        providerAccountId: provider.profile.providerAccountId,
      })
      expect((await refresh(api, sessionFrom(response))).statusCode).toBe(200)
    })

    it('sends the verifier matching the challenge from the start of the flow', async () => {
      const { state, challenge, cookie } = await start()
      await callback({ code: 'provider-code', state }, cookie)
      const { code, codeVerifier, redirectUri } = provider.exchanges[0] as CodeExchange
      expect(code).toBe('provider-code')
      expect(createHash('sha256').update(codeVerifier).digest('base64url')).toBe(challenge)
      expect(redirectUri).toBe(`${config.publicApiUrl}/api/v1/auth/oauth/github/callback`)
    })

    it('finds the same user on a second login, even after the email changes', async () => {
      await complete()
      const first = await api.prisma.oAuthAccount.findFirstOrThrow({
        where: { providerAccountId: provider.profile.providerAccountId },
      })
      provider.profile = { ...provider.profile, email: uniqueEmail() }
      await complete()
      expect(
        await api.prisma.oAuthAccount.count({
          where: { providerAccountId: provider.profile.providerAccountId },
        }),
      ).toBe(1)
      const { userId } = await api.prisma.oAuthAccount.findFirstOrThrow({
        where: { providerAccountId: provider.profile.providerAccountId },
      })
      expect(userId).toBe(first.userId)
    })

    it('links to a verified password account with the same address', async () => {
      const email = uniqueEmail()
      const user = await api.prisma.user.create({
        data: {
          email,
          displayName: 'Existing',
          passwordHash: await hashPassword(PASSWORD),
          emailVerifiedAt: new Date(),
        },
      })
      provider.profile = { ...provider.profile, email }
      expect((await complete()).headers.location).toBe(SUCCESS)
      const account = await api.prisma.oAuthAccount.findFirstOrThrow({
        where: { userId: user.id },
      })
      expect(account.provider).toBe('GITHUB')
      expect((await login(api, email)).statusCode).toBe(200)
    })

    it('removes a password someone set on an unverified account with this address', async () => {
      const email = uniqueEmail()
      await api.prisma.user.create({
        data: {
          email,
          displayName: 'Attacker',
          passwordHash: await hashPassword('attacker chosen password'),
        },
      })
      provider.profile = { ...provider.profile, email }
      expect((await complete()).headers.location).toBe(SUCCESS)
      expect((await login(api, email, 'attacker chosen password')).statusCode).toBe(401)
      const user = await api.prisma.user.findUniqueOrThrow({ where: { email } })
      expect(user.passwordHash).toBeNull()
      expect(user.emailVerifiedAt).not.toBeNull()
    })

    it('ends any existing session on an unverified account it takes over', async () => {
      const email = uniqueEmail()
      const planted = await api.prisma.user.create({
        data: { email, displayName: 'Attacker' },
      })
      await api.prisma.refreshToken.create({
        data: {
          userId: planted.id,
          familyId: crypto.randomUUID(),
          tokenHash: crypto.randomUUID(),
          expiresAt: new Date(Date.now() + 100_000),
        },
      })
      provider.profile = { ...provider.profile, email }
      await complete()
      const revoked = await api.prisma.refreshToken.findFirstOrThrow({
        where: { userId: planted.id, tokenHash: { not: { startsWith: 'x' } } },
        orderBy: { createdAt: 'asc' },
      })
      expect(revoked.revokedAt).not.toBeNull()
    })

    it('refuses an address the provider has not verified, and links nothing', async () => {
      const session = await signedIn(api)
      expect(session.refresh).toBeTruthy()
      const email = uniqueEmail()
      await api.prisma.user.create({
        data: { email, displayName: 'Victim', emailVerifiedAt: new Date() },
      })
      provider.profile = { ...provider.profile, email, emailVerified: false }
      expect((await complete()).headers.location).toBe(FAILED)
      expect(
        await api.prisma.oAuthAccount.count({
          where: { providerAccountId: provider.profile.providerAccountId },
        }),
      ).toBe(0)
    })

    it('refuses an account with no email', async () => {
      provider.profile = { ...provider.profile, email: null }
      expect((await complete()).headers.location).toBe(FAILED)
    })

    it('fails cleanly when the provider does', async () => {
      provider.failure = new Error('provider down')
      const response = await complete()
      expect(response.headers.location).toBe(FAILED)
      expect(response.body).not.toContain('provider down')
    })
  })

  describe('login CSRF', () => {
    it('refuses a state that does not match the cookie', async () => {
      const { cookie } = await start()
      const response = await callback({ code: 'code', state: 'attacker-state' }, cookie)
      expect(response.headers.location).toBe(FAILED)
      expect(provider.exchanges).toHaveLength(0)
    })

    it('refuses a callback with no cookie, as a link sent to a victim would be', async () => {
      const { state } = await start()
      const response = await callback({ code: 'attacker-code', state })
      expect(response.headers.location).toBe(FAILED)
      expect(provider.exchanges).toHaveLength(0)
    })

    it('refuses a forged cookie', async () => {
      const forged = jwt.sign(
        { state: 'chosen', verifier: 'chosen', provider: 'github' },
        'attacker-secret-with-at-least-32-chars',
        { algorithm: 'HS256', audience: 'oauth', expiresIn: 600 },
      )
      const response = await callback({ code: 'code', state: 'chosen' }, forged)
      expect(response.headers.location).toBe(FAILED)
    })

    it('refuses an expired cookie', async () => {
      const expired = jwt.sign(
        { state: 'chosen', verifier: 'chosen', provider: 'github' },
        config.oauthStateSecret,
        { algorithm: 'HS256', audience: 'oauth', expiresIn: -10 },
      )
      const response = await callback({ code: 'code', state: 'chosen' }, expired)
      expect(response.headers.location).toBe(FAILED)
    })

    it('refuses a state issued for another provider', async () => {
      const crossed = jwt.sign(
        { state: 'chosen', verifier: 'chosen', provider: 'google' },
        config.oauthStateSecret,
        { algorithm: 'HS256', audience: 'oauth', expiresIn: 600 },
      )
      const response = await callback({ code: 'code', state: 'chosen' }, crossed)
      expect(response.headers.location).toBe(FAILED)
    })

    it('clears the state cookie, so a callback URL cannot be replayed', async () => {
      const response = await complete()
      const cookie = response.cookies.find((item) => item.name === 'codesync_oauth')
      expect(cookie?.value).toBe('')
    })

    it('does not start a session on failure', async () => {
      const { cookie } = await start()
      const response = await callback({ code: 'code', state: 'wrong' }, cookie)
      expect(response.cookies.find((item) => item.name === REFRESH_COOKIE)).toBeUndefined()
    })
  })
})

describe('logging', () => {
  it('keeps OAuth codes and state out of the logs at any level', async () => {
    let logged = ''
    const sink = new Writable({
      write(chunk, _encoding, done) {
        logged += String(chunk)
        done()
      },
    })
    const provider = new FakeProvider()
    const api = await createTestApi(undefined, {
      oauth: { github: provider },
      logger: pino({ level: 'trace' }, sink),
    })
    const start = await api.app.inject({ method: 'GET', url: '/api/v1/auth/oauth/github' })
    const state = new URL(start.headers.location as string).searchParams.get('state') as string
    await api.app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/github/callback',
      query: { code: 'secret-provider-code', state },
      cookies: { codesync_oauth: start.cookies[0]?.value as string },
    })
    await api.close()
    expect(provider.exchanges).toHaveLength(1)
    expect(logged).not.toContain('secret-provider-code')
    expect(logged).not.toContain(state)
  })
})

describe('provider clients', () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status })

  const credentials = { clientId: 'client-id', clientSecret: 'client-secret' }
  const exchange = { code: 'the-code', codeVerifier: 'the-verifier', redirectUri: 'https://api/cb' }

  describe('GitHub', () => {
    const responses = (emails: unknown[], user: object = {}) =>
      vi.fn<Fetch>(async (input) => {
        const url = String(input)
        if (url.endsWith('/access_token')) return json({ access_token: 'gh-token' })
        if (url.endsWith('/user/emails')) return json(emails)
        return json({
          id: 42,
          login: 'octo',
          name: 'Octo Cat',
          avatar_url: 'https://avatars/x',
          ...user,
        })
      })

    it('requests PKCE and sends the secret and verifier only to GitHub', async () => {
      const fetcher = responses([{ email: 'A@B.test', primary: true, verified: true }])
      const client = createGitHubProvider(credentials, fetcher)

      const url = new URL(
        client.authorizeUrl({ state: 's', codeChallenge: 'c', redirectUri: 'https://api/cb' }),
      )
      expect(url.origin).toBe('https://github.com')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      expect(url.searchParams.has('client_secret')).toBe(false)

      await client.fetchProfile(exchange)
      const [tokenUrl, init] = fetcher.mock.calls[0] as [string, RequestInit]
      expect(tokenUrl).toBe('https://github.com/login/oauth/access_token')
      expect(JSON.parse(init.body as string)).toMatchObject({
        client_secret: 'client-secret',
        code_verifier: 'the-verifier',
      })
    })

    it('uses the primary address and reports whether it is verified', async () => {
      const client = createGitHubProvider(
        credentials,
        responses([
          { email: 'other@b.test', primary: false, verified: true },
          { email: 'Main@B.test', primary: true, verified: false },
        ]),
      )
      expect(await client.fetchProfile(exchange)).toMatchObject({
        providerAccountId: '42',
        email: 'main@b.test',
        emailVerified: false,
        displayName: 'Octo Cat',
      })
    })

    it('falls back to the login when there is no name', async () => {
      const client = createGitHubProvider(
        credentials,
        responses([{ email: 'a@b.test', primary: true, verified: true }], { name: null }),
      )
      expect((await client.fetchProfile(exchange)).displayName).toBe('octo')
    })

    it('drops an avatar that is not https', async () => {
      const client = createGitHubProvider(
        credentials,
        responses([{ email: 'a@b.test', primary: true, verified: true }], {
          avatar_url: 'javascript:alert(1)',
        }),
      )
      expect((await client.fetchProfile(exchange)).avatarUrl).toBeNull()
    })

    it('fails when GitHub returns an error instead of a token', async () => {
      const client = createGitHubProvider(
        credentials,
        vi.fn<Fetch>(async () => json({ error: 'bad_verification_code' })),
      )
      await expect(client.fetchProfile(exchange)).rejects.toThrow()
    })
  })

  describe('Google', () => {
    it('reads email_verified from userinfo', async () => {
      const fetcher = vi.fn<Fetch>(async (input) =>
        String(input).endsWith('/token')
          ? json({ access_token: 'g-token' })
          : json({
              sub: 'google-sub',
              email: 'A@Gmail.test',
              email_verified: true,
              name: 'Ada',
              picture: 'https://lh3/x',
            }),
      )
      const client = createGoogleProvider(credentials, fetcher)
      expect(await client.fetchProfile(exchange)).toEqual({
        providerAccountId: 'google-sub',
        email: 'a@gmail.test',
        emailVerified: true,
        displayName: 'Ada',
        avatarUrl: 'https://lh3/x',
      })
      const [url] = fetcher.mock.calls[1] as [string]
      expect(url).toBe('https://openidconnect.googleapis.com/v1/userinfo')
    })

    it('treats a missing email_verified as unverified', async () => {
      const client = createGoogleProvider(
        credentials,
        vi.fn<Fetch>(async (input) =>
          String(input).endsWith('/token')
            ? json({ access_token: 't' })
            : json({ sub: 's', email: 'a@b.test' }),
        ),
      )
      expect((await client.fetchProfile(exchange)).emailVerified).toBe(false)
    })

    it('fails on an error status', async () => {
      const client = createGoogleProvider(
        credentials,
        vi.fn<Fetch>(async () => json({}, 401)),
      )
      await expect(client.fetchProfile(exchange)).rejects.toThrow()
    })
  })
})
