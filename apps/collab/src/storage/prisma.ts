import type { PrismaClient } from '@codesync/db'
import type { Catalog, CatalogFile, DocStore, RoomAccess, StoredDoc } from './types.js'

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
