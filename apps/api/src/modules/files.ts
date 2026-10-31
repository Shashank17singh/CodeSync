import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@codesync/db'
import { COLLAB_LIMITS } from '@codesync/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { conflict, invalid, notFound } from '../lib/errors.js'
import { isInside, parentPaths, validateProjectPath } from '../lib/paths.js'
import { readProjectArchive, writeProjectArchive } from '../lib/zip.js'
import { requireProject, requireRoom } from './access.js'

const MAX_FILES_PER_PROJECT = 1000

const roomParams = z.object({ id: z.uuid() })
const projectParams = z.object({ id: z.uuid() })
const fileParams = z.object({ id: z.uuid(), fileId: z.uuid() })

const createProjectBody = z.object({ name: z.string().trim().min(1).max(120) })
const createFileBody = z.object({
  path: z.string().min(1).max(1024),
  kind: z.enum(['FILE', 'DIRECTORY']).default('FILE'),
  content: z.string().max(COLLAB_LIMITS.maxFileChars).default(''),
})
const moveFileBody = z.object({ path: z.string().min(1).max(1024) })

interface NewFile {
  path: string
  content: string
}

interface PlannedRow {
  id: string
  projectId: string
  path: string
  kind: 'FILE' | 'DIRECTORY'
}

// Works out the rows for a set of new files, including any missing parent folders. Fails before
// anything is written, so an import either lands completely or not at all.
async function planNewRows(
  prisma: PrismaClient,
  projectId: string,
  files: NewFile[],
  directories: string[] = [],
): Promise<{ rows: PlannedRow[]; contents: Array<{ id: string; content: string }> }> {
  const existing = await prisma.file.findMany({
    where: { projectId },
    select: { path: true, kind: true },
  })
  const kinds = new Map(existing.map((file) => [file.path, file.kind]))
  const rows: PlannedRow[] = []
  const contents: Array<{ id: string; content: string }> = []

  const addDirectory = (path: string): void => {
    const kind = kinds.get(path)
    if (kind === 'DIRECTORY') return
    if (kind === 'FILE') throw conflict('path_is_file', `${path} is a file, not a folder`)
    kinds.set(path, 'DIRECTORY')
    rows.push({ id: randomUUID(), projectId, path, kind: 'DIRECTORY' })
  }

  for (const path of directories) {
    parentPaths(path).forEach(addDirectory)
    addDirectory(path)
  }
  for (const file of files) {
    parentPaths(file.path).forEach(addDirectory)
    if (kinds.has(file.path)) {
      throw conflict('path_exists', `${file.path.slice(0, 120)} already exists`)
    }
    const id = randomUUID()
    kinds.set(file.path, 'FILE')
    rows.push({ id, projectId, path: file.path, kind: 'FILE' })
    contents.push({ id, content: file.content })
  }

  if (kinds.size > MAX_FILES_PER_PROJECT) {
    throw invalid('too_many_files', `A project can hold at most ${MAX_FILES_PER_PROJECT} files`)
  }
  return { rows, contents }
}

