import { randomUUID } from 'node:crypto'
import { captureSnapshot, type PrismaClient } from '@codesync/db'
import { SNAPSHOTS } from '@codesync/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { conflict, notFound } from '../lib/errors.js'
import {
  blameLines,
  parseTree,
  readContents,
  toRanges,
  withDocFiles,
  type SnapshotEntry,
} from '../lib/history.js'
import { parentPaths } from '../lib/paths.js'
import { writeProjectArchive } from '../lib/zip.js'
import type { Action } from './permissions.js'
import { requireProject } from './access.js'
import { MINUTE, enforceRateLimits } from './auth/rateLimit.js'

const idParams = z.object({ id: z.uuid() })
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() })
const listQuery = z.object({ before: z.coerce.date().optional() })
const checkpointBody = z.object({ label: z.string().trim().min(1).max(120) })
const restoreBody = z.object({ fileId: z.uuid().optional() })

const SNAPSHOT_FIELDS = {
  id: true,
  kind: true,
  label: true,
  authorIds: true,
  createdById: true,
  createdAt: true,
} as const

// The whole tree goes back to its snapshot, including removing files added since. Paths move
// in two steps because a rename chain would otherwise hit the unique path index midway.
async function restoreProjectTree(
  prisma: PrismaClient,
  projectId: string,
  tree: SnapshotEntry[],
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.file.findMany({
      where: { projectId },
      select: { id: true, path: true },
    })
    const target = new Map(tree.map((entry) => [entry.id, entry]))
    await tx.file.deleteMany({
      where: { id: { in: current.filter((file) => !target.has(file.id)).map((file) => file.id) } },
    })
    const known = new Set(current.map((file) => file.id))
    const moved = current.filter(
      (file) => target.has(file.id) && target.get(file.id)?.path !== file.path,
    )
    for (const { id } of moved) {
      await tx.file.update({ where: { id }, data: { path: `.restore/${id}` } })
    }
    for (const { id } of moved) {
      await tx.file.update({ where: { id }, data: { path: target.get(id)?.path as string } })
    }
    await tx.file.createMany({
      data: tree
        .filter((entry) => !known.has(entry.id))
        .map(({ id, path, kind }) => ({ id, projectId, path, kind })),
    })
  })
}

// A file that still exists keeps its current path. One deleted since comes back where it was.
async function restoreDeletedFile(
  prisma: PrismaClient,
  projectId: string,
  entry: SnapshotEntry,
): Promise<void> {
  const present = await prisma.file.findUnique({ where: { id: entry.id }, select: { id: true } })
  if (present) return
  const parents = parentPaths(entry.path)
  const taken = await prisma.file.findMany({
    where: { projectId, path: { in: [entry.path, ...parents] } },
    select: { path: true, kind: true },
  })
  if (taken.some(({ path, kind }) => path === entry.path || kind === 'FILE')) {
    throw conflict('path_exists', `${entry.path.slice(0, 120)} is already in use`)
  }
  const existing = new Set(taken.map(({ path }) => path))
  await prisma.file.createMany({
    data: [
      ...parents
        .filter((path) => !existing.has(path))
        .map((path) => ({ id: randomUUID(), projectId, path, kind: 'DIRECTORY' as const })),
      { id: entry.id, projectId, path: entry.path, kind: 'FILE' as const },
    ],
  })
}

