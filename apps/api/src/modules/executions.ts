import { createHash, timingSafeEqual } from 'node:crypto'
import { captureSnapshot, type PrismaClient } from '@codesync/db'
import { EXECUTION_LIMITS } from '@codesync/shared'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AppDeps } from '../app.js'
import type { CollabBridge } from '../collab/bridge.js'
import { ApiError, assertExecutionEnabled, forbidden, invalid, notFound } from '../lib/errors.js'
import { validateProjectPath } from '../lib/paths.js'
import type { RunJob } from '../queue/executionQueue.js'
import { requireRoom } from './access.js'
import { MINUTE, enforceRateLimits } from './auth/rateLimit.js'

const HISTORY_LIMIT = 50
const CRASHED_MESSAGE = 'The run could not be completed. Try again.'

const LANGUAGE_BY_EXTENSION: Record<string, RunJob['language']> = {
  py: 'PYTHON',
  cpp: 'CPP',
  cc: 'CPP',
  java: 'JAVA',
  js: 'JAVASCRIPT',
  mjs: 'JAVASCRIPT',
}

const roomParams = z.object({ id: z.uuid() })
const executionParams = z.object({ id: z.uuid() })
const createBody = z.object({
  projectId: z.uuid(),
  entryPath: z.string().min(1).max(1024),
  stdin: z.string().max(EXECUTION_LIMITS.maxStdinChars).default(''),
})

const startedBody = z.object({ worker_id: z.string().min(1).max(120) })

const resultBody = z.object({
  status: z.enum([
    'OK',
    'COMPILE_ERROR',
    'RUNTIME_ERROR',
    'TIME_LIMIT_EXCEEDED',
    'MEMORY_LIMIT_EXCEEDED',
    'OUTPUT_LIMIT_EXCEEDED',
    'INTERNAL_ERROR',
  ]),
  exit_code: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  compile_output: z.string(),
  time_ms: z.number().int().nonnegative().nullable(),
  memory_kb: z.number().int().nonnegative().nullable(),
  message: z.string().max(500).nullable(),
})

const PUBLIC_FIELDS = {
  id: true,
  roomId: true,
  projectId: true,
  userId: true,
  language: true,
  entryPath: true,
  status: true,
  stdout: true,
  stderr: true,
  compileOutput: true,
  message: true,
  exitCode: true,
  timeMs: true,
  memoryKb: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
} as const

// A program can print any byte, and PostgreSQL text columns cannot hold NUL.
const storable = (text: string): string => text.replaceAll('\u0000', '�')

function detectLanguage(path: string): RunJob['language'] {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  const language = LANGUAGE_BY_EXTENSION[extension]
  if (!language) throw invalid('unsupported_language', 'This file type cannot be run')
  return language
}

export function assertServiceToken(request: FastifyRequest, expected: string): void {
  const received = request.headers['x-service-token']
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
  if (typeof received !== 'string' || !timingSafeEqual(digest(received), digest(expected))) {
    throw forbidden('Request refused')
  }
}

// Used when no worker can report: a job that kept crashing, or a queue that refused it. Only an
// unfinished run changes, so a late failure cannot overwrite a real result.
export async function failExecution(
  prisma: PrismaClient,
  bridge: CollabBridge,
  executionId: string,
): Promise<void> {
  const finishedAt = new Date()
  const updated = await prisma.execution.updateMany({
    where: { id: executionId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'INTERNAL_ERROR', message: CRASHED_MESSAGE, finishedAt },
  })
  if (updated.count !== 1) return
  const { roomId } = await prisma.execution.findUniqueOrThrow({
    where: { id: executionId },
    select: { roomId: true },
  })
  await bridge.publishRoomEvent(roomId, {
    type: 'exec.finished',
    executionId,
    status: 'INTERNAL_ERROR',
    exitCode: null,
    timeMs: null,
    memoryKb: null,
  })
}

