import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ApiConfig } from '../../config.js'
import { forbidden } from '../../lib/errors.js'
import { REFRESH_TOKEN_TTL_MS } from './sessions.js'

export const REFRESH_COOKIE = 'codesync_refresh'
export const CSRF_COOKIE = 'codesync_csrf'
export const CSRF_HEADER = 'x-csrf-token'

const AUTH_PATH = '/api/v1/auth'
const MAX_AGE_SECONDS = REFRESH_TOKEN_TTL_MS / 1000

export function setSessionCookies(
  reply: FastifyReply,
  config: ApiConfig,
  refreshToken: string,
): void {
  const shared = {
    secure: config.secureCookies,
    sameSite: 'lax',
    maxAge: MAX_AGE_SECONDS,
  } as const
  reply.setCookie(REFRESH_COOKIE, refreshToken, { ...shared, httpOnly: true, path: AUTH_PATH })
  // Readable by page scripts on purpose: this is the value the client echoes in a header.
  reply.setCookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
    ...shared,
    httpOnly: false,
    path: '/',
  })
}

export function clearSessionCookies(reply: FastifyReply, config: ApiConfig): void {
  const shared = { secure: config.secureCookies, sameSite: 'lax' } as const
  reply.clearCookie(REFRESH_COOKIE, { ...shared, httpOnly: true, path: AUTH_PATH })
  reply.clearCookie(CSRF_COOKIE, { ...shared, path: '/' })
}

const webOrigin = (config: ApiConfig): string => new URL(config.publicWebUrl).origin

// For credential forms: a browser always sends Origin on a cross-site POST, so a page elsewhere
// cannot log a victim into the attacker's account. Clients without Origin are not browsers.
export function rejectForeignOrigin(request: FastifyRequest, config: ApiConfig): void {
  const { origin } = request.headers
  if (origin !== undefined && origin !== webOrigin(config)) throw forbidden('Request refused')
}

// SameSite=Lax already withholds the cookie on cross-site POSTs. These two checks mean a single
// browser or configuration mistake is not enough to spend someone's session.
export function assertCsrf(request: FastifyRequest, config: ApiConfig): void {
  if (request.headers.origin !== webOrigin(config)) throw forbidden('Request refused')
  const cookie = request.cookies[CSRF_COOKIE]
  const header = request.headers[CSRF_HEADER]
  if (typeof header !== 'string' || !cookie) throw forbidden('Request refused')
  const expected = Buffer.from(cookie)
  const received = Buffer.from(header)
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw forbidden('Request refused')
  }
}
