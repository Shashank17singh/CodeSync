import type { PrismaClient } from '@codesync/db'
import { EXECUTION_LIMITS } from '@codesync/shared'
import type { FastifyInstance } from 'fastify'
import { unzipSync } from 'fflate'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import { ApiError, forbidden, invalid, notFound } from '../lib/errors.js'
import { rankSubmissions } from '../lib/leaderboard.js'
import { fingerprint, similarity, tokenize } from '../lib/winnow.js'
import { ZIP_LIMITS } from '../lib/zip.js'
import { requireRoom } from './access.js'
import { assertServiceToken } from './executions.js'
import { MINUTE, enforceRateLimits } from './auth/rateLimit.js'

const PAGE_SIZE = 50
const MAX_TEST_PAIRS = 100
const MAX_SOURCE_CHARS = 64 * 1024
const DEFAULT_LIMIT = { timeMs: 2000, memoryMb: 256 }
const PLAGIARISM_THRESHOLD = 0.5
const MAX_COMPARED_SUBMISSIONS = 500

const language = z.enum(['PYTHON', 'CPP', 'JAVA', 'JAVASCRIPT'])
const verdict = z.enum([
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'RUNTIME_ERROR',
  'COMPILE_ERROR',
  'INTERNAL_ERROR',
])

const idParams = z.object({ id: z.uuid() })
const slugParams = z.object({ slug: z.string().min(1).max(120) })
const listQuery = z.object({
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  tag: z.string().max(40).optional(),
  q: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
})

const languageLimit = z.object({
  timeMs: z.number().int().min(100).max(30_000),
  memoryMb: z.number().int().min(16).max(256),
})

const problemFields = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(120),
  title: z.string().trim().min(1).max(200),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  statementMd: z.string().max(100_000),
  inputFormat: z.string().max(10_000),
  outputFormat: z.string().max(10_000),
  constraints: z.string().max(10_000),
  limits: z.partialRecord(language, languageLimit).default({}),
  starterCode: z.partialRecord(language, z.string().max(MAX_SOURCE_CHARS)).default({}),
  checkerKind: z.enum(['EXACT', 'WHITESPACE', 'CUSTOM']).default('EXACT'),
  checkerSource: z.string().max(MAX_SOURCE_CHARS).nullable().default(null),
  checkerLanguage: language.nullable().default(null),
  referenceSolution: z.string().max(MAX_SOURCE_CHARS).nullable().default(null),
  referenceLanguage: language.nullable().default(null),
  stopOnFirstFailure: z.boolean().default(true),
  published: z.boolean().default(false),
})

const submitBody = z.object({
  language,
  source: z.string().min(1).max(MAX_SOURCE_CHARS),
  contestId: z.uuid().optional(),
})

const problemSetBody = z.object({
  title: z.string().trim().min(1).max(200),
  problemIds: z.array(z.uuid()).min(1).max(100),
})

const contestBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    problemSetId: z.uuid(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    freezeMinutes: z.number().int().min(0).max(1440).default(15),
  })
  .refine((body) => body.endsAt > body.startsAt, { message: 'A contest must end after it starts' })

const judgeResultBody = z.object({
  verdict,
  failed_ordinal: z.number().int().nullable(),
  time_ms: z.number().int().nonnegative().nullable(),
  memory_kb: z.number().int().nonnegative().nullable(),
  compile_output: z.string(),
  results: z.array(
    z.object({
      ordinal: z.number().int(),
      verdict,
      time_ms: z.number().int().nullable(),
      memory_kb: z.number().int().nullable(),
    }),
  ),
})

const PUBLIC_PROBLEM = {
  id: true,
  slug: true,
  title: true,
  difficulty: true,
  tags: true,
  statementMd: true,
  inputFormat: true,
  outputFormat: true,
  constraints: true,
  limits: true,
  starterCode: true,
} as const

interface TestPair {
  ordinal: number
  input: Uint8Array
  output: Uint8Array
  isSample: boolean
}

