import type { AuthTokenPurpose } from '@codesync/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../../app.js'
import { ApiError } from '../../lib/errors.js'
import {
  REFRESH_COOKIE,
  assertCsrf,
  clearSessionCookies,
  rejectForeignOrigin,
  setSessionCookies,
} from './cookies.js'
import { burnPasswordCheck, hashPassword, verifyPassword } from './passwords.js'
import { AUTH_LIMITS, HOUR, accountKey, enforceRateLimits, ipKey } from './rateLimit.js'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  hashToken,
  randomToken,
  type IssuedSession,
} from './sessions.js'

const VERIFY_TOKEN_TTL_MS = 24 * HOUR
const RESET_TOKEN_TTL_MS = HOUR
const PRISMA_UNIQUE_VIOLATION = 'P2002'

const email = z.email().max(254).toLowerCase()
// The upper bound stops a huge password being used to tie up Argon2.
const password = z.string().min(10).max(128)

const signupBody = z.object({
  email,
  password,
  displayName: z.string().trim().min(1).max(80),
})
const loginBody = z.object({ email, password: z.string().min(1).max(128) })
const emailBody = z.object({ email })
const verifyBody = z.object({ token: z.string().min(1).max(128), password: z.string().min(1).max(128) })
const resetBody = z.object({ token: z.string().min(1).max(128), password })

const invalidLogin = (): ApiError =>
  new ApiError(401, 'invalid_credentials', 'Incorrect email or password')