export function registerExecutionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { prisma, bridge, limiter, queue, config, logger } = deps
  const internal = { config: { public: true } }

  app.post('/rooms/:id/executions', async (request, reply) => {
    const { id: roomId } = roomParams.parse(request.params)
    await requireRoom(prisma, roomId, request.userId, 'execution.run')
    assertExecutionEnabled(config)
    const body = createBody.parse(request.body)
    const entryPath = validateProjectPath(body.entryPath)
    const language = detectLanguage(entryPath)

    const project = await prisma.project.findFirst({
      where: { id: body.projectId, roomId },
      select: { files: { where: { kind: 'FILE' }, select: { id: true, path: true } } },
    })
    if (!project) throw notFound('Project')
    if (!project.files.some((file) => file.path === entryPath)) throw notFound('File')

    // Checked in order, so attempts refused for one user do not use up the room's budget.
    // Otherwise a single person hammering Run could lock everyone else in the room out.
    await enforceRateLimits(
      limiter,
      [
        {
          key: `rate:run:user:${request.userId}`,
          limit: EXECUTION_LIMITS.runsPerUserPerMinute,
          windowMs: MINUTE,
        },
      ],
      `You can run ${EXECUTION_LIMITS.runsPerUserPerMinute} programs a minute. Wait a moment and ` +
        'try again.',
    )
    await enforceRateLimits(
      limiter,
      [
        {
          key: `rate:run:room:${roomId}`,
          limit: EXECUTION_LIMITS.runsPerRoomPerMinute,
          windowMs: MINUTE,
        },
      ],
      `This room has reached its limit of ${EXECUTION_LIMITS.runsPerRoomPerMinute} runs a ` +
        'minute. Wait a moment and try again.',
    )

    if ((await queue.waitingCount()) >= EXECUTION_LIMITS.maxWaitingRuns) {
      throw new ApiError(503, 'queue_full', 'The servers are busy. Try again in a minute.', {
        'retry-after': '60',
      })
    }

    // Taken now, so the run uses the code as it was when the button was pressed.
    const contents = await bridge.readFiles(body.projectId)
    const files = project.files.map(({ id, path }) => ({
      path,
      content: contents.get(id) ?? '',
    }))
    const payloadBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0)
    if (payloadBytes > EXECUTION_LIMITS.maxPayloadBytes) {
      throw new ApiError(413, 'project_too_large', 'This project is too large to run')
    }

    const execution = await prisma.execution.create({
      data: {
        roomId,
        projectId: body.projectId,
        userId: request.userId,
        language,
        entryPath,
        stdin: storable(body.stdin),
      },
      select: { id: true, status: true, queuedAt: true },
    })
    try {
      await queue.enqueueRun({
        execution_id: execution.id,
        room_id: roomId,
        user_id: request.userId,
        language,
        entry_path: entryPath,
        files,
        stdin: body.stdin,
      })
    } catch (error) {
      logger.error({ err: error, executionId: execution.id }, 'failed to enqueue a run')
      await failExecution(prisma, bridge, execution.id)
      throw new ApiError(503, 'queue_unavailable', 'Runs are unavailable. Try again in a moment.')
    }
    return reply.status(202).send({ execution })
  })

  app.get('/rooms/:id/executions', async (request) => {
    const { id: roomId } = roomParams.parse(request.params)
    await requireRoom(prisma, roomId, request.userId, 'file.read')
    const executions = await prisma.execution.findMany({
      where: { roomId },
      select: PUBLIC_FIELDS,
      orderBy: { queuedAt: 'desc' },
      take: HISTORY_LIMIT,
    })
    return { executions }
  })

  app.get('/executions/:id', async (request) => {
    const { id } = executionParams.parse(request.params)
    const execution = await prisma.execution.findUnique({
      where: { id },
      select: PUBLIC_FIELDS,
    })
    if (!execution) throw notFound('Run')
    try {
      await requireRoom(prisma, execution.roomId, request.userId, 'file.read')
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 403) throw notFound('Run')
      throw error
    }
    return { execution }
  })

  // Answers whether the worker should go ahead. This is what limits a crashed job to one retry,
  // and it stops a retry repeating a run that had finished before its worker died.
  app.post('/internal/executions/:id/started', internal, async (request) => {
    assertServiceToken(request, config.internalServiceToken)
    const { id } = executionParams.parse(request.params)
    const { worker_id: workerId } = startedBody.parse(request.body)

    const claimed = await prisma.execution.updateMany({
      where: {
        id,
        status: { in: ['QUEUED', 'RUNNING'] },
        attempts: { lt: EXECUTION_LIMITS.maxAttempts },
      },
      data: {
        status: 'RUNNING',
        workerId,
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    })
    if (claimed.count === 1) return { proceed: true }

    // Unfinished with no attempts left: this run has now crashed a worker twice.
    await failExecution(prisma, bridge, id)
    return { proceed: false }
  })

  app.post('/internal/executions/:id/result', internal, async (request) => {
    assertServiceToken(request, config.internalServiceToken)
    const { id } = executionParams.parse(request.params)
    const result = resultBody.parse(request.body)

    // Conditional, so a stale worker returning late cannot overwrite the recorded result.
    const updated = await prisma.execution.updateMany({
      where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: result.status,
        exitCode: result.exit_code,
        stdout: storable(result.stdout),
        stderr: storable(result.stderr),
        compileOutput: storable(result.compile_output),
        timeMs: result.time_ms,
        memoryKb: result.memory_kb,
        message: result.message,
        finishedAt: new Date(),
      },
    })
    if (updated.count === 1 && result.status === 'OK') {
      // History is a side effect here, so a failure must not make the worker report again.
      try {
        const { projectId, userId } = await prisma.execution.findUniqueOrThrow({
          where: { id },
          select: { projectId: true, userId: true },
        })
        const state = await bridge.encodeState(projectId)
        await captureSnapshot(prisma, { projectId, kind: 'RUN', state, createdById: userId })
      } catch (error) {
        request.log.error({ err: error, executionId: id }, 'failed to snapshot a run')
      }
    }
    return { recorded: updated.count === 1 }
  })
}