// Accepts `1.in`, `1.out`, `sample1.in` and so on. Names starting with "sample" are visible.
export function readTestArchive(archive: Uint8Array): TestPair[] {
  let expandedBytes = 0
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(archive, {
      filter: (file) => {
        expandedBytes += file.originalSize
        if (expandedBytes > ZIP_LIMITS.maxExpandedBytes) {
          throw invalid('archive_too_large', 'The archive expands to too much data')
        }
        return !file.name.endsWith('/') && !file.name.startsWith('__MACOSX/')
      },
    })
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw invalid('invalid_archive', 'The file is not a valid zip archive')
  }

  const inputs = new Map<string, Uint8Array>()
  const outputs = new Map<string, Uint8Array>()
  for (const [name, bytes] of Object.entries(entries)) {
    const match = /^([\w-]+)\.(in|out)$/.exec(name)
    if (!match) throw invalid('invalid_test_name', 'Test files must be named like 1.in and 1.out')
    ;(match[2] === 'in' ? inputs : outputs).set(match[1] as string, bytes)
  }
  if (inputs.size === 0) throw invalid('no_tests', 'The archive has no tests')
  if (inputs.size > MAX_TEST_PAIRS) {
    throw invalid('too_many_tests', `A problem can have at most ${MAX_TEST_PAIRS} tests`)
  }
  for (const name of inputs.keys()) {
    if (!outputs.has(name)) throw invalid('unpaired_test', `${name}.in has no matching .out file`)
  }
  for (const name of outputs.keys()) {
    if (!inputs.has(name)) throw invalid('unpaired_test', `${name}.out has no matching .in file`)
  }

  const names = [...inputs.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  // Samples first, so that a student meets the visible tests before the hidden ones.
  const ordered = [
    ...names.filter((name) => name.startsWith('sample')),
    ...names.filter((name) => !name.startsWith('sample')),
  ]
  return ordered.map((name, index) => ({
    ordinal: index + 1,
    input: inputs.get(name) as Uint8Array,
    output: outputs.get(name) as Uint8Array,
    isSample: name.startsWith('sample'),
  }))
}

async function isFaculty(prisma: PrismaClient, userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
  return user?.role === 'FACULTY' || user?.role === 'ADMIN'
}

async function requireFaculty(prisma: PrismaClient, userId: string): Promise<void> {
  if (!(await isFaculty(prisma, userId))) throw forbidden()
}

