import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import type { AppDeps } from '../../app.js'
import { notFound } from '../../lib/errors.js'
import { setSessionCookies } from './cookies.js'
import type { OAuthProfile } from './providers.js'
import { MINUTE, enforceRateLimits, ipKey } from './rateLimit.js'

const OAUTH_COOKIE = 'codesync_oauth'
const OAUTH_AUDIENCE = 'oauth'
const OAUTH_TTL_SECONDS = 600
const COOKIE_PATH = '/api/v1/auth/oauth'
const PROVIDER_ENUM = { github: 'GITHUB', google: 'GOOGLE' } as const

const providerParams = z.object({ provider: z.enum(['github', 'google']) })
const callbackQuery = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(256),
})
const stateClaims = z.object({
  state: z.string(),
  verifier: z.string(),
  provider: z.enum(['github', 'google']),
})

class OAuthRefusal extends Error {}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function registerOAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, sessions, limiter, config, oauth, logger } = deps
  const open = { config: { public: true } }

  const redirectUri = (provider: string): string =>
    `${config.publicApiUrl}/api/v1/auth/oauth/${provider}/callback`

  const cookieOptions = {
    httpOnly: true,
    secure: config.secureCookies,
    // Lax, because the callback is a top-level navigation arriving from the provider's site.
    sameSite: 'lax',
    path: COOKIE_PATH,
  } as const

  const resolveUser = async (
    provider: 'GITHUB' | 'GOOGLE',
    profile: OAuthProfile,
  ): Promise<string> => {
    const account = await prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider,
          providerAccountId: profile.providerAccountId,
        },
      },
      select: { userId: true },
    })
    if (account) return account.userId

    // An unverified provider address proves nothing, and linking on it would hand over accounts.
    if (!profile.email || !profile.emailVerified) throw new OAuthRefusal('email not verified')

    const existing = await prisma.user.findUnique({ where: { email: profile.email } })
    if (existing) {
      const unverified = existing.emailVerifiedAt === null
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          oauthAccounts: {
            create: { provider, providerAccountId: profile.providerAccountId },
          },
          // An unverified account's password was set by someone who never proved they own this
          // address, possibly an attacker waiting for the real owner to arrive. It must not
          // survive that owner signing in.
          ...(unverified ? { passwordHash: null, emailVerifiedAt: new Date() } : {}),
        },
      })
      if (unverified) await sessions.revokeAll(existing.id)
      return existing.id
    }

    const created = await prisma.user.create({
      data: {
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        emailVerifiedAt: new Date(),
        oauthAccounts: {
          create: { provider, providerAccountId: profile.providerAccountId },
        },
      },
      select: { id: true },
    })
    return created.id
  }

  app.get('/auth/oauth/:provider', open, async (request, reply) => {
    const { provider } = providerParams.parse(request.params)
    const client = oauth[provider]
    if (!client) throw notFound('Login provider')
    await enforceRateLimits(limiter, [
      { key: ipKey('oauth', request.ip), limit: 30, windowMs: 15 * MINUTE },
    ])

    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url')
    const cookie = jwt.sign({ state, verifier, provider }, config.oauthStateSecret, {
      algorithm: 'HS256',
      audience: OAUTH_AUDIENCE,
      expiresIn: OAUTH_TTL_SECONDS,
    })
    reply.setCookie(OAUTH_COOKIE, cookie, { ...cookieOptions, maxAge: OAUTH_TTL_SECONDS })
    return reply.redirect(
      client.authorizeUrl({ state, codeChallenge, redirectUri: redirectUri(provider) }),
    )
  })

  // Ends in a redirect either way, because a browser is looking at this response. The access
  // token is not in the redirect: the web app gets one by calling /auth/refresh.
  app.get('/auth/oauth/:provider/callback', open, async (request, reply) => {
    const failed = `${config.publicWebUrl}/login?error=oauth_failed`
    const cookie = request.cookies[OAUTH_COOKIE]
    reply.clearCookie(OAUTH_COOKIE, cookieOptions)
    try {
      const { provider } = providerParams.parse(request.params)
      const client = oauth[provider]
      if (!client) throw new OAuthRefusal('provider not configured')
      if (!cookie) throw new OAuthRefusal('missing state cookie')

      const { code, state } = callbackQuery.parse(request.query)
      const claims = stateClaims.parse(
        jwt.verify(cookie, config.oauthStateSecret, {
          algorithms: ['HS256'],
          audience: OAUTH_AUDIENCE,
        }),
      )
      // Ties this callback to the browser that started the login, which stops an attacker
      // feeding a victim a callback URL holding the attacker's own code.
      if (claims.provider !== provider || !sameText(claims.state, state)) {
        throw new OAuthRefusal('state mismatch')
      }

      const profile = await client.fetchProfile({
        code,
        codeVerifier: claims.verifier,
        redirectUri: redirectUri(provider),
      })
      const userId = await resolveUser(PROVIDER_ENUM[provider], profile)
      const session = await sessions.start(userId, request.headers['user-agent'])
      setSessionCookies(reply, config, session.refreshToken)
      return reply.redirect(`${config.publicWebUrl}/auth/callback`)
    } catch (error) {
      logger.warn({ err: error }, 'oauth login refused')
      return reply.redirect(failed)
    }
  })
}