const invalidLink = (): ApiError =>
  new ApiError(400, 'invalid_link', 'This link has expired or is not valid')

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, mailer, sessions, limiter, config, logger } = deps
  const open = { config: { public: true } }

  const issueLinkToken = async (userId: string, purpose: AuthTokenPurpose, ttlMs: number) => {
    const token = randomToken()
    // A new link replaces any earlier one, so an old email cannot be used later.
    await prisma.authToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    })
    await prisma.authToken.create({
      data: {
        userId,
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    })
    return token
  }

  // Not awaited: response time must not reveal whether an email went out for this address.
  const sendInBackground = (send: () => Promise<void>): void => {
    send().catch((error: unknown) => logger.error({ err: error }, 'failed to send email'))
  }

  // Fragments are never sent to a server, so these links stay out of access logs.
  const webLink = (page: string, token: string): string =>
    `${config.publicWebUrl}/${page}#token=${token}`

  const sendVerification = async (user: { id: string; email: string }): Promise<void> => {
    const token = await issueLinkToken(user.id, 'EMAIL_VERIFY', VERIFY_TOKEN_TTL_MS)
    await mailer.sendVerification({ to: user.email, url: webLink('verify-email', token) })
  }

  const sessionResponse = (session: IssuedSession) => ({
    accessToken: session.accessToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  })

  const userAgent = (request: FastifyRequest): string | undefined =>
    request.headers['user-agent']

  app.post('/auth/signup', open, async (request, reply) => {
    rejectForeignOrigin(request, config)
    const body = signupBody.parse(request.body)
    await enforceRateLimits(limiter, [
      { key: ipKey('signup', request.ip), ...AUTH_LIMITS.signupPerIp },
      { key: accountKey('signup', body.email), ...AUTH_LIMITS.emailPerAccount },
    ])
    // Hashed before the lookup, so a taken address costs the same time as a free one.
    const passwordHash = await hashPassword(body.password)
    try {
      const user = await prisma.user.create({
        data: { email: body.email, displayName: body.displayName, passwordHash },
        select: { id: true, email: true },
      })
      sendInBackground(() => sendVerification(user))
    } catch (error) {
      if ((error as { code?: string }).code !== PRISMA_UNIQUE_VIOLATION) throw error
    }
    // Identical for a taken address, so signup cannot be used to discover accounts.
    return reply.status(202).send({ status: 'check_your_email' })
  })

  app.post('/auth/verify-email/resend', open, async (request, reply) => {
    rejectForeignOrigin(request, config)
    const body = emailBody.parse(request.body)
    await enforceRateLimits(limiter, [
      { key: ipKey('resend', request.ip), ...AUTH_LIMITS.emailPerIp },
      { key: accountKey('resend', body.email), ...AUTH_LIMITS.emailPerAccount },
    ])
    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true, email: true, emailVerifiedAt: true },
    })
    if (user && !user.emailVerifiedAt) sendInBackground(() => sendVerification(user))
    return reply.status(202).send({ status: 'check_your_email' })
  })

  // Asks for the password as well as the emailed link. Without that, an attacker could sign up
  // with a victim's address, wait for the victim to click, and own a verified account whose
  // password the attacker chose. A victim who does not know it uses password reset instead.
  app.post('/auth/verify-email', open, async (request) => {
    rejectForeignOrigin(request, config)
    const body = verifyBody.parse(request.body)
    await enforceRateLimits(limiter, [
      { key: ipKey('verify', request.ip), ...AUTH_LIMITS.linkPerIp },
    ])
    const record = await prisma.authToken.findUnique({
      where: { tokenHash: hashToken(body.token) },
      include: { user: { select: { passwordHash: true } } },
    })
    if (
      !record ||
      record.purpose !== 'EMAIL_VERIFY' ||
      record.usedAt ||
      record.expiresAt <= new Date() ||
      !record.user.passwordHash
    ) {
      throw invalidLink()
    }
    if (!(await verifyPassword(record.user.passwordHash, body.password))) throw invalidLogin()

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.authToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      })
      if (claimed.count !== 1) throw invalidLink()
      await tx.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      })
    })
    return { status: 'verified' }
  })

  app.post('/auth/login', open, async (request, reply) => {
    rejectForeignOrigin(request, config)
    const body = loginBody.parse(request.body)
    const accountLimit = accountKey('login', body.email)
    await enforceRateLimits(limiter, [
      { key: ipKey('login', request.ip), ...AUTH_LIMITS.loginPerIp },
      { key: accountLimit, ...AUTH_LIMITS.loginPerAccount },
    ])

    const user = await prisma.user.findUnique({ where: { email: body.email } })
    if (!user?.passwordHash) {
      await burnPasswordCheck(body.password)
      throw invalidLogin()
    }
    if (!(await verifyPassword(user.passwordHash, body.password))) throw invalidLogin()
    // Only reachable with the right password, so this reveals nothing to a stranger.
    if (!user.emailVerifiedAt) {
      throw new ApiError(403, 'email_not_verified', 'Verify your email before signing in')
    }

    await limiter.reset(accountLimit)
    const session = await sessions.start(user.id, userAgent(request))
    setSessionCookies(reply, config, session.refreshToken)
    return sessionResponse(session)
  })

  app.post('/auth/refresh', open, async (request, reply) => {
    assertCsrf(request, config)
    const token = request.cookies[REFRESH_COOKIE]
    const session = token ? await sessions.rotate(token, userAgent(request)) : null
    if (!session) {
      clearSessionCookies(reply, config)
      throw new ApiError(401, 'session_expired', 'Sign in to continue')
    }
    setSessionCookies(reply, config, session.refreshToken)
    return sessionResponse(session)
  })

  app.post('/auth/logout', open, async (request, reply) => {
    assertCsrf(request, config)
    const token = request.cookies[REFRESH_COOKIE]
    if (token) await sessions.revokeByToken(token)
    clearSessionCookies(reply, config)
    return reply.status(204).send()
  })

  app.post('/auth/password/forgot', open, async (request, reply) => {
    rejectForeignOrigin(request, config)
    const body = emailBody.parse(request.body)
    await enforceRateLimits(limiter, [
      { key: ipKey('forgot', request.ip), ...AUTH_LIMITS.emailPerIp },
      { key: accountKey('forgot', body.email), ...AUTH_LIMITS.emailPerAccount },
    ])
    const user = await prisma.user.findUnique({
      where: { email: body.email },
      select: { id: true, email: true },
    })
    if (user) {
      sendInBackground(async () => {
        const token = await issueLinkToken(user.id, 'PASSWORD_RESET', RESET_TOKEN_TTL_MS)
        await mailer.sendPasswordReset({ to: user.email, url: webLink('reset-password', token) })
      })
    }
    return reply.status(202).send({ status: 'check_your_email' })
  })

  app.post('/auth/password/reset', open, async (request) => {
    rejectForeignOrigin(request, config)
    const body = resetBody.parse(request.body)
    await enforceRateLimits(limiter, [
      { key: ipKey('reset', request.ip), ...AUTH_LIMITS.linkPerIp },
    ])
    const record = await prisma.authToken.findUnique({
      where: { tokenHash: hashToken(body.token) },
    })
    if (
      !record ||
      record.purpose !== 'PASSWORD_RESET' ||
      record.usedAt ||
      record.expiresAt <= new Date()
    ) {
      throw invalidLink()
    }
    const passwordHash = await hashPassword(body.password)

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.authToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      })
      if (claimed.count !== 1) throw invalidLink()
      // The link proves control of the inbox, which also settles an unverified account and
      // replaces any password someone else set on it.
      const user = await tx.user.findUniqueOrThrow({ where: { id: record.userId } })
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
      })
    })
    // A password reset often follows a compromise, so every session ends.
    await sessions.revokeAll(record.userId)
    return { status: 'password_changed' }
  })
}
