import type { PrismaClient, Room } from '@codesync/db'
import type { CollabRole } from '@codesync/shared'
import { forbidden, notFound } from '../lib/errors.js'
import { isAllowed, type Action } from './permissions.js'

export interface RoomAccess {
  room: Room
  role: CollabRole | null
}

export async function loadRoomAccess(
  prisma: PrismaClient,
  roomId: string,
  userId: string,
): Promise<RoomAccess | null> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { members: { where: { userId }, select: { role: true } } },
  })
  if (!room) return null
  const { members, ...rest } = room
  const member = members[0]
  if (room.ownerId === userId) return { room: rest, role: 'owner' }
  if (!member) return { room: rest, role: null }
  return { room: rest, role: member.role === 'EDITOR' ? 'editor' : 'viewer' }
}

function assertAllowed(access: RoomAccess, action: Action): void {
  const allowed = isAllowed(action, {
    role: access.role,
    locked: access.room.lockedAt !== null,
    isPublic: access.room.visibility === 'PUBLIC',
  })
  if (allowed) return
  // Outsiders cannot tell a private room from one that does not exist.
  if (access.role === null && access.room.visibility === 'PRIVATE') throw notFound('Room')
  throw forbidden()
}

export async function requireRoom(
  prisma: PrismaClient,
  roomId: string,
  userId: string,
  action: Action,
): Promise<RoomAccess> {
  const access = await loadRoomAccess(prisma, roomId, userId)
  if (!access) throw notFound('Room')
  assertAllowed(access, action)
  return access
}

export async function requireProject(
  prisma: PrismaClient,
  projectId: string,
  userId: string,
  action: Action,
): Promise<RoomAccess & { projectName: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { roomId: true, name: true },
  })
  if (!project) throw notFound('Project')
  const access = await loadRoomAccess(prisma, project.roomId, userId)
  if (!access) throw notFound('Project')
  try {
    assertAllowed(access, action)
  } catch (error) {
    if (access.role === null) throw notFound('Project')
    throw error
  }
  return { ...access, projectName: project.name }
}
