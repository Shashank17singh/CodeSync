import { EXECUTION_LIMITS } from '@codesync/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { failExecution } from '../src/modules/executions.js'
import { CollabBridge } from '../src/collab/bridge.js'
import { MemoryRateLimiter } from '../src/modules/auth/rateLimit.js'
import pino from 'pino'
import {
  as,
  config,
  createRoomFixture,
  createTestApi,
  createUser,
  type RoomFixture,
  type TestApi,
} from './helpers.js'

const RESULT = {
  status: 'OK',
  exit_code: 0,
  stdout: 'hello\n',
  stderr: '',
  compile_output: '',
  time_ms: 12,
  memory_kb: 4096,
  message: null,
}

describe('executions', () => {
  let api: TestApi
  let fixture: RoomFixture

  beforeAll(async () => {
    const limiter = new MemoryRateLimiter()
    limiter.hit = async () => ({ allowed: true, retryAfterMs: 0 })
    api = await createTestApi(undefined, { limiter })
  })
  afterAll(() => api.close())

  const start = (payload: object = {}, user = fixture.editor) =>
    api.app.inject(
      as(user, {
        method: 'POST',
        url: `/rooms/${fixture.roomId}/executions`,
        payload: { projectId: fixture.projectId, entryPath: 'main.py', ...payload },
      }),
    )

  const queued = async (): Promise<string> => {
    const response = await start()
    expect(response.statusCode).toBe(202)
    return response.json<{ execution: { id: string } }>().execution.id
  }

  const internal = (path: string, payload: object, token = config.internalServiceToken) =>
    api.app.inject({
      method: 'POST',
      url: `/api/v1/internal/executions/${path}`,
      headers: { 'x-service-token': token },
      payload,
    })

  const claim = async (id: string, worker = 'worker-1'): Promise<boolean> =>
    (await internal(`${id}/started`, { worker_id: worker })).json<{ proceed: boolean }>().proceed

  const row = (id: string) => api.prisma.execution.findUniqueOrThrow({ where: { id } })

  describe('starting a run', () => {
    it('queues the code as it is now, under the execution id', async () => {
      fixture = await createRoomFixture(api)
      const response = await start({ stdin: 'input\n' })
      expect(response.statusCode).toBe(202)
      const { execution } = response.json<{ execution: { id: string; status: string } }>()
      expect(execution.status).toBe('QUEUED')

      const job = api.queue.jobs.at(-1)
      expect(job).toMatchObject({
        execution_id: execution.id,
        room_id: fixture.roomId,
        user_id: fixture.editor,
        language: 'PYTHON',
        entry_path: 'main.py',
        stdin: 'input\n',
      })
      expect(job?.files).toEqual([
        { path: 'main.py', content: 'print("Hello, CodeSync!")\n' },
      ])
    })

    it.each([
      ['main.cpp', 'CPP'],
      ['a.cc', 'CPP'],
      ['Main.java', 'JAVA'],
      ['app.js', 'JAVASCRIPT'],
    ])('detects the language of %s', async (path, language) => {
      fixture = await createRoomFixture(api)
      await api.app.inject(
        as(fixture.owner, {
          method: 'POST',
          url: `/projects/${fixture.projectId}/files`,
          payload: { path },
        }),
      )
      expect((await start({ entryPath: path })).statusCode).toBe(202)
      expect(api.queue.jobs.at(-1)?.language).toBe(language)
    })

    it('refuses a file type it cannot run', async () => {
      fixture = await createRoomFixture(api)
      const response = await start({ entryPath: 'notes.txt' })
      expect(response.json().error.code).toBe('unsupported_language')
    })

    it('refuses an entry that does not exist', async () => {
      fixture = await createRoomFixture(api)
      expect((await start({ entryPath: 'missing.py' })).statusCode).toBe(404)
    })

    it('refuses a traversal path', async () => {
      fixture = await createRoomFixture(api)
      expect((await start({ entryPath: '../evil.py' })).statusCode).toBe(422)
    })

    it('refuses a project from another room', async () => {
      fixture = await createRoomFixture(api)
      const other = await createRoomFixture(api)
      expect((await start({ projectId: other.projectId })).statusCode).toBe(404)
    })

    it('refuses a project too large to queue', async () => {
      fixture = await createRoomFixture(api)
      for (const name of ['a', 'b', 'c']) {
        await api.app.inject(
          as(fixture.owner, {
            method: 'POST',
            url: `/projects/${fixture.projectId}/files`,
            payload: { path: `${name}.txt`, content: 'x'.repeat(800_000) },
          }),
        )
      }
      const response = await start()
      expect(response.statusCode).toBe(413)
      expect(response.json().error.code).toBe('project_too_large')
    })

    it('refuses new runs when the queue is full, with a clear message', async () => {
      fixture = await createRoomFixture(api)
      api.queue.waiting = EXECUTION_LIMITS.maxWaitingRuns
      const response = await start()
      api.queue.waiting = null
      expect(response.statusCode).toBe(503)
      expect(response.json().error.code).toBe('queue_full')
      expect(response.headers['retry-after']).toBe('60')
    })

    it('marks the run failed when the queue is down, not stuck forever', async () => {
      fixture = await createRoomFixture(api)
      api.queue.failure = new Error('redis down')
      const response = await start()
      api.queue.failure = null
      expect(response.statusCode).toBe(503)
      const stored = await api.prisma.execution.findFirstOrThrow({
        where: { roomId: fixture.roomId },
      })
      expect(stored.status).toBe('INTERNAL_ERROR')
    })
  })

  describe('reading results', () => {
    it('shows a run to everyone in the room but nobody outside it', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      const read = (user: string) =>
        api.app.inject(as(user, { method: 'GET', url: `/executions/${id}` }))
      expect((await read(fixture.viewer)).statusCode).toBe(200)
      expect((await read(fixture.outsider)).statusCode).toBe(404)
    })

    it('lists the room history, newest first, without stdin', async () => {
      fixture = await createRoomFixture(api)
      const first = await queued()
      const second = await queued()
      const response = await api.app.inject(
        as(fixture.viewer, { method: 'GET', url: `/rooms/${fixture.roomId}/executions` }),
      )
      const { executions } = response.json<{ executions: Array<{ id: string }> }>()
      expect(executions.map((item) => item.id)).toEqual([second, first])
      expect(executions[0]).not.toHaveProperty('stdin')
    })
  })

  describe('worker reports', () => {
    it('records a claim and then a result', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      expect(await claim(id)).toBe(true)
      expect(await row(id)).toMatchObject({ status: 'RUNNING', workerId: 'worker-1', attempts: 1 })

      const response = await internal(`${id}/result`, RESULT)
      expect(response.json()).toEqual({ recorded: true })
      expect(await row(id)).toMatchObject({
        status: 'OK',
        stdout: 'hello\n',
        exitCode: 0,
        timeMs: 12,
        memoryKb: 4096,
      })
    })

    it('stores compile output', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      await internal(`${id}/result`, {
        ...RESULT,
        status: 'COMPILE_ERROR',
        compile_output: 'error: expected ;',
      })
      expect((await row(id)).compileOutput).toBe('error: expected ;')
    })

    it('survives a program that prints a NUL byte', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      const response = await internal(`${id}/result`, { ...RESULT, stdout: 'a\u0000b' })
      expect(response.statusCode).toBe(200)
      expect((await row(id)).stdout).toBe('a�b')
    })

    it.each([
      ['missing', {}],
      ['wrong', { 'x-service-token': 'guessed' }],
    ])('refuses a %s service token', async (_name, headers) => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      const response = await api.app.inject({
        method: 'POST',
        url: `/api/v1/internal/executions/${id}/result`,
        headers,
        payload: RESULT,
      })
      expect(response.statusCode).toBe(403)
      expect((await row(id)).status).toBe('QUEUED')
    })

    it('refuses a user access token on internal routes', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      const response = await api.app.inject(
        as(fixture.owner, {
          method: 'POST',
          url: `/internal/executions/${id}/result`,
          payload: RESULT,
        }),
      )
      expect(response.statusCode).toBe(403)
    })
  })

  describe('crashed workers', () => {
    it('lets a second worker take over a run whose worker died', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      expect(await claim(id, 'crashed')).toBe(true)
      expect(await claim(id, 'replacement')).toBe(true)
      expect(await row(id)).toMatchObject({ workerId: 'replacement', attempts: 2 })
    })

    it('retries only once, then fails the run and tells the room', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      await claim(id, 'first')
      await claim(id, 'second')
      const before = api.transport.published.length

      expect(await claim(id, 'third')).toBe(false)

      expect(await row(id)).toMatchObject({ status: 'INTERNAL_ERROR', attempts: 2 })
      const event = api.transport.published.slice(before).find(({ channel }) => {
        return channel === `room:${fixture.roomId}:events`
      })
      expect(event).toBeDefined()
      expect(Buffer.from((event as { payload: Uint8Array }).payload).toString()).toContain(
        'exec.finished',
      )
    })

    it('does not repeat a run that finished before its worker died', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      await claim(id)
      await internal(`${id}/result`, RESULT)
      expect(await claim(id, 'redelivered')).toBe(false)
      expect((await row(id)).status).toBe('OK')
    })

    it('lets only one of two workers claim a fresh run per attempt', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      const claims = await Promise.all([claim(id, 'a'), claim(id, 'b'), claim(id, 'c')])
      expect(claims.filter(Boolean).length).toBeLessThanOrEqual(EXECUTION_LIMITS.maxAttempts)
      expect((await row(id)).attempts).toBe(EXECUTION_LIMITS.maxAttempts)
    })

    it('keeps the first result when a stale worker reports late', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      await internal(`${id}/result`, RESULT)
      const late = await internal(`${id}/result`, { ...RESULT, stdout: 'stale' })
      expect(late.json()).toEqual({ recorded: false })
      expect((await row(id)).stdout).toBe('hello\n')
    })

    it('does not overwrite a finished run when BullMQ reports failure', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      await internal(`${id}/result`, RESULT)
      await failExecution(api.prisma, new CollabBridge(api.transport, pino({ level: 'silent' })), id)
      expect((await row(id)).status).toBe('OK')
    })

    it('fails a run BullMQ gave up on', async () => {
      fixture = await createRoomFixture(api)
      const id = await queued()
      await failExecution(api.prisma, new CollabBridge(api.transport, pino({ level: 'silent' })), id)
      expect((await row(id)).status).toBe('INTERNAL_ERROR')
    })
  })
})