export function registerProblemRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, queue, limiter, config, logger } = deps
  const internal = { config: { public: true } }

  const enqueue = async (submissionId: string): Promise<void> => {
    try {
      await queue.enqueueJudge(submissionId)
    } catch (error) {
      logger.error({ err: error, submissionId }, 'failed to enqueue a submission')
      await prisma.submission.update({
        where: { id: submissionId },
        data: { verdict: 'INTERNAL_ERROR', judgedAt: new Date() },
      })
      throw new ApiError(503, 'queue_unavailable', 'Judging is unavailable. Try again shortly.')
    }
  }

  app.get('/problems', async (request) => {
    const query = listQuery.parse(request.query)
    const faculty = await isFaculty(prisma, request.userId)
    const problems = await prisma.problem.findMany({
      where: {
        ...(faculty ? {} : { publishedAt: { not: null } }),
        ...(query.difficulty ? { difficulty: query.difficulty } : {}),
        ...(query.tag ? { tags: { has: query.tag } } : {}),
        ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
      },
      select: { id: true, slug: true, title: true, difficulty: true, tags: true },
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    })
    return { problems }
  })

  app.get('/problems/:slug', async (request) => {
    const { slug } = slugParams.parse(request.params)
    const faculty = await isFaculty(prisma, request.userId)
    const problem = await prisma.problem.findFirst({
      where: { slug, ...(faculty ? {} : { publishedAt: { not: null } }) },
      select: {
        ...PUBLIC_PROBLEM,
        testCases: {
          where: { isSample: true },
          select: { ordinal: true, input: true, output: true },
          orderBy: { ordinal: 'asc' },
        },
      },
    })
    if (!problem) throw notFound('Problem')
    const { testCases, ...fields } = problem
    return {
      problem: {
        ...fields,
        samples: testCases.map((test) => ({
          ordinal: test.ordinal,
          input: Buffer.from(test.input).toString('utf8'),
          output: Buffer.from(test.output).toString('utf8'),
        })),
      },
    }
  })

  const assertChecker = (fields: {
    checkerKind?: string | undefined
    checkerSource?: string | null | undefined
    checkerLanguage?: string | null | undefined
  }): void => {
    if (fields.checkerKind === 'CUSTOM' && (!fields.checkerSource || !fields.checkerLanguage)) {
      throw invalid('checker_required', 'A custom checker needs its source and language')
    }
  }

  app.post('/problems', async (request, reply) => {
    await requireFaculty(prisma, request.userId)
    const { published, ...body } = problemFields.parse(request.body)
    assertChecker(body)
    const problem = await prisma.problem.create({
      data: {
        ...body,
        createdById: request.userId,
        publishedAt: published ? new Date() : null,
      },
      select: { id: true, slug: true },
    })
    return reply.status(201).send({ problem })
  })

  app.patch('/problems/:id', async (request) => {
    await requireFaculty(prisma, request.userId)
    const { id } = idParams.parse(request.params)
    const { published, ...body } = problemFields.partial().parse(request.body)
    assertChecker(body)
    const defined = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    )
    const problem = await prisma.problem.update({
      where: { id },
      data: {
        ...defined,
        ...(published === undefined ? {} : { publishedAt: published ? new Date() : null }),
      },
      select: { id: true, slug: true, publishedAt: true },
    })
    return { problem }
  })

  app.post('/problems/:id/tests', async (request, reply) => {
    await requireFaculty(prisma, request.userId)
    const { id } = idParams.parse(request.params)
    if (!Buffer.isBuffer(request.body)) {
      throw invalid('invalid_archive', 'Send the archive with content type application/zip')
    }
    const pairs = readTestArchive(request.body)
    await prisma.$transaction(async (tx) => {
      await tx.problem.findUniqueOrThrow({ where: { id }, select: { id: true } })
      await tx.testCase.deleteMany({ where: { problemId: id } })
      await tx.testCase.createMany({
        data: pairs.map((pair) => ({
          problemId: id,
          ordinal: pair.ordinal,
          isSample: pair.isSample,
          input: Buffer.from(pair.input),
          output: Buffer.from(pair.output),
        })),
      })
    })
    return reply.status(201).send({
      tests: pairs.length,
      samples: pairs.filter((pair) => pair.isSample).length,
    })
  })

  app.post('/problems/:id/validate', async (request, reply) => {
    await requireFaculty(prisma, request.userId)
    const { id } = idParams.parse(request.params)
    const problem = await prisma.problem.findUnique({
      where: { id },
      select: { referenceSolution: true, referenceLanguage: true },
    })
    if (!problem) throw notFound('Problem')
    if (!problem.referenceSolution || !problem.referenceLanguage) {
      throw invalid('no_reference', 'Add a reference solution first')
    }
    const submission = await prisma.submission.create({
      data: {
        problemId: id,
        userId: request.userId,
        language: problem.referenceLanguage,
        source: problem.referenceSolution,
        isValidation: true,
      },
      select: { id: true, verdict: true },
    })
    await enqueue(submission.id)
    return reply.status(202).send({ submission })
  })

  app.post('/problems/:slug/submissions', async (request, reply) => {
    const { slug } = slugParams.parse(request.params)
    const body = submitBody.parse(request.body)
    const problem = await prisma.problem.findFirst({
      where: { slug, publishedAt: { not: null } },
      select: { id: true, _count: { select: { testCases: true } } },
    })
    if (!problem) throw notFound('Problem')
    if (problem._count.testCases === 0) {
      throw invalid('no_tests', 'This problem has no tests yet')
    }

    if (body.contestId) {
      const contest = await prisma.contest.findUnique({
        where: { id: body.contestId },
        include: { problemSet: { select: { problems: { where: { id: problem.id } } } } },
      })
      if (!contest) throw notFound('Contest')
      await requireRoom(prisma, contest.roomId, request.userId, 'file.read')
      const now = new Date()
      if (now < contest.startsAt || now >= contest.endsAt) {
        throw invalid('contest_closed', 'This contest is not running')
      }
      if (contest.problemSet.problems.length === 0) {
        throw invalid('not_in_contest', 'This problem is not part of the contest')
      }
    }

    await enforceRateLimits(
      limiter,
      [
        {
          key: `rate:submit:user:${request.userId}`,
          limit: EXECUTION_LIMITS.submissionsPerUserPerMinute,
          windowMs: MINUTE,
        },
      ],
      `You can submit ${EXECUTION_LIMITS.submissionsPerUserPerMinute} times a minute.`,
    )

    const submission = await prisma.submission.create({
      data: {
        problemId: problem.id,
        userId: request.userId,
        language: body.language,
        source: body.source,
        contestId: body.contestId ?? null,
      },
      select: { id: true, verdict: true },
    })
    await enqueue(submission.id)
    return reply.status(202).send({ submission })
  })

  app.get('/submissions/:id', async (request) => {
    const { id } = idParams.parse(request.params)
    const submission = await prisma.submission.findUnique({
      where: { id },
      select: {
        id: true,
        problemId: true,
        userId: true,
        language: true,
        source: true,
        verdict: true,
        failedOrdinal: true,
        timeMs: true,
        memoryKb: true,
        compileOutput: true,
        results: true,
        createdAt: true,
        judgedAt: true,
      },
    })
    const allowed =
      submission?.userId === request.userId || (await isFaculty(prisma, request.userId))
    if (!submission || !allowed) throw notFound('Submission')
    return { submission }
  })

  app.get('/me/submissions', async (request) => {
    const submissions = await prisma.submission.findMany({
      where: { userId: request.userId, isValidation: false },
      select: {
        id: true,
        problemId: true,
        language: true,
        verdict: true,
        failedOrdinal: true,
        timeMs: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
    })
    return { submissions }
  })

  app.post('/problem-sets', async (request, reply) => {
    await requireFaculty(prisma, request.userId)
    const body = problemSetBody.parse(request.body)
    const problemSet = await prisma.problemSet.create({
      data: {
        title: body.title,
        createdById: request.userId,
        problems: { connect: body.problemIds.map((id) => ({ id })) },
      },
      select: { id: true, title: true },
    })
    return reply.status(201).send({ problemSet })
  })

  const displayNames = async (rows: Array<{ userId: string }>) => {
    const users = await prisma.user.findMany({
      where: { id: { in: rows.map((row) => row.userId) } },
      select: { id: true, displayName: true },
    })
    return Object.fromEntries(users.map((user) => [user.id, user.displayName]))
  }

  app.get('/problem-sets', async () => ({
    problemSets: await prisma.problemSet.findMany({
      select: { id: true, title: true, _count: { select: { problems: true } } },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
    }),
  }))

  app.get('/problem-sets/:id/leaderboard', async (request) => {
    const { id } = idParams.parse(request.params)
    const set = await prisma.problemSet.findUnique({
      where: { id },
      select: { problems: { select: { id: true } } },
    })
    if (!set) throw notFound('Problem set')
    const submissions = await prisma.submission.findMany({
      where: {
        problemId: { in: set.problems.map((problem) => problem.id) },
        isValidation: false,
        contestId: null,
      },
      select: { userId: true, problemId: true, verdict: true, createdAt: true },
    })
    const leaderboard = rankSubmissions(submissions, null)
    return { leaderboard, users: await displayNames(leaderboard) }
  })

  app.post('/rooms/:id/contests', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    await requireRoom(prisma, id, request.userId, 'room.update')
    const body = contestBody.parse(request.body)
    const contest = await prisma.contest.create({
      data: { ...body, roomId: id },
      select: { id: true, title: true, startsAt: true, endsAt: true, freezeMinutes: true },
    })
    return reply.status(201).send({ contest })
  })

  app.get('/contests', async (request) => ({
    contests: await prisma.contest.findMany({
      where: { room: { members: { some: { userId: request.userId } } } },
      orderBy: { startsAt: 'desc' },
      take: PAGE_SIZE,
    }),
  }))

  app.get('/contests/:id', async (request) => {
    const { id } = idParams.parse(request.params)
    const contest = await prisma.contest.findUnique({
      where: { id },
      include: {
        problemSet: { select: { problems: { select: { id: true, slug: true, title: true } } } },
      },
    })
    if (!contest) throw notFound('Contest')
    await requireRoom(prisma, contest.roomId, request.userId, 'file.read')
    return { contest }
  })

  app.get('/contests/:id/leaderboard', async (request) => {
    const { id } = idParams.parse(request.params)
    const contest = await prisma.contest.findUnique({ where: { id } })
    if (!contest) throw notFound('Contest')
    const { role } = await requireRoom(prisma, contest.roomId, request.userId, 'file.read')

    const now = new Date()
    const freezeAt = new Date(contest.endsAt.getTime() - contest.freezeMinutes * 60_000)
    const canSeeAll = role === 'owner' || (await isFaculty(prisma, request.userId))
    const frozen = now >= freezeAt && now < contest.endsAt && !canSeeAll
    const submissions = await prisma.submission.findMany({
      where: {
        contestId: id,
        // The window stops late results from entering after the contest ends.
        createdAt: { gte: contest.startsAt, lt: frozen ? freezeAt : contest.endsAt },
      },
      select: { userId: true, problemId: true, verdict: true, createdAt: true },
    })
    const leaderboard = rankSubmissions(submissions, contest.startsAt)
    return { frozen, leaderboard, users: await displayNames(leaderboard) }
  })

  app.post('/problems/:id/plagiarism', async (request) => {
    await requireFaculty(prisma, request.userId)
    const { id } = idParams.parse(request.params)
    const submissions = await prisma.submission.findMany({
      where: { problemId: id, isValidation: false },
      select: { id: true, userId: true, language: true, source: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_COMPARED_SUBMISSIONS,
    })
    // Each student's latest attempt per language, as earlier attempts resemble later ones.
    const latest = new Map<string, (typeof submissions)[number]>()
    for (const submission of submissions) {
      const key = `${submission.userId}:${submission.language}`
      if (!latest.has(key)) latest.set(key, submission)
    }
    const prints = [...latest.values()].map((submission) => ({
      ...submission,
      prints: fingerprint(tokenize(submission.source, submission.language)),
    }))

    const matches: Array<{
      problemId: string
      submissionAId: string
      submissionBId: string
      similarity: number
    }> = []
    for (let first = 0; first < prints.length; first++) {
      for (let second = first + 1; second < prints.length; second++) {
        const a = prints[first] as (typeof prints)[number]
        const b = prints[second] as (typeof prints)[number]
        if (a.userId === b.userId || a.language !== b.language) continue
        const score = similarity(a.prints, b.prints)
        if (score < PLAGIARISM_THRESHOLD) continue
        const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
        matches.push({
          problemId: id,
          submissionAId: low as string,
          submissionBId: high as string,
          similarity: score,
        })
      }
    }
    await prisma.$transaction([
      prisma.plagiarismMatch.deleteMany({ where: { problemId: id } }),
      prisma.plagiarismMatch.createMany({ data: matches }),
    ])
    return { compared: prints.length, matches: matches.length }
  })

  app.get('/problems/:id/plagiarism', async (request) => {
    await requireFaculty(prisma, request.userId)
    const { id } = idParams.parse(request.params)
    const matches = await prisma.plagiarismMatch.findMany({
      where: { problemId: id },
      orderBy: { similarity: 'desc' },
      select: {
        similarity: true,
        submissionA: { select: { id: true, userId: true } },
        submissionB: { select: { id: true, userId: true } },
      },
    })
    return {
      matches: matches.map((match) => ({
        similarityPercent: Math.round(match.similarity * 100),
        submissionA: match.submissionA,
        submissionB: match.submissionB,
      })),
    }
  })

  // Hidden tests leave the database only through this route, so they never sit in Redis.
  app.get('/internal/submissions/:id/package', internal, async (request) => {
    assertServiceToken(request, config.internalServiceToken)
    const { id } = idParams.parse(request.params)
    const claimed = await prisma.submission.updateMany({
      where: { id, verdict: { in: ['PENDING', 'JUDGING'] } },
      data: { verdict: 'JUDGING' },
    })
    if (claimed.count !== 1) return { proceed: false }

    const submission = await prisma.submission.findUniqueOrThrow({
      where: { id },
      select: {
        language: true,
        source: true,
        problem: {
          select: {
            limits: true,
            checkerKind: true,
            checkerSource: true,
            checkerLanguage: true,
            stopOnFirstFailure: true,
            testCases: {
              select: { ordinal: true, input: true, output: true },
              orderBy: { ordinal: 'asc' },
            },
          },
        },
      },
    })
    const { problem } = submission
    const limits = problem.limits as Partial<Record<string, typeof DEFAULT_LIMIT>>
    const limit = limits[submission.language] ?? DEFAULT_LIMIT
    return {
      proceed: true,
      package: {
        submission_id: id,
        language: submission.language,
        source: submission.source,
        time_limit_ms: limit.timeMs,
        memory_limit_mb: limit.memoryMb,
        checker_kind: problem.checkerKind,
        checker_source: problem.checkerSource,
        checker_language: problem.checkerLanguage,
        stop_on_first_failure: problem.stopOnFirstFailure,
        tests: problem.testCases.map((test) => ({
          ordinal: test.ordinal,
          input: Buffer.from(test.input).toString('base64'),
          output: Buffer.from(test.output).toString('base64'),
        })),
      },
    }
  })

  app.post('/internal/submissions/:id/result', internal, async (request) => {
    assertServiceToken(request, config.internalServiceToken)
    const { id } = idParams.parse(request.params)
    const result = judgeResultBody.parse(request.body)
    const updated = await prisma.submission.updateMany({
      where: { id, verdict: { in: ['PENDING', 'JUDGING'] } },
      data: {
        verdict: result.verdict,
        failedOrdinal: result.failed_ordinal,
        timeMs: result.time_ms,
        memoryKb: result.memory_kb,
        compileOutput: result.compile_output.replaceAll('\u0000', '�'),
        results: result.results,
        judgedAt: new Date(),
      },
    })
    return { recorded: updated.count === 1 }
  })
}

export async function failSubmission(prisma: PrismaClient, submissionId: string): Promise<void> {
  await prisma.submission.updateMany({
    where: { id: submissionId, verdict: { in: ['PENDING', 'JUDGING'] } },
    data: { verdict: 'INTERNAL_ERROR', judgedAt: new Date() },
  })
}
