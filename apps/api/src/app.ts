import type { PrismaClient } from '@codesync/db'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { z, ZodError } from 'zod'
import type { CollabBridge } from './collab/bridge.js'
import type { ApiConfig } from './config.js'
import { ApiError } from './lib/errors.js'
import { ZIP_LIMITS } from './lib/zip.js'
import type { Mailer } from './mailer.js'
import { registerFileRoutes } from './modules/files.js'
import { registerInviteRoutes } from './modules/invites.js'
import { registerRoomRoutes } from './modules/rooms.js'

const PRISMA_UNIQUE_VIOLATION = 'P2002'
const ACCESS_TOKEN_AUDIENCE = 'api'

export interface AppDeps {
  prisma: PrismaClient
  bridge: CollabBridge
  mailer: Mailer
  config: ApiConfig
  logger: FastifyBaseLogger
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
  }
}

const accessClaimsSchema = z.object({ sub: z.uuid() })

function verifyAccessToken(header: string | undefined, secret: string): string {
  const unauthorized = new ApiError(401, 'unauthorized', 'Sign in to continue')
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  if (!token) throw unauthorized
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: ACCESS_TOKEN_AUDIENCE,
    })
    return accessClaimsSchema.parse(payload).sub
  } catch {
    throw unauthorized
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    // Tokens must stay out of request logs: invite links carry them in the path.
    disableRequestLogging: true,
    bodyLimit: 1024 * 1024,
  })

  app.decorateRequest('userId', '')

  app.addContentTypeParser(
    'application/zip',
    { parseAs: 'buffer', bodyLimit: ZIP_LIMITS.maxArchiveBytes },
    (_request, body, done) => done(null, body),
  )

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.statusCode)
        .send({ error: { code: error.code, message: error.message } })
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'invalid_request',
          message: 'The request is not valid',
          issues: error.issues.map(({ path, message }) => ({ path, message })),
        },
      })
    }
    const { code, statusCode } = error as { code?: string; statusCode?: number }
    if (code === PRISMA_UNIQUE_VIOLATION) {
      return reply
        .status(409)
        .send({ error: { code: 'already_exists', message: 'That name is already in use' } })
    }
    if (statusCode === 413) {
      return reply
        .status(413)
        .send({ error: { code: 'payload_too_large', message: 'The upload is too large' } })
    }
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send({ error: { code: 'invalid_request', message: 'The request is not valid' } })
    }
    request.log.error({ err: error }, 'unhandled request error')
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Something went wrong' } })
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  void app.register(
    async (api) => {
      api.addHook('onRequest', async (request) => {
        request.userId = verifyAccessToken(
          request.headers.authorization,
          deps.config.accessTokenSecret,
        )
      })
      registerRoomRoutes(api, deps)
      registerInviteRoutes(api, deps)
      registerFileRoutes(api, deps)
    },
    { prefix: '/api/v1' },
  )

  return app
}
