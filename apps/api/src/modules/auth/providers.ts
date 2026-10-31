import { z } from 'zod'
import type { OAuthCredentials } from '../../config.js'

const REQUEST_TIMEOUT_MS = 10_000

export interface OAuthProfile {
  providerAccountId: string
  email: string | null
  emailVerified: boolean
  displayName: string
  avatarUrl: string | null
}

export interface AuthorizeRequest {
  state: string
  codeChallenge: string
  redirectUri: string
}

export interface CodeExchange {
  code: string
  codeVerifier: string
  redirectUri: string
}

export interface OAuthProvider {
  authorizeUrl(request: AuthorizeRequest): string
  fetchProfile(exchange: CodeExchange): Promise<OAuthProfile>
}

export type OAuthProviders = Partial<Record<'github' | 'google', OAuthProvider>>

export type Fetch = typeof fetch

const tokenResponse = z.object({ access_token: z.string().min(1) })

async function getJson(fetcher: Fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`OAuth request failed with status ${response.status}`)
  return response.json()
}

// Provider data ends up in the page, so only https avatars are kept.
const httpsUrl = (value: string | null | undefined): string | null =>
  value?.startsWith('https://') ? value : null

const githubUser = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
})

const githubEmails = z.array(
  z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }),
)

export function createGitHubProvider(
  credentials: OAuthCredentials,
  fetcher: Fetch = fetch,
): OAuthProvider {
  return {
    authorizeUrl: ({ state, codeChallenge, redirectUri }) => {
      const query = new URLSearchParams({
        client_id: credentials.clientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      })
      return `https://github.com/login/oauth/authorize?${query}`
    },
    fetchProfile: async ({ code, codeVerifier, redirectUri }) => {
      const token = tokenResponse.parse(
        await getJson(fetcher, 'https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri,
          }),
        }),
      )
      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token.access_token}`,
        'user-agent': 'CodeSync',
      }
      const user = githubUser.parse(await getJson(fetcher, 'https://api.github.com/user', { headers }))
      const emails = githubEmails.parse(
        await getJson(fetcher, 'https://api.github.com/user/emails', { headers }),
      )
      const primary = emails.find((email) => email.primary)
      return {
        providerAccountId: String(user.id),
        email: primary?.email.toLowerCase() ?? null,
        emailVerified: primary?.verified ?? false,
        displayName: (user.name?.trim() || user.login).slice(0, 80),
        avatarUrl: httpsUrl(user.avatar_url),
      }
    },
  }
}

const googleUser = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
})

export function createGoogleProvider(
  credentials: OAuthCredentials,
  fetcher: Fetch = fetch,
): OAuthProvider {
  return {
    authorizeUrl: ({ state, codeChallenge, redirectUri }) => {
      const query = new URLSearchParams({
        client_id: credentials.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      })
      return `https://accounts.google.com/o/oauth2/v2/auth?${query}`
    },
    fetchProfile: async ({ code, codeVerifier, redirectUri }) => {
      const token = tokenResponse.parse(
        await getJson(fetcher, 'https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            code,
            code_verifier: codeVerifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }),
        }),
      )
      const user = googleUser.parse(
        await getJson(fetcher, 'https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { authorization: `Bearer ${token.access_token}` },
        }),
      )
      return {
        providerAccountId: user.sub,
        email: user.email?.toLowerCase() ?? null,
        emailVerified: user.email_verified ?? false,
        displayName: (user.name?.trim() || user.email?.split('@')[0] || 'CodeSync user').slice(0, 80),
        avatarUrl: httpsUrl(user.picture),
      }
    },
  }
}
