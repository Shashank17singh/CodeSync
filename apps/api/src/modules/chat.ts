import { CHAT_LIMITS } from '@codesync/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { forbidden, invalid, notFound } from '../lib/errors.js'
import { loadRoomAccess, requireRoom } from './access.js'
import { MINUTE, enforceRateLimits } from './auth/rateLimit.js'

const roomParams = z.object({ id: z.uuid() })
const messageParams = z.object({ id: z.uuid(), messageId: z.uuid() })
const historyQuery = z.object({ before: z.coerce.date().optional() })
const fileParams = z.object({ id: z.uuid() })

const MAX_COMMENT_CHARS = 4000
const MAX_ANCHOR_CHARS = 512
const COMMENTS_PER_USER_PER_MINUTE = 30

const anchorBody = z.object({
  body: z.string().trim().min(1).max(MAX_COMMENT_CHARS),
  anchorStart: z.base64().max(MAX_ANCHOR_CHARS),
  anchorEnd: z.base64().max(MAX_ANCHOR_CHARS),
})
const replyBody = z.object({ body: z.string().trim().min(1).max(MAX_COMMENT_CHARS) })
const updateBody = z
  .object({
    body: z.string().trim().min(1).max(MAX_COMMENT_CHARS),
    resolved: z.boolean(),
  })
  .partial()

const COMMENT_FIELDS = {
  id: true,
  fileId: true,
  authorId: true,
  parentId: true,
  anchorStart: true,
  anchorEnd: true,
  body: true,
  resolvedAt: true,
  resolvedById: true,
  createdAt: true,
  updatedAt: true,
} as const

interface StoredComment {
  anchorStart: Uint8Array | null
  anchorEnd: Uint8Array | null
}

const present = <T extends StoredComment>(comment: T) => ({
  ...comment,
  anchorStart: comment.anchorStart && Buffer.from(comment.anchorStart).toString('base64'),
  anchorEnd: comment.anchorEnd && Buffer.from(comment.anchorEnd).toString('base64'),
})