describe('run rate limits', () => {
  let api: TestApi

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  const run = (fixture: RoomFixture, user: string) =>
    api.app.inject(
      as(user, {
        method: 'POST',
        url: `/rooms/${fixture.roomId}/executions`,
        payload: { projectId: fixture.projectId, entryPath: 'main.py' },
      }),
    )

  it('allows 10 runs a minute per user, with a clear message', async () => {
    const fixture = await createRoomFixture(api)
    for (let index = 0; index < EXECUTION_LIMITS.runsPerUserPerMinute; index++) {
      expect((await run(fixture, fixture.editor)).statusCode).toBe(202)
    }
    const response = await run(fixture, fixture.editor)
    expect(response.statusCode).toBe(429)
    expect(response.json().error.message).toContain('10 programs a minute')
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0)
    expect((await run(fixture, fixture.owner)).statusCode).toBe(202)
  })

  it('limits a whole room, however many people are in it', async () => {
    const fixture = await createRoomFixture(api)
    let accepted = 0
    for (let round = 0; round < 12; round++) {
      for (const user of [fixture.owner, fixture.editor]) {
        if ((await run(fixture, user)).statusCode === 202) accepted += 1
      }
    }
    expect(accepted).toBe(EXECUTION_LIMITS.runsPerUserPerMinute * 2)

    const members = await Promise.all(
      Array.from({ length: 15 }, () => createUser(api.prisma)),
    )
    await api.prisma.roomMember.createMany({
      data: members.map((userId) => ({ roomId: fixture.roomId, userId, role: 'EDITOR' })),
    })
    for (const id of members) await run(fixture, id)
    const rows = await api.prisma.execution.count({ where: { roomId: fixture.roomId } })
    expect(rows).toBe(EXECUTION_LIMITS.runsPerRoomPerMinute)
  })

  it('queues nothing for a refused run', async () => {
    const fixture = await createRoomFixture(api)
    for (let index = 0; index < EXECUTION_LIMITS.runsPerUserPerMinute + 3; index++) {
      await run(fixture, fixture.editor)
    }
    const rows = await api.prisma.execution.count({ where: { roomId: fixture.roomId } })
    expect(rows).toBe(EXECUTION_LIMITS.runsPerUserPerMinute)
  })
})