export function registerHistoryRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, bridge, limiter } = deps

  const loadSnapshot = async (id: string, userId: string, action: Action) => {
    const snapshot = await prisma.snapshot.findUnique({
      where: { id },
      select: { projectId: true, state: true, tree: true, ...SNAPSHOT_FIELDS },
    })
    if (!snapshot) throw notFound('Snapshot')
    const { room } = await requireProject(prisma, snapshot.projectId, userId, action)
    return { snapshot, roomId: room.id, tree: parseTree(snapshot.tree) }
  }

  const limitWrites = (userId: string) =>
    enforceRateLimits(limiter, [
      { key: `history:${userId}`, limit: SNAPSHOTS.writesPerUserPerMinute, windowMs: MINUTE },
    ])

  const blame = async (projectId: string, state: Uint8Array, fileId: string) => {
    const lines = withDocFiles(state, (files) => {
      const text = files.get(fileId)
      if (!text) throw notFound('File')
      return blameLines(text)
    })
    const clients = [...new Set(lines)].filter((client) => client !== null)
    const rows = await prisma.yjsClient.findMany({
      where: { projectId, clientId: { in: clients.map(BigInt) } },
      select: { clientId: true, userId: true, user: { select: { displayName: true } } },
    })
    return {
      ranges: toRanges(lines, new Map(rows.map((row) => [Number(row.clientId), row.userId]))),
      users: Object.fromEntries(rows.map((row) => [row.userId, row.user.displayName])),
    }
  }

  app.get('/projects/:id/snapshots', async (request) => {
    const { id } = idParams.parse(request.params)
    await requireProject(prisma, id, request.userId, 'file.read')
    const { before } = listQuery.parse(request.query)
    const snapshots = await prisma.snapshot.findMany({
      where: { projectId: id, ...(before ? { createdAt: { lt: before } } : {}) },
      select: SNAPSHOT_FIELDS,
      orderBy: { createdAt: 'desc' },
      take: SNAPSHOTS.pageSize,
    })
    const ids = [...new Set(snapshots.flatMap((snapshot) => snapshot.authorIds))]
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    })
    return {
      snapshots,
      users: Object.fromEntries(users.map((user) => [user.id, user.displayName])),
    }
  })

  app.post('/projects/:id/snapshots', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const { room } = await requireProject(prisma, id, request.userId, 'file.write')
    const { label } = checkpointBody.parse(request.body)
    await limitWrites(request.userId)
    const checkpoints = await prisma.snapshot.count({ where: { projectId: id, kind: 'MANUAL' } })
    if (checkpoints >= SNAPSHOTS.maxManualPerProject) {
      throw conflict('too_many_checkpoints', 'This project has reached its checkpoint limit')
    }
    const snapshotId = await captureSnapshot(prisma, {
      projectId: id,
      kind: 'MANUAL',
      label,
      state: await bridge.encodeState(id),
      createdById: request.userId,
    })
    await bridge.publishRoomEvent(room.id, {
      type: 'history.changed',
      projectId: id,
      snapshotId,
      action: 'checkpoint',
      userId: request.userId,
    })
    return reply.status(201).send({ snapshot: { id: snapshotId } })
  })

  app.get('/snapshots/:id', async (request) => {
    const { id } = idParams.parse(request.params)
    const { snapshot, tree } = await loadSnapshot(id, request.userId, 'file.read')
    const { id: snapshotId, kind, label, authorIds, createdById, createdAt } = snapshot
    return { snapshot: { id: snapshotId, kind, label, authorIds, createdById, createdAt }, tree }
  })

  app.get('/snapshots/:id/files/:fileId', async (request) => {
    const { id, fileId } = fileParams.parse(request.params)
    const { snapshot, tree } = await loadSnapshot(id, request.userId, 'file.read')
    const entry = tree.find((item) => item.id === fileId && item.kind === 'FILE')
    if (!entry) throw notFound('File')
    return { path: entry.path, content: readContents(snapshot.state, [entry]).get(fileId) }
  })

  app.get('/snapshots/:id/files/:fileId/blame', async (request) => {
    const { id, fileId } = fileParams.parse(request.params)
    const { snapshot } = await loadSnapshot(id, request.userId, 'file.read')
    return blame(snapshot.projectId, snapshot.state, fileId)
  })

  app.get('/files/:id/blame', async (request) => {
    const { id } = idParams.parse(request.params)
    const file = await prisma.file.findUnique({ where: { id }, select: { projectId: true } })
    if (!file) throw notFound('File')
    await requireProject(prisma, file.projectId, request.userId, 'file.read')
    return blame(file.projectId, await bridge.encodeState(file.projectId), id)
  })

  app.get('/snapshots/:id/export', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const { snapshot, tree } = await loadSnapshot(id, request.userId, 'file.export')
    const contents = readContents(snapshot.state, tree)
    const archive = writeProjectArchive(
      tree
        .filter((entry) => entry.kind === 'FILE')
        .map(({ id: fileId, path }) => ({ path, content: contents.get(fileId) ?? '' })),
    )
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="snapshot-${id}.zip"`)
      .send(Buffer.from(archive))
  })

  // A restore is an ordinary edit on top of the live document, so it reaches everyone and
  // concurrent typing merges with it. The snapshot taken first is how it gets undone.
  app.post('/snapshots/:id/restore', async (request) => {
    const { id } = idParams.parse(request.params)
    const { snapshot, roomId, tree } = await loadSnapshot(id, request.userId, 'file.write')
    const { projectId } = snapshot
    const { fileId } = restoreBody.parse(request.body ?? {})
    const single = fileId ? tree.find((item) => item.id === fileId) : undefined
    if (fileId && single?.kind !== 'FILE') throw notFound('File')
    await limitWrites(request.userId)

    const contents = readContents(snapshot.state, single ? [single] : tree)
    const undoSnapshotId = await bridge.withTreeLock(projectId, async () => {
      const undoId = await captureSnapshot(prisma, {
        projectId,
        kind: 'AUTO',
        label: 'Before restore',
        state: await bridge.encodeState(projectId),
        createdById: request.userId,
      })
      if (single) await restoreDeletedFile(prisma, projectId, single)
      else await restoreProjectTree(prisma, projectId, tree)
      const clientId = await bridge.writeFiles(
        projectId,
        [...contents].map(([file, content]) => ({ id: file, content })),
      )
      if (clientId !== null) {
        await prisma.yjsClient.createMany({
          data: [{ projectId, clientId: BigInt(clientId), userId: request.userId }],
          skipDuplicates: true,
        })
      }
      return undoId
    })
    await bridge.notify(roomId, { type: 'tree.changed', projectId })
    await bridge.publishRoomEvent(roomId, {
      type: 'history.changed',
      projectId,
      snapshotId: id,
      action: 'restored',
      userId: request.userId,
    })
    return { undoSnapshotId }
  })
}
