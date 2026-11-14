import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@codesync/db'
import type { FastifyBaseLogger } from 'fastify'
import jwt from 'jsonwebtoken'

export const ACCESS_TOKEN_AUDIENCE = 'api'
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

const LOST_ROTATION = Symbol('lost rotation')

export const randomToken = (): string => randomBytes(32).toString('base64url')

// The database holds only hashes, so a leaked backup contains no usable session or link.
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export interface IssuedSession {
  accessToken: string
  refreshToken: string
  userId: string
}

export class SessionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly accessTokenSecret: string,
    private readonly logger: FastifyBaseLogger,
  ) {}

  private signAccess(userId: string): string {
    return jwt.sign({}, this.accessTokenSecret, {
      algorithm: 'HS256',
      subject: userId,
      audience: ACCESS_TOKEN_AUDIENCE,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    })
  }

  private refreshRow(
    userId: string,
    familyId: string,
    refreshToken: string,
    userAgent: string | undefined,
  ) {
    return {
      id: randomUUID(),
      userId,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      userAgent: userAgent?.slice(0, 256) ?? null,
    }
  }

  async start(userId: string, userAgent?: string): Promise<IssuedSession> {
    const refreshToken = randomToken()
    await this.prisma.refreshToken.create({
      data: this.refreshRow(userId, randomUUID(), refreshToken, userAgent),
    })
    return { accessToken: this.signAccess(userId), refreshToken, userId }
  }

  // Each refresh token works once. Presenting a used one means two parties hold the same token,
  // and the server cannot tell which is the thief, so the whole family ends.
  async rotate(refreshToken: string, userAgent?: string): Promise<IssuedSession | null> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    })
    if (!row || row.revokedAt) return null
    if (row.replacedById) {
      await this.reportReuse(row.familyId, row.userId)
      return null
    }
    if (row.expiresAt <= new Date()) return null
    // A revocation that ran while this token's own refresh was committing could not see this
    // row and revoked only the parent. A revoked parent therefore ends this token too.
    const parent = await this.prisma.refreshToken.findFirst({
      where: { replacedById: row.id },
      select: { revokedAt: true },
    })
    if (parent?.revokedAt) {
      await this.revokeFamily(row.familyId)
      return null
    }

    const nextToken = randomToken()
    const next = this.refreshRow(row.userId, row.familyId, nextToken, userAgent)
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.refreshToken.create({ data: next })
        // Conditional, so that of two concurrent requests with one token only one can win.
        const claimed = await tx.refreshToken.updateMany({
          where: { id: row.id, replacedById: null, revokedAt: null },
          data: { replacedById: next.id },
        })
        if (claimed.count !== 1) throw LOST_ROTATION
      })
    } catch (error) {
      if (error !== LOST_ROTATION) throw error
      await this.reportReuse(row.familyId, row.userId)
      return null
    }
    return { accessToken: this.signAccess(row.userId), refreshToken: nextToken, userId: row.userId }
  }

  private async reportReuse(familyId: string, userId: string): Promise<void> {
    this.logger.warn({ userId, familyId }, 'refresh token reuse detected, revoking session')
    await this.revokeFamily(familyId)
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  async revokeByToken(refreshToken: string): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
      select: { familyId: true },
    })
    if (row) await this.revokeFamily(row.familyId)
  }

  async revokeAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }
}
