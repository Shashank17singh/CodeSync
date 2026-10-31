import { randomUUID } from 'node:crypto'
import { Prisma } from '@codesync/db'
import { COLLAB_TOKEN_AUDIENCE, COLLAB_TOKEN_TTL_SECONDS, type CollabRole } from '@codesync/shared'
import type { FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { conflict, invalid, notFound } from '../lib/errors.js'
import { templateFiles } from '../lib/templates.js'
import { requireProject, requireRoom } from './access.js'

const DEFAULT_PROJECT_NAME = 'main'

const roomParams = z.object({ id: z.uuid() })
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() })

const createRoomBody = z.object({
  name: z.string().trim().min(1).max(120),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).default('PRIVATE'),
  template: z.enum(['PYTHON', 'CPP', 'JAVA', 'JAVASCRIPT', 'BLANK']).default('BLANK'),
})

const updateRoomBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    visibility: z.enum(['PUBLIC', 'PRIVATE']),
    profanityFilter: z.boolean(),
  })
  .partial()

const changeRoleBody = z.object({ role: z.enum(['EDITOR', 'VIEWER']) })
const transferBody = z.object({ userId: z.uuid() })
const collabTokenBody = z.object({ projectId: z.uuid() })

const toCollabRole = (role: 'EDITOR' | 'VIEWER'): CollabRole =>
  role === 'EDITOR' ? 'editor' : 'viewer'

