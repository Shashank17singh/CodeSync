import type { PrismaClient } from '@codesync/db'
import { maskProfanity } from '@codesync/shared'
import type {
  Catalog,
  CatalogFile,
  ChatPost,
  ChatStore,
  DocStore,
  RoomAccess,
  StoredChatMessage,
  StoredDoc,
} from './types.js'

export class PrismaDocStore implements DocStore {
  constructor(private readonly prisma: PrismaClient) {}

  async load(projectId: string): Promise<StoredDoc> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { ydocState: true, ydocVersion: true },
    })
    return { state: project.ydocState, version: project.ydocVersion }
  }

  async save(projectId: string, state: Uint8Array, expectedVersion: number): Promise<boolean> {
    const result = await this.prisma.project.updateMany({
      where: { id: projectId, ydocVersion: expectedVersion },
      data: {
        ydocState: Buffer.from(state),
        ydocVersion: { increment: 1 },
        compactedAt: new Date(),
      },
    })
    return result.count === 1
  }
}

export class PrismaChat implements ChatStore {
  constructor(private readonly prisma: PrismaClient) {}

  async post({ roomId, authorId, body, mentions }: ChatPost): Promise<StoredChatMessage> {
    return this.prisma.$transaction(async (tx) => {
      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        select: { profanityFilter: true },
      })
      const members = await tx.roomMember.findMany({
        where: { roomId, userId: { in: mentions, not: authorId } },
        select: { userId: true },
      })
      const mentionedUserIds = members.map((member) => member.userId)
      const message = await tx.chatMessage.create({
        data: {
          roomId,
          authorId,
          body: room.profanityFilter ? maskProfanity(body) : body,
          mentionedUserIds,
        },
        select: { id: true, body: true, createdAt: true },
      })
      const notifications = await Promise.all(
        mentionedUserIds.map((userId) =>
          tx.notification.create({
            data: { userId, kind: 'MENTION', messageId: message.id, payload: { roomId } },
            select: { id: true, userId: true },
          }),
        ),
      )
      return { ...message, mentionedUserIds, notifications }
    })
  }
}

export class PrismaCatalog implements Catalog {
  constructor(private readonly prisma: PrismaClient) {}

  async resolveAccess(
    roomId: string,
    projectId: string,
    userId: string,
  ): Promise<RoomAccess | null> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, roomId },
      select: {
        room: {
          select: {
            ownerId: true,
            lockedAt: true,
            members: { where: { userId }, select: { role: true } },
          },
        },
      },
    })
    if (!project) return null
    const { room } = project
    const locked = room.lockedAt !== null
    if (room.ownerId === userId) return { role: 'owner', locked }
    const member = room.members[0]
    if (!member) return null
    return { role: member.role === 'EDITOR' ? 'editor' : 'viewer', locked }
  }

  async listFiles(projectId: string): Promise<CatalogFile[]> {
    return this.prisma.file.findMany({
      where: { projectId },
      select: { id: true, path: true, kind: true },
    })
  }

  async recordClients(projectId: string, userId: string, clientIds: number[]): Promise<void> {
    await this.prisma.yjsClient.createMany({
      data: clientIds.map((clientId) => ({ projectId, userId, clientId: BigInt(clientId) })),
      skipDuplicates: true,
    })
  }
}
