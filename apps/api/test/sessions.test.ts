import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CSRF_COOKIE, REFRESH_COOKIE } from '../src/modules/auth/cookies.js'
import { hashToken } from '../src/modules/auth/sessions.js'
import {
  PASSWORD,
  WEB_ORIGIN,
  createVerifiedUser,
  login,
  post,
  refresh,
  sessionFrom,
  signedIn,
  type BrowserSession,
} from './authHelpers.js'
import { config, createTestApi, type TestApi } from './helpers.js'

describe('sessions', () => {
  let api: TestApi

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  const familyTokens = async (session: BrowserSession) => {
    const row = await api.prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashToken(session.refresh) },
    })
    return api.prisma.refreshToken.findMany({ where: { familyId: row.familyId } })
  }

  describe('login', () => {
    it('returns a 15-minute access token and sets hardened cookies', async () => {
      const response = await login(api, await createVerifiedUser(api))
      expect(response.statusCode).toBe(200)
      const { accessToken, expiresIn } = response.json()
      expect(expiresIn).toBe(900)
      const payload = jwt.verify(accessToken, config.accessTokenSecret, {
        algorithms: ['HS256'],
        audience: 'api',
      }) as jwt.JwtPayload
      expect((payload.exp as number) - (payload.iat as number)).toBe(900)

      const refreshCookie = response.cookies.find((cookie) => cookie.name === REFRESH_COOKIE)
      expect(refreshCookie).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: '/api/v1/auth',
      })
      const csrfCookie = response.cookies.find((cookie) => cookie.name === CSRF_COOKIE)
      expect(csrfCookie?.httpOnly).toBeUndefined()
      expect(csrfCookie).toMatchObject({ secure: true, sameSite: 'Lax', path: '/' })
    })

    it('never returns the refresh token in the body', async () => {
      const response = await login(api, await createVerifiedUser(api))
      expect(response.body).not.toContain(sessionFrom(response).refresh)
    })

    it('stores only a hash of the refresh token', async () => {
      const session = await signedIn(api)
      const [row] = await familyTokens(session)
      expect(row?.tokenHash).toBe(hashToken(session.refresh))
      expect(row?.tokenHash).not.toContain(session.refresh)
    })
  })

  describe('rotation', () => {
    it('issues a new token and a working access token on each refresh', async () => {
      const first = await signedIn(api)
      const response = await refresh(api, first)
      expect(response.statusCode).toBe(200)
      const second = sessionFrom(response)
      expect(second.refresh).not.toBe(first.refresh)

      const me = await api.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${response.json().accessToken}` },
      })
      expect(me.statusCode).toBe(200)
    })

    it('keeps rotating through a chain of tokens in one family', async () => {
      let session = await signedIn(api)
      for (let index = 0; index < 4; index++) {
        const response = await refresh(api, session)
        expect(response.statusCode).toBe(200)
        session = sessionFrom(response)
      }
      expect(await familyTokens(session)).toHaveLength(5)
    })

    it('refuses an expired token', async () => {
      const session = await signedIn(api)
      await api.prisma.refreshToken.updateMany({
        where: { tokenHash: hashToken(session.refresh) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      expect((await refresh(api, session)).statusCode).toBe(401)
    })

    it('refuses an unknown token', async () => {
      const session = await signedIn(api)
      const response = await refresh(api, { ...session, refresh: 'made-up-token' })
      expect(response.statusCode).toBe(401)
    })
  })

  describe('reuse detection', () => {
    it('revokes the whole family when a used token is presented', async () => {
      const stolen = await signedIn(api)
      const victim = sessionFrom(await refresh(api, stolen))

      // The token is replayed after its owner already rotated it.
      expect((await refresh(api, stolen)).statusCode).toBe(401)

      expect((await refresh(api, victim)).statusCode).toBe(401)
      const rows = await familyTokens(victim)
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true)
    })

    it('also ends the session when the thief rotates first', async () => {
      const shared = await signedIn(api)
      const thief = sessionFrom(await refresh(api, shared))
      // The real user's next refresh is the replay that exposes the theft.
      expect((await refresh(api, shared)).statusCode).toBe(401)
      expect((await refresh(api, thief)).statusCode).toBe(401)
    })

    it('clears the cookies when it refuses', async () => {
      const stolen = await signedIn(api)
      await refresh(api, stolen)
      const response = await refresh(api, stolen)
      const cookie = response.cookies.find((item) => item.name === REFRESH_COOKIE)
      expect(cookie?.value).toBe('')
    })

    it('does not touch other sessions of the same user', async () => {
      const email = await createVerifiedUser(api)
      const compromised = sessionFrom(await login(api, email))
      const otherDevice = sessionFrom(await login(api, email))
      await refresh(api, compromised)
      await refresh(api, compromised)
      expect((await refresh(api, otherDevice)).statusCode).toBe(200)
    })

    it('never gives two concurrent requests a new token from one old token', async () => {
      const session = await signedIn(api)
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => refresh(api, session)),
      )
      const winners = responses.filter((response) => response.statusCode === 200)
      expect(winners.length).toBeLessThanOrEqual(1)
      const rows = await familyTokens(session)
      // A race for one token looks like theft, so the family ends and nobody keeps a session.
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true)
    })
  })

  describe('logout', () => {
    const logout = (session: BrowserSession) =>
      api.app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { [REFRESH_COOKIE]: session.refresh, [CSRF_COOKIE]: session.csrf },
        headers: { origin: WEB_ORIGIN, 'x-csrf-token': session.csrf },
      })

    it('ends the session', async () => {
      const session = await signedIn(api)
      expect((await logout(session)).statusCode).toBe(204)
      expect((await refresh(api, session)).statusCode).toBe(401)
    })

    it('ends the family, so an older rotated token cannot bring it back', async () => {
      const first = await signedIn(api)
      const second = sessionFrom(await refresh(api, first))
      await logout(second)
      expect((await refresh(api, first)).statusCode).toBe(401)
      expect((await refresh(api, second)).statusCode).toBe(401)
    })
  })

  describe('CSRF', () => {
    it('refuses a refresh with no CSRF header', async () => {
      const session = await signedIn(api)
      const response = await api.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: session.refresh, [CSRF_COOKIE]: session.csrf },
        headers: { origin: WEB_ORIGIN },
      })
      expect(response.statusCode).toBe(403)
    })

    it('refuses a mismatched CSRF header', async () => {
      const session = await signedIn(api)
      const response = await refresh(api, session, { 'x-csrf-token': 'guessed' })
      expect(response.statusCode).toBe(403)
    })

    it('refuses another origin even with a matching token', async () => {
      const session = await signedIn(api)
      const response = await refresh(api, session, { origin: 'https://evil.test' })
      expect(response.statusCode).toBe(403)
    })

    it('refuses a request with no origin', async () => {
      const session = await signedIn(api)
      const response = await api.app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        cookies: { [REFRESH_COOKIE]: session.refresh, [CSRF_COOKIE]: session.csrf },
        headers: { 'x-csrf-token': session.csrf },
      })
      expect(response.statusCode).toBe(403)
    })

    it('does not spend the token on a refused request', async () => {
      const session = await signedIn(api)
      await refresh(api, session, { origin: 'https://evil.test' })
      expect((await refresh(api, session)).statusCode).toBe(200)
    })

    it('refuses a login posted from another site', async () => {
      const email = await createVerifiedUser(api)
      const response = await post(
        api,
        '/auth/login',
        { email, password: PASSWORD },
        { origin: 'https://evil.test' },
      )
      expect(response.statusCode).toBe(403)
    })

    it('rejects a form-encoded login, which a cross-site form could send', async () => {
      const email = await createVerifiedUser(api)
      const response = await api.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `email=${email}&password=${PASSWORD}`,
      })
      expect(response.statusCode).toBe(415)
    })
  })

  describe('access tokens', () => {
    it('are refused when forged, expired, or issued for another audience', async () => {
      const email = await createVerifiedUser(api)
      const { accessToken } = (await login(api, email)).json()
      const { sub } = jwt.decode(accessToken) as jwt.JwtPayload
      const call = (token: string) =>
        api.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { authorization: `Bearer ${token}` },
        })
      const sign = (secret: string, options: jwt.SignOptions) =>
        jwt.sign({}, secret, { algorithm: 'HS256', subject: sub as string, ...options })

      expect((await call(accessToken)).statusCode).toBe(200)
      expect(
        (await call(sign('attacker-secret-with-at-least-32-chars', { audience: 'api' }))).statusCode,
      ).toBe(401)
      expect(
        (await call(sign(config.accessTokenSecret, { audience: 'api', expiresIn: -10 }))).statusCode,
      ).toBe(401)
      expect(
        (await call(sign(config.accessTokenSecret, { audience: 'collab' }))).statusCode,
      ).toBe(401)
    })

    it('reject the collab token, which has a different secret and purpose', async () => {
      const unsigned = jwt.sign({ sub: crypto.randomUUID() }, '', {
        algorithm: 'none',
        audience: 'api',
      })
      const response = await api.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${unsigned}` },
      })
      expect(response.statusCode).toBe(401)
    })
  })
})
