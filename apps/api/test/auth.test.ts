import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AUTH_LIMITS, MemoryRateLimiter } from '../src/modules/auth/rateLimit.js'
import { hashToken } from '../src/modules/auth/sessions.js'
import {
  PASSWORD,
  createVerifiedUser,
  login,
  post,
  refresh,
  sessionFrom,
  tokenFromLink,
  uniqueEmail,
  waitForEmail,
} from './authHelpers.js'
import { createTestApi, type TestApi } from './helpers.js'

const NEW_PASSWORD = 'a different long passphrase'

const IP_LIMIT = AUTH_LIMITS.loginPerIp.limit
const ACCOUNT_LIMIT = AUTH_LIMITS.loginPerAccount.limit

describe('accounts', () => {
  let api: TestApi

  // These tests share one address and are not about limits, which have their own suite below.
  beforeAll(async () => {
    const limiter = new MemoryRateLimiter()
    limiter.hit = async () => ({ allowed: true, retryAfterMs: 0 })
    api = await createTestApi(undefined, { limiter })
  })
  afterAll(() => api.close())

  const signup = (email: string, password = PASSWORD) =>
    post(api, '/auth/signup', { email, password, displayName: 'New User' })

  const verificationToken = async (email: string): Promise<string> => {
    const deadline = Date.now() + 3_000
    for (;;) {
      const mail = [...api.mailer.verifications].reverse().find((item) => item.to === email)
      if (mail) return tokenFromLink(mail.url)
      if (Date.now() > deadline) throw new Error('no verification email')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  const resetToken = async (email: string): Promise<string> => {
    const count = api.mailer.resets.length
    await post(api, '/auth/password/forgot', { email })
    const mail = await waitForEmail(api.mailer.resets, count + 1)
    return tokenFromLink(mail.url)
  }

  describe('signup', () => {
    it('stores an Argon2id hash with the OWASP minimum, never the password', async () => {
      const email = uniqueEmail()
      expect((await signup(email)).statusCode).toBe(202)
      const user = await api.prisma.user.findUniqueOrThrow({ where: { email } })
      expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
      expect(user.emailVerifiedAt).toBeNull()
    })

    it('answers identically for a free and a taken address', async () => {
      const taken = await createVerifiedUser(api)
      const free = await signup(uniqueEmail())
      const duplicate = await signup(taken)
      expect(duplicate.statusCode).toBe(free.statusCode)
      expect(duplicate.body).toBe(free.body)
    })

    it('leaves an existing account untouched when its address signs up again', async () => {
      const email = await createVerifiedUser(api)
      await signup(email, 'attacker chosen password')
      expect((await login(api, email)).statusCode).toBe(200)
      expect((await login(api, email, 'attacker chosen password')).statusCode).toBe(401)
    })

    it('treats addresses as case-insensitive', async () => {
      const email = uniqueEmail()
      await signup(email.toUpperCase())
      expect(await api.prisma.user.count({ where: { email } })).toBe(1)
    })

    it.each([
      ['too short', 'short'],
      ['too long', 'x'.repeat(129)],
    ])('rejects a password that is %s', async (_name, password) => {
      expect((await signup(uniqueEmail(), password)).statusCode).toBe(400)
    })
  })

  describe('email verification', () => {
    it('blocks login until verified, then allows it', async () => {
      const email = uniqueEmail()
      await signup(email)
      const blocked = await login(api, email)
      expect(blocked.statusCode).toBe(403)
      expect(blocked.json().error.code).toBe('email_not_verified')

      const token = await verificationToken(email)
      const verified = await post(api, '/auth/verify-email', { token, password: PASSWORD })
      expect(verified.statusCode).toBe(200)
      expect((await login(api, email)).statusCode).toBe(200)
    })

    it('hides the unverified state from someone without the password', async () => {
      const email = uniqueEmail()
      await signup(email)
      const response = await login(api, email, 'wrong password here')
      expect(response.statusCode).toBe(401)
      expect(response.json().error.code).toBe('invalid_credentials')
    })

    it('keeps tokens in a fragment and stores only their hash', async () => {
      const email = uniqueEmail()
      await signup(email)
      const token = await verificationToken(email)
      const row = await api.prisma.authToken.findUniqueOrThrow({
        where: { tokenHash: hashToken(token) },
      })
      expect(row.tokenHash).not.toBe(token)
      const mail = api.mailer.verifications.find((item) => item.to === email)
      expect(mail?.url).toContain('/verify-email#token=')
    })

    it('works only once', async () => {
      const email = uniqueEmail()
      await signup(email)
      const token = await verificationToken(email)
      await post(api, '/auth/verify-email', { token, password: PASSWORD })
      const again = await post(api, '/auth/verify-email', { token, password: PASSWORD })
      expect(again.statusCode).toBe(400)
    })

    it('refuses an expired link', async () => {
      const email = uniqueEmail()
      await signup(email)
      const token = await verificationToken(email)
      await api.prisma.authToken.update({
        where: { tokenHash: hashToken(token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      const response = await post(api, '/auth/verify-email', { token, password: PASSWORD })
      expect(response.statusCode).toBe(400)
    })

    it('refuses a password reset token', async () => {
      const email = await createVerifiedUser(api)
      const token = await resetToken(email)
      const response = await post(api, '/auth/verify-email', { token, password: PASSWORD })
      expect(response.statusCode).toBe(400)
    })

    it('replaces an older link when a new one is requested', async () => {
      const email = uniqueEmail()
      await signup(email)
      const first = await verificationToken(email)
      const count = api.mailer.verifications.length
      await post(api, '/auth/verify-email/resend', { email })
      await waitForEmail(api.mailer.verifications, count + 1)
      const stale = await post(api, '/auth/verify-email', { token: first, password: PASSWORD })
      expect(stale.statusCode).toBe(400)
    })

    it('sends nothing to a verified account', async () => {
      const email = await createVerifiedUser(api)
      const before = api.mailer.verifications.length
      expect((await post(api, '/auth/verify-email/resend', { email })).statusCode).toBe(202)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(api.mailer.verifications.length).toBe(before)
    })
  })

  describe('account pre-hijacking', () => {
    it('stops an attacker password surviving when the real owner verifies', async () => {
      // The attacker registers the victim's address with a password of their choosing.
      const victim = uniqueEmail()
      await signup(victim, 'attacker chosen password')
      const token = await verificationToken(victim)

      // The victim clicks the emailed link but cannot complete it, not knowing that password.
      const response = await post(api, '/auth/verify-email', {
        token,
        password: 'the victim guesses',
      })
      expect(response.statusCode).toBe(401)
      const user = await api.prisma.user.findUniqueOrThrow({ where: { email: victim } })
      expect(user.emailVerifiedAt).toBeNull()
      expect((await login(api, victim, 'attacker chosen password')).statusCode).toBe(403)
    })

    it('lets the owner take the account with a reset, which removes that password', async () => {
      const victim = uniqueEmail()
      await signup(victim, 'attacker chosen password')
      const token = await resetToken(victim)
      await post(api, '/auth/password/reset', { token, password: NEW_PASSWORD })

      expect((await login(api, victim, NEW_PASSWORD)).statusCode).toBe(200)
      expect((await login(api, victim, 'attacker chosen password')).statusCode).toBe(401)
    })
  })

  describe('login', () => {
    it('gives the same answer for a wrong password and an unknown account', async () => {
      const email = await createVerifiedUser(api)
      const wrong = await login(api, email, 'wrong password here')
      const unknown = await login(api, uniqueEmail(), 'wrong password here')
      expect(unknown.statusCode).toBe(401)
      expect(unknown.body).toBe(wrong.body)
    })

    it('spends comparable time on an unknown account', async () => {
      const email = await createVerifiedUser(api)
      const timed = async (address: string): Promise<number> => {
        const started = performance.now()
        await login(api, address, 'wrong password here')
        return performance.now() - started
      }
      await timed(uniqueEmail())
      const known = await timed(email)
      const unknown = await timed(uniqueEmail())
      // Without the decoy check an unknown account returns in a few milliseconds.
      expect(unknown).toBeGreaterThan(known / 3)
    })

    it('refuses password login for an account created through OAuth', async () => {
      const email = uniqueEmail()
      await api.prisma.user.create({
        data: { email, displayName: 'OAuth', emailVerifiedAt: new Date() },
      })
      expect((await login(api, email)).statusCode).toBe(401)
    })
  })

  describe('password reset', () => {
    it('changes the password and ends every session', async () => {
      const email = await createVerifiedUser(api)
      const session = sessionFrom(await login(api, email))
      const token = await resetToken(email)
      const response = await post(api, '/auth/password/reset', { token, password: NEW_PASSWORD })
      expect(response.statusCode).toBe(200)

      expect((await login(api, email)).statusCode).toBe(401)
      expect((await login(api, email, NEW_PASSWORD)).statusCode).toBe(200)
      expect((await refresh(api, session)).statusCode).toBe(401)
    })

    it('works only once', async () => {
      const email = await createVerifiedUser(api)
      const token = await resetToken(email)
      await post(api, '/auth/password/reset', { token, password: NEW_PASSWORD })
      const again = await post(api, '/auth/password/reset', {
        token,
        password: 'yet another long password',
      })
      expect(again.statusCode).toBe(400)
      expect((await login(api, email, NEW_PASSWORD)).statusCode).toBe(200)
    })

    it('lets only one of two concurrent uses through', async () => {
      const email = await createVerifiedUser(api)
      const token = await resetToken(email)
      const results = await Promise.all([
        post(api, '/auth/password/reset', { token, password: NEW_PASSWORD }),
        post(api, '/auth/password/reset', { token, password: 'yet another long password' }),
      ])
      expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1)
    })

    it('refuses an expired link and a verification token', async () => {
      const email = uniqueEmail()
      await signup(email)
      const verify = await verificationToken(email)
      const wrongPurpose = await post(api, '/auth/password/reset', {
        token: verify,
        password: NEW_PASSWORD,
      })
      expect(wrongPurpose.statusCode).toBe(400)

      const reset = await resetToken(email)
      await api.prisma.authToken.update({
        where: { tokenHash: hashToken(reset) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      const expired = await post(api, '/auth/password/reset', {
        token: reset,
        password: NEW_PASSWORD,
      })
      expect(expired.statusCode).toBe(400)
    })

    it('answers the same for a known and an unknown address', async () => {
      const known = await post(api, '/auth/password/forgot', {
        email: await createVerifiedUser(api),
      })
      const unknown = await post(api, '/auth/password/forgot', { email: uniqueEmail() })
      expect(unknown.statusCode).toBe(known.statusCode)
      expect(unknown.body).toBe(known.body)
    })

    it('still answers when the mail server is down', async () => {
      const send = api.mailer.sendPasswordReset.bind(api.mailer)
      api.mailer.sendPasswordReset = async () => {
        throw new Error('smtp down')
      }
      const response = await post(api, '/auth/password/forgot', {
        email: await createVerifiedUser(api),
      })
      api.mailer.sendPasswordReset = send
      expect(response.statusCode).toBe(202)
    })
  })
})

describe('rate limits', () => {
  let api: TestApi

  afterEach(() => api.close())

  const attempts = async (
    count: number,
    attempt: (index: number) => Promise<{ statusCode: number }>,
  ): Promise<number[]> => {
    const codes: number[] = []
    for (let index = 0; index < count; index++) codes.push((await attempt(index)).statusCode)
    return codes
  }

  it('stops guessing against one account from many addresses', async () => {
    api = await createTestApi(undefined, { trustProxyHops: 1 })
    const email = await createVerifiedUser(api)
    const codes = await attempts(ACCOUNT_LIMIT + 2, (index) =>
      post(
        api,
        '/auth/login',
        { email, password: 'wrong password here' },
        { 'x-forwarded-for': `203.0.113.${index}` },
      ),
    )
    expect(codes.slice(0, ACCOUNT_LIMIT).every((code) => code === 401)).toBe(true)
    expect(codes.slice(ACCOUNT_LIMIT)).toEqual([429, 429])
  })

  it('stops one address guessing across many accounts', async () => {
    api = await createTestApi()
    const codes = await attempts(IP_LIMIT + 2, () =>
      post(api, '/auth/login', { email: uniqueEmail(), password: 'wrong password here' }),
    )
    expect(codes.at(IP_LIMIT - 1)).toBe(401)
    expect(codes.slice(IP_LIMIT)).toEqual([429, 429])
  })

  it('tells the client when to retry', async () => {
    api = await createTestApi()
    const email = await createVerifiedUser(api)
    await attempts(ACCOUNT_LIMIT, () => login(api, email, 'wrong password here'))
    const response = await login(api, email, 'wrong password here')
    expect(response.statusCode).toBe(429)
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('clears the account counter after a success', async () => {
    api = await createTestApi()
    const email = await createVerifiedUser(api)
    await attempts(ACCOUNT_LIMIT - 1, () => login(api, email, 'wrong password here'))
    expect((await login(api, email)).statusCode).toBe(200)
    const codes = await attempts(ACCOUNT_LIMIT - 1, () =>
      login(api, email, 'wrong password here'),
    )
    expect(codes.every((code) => code === 401)).toBe(true)
  })

  it('cannot be escaped by forging X-Forwarded-For when no proxy is trusted', async () => {
    api = await createTestApi()
    const codes = await attempts(IP_LIMIT + 2, (index) =>
      post(
        api,
        '/auth/login',
        { email: uniqueEmail(), password: 'wrong password here' },
        { 'x-forwarded-for': `198.51.100.${index % 250}` },
      ),
    )
    expect(codes.slice(IP_LIMIT)).toEqual([429, 429])
  })

  it('limits signups per address', async () => {
    api = await createTestApi()
    const email = uniqueEmail()
    const codes = await attempts(4, () =>
      post(api, '/auth/signup', { email, password: PASSWORD, displayName: 'x' }),
    )
    expect(codes).toEqual([202, 202, 202, 429])
  })

  it('limits password reset emails per address', async () => {
    api = await createTestApi()
    const email = await createVerifiedUser(api)
    const codes = await attempts(4, () => post(api, '/auth/password/forgot', { email }))
    expect(codes).toEqual([202, 202, 202, 429])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(api.mailer.resets).toHaveLength(3)
  })

  it('refuses login instead of removing the limit when Redis is down', async () => {
    const limiter = new MemoryRateLimiter()
    limiter.hit = async () => {
      throw new Error('redis down')
    }
    api = await createTestApi(undefined, { limiter })
    const response = await login(api, await createVerifiedUser(api))
    expect(response.statusCode).toBe(503)
  })
})
