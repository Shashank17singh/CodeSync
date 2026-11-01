import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { as, createRoomFixture, createTestApi, createUser, type TestApi } from './helpers.js'

describe('with code execution turned off', () => {
  let api: TestApi

  beforeAll(async () => {
    api = await createTestApi(undefined, { executionEnabled: false })
  })
  afterAll(() => api.close())

  const expectDisabled = (response: { statusCode: number; json: () => unknown }): void => {
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'execution_disabled' } })
  }

  it('refuses a run and queues nothing', async () => {
    const fixture = await createRoomFixture(api)
    const response = await api.app.inject(
      as(fixture.editor, {
        method: 'POST',
        url: `/rooms/${fixture.roomId}/executions`,
        payload: { projectId: fixture.projectId, entryPath: 'main.py' },
      }),
    )
    expectDisabled(response)
    expect(api.queue.jobs).toEqual([])
    expect(await api.prisma.execution.count({ where: { roomId: fixture.roomId } })).toBe(0)
  })

  it('still checks permission first, so a viewer learns nothing new', async () => {
    const fixture = await createRoomFixture(api)
    const response = await api.app.inject(
      as(fixture.viewer, {
        method: 'POST',
        url: `/rooms/${fixture.roomId}/executions`,
        payload: { projectId: fixture.projectId, entryPath: 'main.py' },
      }),
    )
    expect(response.statusCode).toBe(403)
  })

  it('refuses a practice submission and stores nothing', async () => {
    const author = await createUser(api.prisma)
    const problem = await api.prisma.problem.create({
      data: {
        slug: `switch-${author}`,
        title: 'Switch',
        difficulty: 'EASY',
        statementMd: 's',
        inputFormat: 'i',
        outputFormat: 'o',
        constraints: 'c',
        limits: {},
        starterCode: {},
        publishedAt: new Date(),
        createdById: author,
        testCases: { create: { ordinal: 1, input: Buffer.from('1'), output: Buffer.from('1') } },
      },
    })
    const response = await api.app.inject(
      as(author, {
        method: 'POST',
        url: `/problems/${problem.slug}/submissions`,
        payload: { language: 'PYTHON', source: 'print(1)' },
      }),
    )
    expectDisabled(response)
    expect(await api.prisma.submission.count({ where: { problemId: problem.id } })).toBe(0)
  })

  it('refuses a review without using up the daily quota', async () => {
    const fixture = await createRoomFixture(api)
    const review = () =>
      api.app.inject(
        as(fixture.editor, {
          method: 'POST',
          url: '/reviews',
          payload: {
            language: 'PYTHON',
            roomId: fixture.roomId,
            projectId: fixture.projectId,
            fileId: fixture.fileId,
          },
        }),
      )
    expectDisabled(await review())
    const quota = await api.app.inject(as(fixture.editor, { method: 'GET', url: '/reviews/quota' }))
    expect(quota.json()).toMatchObject({ used: 0 })
  })
})
