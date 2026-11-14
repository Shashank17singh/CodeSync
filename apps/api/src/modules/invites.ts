import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { ApiError, forbidden, notFound } from '../lib/errors.js'
import { requireRoom } from './access.js'
import { AUTH_LIMITS, HOUR, enforceRateLimits, ipKey } from './auth/rateLimit.js'

const INVITE_AUDIENCE = 'invite'
// Each email goes out from our sender with a room name the user chose, so it is capped like
// the other emails we send on a user's behalf.
export const INVITE_EMAILS_PER_HOUR = 20
const MAX_TOKEN_LENGTH = 2048

const roomParams = z.object({ id: z.uuid() })
const inviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() })
const acceptBody = z.object({ token: z.string().min(1).max(MAX_TOKEN_LENGTH) })
const claimsSchema = z.object({ inviteId: z.uuid() })

const createInviteBody = z.object({
  role: z.enum(['EDITOR', 'VIEWER']),
  email: z.email().toLowerCase().optional(),
  expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
  maxUses: z.number().int().min(1).max(10_000).optional(),
})

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

const inviteUnusable = (): ApiError =>
  new ApiError(410, 'invite_unusable', 'This invite has expired or is no longer valid')

export function registerInviteRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, mailer, config, limiter } = deps

  app.get('/rooms/:id/invites', async (request) => {
    const { id } = roomParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'invite.manage')
    const invites = await prisma.invite.findMany({
      where: { roomId: id, revokedAt: null },
      omit: { tokenHash: true },
      orderBy: { createdAt: 'desc' },
    })
    return { invites }
  })

  app.post('/rooms/:id/invites', async (request, reply) => {
    const { id } = roomParams.parse(request.params)
    const { room } = await requireRoom(prisma, id, request.userId, 'invite.manage')
    const body = createInviteBody.parse(request.body)
    if (body.email) {
      await enforceRateLimits(
        limiter,
        [
          {
            key: `invite-email:user:${request.userId}`,
            limit: INVITE_EMAILS_PER_HOUR,
            windowMs: HOUR,
          },
          { key: ipKey('invite-email', request.ip), ...AUTH_LIMITS.emailPerIp },
        ],
        'Too many invite emails, try again later',
      )
    }
    const expiresAt = body.expiresInHours
      ? new Date(Date.now() + body.expiresInHours * 3_600_000)
      : null
    // An emailed invite is for one person, so it can only be used once.
    const maxUses = body.email ? 1 : (body.maxUses ?? null)

    const invite = await prisma.$transaction(async (tx) => {
      const created = await tx.invite.create({
        data: {
          roomId: id,
          role: body.role,
          email: body.email ?? null,
          expiresAt,
          maxUses,
          createdById: request.userId,
          tokenHash: `pending:${crypto.randomUUID()}`,
        },
      })
      // The signature proves the link came from us. Limits and revocation live in the database,
      // so they can change after the link has been sent.
      const token = jwt.sign({ inviteId: created.id }, config.inviteTokenSecret, {
        algorithm: 'HS256',
        audience: INVITE_AUDIENCE,
        ...(body.expiresInHours ? { expiresIn: body.expiresInHours * 3600 } : {}),
      })
      await tx.invite.update({
        where: { id: created.id },
        data: { tokenHash: hashToken(token) },
      })
      return { id: created.id, token }
    })

    // A fragment, so the token never reaches a server or its access logs.
    const inviteUrl = `${config.publicWebUrl}/invite#token=${invite.token}`
    if (body.email) await mailer.sendInvite({ to: body.email, roomName: room.name, inviteUrl })
    return reply.status(201).send({ inviteId: invite.id, inviteUrl, expiresAt, maxUses })
  })

  app.delete('/rooms/:id/invites/:inviteId', async (request, reply) => {
    const { id, inviteId } = inviteParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'invite.manage')
    const revoked = await prisma.invite.updateMany({
      where: { id: inviteId, roomId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    if (revoked.count !== 1) throw notFound('Invite')
    return reply.status(204).send()
  })

  // The token travels in the body so that it stays out of proxy access logs.
  app.post('/invites/accept', async (request) => {
    const { token } = acceptBody.parse(request.body)
    let inviteId: string
    try {
      const payload = jwt.verify(token, config.inviteTokenSecret, {
        algorithms: ['HS256'],
        audience: INVITE_AUDIENCE,
      })
      ;({ inviteId } = claimsSchema.parse(payload))
    } catch {
      throw inviteUnusable()
    }

    return prisma.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({ where: { id: inviteId } })
      if (!invite || invite.tokenHash !== hashToken(token) || invite.revokedAt) {
        throw inviteUnusable()
      }
      if (invite.expiresAt && invite.expiresAt <= new Date()) throw inviteUnusable()

      const user = await tx.user.findUniqueOrThrow({
        where: { id: request.userId },
        select: { email: true },
      })
      if (invite.email && invite.email !== user.email.toLowerCase()) {
        throw forbidden('This invite was sent to a different email address')
      }

      // Existing members keep their role, and accepting again does not use up the invite.
      const existing = await tx.roomMember.findUnique({
        where: { roomId_userId: { roomId: invite.roomId, userId: request.userId } },
      })
      if (existing) return { roomId: invite.roomId, joined: false }

      // Conditional, so the last use cannot be claimed twice by concurrent requests.
      const claimed = await tx.invite.updateMany({
        where: {
          id: invite.id,
          ...(invite.maxUses === null ? {} : { uses: { lt: invite.maxUses } }),
        },
        data: { uses: { increment: 1 } },
      })
      if (claimed.count !== 1) throw inviteUnusable()

      await tx.roomMember.create({
        data: { roomId: invite.roomId, userId: request.userId, role: invite.role },
      })
      return { roomId: invite.roomId, joined: true }
    })
  })
}
