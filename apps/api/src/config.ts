import { z } from 'zod'

const optional = z
  .string()
  .optional()
  .transform((value) => (value ? value : undefined))

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  COLLAB_TOKEN_SECRET: z.string().min(32),
  INVITE_TOKEN_SECRET: z.string().min(32),
  OAUTH_STATE_SECRET: z.string().min(32),
  INTERNAL_SERVICE_TOKEN: z.string().min(32),
  PUBLIC_WEB_URL: z.url(),
  PUBLIC_API_URL: z.url(),
  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().min(1),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  LOG_LEVEL: z.string().default('info'),
})

export interface ApiConfig {
  accessTokenSecret: string
  collabTokenSecret: string
  inviteTokenSecret: string
  oauthStateSecret: string
  internalServiceToken: string
  publicWebUrl: string
  publicApiUrl: string
  secureCookies: boolean
  trustProxyHops: number
}

export interface OAuthCredentials {
  clientId: string
  clientSecret: string
}

export interface ProcessConfig extends ApiConfig {
  port: number
  databaseUrl: string
  redisUrl: string
  smtpUrl: string
  mailFrom: string
  logLevel: string
  github: OAuthCredentials | null
  google: OAuthCredentials | null
}

const credentials = (clientId?: string, clientSecret?: string): OAuthCredentials | null =>
  clientId && clientSecret ? { clientId, clientSecret } : null

export function loadConfig(env: NodeJS.ProcessEnv): ProcessConfig {
  const parsed = envSchema.parse(env)
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    accessTokenSecret: parsed.ACCESS_TOKEN_SECRET,
    collabTokenSecret: parsed.COLLAB_TOKEN_SECRET,
    inviteTokenSecret: parsed.INVITE_TOKEN_SECRET,
    oauthStateSecret: parsed.OAUTH_STATE_SECRET,
    internalServiceToken: parsed.INTERNAL_SERVICE_TOKEN,
    publicWebUrl: parsed.PUBLIC_WEB_URL,
    publicApiUrl: parsed.PUBLIC_API_URL,
    smtpUrl: parsed.SMTP_URL,
    mailFrom: parsed.MAIL_FROM,
    secureCookies: parsed.COOKIE_SECURE === 'true',
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    logLevel: parsed.LOG_LEVEL,
    github: credentials(parsed.GITHUB_CLIENT_ID, parsed.GITHUB_CLIENT_SECRET),
    google: credentials(parsed.GOOGLE_CLIENT_ID, parsed.GOOGLE_CLIENT_SECRET),
  }
}
