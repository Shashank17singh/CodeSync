import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  COLLAB_TOKEN_SECRET: z.string().min(32),
  INVITE_TOKEN_SECRET: z.string().min(32),
  PUBLIC_WEB_URL: z.url(),
  LOG_LEVEL: z.string().default('info'),
})

export interface ApiConfig {
  accessTokenSecret: string
  collabTokenSecret: string
  inviteTokenSecret: string
  publicWebUrl: string
}

export interface ProcessConfig extends ApiConfig {
  port: number
  databaseUrl: string
  redisUrl: string
  logLevel: string
}

export function loadConfig(env: NodeJS.ProcessEnv): ProcessConfig {
  const parsed = envSchema.parse(env)
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    accessTokenSecret: parsed.ACCESS_TOKEN_SECRET,
    collabTokenSecret: parsed.COLLAB_TOKEN_SECRET,
    inviteTokenSecret: parsed.INVITE_TOKEN_SECRET,
    publicWebUrl: parsed.PUBLIC_WEB_URL,
    logLevel: parsed.LOG_LEVEL,
  }
}