export function registerRoomRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, bridge, config } = deps

  app.get('/rooms', async (request) => {
    const memberships = await prisma.roomMember.findMany({
      where: { userId: request.userId },
      include: { room: true },
      orderBy: { joinedAt: 'desc' },
    })
    return {
      rooms: memberships.map(({ room, role }) => ({
        ...room,
        role: room.ownerId === request.userId ? 'owner' : toCollabRole(role),
      })),
    }
  })

  app.post('/rooms', async (request, reply) => {
    const body = createRoomBody.parse(request.body)
    const roomId = randomUUID()
    const projectId = randomUUID()
    const files = templateFiles(body.template).map((file) => ({ ...file, id: randomUUID() }))

    // The content goes in first so that collab never sees a file row without its text.
    await bridge.withTreeLock(projectId, async () => {
      await bridge.seedFiles(projectId, files)
      await prisma.room.create({
        data: {
          id: roomId,
          ...body,
          ownerId: request.userId,
          members: { create: { userId: request.userId, role: 'EDITOR' } },
          projects: {
            create: {
              id: projectId,
              name: DEFAULT_PROJECT_NAME,
              files: { create: files.map(({ id, path }) => ({ id, path })) },
            },
          },
        },
      })
    })
    return reply.status(201).send({ room: { id: roomId, ...body, projectId } })
  })

  app.get('/rooms/:id', async (request) => {
    const { id } = roomParams.parse(request.params)
    const { room, role } = await requireRoom(prisma, id, request.userId, 'room.view')
    const projects = await prisma.project.findMany({
      where: { roomId: id },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    })
    return { room: { ...room, role, projects } }
  })

  app.post('/rooms/:id/join', async (request, reply) => {
    const { id } = roomParams.parse(request.params)
    const { role } = await requireRoom(prisma, id, request.userId, 'room.view')
    // Existing members keep their role: joining must never downgrade anyone.
    if (role !== null) return reply.status(200).send({ role })
    await requireRoom(prisma, id, request.userId, 'room.join')
    await prisma.roomMember.create({ data: { roomId: id, userId: request.userId, role: 'VIEWER' } })
    return reply.status(201).send({ role: 'viewer' })
  })

  app.patch('/rooms/:id', async (request) => {
    const { id } = roomParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'room.update')
    const body = updateRoomBody.parse(request.body)
    const data: Prisma.RoomUpdateInput = {}
    if (body.name !== undefined) data.name = body.name
    if (body.visibility !== undefined) data.visibility = body.visibility
    if (body.profanityFilter !== undefined) data.profanityFilter = body.profanityFilter
    return { room: await prisma.room.update({ where: { id }, data }) }
  })

  app.delete('/rooms/:id', async (request, reply) => {
    const { id } = roomParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'room.delete')
    const projects = await prisma.project.findMany({ where: { roomId: id }, select: { id: true } })
    await prisma.room.delete({ where: { id } })
    await bridge.notify(id, { type: 'room.deleted' })
    await Promise.all(projects.map((project) => bridge.forgetProject(project.id)))
    return reply.status(204).send()
  })

  const setLock = (locked: boolean) =>
    async (request: { params: unknown; userId: string }) => {
      const { id } = roomParams.parse(request.params)
      await requireRoom(prisma, id, request.userId, 'room.lock')
      await prisma.room.update({ where: { id }, data: { lockedAt: locked ? new Date() : null } })
      await bridge.notify(id, { type: 'room.locked', locked })
      return { locked }
    }

  app.post('/rooms/:id/lock', setLock(true))
  app.post('/rooms/:id/unlock', setLock(false))

  app.post('/rooms/:id/transfer', async (request) => {
    const { id } = roomParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'room.transfer')
    const { userId } = transferBody.parse(request.body)
    if (userId === request.userId) throw invalid('already_owner', 'You already own this room')

    await prisma.$transaction(async (tx) => {
      // Conditional on the current owner, so two concurrent transfers cannot both succeed.
      const updated = await tx.room.updateMany({
        where: { id, ownerId: request.userId },
        data: { ownerId: userId },
      })
      if (updated.count !== 1) throw conflict('owner_changed', 'The room owner has changed')
      const member = await tx.roomMember.updateMany({
        where: { roomId: id, userId },
        data: { role: 'EDITOR' },
      })
      if (member.count !== 1) throw invalid('not_a_member', 'The new owner must be a room member')
      await tx.roomMember.update({
        where: { roomId_userId: { roomId: id, userId: request.userId } },
        data: { role: 'EDITOR' },
      })
    })
    await bridge.notify(id, { type: 'role.changed', userId, role: 'owner' })
    await bridge.notify(id, { type: 'role.changed', userId: request.userId, role: 'editor' })
    return { ownerId: userId }
  })

  app.get('/rooms/:id/members', async (request) => {
    const { id } = roomParams.parse(request.params)
    const { room } = await requireRoom(prisma, id, request.userId, 'member.list')
    const members = await prisma.roomMember.findMany({
      where: { roomId: id },
      select: {
        role: true,
        joinedAt: true,
        user: { select: { id: true, displayName: true, avatarUrl: true } },
      },
      orderBy: { joinedAt: 'asc' },
    })
    return {
      members: members.map(({ role, joinedAt, user }) => ({
        ...user,
        joinedAt,
        role: user.id === room.ownerId ? 'owner' : toCollabRole(role),
      })),
    }
  })

  app.patch('/rooms/:id/members/:userId', async (request) => {
    const { id, userId } = memberParams.parse(request.params)
    const { room } = await requireRoom(prisma, id, request.userId, 'member.role')
    const { role } = changeRoleBody.parse(request.body)
    if (userId === room.ownerId) {
      throw invalid('owner_role', 'Transfer ownership to change the owner role')
    }
    const updated = await prisma.roomMember.updateMany({
      where: { roomId: id, userId },
      data: { role },
    })
    if (updated.count !== 1) throw notFound('Member')
    await bridge.notify(id, { type: 'role.changed', userId, role: toCollabRole(role) })
    return { role: toCollabRole(role) }
  })

  app.delete('/rooms/:id/members/:userId', async (request, reply) => {
    const { id, userId } = memberParams.parse(request.params)
    const isSelf = userId === request.userId
    const { room } = await requireRoom(
      prisma,
      id,
      request.userId,
      isSelf ? 'room.view' : 'member.remove',
    )
    if (userId === room.ownerId) {
      throw conflict('owner_cannot_leave', 'Transfer ownership before leaving the room')
    }
    const removed = await prisma.roomMember.deleteMany({ where: { roomId: id, userId } })
    if (removed.count !== 1) throw notFound('Member')
    await bridge.notify(id, { type: 'member.removed', userId })
    return reply.status(204).send()
  })

  app.post('/rooms/:id/collab-token', async (request) => {
    const { id } = roomParams.parse(request.params)
    const { role } = await requireRoom(prisma, id, request.userId, 'collab.token')
    const { projectId } = collabTokenBody.parse(request.body)
    const project = await requireProject(prisma, projectId, request.userId, 'project.view')
    if (project.room.id !== id) throw notFound('Project')
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.userId },
      select: { displayName: true },
    })
    const token = jwt.sign(
      { name: user.displayName, roomId: id, projectId, role },
      config.collabTokenSecret,
      {
        algorithm: 'HS256',
        subject: request.userId,
        audience: COLLAB_TOKEN_AUDIENCE,
        expiresIn: COLLAB_TOKEN_TTL_SECONDS,
      },
    )
    return { token, expiresIn: COLLAB_TOKEN_TTL_SECONDS }
  })
}
