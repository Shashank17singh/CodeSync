import { collabKeys } from '@codesync/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { as, createRoomFixture, createTestApi, type RoomFixture, type TestApi } from './helpers.js'

describe('tree lock', () => {
  let api: TestApi
  let fixture: RoomFixture

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  const createFile = (path: string) =>
    api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/projects/${fixture.projectId}/files`,
        payload: { path, content: 'x' },
      }),
    )

  const fileExists = async (path: string): Promise<boolean> =>
    (await api.prisma.file.count({ where: { projectId: fixture.projectId, path } })) === 1

  it('waits for the lock before writing content or the file row', async () => {
    fixture = await createRoomFixture(api)
    const lock = collabKeys.treeLock(fixture.projectId)
    const logBefore = api.transport.logs.get(fixture.projectId)?.length
    api.transport.locks.add(lock)

    let settled = false
    const request = createFile('waiting.py').then((response) => {
      settled = true
      return response
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(settled).toBe(false)
    expect(await fileExists('waiting.py')).toBe(false)
    expect(api.transport.logs.get(fixture.projectId)?.length).toBe(logBefore)

    api.transport.locks.delete(lock)
    expect((await request).statusCode).toBe(201)
    expect(await fileExists('waiting.py')).toBe(true)
  })

  it('answers 503 and changes nothing when the lock never frees', async () => {
    fixture = await createRoomFixture(api)
    const lock = collabKeys.treeLock(fixture.projectId)
    api.transport.locks.add(lock)
    const response = await createFile('stuck.py')
    api.transport.locks.delete(lock)
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('project_busy')
    expect(await fileExists('stuck.py')).toBe(false)
  })

  it('holds the lock until the file row is committed', async () => {
    fixture = await createRoomFixture(api)
    const lock = collabKeys.treeLock(fixture.projectId)
    let heldDuringCommit = false
    const createMany = api.prisma.file.createMany.bind(api.prisma.file)
    const spy = async (args: Parameters<typeof createMany>[0]) => {
      heldDuringCommit = api.transport.locks.has(lock)
      return createMany(args)
    }
    Object.defineProperty(api.prisma.file, 'createMany', { value: spy, configurable: true })
    try {
      expect((await createFile('committed.py')).statusCode).toBe(201)
    } finally {
      Object.defineProperty(api.prisma.file, 'createMany', {
        value: createMany,
        configurable: true,
      })
    }
    expect(heldDuringCommit).toBe(true)
    expect(api.transport.locks.has(lock)).toBe(false)
  })
})