export function registerChatRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, bridge, limiter } = deps

  // Viewers can comment, and each one fans out to the room and may write a notification.
  const limitComments = (userId: string) =>
    enforceRateLimits(limiter, [
      { key: `comment:${userId}`, limit: COMMENTS_PER_USER_PER_MINUTE, windowMs: MINUTE },
    ])

  const fileRoom = async (fileId: string, userId: string): Promise<string> => {
    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: { project: { select: { roomId: true } } },
    })
    if (!file) throw notFound('File')
    const access = await loadRoomAccess(prisma, file.project.roomId, userId)
    if (!access?.role) throw notFound('File')
    return file.project.roomId
  }

  const commentRoom = async (commentId: string, userId: string) => {
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, fileId: true, authorId: true, parentId: true },
    })
    if (!comment) throw notFound('Comment')
    return { comment, roomId: await fileRoom(comment.fileId, userId) }
  }

  const notifyComments = (roomId: string, fileId: string, threadId: string, action: string) =>
    bridge.publishRoomEvent(roomId, { type: 'comment.changed', fileId, threadId, action })

  app.get('/rooms/:id/messages', async (request) => {
    const { id } = roomParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'file.read')
    const { before } = historyQuery.parse(request.query)
    const messages = await prisma.chatMessage.findMany({
      where: { roomId: id, ...(before ? { createdAt: { lt: before } } : {}) },
      select: {
        id: true,
        authorId: true,
        body: true,
        mentionedUserIds: true,
        createdAt: true,
        deletedAt: true,
        author: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: CHAT_LIMITS.historyPageSize,
    })
    return {
      // A moderated message keeps its place, without its text.
      messages: messages.map(({ author, ...message }) => ({
        ...message,
        authorName: author.displayName,
        body: message.deletedAt ? '' : message.body,
      })),
    }
  })

  app.delete('/rooms/:id/messages/:messageId', async (request, reply) => {
    const { id, messageId } = messageParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'room.update')
    const deleted = await prisma.chatMessage.updateMany({
      where: { id: messageId, roomId: id, deletedAt: null },
      data: { deletedAt: new Date(), deletedById: request.userId },
    })
    if (deleted.count !== 1) throw notFound('Message')
    await bridge.publishRoomEvent(id, { type: 'chat.deleted', id: messageId })
    return reply.status(204).send()
  })

  app.post('/rooms/:id/read', async (request, reply) => {
    const { id } = roomParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'file.read')
    await prisma.roomMember.update({
      where: { roomId_userId: { roomId: id, userId: request.userId } },
      data: { lastReadAt: new Date() },
    })
    return reply.status(204).send()
  })

  app.get('/rooms/:id/unread', async (request) => {
    const { id } = roomParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'file.read')
    const member = await prisma.roomMember.findUniqueOrThrow({
      where: { roomId_userId: { roomId: id, userId: request.userId } },
      select: { lastReadAt: true },
    })
    const unread = await prisma.chatMessage.count({
      where: {
        roomId: id,
        createdAt: { gt: member.lastReadAt },
        deletedAt: null,
        authorId: { not: request.userId },
      },
    })
    return { unread }
  })

  app.get('/me/notifications', async (request) => {
    const notifications = await prisma.notification.findMany({
      where: { userId: request.userId },
      orderBy: { createdAt: 'desc' },
      take: CHAT_LIMITS.historyPageSize,
    })
    return { notifications }
  })

  app.post('/me/notifications/:id/read', async (request, reply) => {
    const { id } = roomParams.parse(request.params)
    const updated = await prisma.notification.updateMany({
      where: { id, userId: request.userId, readAt: null },
      data: { readAt: new Date() },
    })
    if (updated.count !== 1) throw notFound('Notification')
    return reply.status(204).send()
  })

  app.get('/files/:id/comments', async (request) => {
    const { id } = fileParams.parse(request.params)
    await fileRoom(id, request.userId)
    const comments = await prisma.comment.findMany({
      where: { fileId: id },
      select: COMMENT_FIELDS,
      orderBy: { createdAt: 'asc' },
    })
    return { comments: comments.map(present) }
  })

  app.post('/files/:id/comments', async (request, reply) => {
    const { id } = fileParams.parse(request.params)
    const roomId = await fileRoom(id, request.userId)
    const body = anchorBody.parse(request.body)
    await limitComments(request.userId)
    const comment = await prisma.comment.create({
      data: {
        fileId: id,
        authorId: request.userId,
        body: body.body,
        anchorStart: Buffer.from(body.anchorStart, 'base64'),
        anchorEnd: Buffer.from(body.anchorEnd, 'base64'),
      },
      select: COMMENT_FIELDS,
    })
    await notifyComments(roomId, id, comment.id, 'created')
    return reply.status(201).send({ comment: present(comment) })
  })

  app.post('/comments/:id/replies', async (request, reply) => {
    const { id } = fileParams.parse(request.params)
    const { comment: parent, roomId } = await commentRoom(id, request.userId)
    if (parent.parentId) throw invalid('nested_reply', 'Reply to the thread, not to a reply')
    const { body } = replyBody.parse(request.body)
    await limitComments(request.userId)
    const created = await prisma.comment.create({
      data: { fileId: parent.fileId, authorId: request.userId, parentId: id, body },
      select: COMMENT_FIELDS,
    })
    if (parent.authorId !== request.userId) {
      const notification = await prisma.notification.create({
        data: {
          userId: parent.authorId,
          kind: 'COMMENT_REPLY',
          commentId: created.id,
          payload: { roomId, fileId: parent.fileId },
        },
      })
      await bridge.publishRoomEvent(roomId, {
        type: 'notify.created',
        userId: parent.authorId,
        id: notification.id,
        kind: 'COMMENT_REPLY',
      })
    }
    await notifyComments(roomId, parent.fileId, id, 'replied')
    return reply.status(201).send({ comment: present(created) })
  })

  const assertMayModerate = async (
    comment: { authorId: string },
    roomId: string,
    userId: string,
  ): Promise<void> => {
    if (comment.authorId === userId) return
    const access = await loadRoomAccess(prisma, roomId, userId)
    if (access?.role !== 'owner') throw forbidden()
  }

  app.patch('/comments/:id', async (request) => {
    const { id } = fileParams.parse(request.params)
    const { comment, roomId } = await commentRoom(id, request.userId)
    const body = updateBody.parse(request.body)
    // Anyone in the room can resolve a thread, as that is how a review gets finished. Only the
    // author may change what a comment says, so words are never put in someone's mouth.
    if (body.body !== undefined && comment.authorId !== request.userId) throw forbidden()
    const updated = await prisma.comment.update({
      where: { id },
      data: {
        ...(body.body === undefined ? {} : { body: body.body }),
        ...(body.resolved === undefined
          ? {}
          : {
              resolvedAt: body.resolved ? new Date() : null,
              resolvedById: body.resolved ? request.userId : null,
            }),
      },
      select: COMMENT_FIELDS,
    })
    const action = body.resolved === undefined ? 'edited' : body.resolved ? 'resolved' : 'reopened'
    await notifyComments(roomId, comment.fileId, comment.parentId ?? id, action)
    return { comment: present(updated) }
  })

  app.delete('/comments/:id', async (request, reply) => {
    const { id } = fileParams.parse(request.params)
    const { comment, roomId } = await commentRoom(id, request.userId)
    await assertMayModerate(comment, roomId, request.userId)
    await prisma.comment.delete({ where: { id } })
    await notifyComments(roomId, comment.fileId, comment.parentId ?? id, 'deleted')
    return reply.status(204).send()
  })
}
