import type { LightMyRequestResponse } from 'fastify'
import { config, type TestApi } from './helpers.js'
import { CSRF_COOKIE, REFRESH_COOKIE } from '../src/modules/auth/cookies.js'
import { hashPassword } from '../src/modules/auth/passwords.js'

export const PASSWORD = 'correct horse battery'
export const WEB_ORIGIN = new URL(config.publicWebUrl).origin

export const uniqueEmail = (): string => `user-${crypto.randomUUID()}@test.local`

export const post = (api: TestApi, url: string, payload?: object, headers = {}) =>
  api.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers,
    ...(payload ? { payload } : {}),
  })

export async function createVerifiedUser(api: TestApi, email = uniqueEmail()): Promise<string> {
  await api.prisma.user.create({
    data: {
      email,
      displayName: 'Verified',
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
    },
  })
  return email
}

export interface BrowserSession {
  refresh: string
  csrf: string
}

export function sessionFrom(response: LightMyRequestResponse): BrowserSession {
  const value = (name: string): string => {
    const cookie = response.cookies.find((item) => item.name === name)
    if (!cookie) throw new Error(`missing cookie ${name}`)
    return cookie.value
  }
  return { refresh: value(REFRESH_COOKIE), csrf: value(CSRF_COOKIE) }
}

export const login = async (api: TestApi, email: string, password = PASSWORD) =>
  post(api, '/auth/login', { email, password })

export const signedIn = async (api: TestApi): Promise<BrowserSession> =>
  sessionFrom(await login(api, await createVerifiedUser(api)))

export const refresh = (api: TestApi, session: BrowserSession, headers = {}) =>
  api.app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    cookies: { [REFRESH_COOKIE]: session.refresh, [CSRF_COOKIE]: session.csrf },
    headers: { origin: WEB_ORIGIN, 'x-csrf-token': session.csrf, ...headers },
  })

export const tokenFromLink = (url: string): string => url.split('#token=')[1] as string

export const waitForEmail = async <T>(list: T[], count = 1): Promise<T> => {
  const deadline = Date.now() + 3_000
  while (list.length < count) {
    if (Date.now() > deadline) throw new Error('email never arrived')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return list[count - 1] as T
}
