import { COMPACTION } from '@codesync/shared'
import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  COLLAB_TOKEN_SECRET: z.string().min(32),
  ALLOWED_ORIGINS: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
})

export interface ServerConfig {
  tokenSecret: string
  allowedOrigins: ReadonlySet<string>
  compactionIntervalMs: number
  maxPendingUpdates: number
}

export interface AppConfig extends ServerConfig {
  port: number
  databaseUrl: string
  redisUrl: string
  logLevel: string
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.parse(env)
  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    tokenSecret: parsed.COLLAB_TOKEN_SECRET,
    allowedOrigins: new Set(parsed.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim())),
    logLevel: parsed.LOG_LEVEL,
    compactionIntervalMs: COMPACTION.intervalMs,
    maxPendingUpdates: COMPACTION.maxPendingUpdates,
  }
}