export function registerFileRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, bridge } = deps

  const insertFiles = async (
    roomId: string,
    projectId: string,
    files: NewFile[],
    directories: string[] = [],
  ): Promise<PlannedRow[]> => {
    // The lock covers the seed and the commit together. Otherwise collab could reconcile in the
    // gap, see text with no file row, and delete it.
    const rows = await bridge.withTreeLock(projectId, async () => {
      const plan = await planNewRows(prisma, projectId, files, directories)
      await bridge.seedFiles(projectId, plan.contents)
      await prisma.file.createMany({ data: plan.rows })
      return plan.rows
    })
    await bridge.notify(roomId, { type: 'tree.changed', projectId })
    return rows
  }

  app.post('/rooms/:id/projects', async (request, reply) => {
    const { id } = roomParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'project.create')
    const { name } = createProjectBody.parse(request.body)
    const project = await prisma.project.create({
      data: { roomId: id, name },
      select: { id: true, roomId: true, name: true, createdAt: true },
    })
    return reply.status(201).send({ project })
  })

  app.get('/projects/:id', async (request) => {
    const { id } = projectParams.parse(request.params)
    const { room, projectName } = await requireProject(prisma, id, request.userId, 'project.view')
    return { project: { id, roomId: room.id, name: projectName } }
  })

  app.delete('/projects/:id', async (request, reply) => {
    const { id } = projectParams.parse(request.params)
    await requireProject(prisma, id, request.userId, 'project.delete')
    await prisma.project.delete({ where: { id } })
    await bridge.forgetProject(id)
    return reply.status(204).send()
  })

  app.get('/projects/:id/files', async (request) => {
    const { id } = projectParams.parse(request.params)
    await requireProject(prisma, id, request.userId, 'file.read')
    const files = await prisma.file.findMany({
      where: { projectId: id },
      select: { id: true, path: true, kind: true, updatedAt: true },
      orderBy: { path: 'asc' },
    })
    return { files }
  })

  app.post('/projects/:id/files', async (request, reply) => {
    const { id } = projectParams.parse(request.params)
    const { room } = await requireProject(prisma, id, request.userId, 'file.write')
    const body = createFileBody.parse(request.body)
    const path = validateProjectPath(body.path)
    const isFile = body.kind === 'FILE'
    const rows = await insertFiles(
      room.id,
      id,
      isFile ? [{ path, content: body.content }] : [],
      isFile ? [] : [path],
    )
    const created = rows.find((row) => row.path === path)
    if (!created) throw conflict('path_exists', `${path.slice(0, 120)} already exists`)
    return reply.status(201).send({ file: created })
  })

  app.patch('/projects/:id/files/:fileId', async (request) => {
    const { id, fileId } = fileParams.parse(request.params)
    const { room } = await requireProject(prisma, id, request.userId, 'file.write')
    const target = validateProjectPath(moveFileBody.parse(request.body).path)
    const file = await prisma.file.findFirst({ where: { id: fileId, projectId: id } })
    if (!file) throw notFound('File')
    if (isInside(target, file.path)) {
      throw invalid('invalid_move', 'A folder cannot be moved into itself')
    }

    await bridge.withTreeLock(id, async () => {
      const { rows } = await planNewRows(prisma, id, [], parentPaths(target))
      await prisma.$transaction(async (tx) => {
        await tx.file.createMany({ data: rows })
        const children = await tx.file.findMany({
          where: { projectId: id, path: { startsWith: `${file.path}/` } },
          select: { id: true, path: true },
        })
        await tx.file.update({ where: { id: fileId }, data: { path: target } })
        for (const child of children) {
          await tx.file.update({
            where: { id: child.id },
            data: { path: `${target}${child.path.slice(file.path.length)}` },
          })
        }
      })
    })
    await bridge.notify(room.id, { type: 'tree.changed', projectId: id })
    return { file: { id: fileId, path: target, kind: file.kind } }
  })

  app.delete('/projects/:id/files/:fileId', async (request, reply) => {
    const { id, fileId } = fileParams.parse(request.params)
    const { room } = await requireProject(prisma, id, request.userId, 'file.write')
    const file = await prisma.file.findFirst({ where: { id: fileId, projectId: id } })
    if (!file) throw notFound('File')
    await bridge.withTreeLock(id, () =>
      prisma.file.deleteMany({
        where: {
          projectId: id,
          OR: [{ id: fileId }, { path: { startsWith: `${file.path}/` } }],
        },
      }),
    )
    await bridge.notify(room.id, { type: 'tree.changed', projectId: id })
    return reply.status(204).send()
  })

  app.post('/projects/:id/import', async (request, reply) => {
    const { id } = projectParams.parse(request.params)
    const { room } = await requireProject(prisma, id, request.userId, 'file.import')
    if (!Buffer.isBuffer(request.body)) {
      throw invalid('invalid_archive', 'Send the archive with content type application/zip')
    }
    const files = readProjectArchive(request.body)
    const rows = await insertFiles(room.id, id, files)
    return reply.status(201).send({ imported: rows.filter((row) => row.kind === 'FILE').length })
  })

  app.get('/projects/:id/export', async (request, reply) => {
    const { id } = projectParams.parse(request.params)
    await requireProject(prisma, id, request.userId, 'file.export')
    const files = await prisma.file.findMany({
      where: { projectId: id, kind: 'FILE' },
      select: { id: true, path: true },
    })
    const contents = await bridge.readFiles(id)
    const archive = writeProjectArchive(
      files.map(({ id: fileId, path }) => ({ path, content: contents.get(fileId) ?? '' })),
    )
    return reply
      .header('content-type', 'application/zip')
      // Built from the id, because a project name could inject into the header.
      .header('content-disposition', `attachment; filename="project-${id}.zip"`)
      .send(Buffer.from(archive))
  })
}
