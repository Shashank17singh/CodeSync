import { REVIEW_LIMITS } from '@codesync/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { selectLines } from '../src/modules/reviews.js'
import { as, config, createRoomFixture, createTestApi, createUser, type TestApi } from './helpers.js'

const RESULT = {
  status: 'DONE',
  issues: [
    {
      line_start: 1,
      line_end: 1,
      severity: 'error',
      category: 'bug',
      message: 'Problem here',
      suggested_fix: 'print(2)',
    },
  ],
  explanation: 'Summary',
  complexity: [{ function: 'f', line: 1, cyclomatic: 2 }],
  model: 'claude-opus-5-5',
}

describe('reviews', () => {
  let api: TestApi

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  // Unique code, because identical code is answered from the cache.
  const fileReview = async (user?: string) => {
    const fixture = await createRoomFixture(api)
    const created = await api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/projects/${fixture.projectId}/files`,
        payload: { path: 'code.py', content: `print("${crypto.randomUUID()}")\n` },
      }),
    )
    const response = await api.app.inject(
      as(user ?? fixture.editor, {
        method: 'POST',
        url: '/reviews',
        payload: {
          language: 'PYTHON',
          roomId: fixture.roomId,
          projectId: fixture.projectId,
          fileId: created.json().file.id,
        },
      }),
    )
    return { fixture, response, fileId: created.json().file.id as string }
  }

  const finish = (id: string, token = config.internalServiceToken) =>
    api.app.inject({
      method: 'POST',
      url: `/api/v1/internal/reviews/${id}/result`,
      headers: { 'x-service-token': token },
      payload: RESULT,
    })

  const practiceProblem = async (): Promise<string> => {
    const owner = await createUser(api.prisma)
    const problem = await api.prisma.problem.create({
      data: {
        slug: crypto.randomUUID(),
        title: 'P',
        difficulty: 'EASY',
        statementMd: '',
        inputFormat: '',
        outputFormat: '',
        constraints: '',
        limits: {},
        starterCode: {},
        createdById: owner,
        publishedAt: new Date(),
      },
    })
    return problem.id
  }

  it('reads the file on the server and queues it', async () => {
    const { response } = await fileReview()
    expect(response.statusCode).toBe(202)
    expect(api.queue.reviewJobs.at(-1)).toMatchObject({
      mode: 'REVIEW',
      language: 'PYTHON',
      practice: false,
    })
    expect(api.queue.reviewJobs.at(-1)?.code).toMatch(/^print\("/)
  })

  it('refuses a file the user cannot read', async () => {
    const stranger = await createUser(api.prisma)
    const { response } = await fileReview(stranger)
    expect(response.statusCode).toBe(404)
  })

  it('reviews only the selected lines', async () => {
    const fixture = await createRoomFixture(api)
    await api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/projects/${fixture.projectId}/files`,
        payload: { path: 'many.py', content: 'a\nb\nc\nd\n' },
      }),
    )
    const file = await api.prisma.file.findFirstOrThrow({
      where: { projectId: fixture.projectId, path: 'many.py' },
    })
    await api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: '/reviews',
        payload: {
          language: 'PYTHON',
          roomId: fixture.roomId,
          projectId: fixture.projectId,
          fileId: file.id,
          lineStart: 2,
          lineEnd: 3,
        },
      }),
    )
    expect(api.queue.reviewJobs.at(-1)?.code).toBe('b\nc')
  })

  it('refuses more than 400 lines', async () => {
    const problemId = await practiceProblem()
    const user = await createUser(api.prisma)
    const response = await api.app.inject(
      as(user, {
        method: 'POST',
        url: '/reviews',
        payload: { language: 'PYTHON', problemId, code: 'x\n'.repeat(REVIEW_LIMITS.maxLines) },
      }),
    )
    expect(response.json().error.code).toBe('too_many_lines')
  })

  it('marks practice code, which makes the worker give hints only', async () => {
    const problemId = await practiceProblem()
    const user = await createUser(api.prisma)
    await api.app.inject(
      as(user, {
        method: 'POST',
        url: '/reviews',
        payload: { language: 'PYTHON', problemId, code: 'print(1)' },
      }),
    )
    expect(api.queue.reviewJobs.at(-1)?.practice).toBe(true)
  })

  it('answers repeat code from the cache without using quota', async () => {
    const first = await fileReview()
    const { review } = first.response.json()
    expect((await finish(review.id)).json()).toEqual({ recorded: true })
    const user = await createUser(api.prisma)
    await api.prisma.roomMember.create({
      data: { roomId: first.fixture.roomId, userId: user, role: 'VIEWER' },
    })
    const jobs = api.queue.reviewJobs.length

    const second = await api.app.inject(
      as(user, {
        method: 'POST',
        url: '/reviews',
        payload: {
          language: 'PYTHON',
          roomId: first.fixture.roomId,
          projectId: first.fixture.projectId,
          fileId: first.fileId,
        },
      }),
    )
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ cached: true, review: { id: review.id } })
    expect(api.queue.reviewJobs.length).toBe(jobs)
  })

  it('never serves a full review to a practice request', async () => {
    const code = `# ${crypto.randomUUID()}\nprint(1)\n`
    const owner = await createUser(api.prisma)
    const fixture = await createRoomFixture(api)
    const made = await api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/projects/${fixture.projectId}/files`,
        payload: { path: 'same.py', content: code },
      }),
    )
    const full = await api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: '/reviews',
        payload: {
          language: 'PYTHON',
          roomId: fixture.roomId,
          projectId: fixture.projectId,
          fileId: made.json().file.id,
        },
      }),
    )
    await finish(full.json().review.id)

    const problemId = await practiceProblem()
    const practice = await api.app.inject(
      as(owner, {
        method: 'POST',
        url: '/reviews',
        payload: { language: 'PYTHON', problemId, code },
      }),
    )
    expect(practice.json().cached).toBe(false)
  })

  it('enforces the daily quota with a clear message', async () => {
    const problemId = await practiceProblem()
    const user = await createUser(api.prisma)
    const send = (index: number) =>
      api.app.inject(
        as(user, {
          method: 'POST',
          url: '/reviews',
          payload: { language: 'PYTHON', problemId, code: `print(${index})` },
        }),
      )
    for (let index = 0; index < REVIEW_LIMITS.perUserPerDay; index++) {
      expect((await send(index)).statusCode).toBe(202)
    }
    const refused = await send(9999)
    expect(refused.statusCode).toBe(429)
    expect(refused.json().error.message).toContain('reviews')

    const quota = await api.app.inject(as(user, { method: 'GET', url: '/reviews/quota' }))
    expect(quota.json().used).toBeGreaterThanOrEqual(REVIEW_LIMITS.perUserPerDay)
  })

  it('stores the result and shows it only to its author', async () => {
    const { fixture, response } = await fileReview()
    const { id } = response.json().review
    expect((await finish(id)).json()).toEqual({ recorded: true })

    const read = (user: string) =>
      api.app.inject(as(user, { method: 'GET', url: `/reviews/${id}` }))
    expect((await read(fixture.editor)).json().review).toMatchObject({
      status: 'DONE',
      explanation: 'Summary',
      model: 'claude-opus-5-5',
    })
    expect((await read(fixture.owner)).statusCode).toBe(403)
  })

  it('refuses a result without the service token', async () => {
    const { response } = await fileReview()
    const refused = await finish(response.json().review.id, 'guessed')
    expect(refused.statusCode).toBe(403)
  })

  it('marks the review failed when the queue is down', async () => {
    api.queue.failure = new Error('redis down')
    const { fixture, response } = await fileReview()
    api.queue.failure = null
    expect(response.statusCode).toBe(503)
    const rows = await api.prisma.review.findMany({ where: { roomId: fixture.roomId } })
    expect(rows[0]?.status).toBe('FAILED')
  })
})

describe('selectLines', () => {
  it('returns everything without a range', () => {
    expect(selectLines('a\nb')).toBe('a\nb')
  })

  it('selects an inclusive range', () => {
    expect(selectLines('a\nb\nc\nd', 2, 3)).toBe('b\nc')
  })

  it('refuses a range outside the file', () => {
    expect(() => selectLines('a', 5, 6)).toThrow()
    expect(() => selectLines('a\nb', 2, 1)).toThrow()
  })
})
