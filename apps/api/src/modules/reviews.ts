import { createHash } from 'node:crypto'
import { REVIEW_LIMITS } from '@codesync/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { ApiError, forbidden, invalid, notFound } from '../lib/errors.js'
import { requireRoom } from './access.js'
import { enforceRateLimits } from './auth/rateLimit.js'
import { assertServiceToken } from './executions.js'

const DAY_MS = 24 * 60 * 60 * 1000

const language = z.enum(['PYTHON', 'CPP', 'JAVA', 'JAVASCRIPT'])
const mode = z.enum(['REVIEW', 'EXPLAIN', 'WHY_FAILING'])

const createBody = z
  .object({
    mode: mode.default('REVIEW'),
    language,
    // Either a file in a room, read on the server, or practice code sent by the client.
    roomId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    fileId: z.uuid().optional(),
    problemId: z.uuid().optional(),
    code: z.string().max(REVIEW_LIMITS.maxCodeChars).optional(),
    lineStart: z.number().int().min(1).optional(),
    lineEnd: z.number().int().min(1).optional(),
    executionId: z.uuid().optional(),
  })
  .refine((body) => (body.fileId ? body.projectId && body.roomId : body.problemId && body.code), {
    message: 'Send a room file, or practice code with its problem',
  })

const idParams = z.object({ id: z.uuid() })

const issue = z.object({
  line_start: z.number().int(),
  line_end: z.number().int(),
  severity: z.enum(['error', 'warning', 'info']),
  category: z.enum(['bug', 'security', 'performance', 'style', 'readability']),
  message: z.string(),
  suggested_fix: z.string().nullable(),
})

const resultBody = z.object({
  status: z.enum(['DONE', 'FAILED']),
  issues: z.array(issue),
  explanation: z.string(),
  complexity: z.array(z.record(z.string(), z.unknown())),
  model: z.string().max(120),
})

const PUBLIC_FIELDS = {
  id: true,
  mode: true,
  language: true,
  status: true,
  lineStart: true,
  lineEnd: true,
  findings: true,
  explanation: true,
  complexity: true,
  model: true,
  createdAt: true,
} as const

const quotaKey = (userId: string): string => `rate:review:user:${userId}`

export function selectLines(code: string, lineStart?: number, lineEnd?: number): string {
  if (lineStart === undefined && lineEnd === undefined) return code
  const lines = code.split('\n')
  const start = lineStart ?? 1
  const end = lineEnd ?? lines.length
  if (start > end || start > lines.length) {
    throw invalid('invalid_range', 'That line range is outside the file')
  }
  return lines.slice(start - 1, end).join('\n')
}

export function registerReviewRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, bridge, limiter, queue, config } = deps
  const internal = { config: { public: true } }

  app.post('/reviews', async (request, reply) => {
    const body = createBody.parse(request.body)

    let source: string
    if (body.fileId) {
      const roomId = body.roomId as string
      await requireRoom(prisma, roomId, request.userId, 'file.read')
      const file = await prisma.file.findFirst({
        where: {
          id: body.fileId,
          projectId: body.projectId as string,
          project: { roomId },
          kind: 'FILE',
        },
        select: { id: true },
      })
      if (!file) throw notFound('File')
      const contents = await bridge.readFiles(body.projectId as string)
      source = contents.get(body.fileId) ?? ''
    } else {
      const problem = await prisma.problem.findFirst({
        where: { id: body.problemId as string, publishedAt: { not: null } },
        select: { id: true },
      })
      if (!problem) throw notFound('Problem')
      source = body.code as string
    }

    const code = selectLines(source, body.lineStart, body.lineEnd)
    if (code.split('\n').length > REVIEW_LIMITS.maxLines) {
      throw invalid(
        'too_many_lines',
        `A review covers at most ${REVIEW_LIMITS.maxLines} lines. Select a smaller range.`,
      )
    }
    if (!code.trim()) throw invalid('empty_code', 'There is no code to review')

    let errorOutput = ''
    if (body.mode === 'WHY_FAILING' && body.executionId) {
      const execution = await prisma.execution.findFirst({
        where: { id: body.executionId, roomId: body.roomId ?? '' },
        select: { stderr: true, compileOutput: true },
      })
      if (!execution) throw notFound('Run')
      errorOutput = `${execution.compileOutput ?? ''}\n${execution.stderr ?? ''}`
        .trim()
        .slice(-REVIEW_LIMITS.maxErrorChars)
    }

    // Practice is part of the key: a cached full review must never answer a practice request.
    const practice = body.problemId !== undefined
    const contentHash = createHash('sha256')
      .update(JSON.stringify([code, body.mode, body.language, practice, errorOutput]))
      .digest('hex')

    const cached = await prisma.review.findFirst({
      where: {
        contentHash,
        mode: body.mode,
        language: body.language,
        status: 'DONE',
        problemId: practice ? { not: null } : null,
      },
      orderBy: { createdAt: 'desc' },
      select: PUBLIC_FIELDS,
    })
    // Cached answers cost nothing, so they use none of the daily quota.
    if (cached) return reply.status(200).send({ review: cached, cached: true })

    await enforceRateLimits(
      limiter,
      [{ key: quotaKey(request.userId), limit: REVIEW_LIMITS.perUserPerDay, windowMs: DAY_MS }],
      `You have used today's ${REVIEW_LIMITS.perUserPerDay} AI reviews. They reset tomorrow.`,
    )

    const review = await prisma.review.create({
      data: {
        userId: request.userId,
        roomId: body.roomId ?? null,
        projectId: body.projectId ?? null,
        fileId: body.fileId ?? null,
        problemId: body.problemId ?? null,
        mode: body.mode,
        language: body.language,
        contentHash,
        lineStart: body.lineStart ?? null,
        lineEnd: body.lineEnd ?? null,
        findings: [],
        model: '',
      },
      select: PUBLIC_FIELDS,
    })
    try {
      await queue.enqueueReview({
        review_id: review.id,
        mode: body.mode,
        language: body.language,
        code,
        error_output: errorOutput,
        practice,
      })
    } catch {
      await prisma.review.update({ where: { id: review.id }, data: { status: 'FAILED' } })
      throw new ApiError(503, 'queue_unavailable', 'Reviews are unavailable. Try again shortly.')
    }
    return reply.status(202).send({ review, cached: false })
  })

  app.get('/reviews/quota', async (request) => {
    const used = await limiter.count(quotaKey(request.userId))
    return { limit: REVIEW_LIMITS.perUserPerDay, used }
  })

  app.get('/reviews/:id', async (request) => {
    const { id } = idParams.parse(request.params)
    const review = await prisma.review.findUnique({
      where: { id },
      select: { ...PUBLIC_FIELDS, userId: true },
    })
    if (!review) throw notFound('Review')
    if (review.userId !== request.userId) throw forbidden()
    return { review }
  })

  app.post('/internal/reviews/:id/result', internal, async (request) => {
    assertServiceToken(request, config.internalServiceToken)
    const { id } = idParams.parse(request.params)
    const result = resultBody.parse(request.body)
    const updated = await prisma.review.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: result.status,
        findings: result.issues,
        explanation: result.explanation,
        complexity: result.complexity as object[],
        model: result.model,
      },
    })
    return { recorded: updated.count === 1 }
  })

}
