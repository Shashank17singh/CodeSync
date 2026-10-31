import { Prisma } from '@codesync/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../app.js'

const editorSettings = z.strictObject({
  fontSize: z.number().int().min(8).max(32),
  tabSize: z.number().int().min(1).max(8),
  keybindings: z.enum(['default', 'vim', 'emacs']),
})

const updateProfileBody = z.strictObject({
  displayName: z.string().trim().min(1).max(80).optional(),
  // https only: this value becomes an image source for every user in a room.
  avatarUrl: z.url({ protocol: /^https$/ }).max(2048).nullable().optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  editorSettings: editorSettings.partial().optional(),
})

const PROFILE_FIELDS = {
  id: true,
  email: true,
  displayName: true,
  avatarUrl: true,
  role: true,
  theme: true,
  editorSettings: true,
} as const

export function registerProfileRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma } = deps

  app.get('/me', async (request) => ({
    user: await prisma.user.findUniqueOrThrow({
      where: { id: request.userId },
      select: PROFILE_FIELDS,
    }),
  }))

  app.patch('/me', async (request) => {
    const body = updateProfileBody.parse(request.body)
    const data: Prisma.UserUpdateInput = {}
    if (body.displayName !== undefined) data.displayName = body.displayName
    if (body.avatarUrl !== undefined) data.avatarUrl = body.avatarUrl
    if (body.theme !== undefined) data.theme = body.theme

    if (body.editorSettings === undefined) {
      return {
        user: await prisma.user.update({
          where: { id: request.userId },
          data,
          select: PROFILE_FIELDS,
        }),
      }
    }

    // Read and write together, so two devices changing different settings both take effect.
    const { editorSettings: changes } = body
    return prisma.$transaction(async (tx) => {
      const current = await tx.user.findUniqueOrThrow({
        where: { id: request.userId },
        select: { editorSettings: true },
      })
      const merged = { ...(current.editorSettings as Prisma.JsonObject), ...changes }
      return {
        user: await tx.user.update({
          where: { id: request.userId },
          data: { ...data, editorSettings: merged as Prisma.InputJsonObject },
          select: PROFILE_FIELDS,
        }),
      }
    })
  })
}
