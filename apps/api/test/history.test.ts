import { captureSnapshot, pruneSnapshots } from '@codesync/db'
import { collabKeys } from '@codesync/shared'
import { unzipSync, strFromU8 } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  as,
  config,
  createRoomFixture,
  createTestApi,
  type RoomFixture,
  type TestApi,
} from './helpers.js'
import { CollabBridge } from '../src/collab/bridge.js'
import { blameLines, toRanges } from '../src/lib/history.js'
import * as Y from 'yjs'
import pino from 'pino'

const DAY_MS = 24 * 60 * 60 * 1000

describe('version history', () => {
  let api: TestApi
  let bridge: CollabBridge
  let fixture: RoomFixture

  beforeAll(async () => {
    api = await createTestApi()
    bridge = new CollabBridge(api.transport, pino({ level: 'silent' }))
  })
  afterAll(() => api.close())

  const write = (fileId: string, content: string, projectId = fixture.projectId) =>
    bridge.writeFiles(projectId, [{ id: fileId, content }])

  const read = async (fileId = fixture.fileId) =>
    (await bridge.readFiles(fixture.projectId)).get(fileId)

  const checkpoint = async (label = 'before refactor', user = fixture.editor) => {
    const response = await api.app.inject(
      as(user, {
        method: 'POST',
        url: `/projects/${fixture.projectId}/snapshots`,
        payload: { label },
      }),
    )
    expect(response.statusCode).toBe(201)
    return response.json<{ snapshot: { id: string } }>().snapshot.id
  }

  const restore = (snapshotId: string, payload?: object, user = fixture.editor) =>
    api.app.inject(
      as(user, {
        method: 'POST',
        url: `/snapshots/${snapshotId}/restore`,
        ...(payload ? { payload } : {}),
      }),
    )

  describe('checkpoints and reading', () => {
    it('lists a named checkpoint and shows a file as it was', async () => {
      fixture = await createRoomFixture(api)
      await write(fixture.fileId, 'old')
      const id = await checkpoint()
      await write(fixture.fileId, 'new')

      const list = await api.app.inject(
        as(fixture.viewer, { method: 'GET', url: `/projects/${fixture.projectId}/snapshots` }),
      )
      expect(list.json().snapshots[0]).toMatchObject({ id, label: 'before refactor', kind: 'MANUAL' })
      expect(list.body).not.toContain('"state"')

      const file = await api.app.inject(
        as(fixture.viewer, { method: 'GET', url: `/snapshots/${id}/files/${fixture.fileId}` }),
      )
      expect(file.json()).toEqual({ path: 'main.py', content: 'old' })
    })

    it('hides history from outsiders and refuses viewer checkpoints', async () => {
      fixture = await createRoomFixture(api)
      const id = await checkpoint()
      const read = await api.app.inject(
        as(fixture.outsider, { method: 'GET', url: `/snapshots/${id}` }),
      )
      expect(read.statusCode).toBe(404)
      const write = await api.app.inject(
        as(fixture.viewer, {
          method: 'POST',
          url: `/projects/${fixture.projectId}/snapshots`,
          payload: { label: 'x' },
        }),
      )
      expect(write.statusCode).toBe(403)
    })

    it('refuses restore in a locked room', async () => {
      fixture = await createRoomFixture(api)
      const id = await checkpoint()
      await api.prisma.room.update({
        where: { id: fixture.roomId },
        data: { lockedAt: new Date() },
      })
      expect((await restore(id)).statusCode).toBe(403)
    })

    it('exports a snapshot as a zip of its own contents', async () => {
      fixture = await createRoomFixture(api)
      await write(fixture.fileId, 'exported')
      const id = await checkpoint()
      await write(fixture.fileId, 'later')
      const response = await api.app.inject(
        as(fixture.viewer, { method: 'GET', url: `/snapshots/${id}/export` }),
      )
      const entries = unzipSync(response.rawPayload)
      expect(strFromU8(entries['main.py'] as Uint8Array)).toBe('exported')
    })
  })

  describe('automatic snapshots', () => {
    const run = async () => {
      const execution = await api.prisma.execution.create({
        data: {
          roomId: fixture.roomId,
          projectId: fixture.projectId,
          userId: fixture.editor,
          language: 'PYTHON',
          entryPath: 'main.py',
          status: 'RUNNING',
        },
      })
      return (status: string) =>
        api.app.inject({
          method: 'POST',
          url: `/api/v1/internal/executions/${execution.id}/result`,
          headers: { 'x-service-token': config.internalServiceToken },
          payload: {
            status,
            exit_code: 0,
            stdout: '',
            stderr: '',
            compile_output: '',
            time_ms: 1,
            memory_kb: 1,
            message: null,
          },
        })
    }
    const count = () => api.prisma.snapshot.count({ where: { projectId: fixture.projectId } })

    it('records one after a successful run, but not after a failed one', async () => {
      fixture = await createRoomFixture(api)
      await write(fixture.fileId, 'code')
      expect((await (await run())('RUNTIME_ERROR')).json()).toEqual({ recorded: true })
      expect(await count()).toBe(0)
      expect((await (await run())('OK')).json()).toEqual({ recorded: true })
      const stored = await api.prisma.snapshot.findFirstOrThrow({
        where: { projectId: fixture.projectId },
      })
      expect(stored.kind).toBe('RUN')
      expect(stored.createdById).toBe(fixture.editor)
    })

    it('skips a run that changed nothing since the last snapshot', async () => {
      fixture = await createRoomFixture(api)
      await write(fixture.fileId, 'code')
      await (await run())('OK')
      await (await run())('OK')
      expect(await count()).toBe(1)
    })

    it('lists only the users whose edits are new since the last snapshot', async () => {
      fixture = await createRoomFixture(api)
      const remember = async (clientId: number | null, userId: string) => {
        await api.prisma.yjsClient.create({
          data: { projectId: fixture.projectId, clientId: BigInt(clientId as number), userId },
        })
      }
      await remember(await write(fixture.fileId, 'one'), fixture.editor)
      await checkpoint()
      await remember(await write(fixture.fileId, 'one two'), fixture.owner)
      const id = await checkpoint()
      const stored = await api.prisma.snapshot.findUniqueOrThrow({ where: { id } })
      expect(stored.authorIds).toEqual([fixture.owner])
    })

    it('stores the file list even for a project no room has opened', async () => {
      fixture = await createRoomFixture(api)
      const id = await captureSnapshot(api.prisma, {
        projectId: fixture.projectId,
        kind: 'AUTO',
        state: await bridge.encodeState(fixture.projectId),
      })
      const response = await api.app.inject(
        as(fixture.viewer, { method: 'GET', url: `/snapshots/${id}` }),
      )
      expect(response.json().tree).toContainEqual({
        id: fixture.fileId,
        path: 'main.py',
        kind: 'FILE',
      })
    })
  })

  describe('restore', () => {
    const addFile = async (path: string) => {
      const response = await api.app.inject(
        as(fixture.editor, {
          method: 'POST',
          url: `/projects/${fixture.projectId}/files`,
          payload: { path, content: `content of ${path}` },
        }),
      )
      expect(response.statusCode).toBe(201)
      return response.json<{ file: { id: string } }>().file.id
    }
    const removeFile = async (fileId: string) => {
      const response = await api.app.inject(
        as(fixture.editor, {
          method: 'DELETE',
          url: `/projects/${fixture.projectId}/files/${fileId}`,
        }),
      )
      expect(response.statusCode).toBe(204)
    }
    const moveFile = async (fileId: string, path: string) => {
      const response = await api.app.inject(
        as(fixture.editor, {
          method: 'PATCH',
          url: `/projects/${fixture.projectId}/files/${fileId}`,
          payload: { path },
        }),
      )
      expect(response.statusCode).toBe(200)
    }
    const paths = async () =>
      (
        await api.prisma.file.findMany({
          where: { projectId: fixture.projectId },
          select: { path: true },
          orderBy: { path: 'asc' },
        })
      ).map((file) => file.path)

    it('writes the old text as a new edit and tells the room', async () => {
      fixture = await createRoomFixture(api)
      await write(fixture.fileId, 'old')
      const id = await checkpoint()
      await write(fixture.fileId, 'new')
      const before = api.transport.published.length

      expect((await restore(id)).statusCode).toBe(200)

      expect(await read()).toBe('old')
      const channels = api.transport.published.slice(before).map((entry) => entry.channel)
      expect(channels).toContain(collabKeys.sync(fixture.projectId))
      expect(channels).toContain(collabKeys.control(fixture.roomId))
      expect(channels).toContain(collabKeys.events(fixture.roomId))
    })

    it('can be undone with the snapshot it returns', async () => {
      fixture = await createRoomFixture(api)
      await write(fixture.fileId, 'old')
      const id = await checkpoint()
      await write(fixture.fileId, 'work in progress')
      const { undoSnapshotId } = (await restore(id)).json()
      await restore(undoSnapshotId)
      expect(await read()).toBe('work in progress')
    })

    it('keeps edits outside the changed text, so anchors and cursors survive', async () => {
      fixture = await createRoomFixture(api)
      await write(fixture.fileId, 'aaa\nbbb\nccc\n')
      const id = await checkpoint()
      await write(fixture.fileId, 'aaa\nXXX\nccc\n')
      const doc = new Y.Doc()
      Y.applyUpdate(doc, await bridge.encodeState(fixture.projectId))
      const text = doc.getMap<Y.Text>('files').get(fixture.fileId) as Y.Text
      let kept = text._start
      while (kept?.deleted) kept = kept.right
      await restore(id)
      Y.applyUpdate(doc, await bridge.encodeState(fixture.projectId))
      expect(text.toString()).toBe('aaa\nbbb\nccc\n')
      // The same item is still live, so nothing anchored to it moved.
      expect(kept?.deleted).toBe(false)
      expect(kept?.content.getContent().join('').startsWith('aaa')).toBe(true)
      doc.destroy()
    })

    it('puts the whole tree back: removes new files, returns deleted ones, undoes renames', async () => {
      fixture = await createRoomFixture(api)
      const kept = await addFile('src/kept.py')
      const deleted = await addFile('src/deleted.py')
      await write(fixture.fileId, 'main')
      const id = await checkpoint()

      await removeFile(deleted)
      await moveFile(kept, 'src/renamed.py')
      await addFile('src/added.py')
      expect(await paths()).toEqual(['main.py', 'src', 'src/added.py', 'src/renamed.py'])

      expect((await restore(id)).statusCode).toBe(200)

      expect(await paths()).toEqual(['main.py', 'src', 'src/deleted.py', 'src/kept.py'])
      expect(await read(deleted)).toBe('content of src/deleted.py')
    })

    it('handles two files swapping paths', async () => {
      fixture = await createRoomFixture(api)
      const first = await addFile('a.py')
      const second = await addFile('b.py')
      const id = await checkpoint()
      await moveFile(first, 'c.py')
      await moveFile(second, 'a.py')
      await moveFile(first, 'b.py')
      expect((await restore(id)).statusCode).toBe(200)
      const row = await api.prisma.file.findUniqueOrThrow({ where: { id: first } })
      expect(row.path).toBe('a.py')
    })

    it('restores one file and leaves the rest alone', async () => {
      fixture = await createRoomFixture(api)
      const other = await addFile('other.py')
      await write(fixture.fileId, 'old')
      const id = await checkpoint()
      await write(fixture.fileId, 'new')
      await write(other, 'other new')
      expect((await restore(id, { fileId: fixture.fileId })).statusCode).toBe(200)
      expect(await read()).toBe('old')
      expect(await read(other)).toBe('other new')
    })

    it('brings back one deleted file with its folders', async () => {
      fixture = await createRoomFixture(api)
      const file = await addFile('deep/er/file.py')
      const id = await checkpoint()
      await api.prisma.file.deleteMany({
        where: { projectId: fixture.projectId, path: { startsWith: 'deep' } },
      })
      expect((await restore(id, { fileId: file })).statusCode).toBe(200)
      expect(await paths()).toContain('deep/er')
      expect(await paths()).toContain('deep/er/file.py')
    })

    it('refuses to overwrite a different file that took the path', async () => {
      fixture = await createRoomFixture(api)
      const file = await addFile('taken.py')
      const id = await checkpoint()
      await removeFile(file)
      await addFile('taken.py')
      const response = await restore(id, { fileId: file })
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('path_exists')
    })

    it('refuses a file that is not in the snapshot', async () => {
      fixture = await createRoomFixture(api)
      const id = await checkpoint()
      const later = await addFile('later.py')
      expect((await restore(id, { fileId: later })).statusCode).toBe(404)
    })

    it('cannot restore a snapshot from another room', async () => {
      fixture = await createRoomFixture(api)
      const id = await checkpoint()
      const other = await createRoomFixture(api)
      expect((await restore(id, undefined, other.owner)).statusCode).toBe(404)
    })
  })

  describe('blame', () => {
    it('credits each line to the user who wrote most of it', async () => {
      fixture = await createRoomFixture(api)
      const first = (await write(fixture.fileId, 'one\ntwo\nthree')) as number
      const second = (await write(fixture.fileId, 'one\nTWO changed\nthree')) as number
      await api.prisma.yjsClient.createMany({
        data: [
          { projectId: fixture.projectId, clientId: BigInt(first), userId: fixture.editor },
          { projectId: fixture.projectId, clientId: BigInt(second), userId: fixture.owner },
        ],
      })
      const response = await api.app.inject(
        as(fixture.viewer, { method: 'GET', url: `/files/${fixture.fileId}/blame` }),
      )
      const { ranges, users } = response.json()
      expect(ranges).toEqual([
        { startLine: 1, endLine: 1, userId: fixture.editor },
        { startLine: 2, endLine: 2, userId: fixture.owner },
        { startLine: 3, endLine: 3, userId: fixture.editor },
      ])
      expect(users).toMatchObject({ [fixture.editor]: 'Editor', [fixture.owner]: 'Owner' })
    })

    it('leaves imported text without an author', () => {
      const doc = new Y.Doc()
      const text = doc.getText('t')
      text.insert(0, 'a\n\nb')
      const lines = blameLines(text)
      expect(lines).toEqual([doc.clientID, doc.clientID, doc.clientID])
      expect(toRanges(lines, new Map())).toEqual([{ startLine: 1, endLine: 3, userId: null }])
      doc.destroy()
    })
  })

  describe('pruning', () => {
    it('keeps the last automatic snapshot per day, and every checkpoint', async () => {
      fixture = await createRoomFixture(api)
      const now = Date.parse('2026-11-01T12:00:00Z')
      const old = now - 40 * DAY_MS
      const make = (kind: 'AUTO' | 'RUN' | 'MANUAL', at: number, label: string) =>
        api.prisma.snapshot.create({
          data: {
            projectId: fixture.projectId,
            kind,
            label,
            state: Buffer.from([0]),
            createdAt: new Date(at),
          },
        })
      await make('AUTO', old, 'day-old-early')
      await make('RUN', old + 3_600_000, 'day-old-late')
      await make('MANUAL', old, 'checkpoint')
      await make('AUTO', old + DAY_MS, 'next-day')
      await make('AUTO', now - DAY_MS, 'recent-one')
      await make('AUTO', now - DAY_MS + 1000, 'recent-two')

      await pruneSnapshots(api.prisma, new Date(now - 30 * DAY_MS))

      const left = await api.prisma.snapshot.findMany({
        where: { projectId: fixture.projectId },
        orderBy: { label: 'asc' },
      })
      expect(left.map((snapshot) => snapshot.label)).toEqual([
        'checkpoint',
        'day-old-late',
        'next-day',
        'recent-one',
        'recent-two',
      ])
    })
  })
})
