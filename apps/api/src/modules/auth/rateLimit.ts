import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { ApiError } from '../../lib/errors.js'

export interface RateLimitResult {
  allowed: boolean
  retryAfterMs: number
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>
  reset(key: string): Promise<void>
}

export interface RateRule {
  key: string
  limit: number
  windowMs: number
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

// Per-IP limits are generous because a whole college lab can share one public address. The
// per-account limits are what actually stop password guessing, so those stay strict.
export const AUTH_LIMITS = {
  loginPerIp: { limit: 100, windowMs: 15 * MINUTE },
  loginPerAccount: { limit: 10, windowMs: 15 * MINUTE },
  signupPerIp: { limit: 60, windowMs: HOUR },
  emailPerIp: { limit: 60, windowMs: HOUR },
  emailPerAccount: { limit: 3, windowMs: HOUR },
  linkPerIp: { limit: 60, windowMs: 15 * MINUTE },
} as const

// Email addresses are hashed so that Redis holds no list of who is trying to log in.
export const accountKey = (scope: string, email: string): string =>
  `rate:${scope}:account:${createHash('sha256').update(email).digest('hex')}`

export const ipKey = (scope: string, ip: string): string => `rate:${scope}:ip:${ip}`

export async function enforceRateLimits(limiter: RateLimiter, rules: RateRule[]): Promise<void> {
  let results: RateLimitResult[]
  try {
    // Every rule counts the attempt, including those after the first one to refuse.
    results = await Promise.all(
      rules.map((rule) => limiter.hit(rule.key, rule.limit, rule.windowMs)),
    )
  } catch {
    // Refuses rather than allows: losing Redis must not remove the limit on password guessing.
    throw new ApiError(503, 'temporarily_unavailable', 'Try again in a moment')
  }
  const refused = results.filter((result) => !result.allowed)
  if (refused.length === 0) return
  const retryAfterMs = Math.max(...refused.map((result) => result.retryAfterMs))
  throw new ApiError(429, 'rate_limited', 'Too many attempts, try again later', {
    'retry-after': String(Math.ceil(retryAfterMs / 1000)),
  })
}

const HIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { count, redis.call('PTTL', KEYS[1]) }
`

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const [count, ttl] = (await this.redis.eval(HIT, 1, key, windowMs)) as [number, number]
    return { allowed: count <= limit, retryAfterMs: Math.max(ttl, 0) }
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key)
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, { count: number; resetAt: number }>()

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now()
    const current = this.counters.get(key)
    const counter =
      current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs }
    counter.count += 1
    this.counters.set(key, counter)
    return { allowed: counter.count <= limit, retryAfterMs: counter.resetAt - now }
  }

  async reset(key: string): Promise<void> {
    this.counters.delete(key)
  }
}
