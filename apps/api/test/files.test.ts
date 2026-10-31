import { randomUUID } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateProjectPath } from '../src/lib/paths.js'
import { ZIP_LIMITS } from '../src/lib/zip.js'
import { as, createRoomFixture, createTestApi, type RoomFixture, type TestApi } from './helpers.js'

// fflate refuses nothing on the way in, but this makes the attack entry explicit in each test.
const archive = (entries: Record<string, string>): Buffer => {
  const zippable: Zippable = {}
  for (const [name, content] of Object.entries(entries)) zippable[name] = strToU8(content)
  return Buffer.from(zipSync(zippable))
}

describe('file operations', () => {
  let api: TestApi
  let fixture: RoomFixture

  beforeAll(async () => {
    api = await createTestApi()
  })
  afterAll(() => api.close())

  const upload = (body: Buffer) =>
    api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/projects/${fixture.projectId}/import`,
        headers: { 'content-type': 'application/zip' },
        payload: body,
      }),
    )

  const paths = async (): Promise<string[]> => {
    const files = await api.prisma.file.findMany({ where: { projectId: fixture.projectId } })
    // Sorted here because the database order depends on its collation.
    return files.map((file) => file.path).sort()
  }

  const createFile = (path: string, kind = 'FILE') =>
    api.app.inject(
      as(fixture.owner, {
        method: 'POST',
        url: `/projects/${fixture.projectId}/files`,
        payload: { path, kind },
      }),
    )

  describe('zip-slip and hostile archives', () => {
    it.each([
      ['parent traversal', '../evil.sh'],
      ['deep traversal', '../../../../etc/cron.d/evil'],
      ['traversal in the middle', 'src/../../evil.py'],
      ['absolute path', '/etc/passwd'],
      ['windows traversal', '..\\..\\evil.bat'],
      ['windows drive', 'C:/Windows/evil.dll'],
      ['current directory segment', './a/./b.py'],
      ['null byte', 'safe.py\u0000.exe'],
      ['reserved windows name', 'src/CON.txt'],
      ['trailing dot', 'src/evil.'],
    ])('rejects %s and writes nothing', async (_name, path) => {
      fixture = await createRoomFixture(api)
      const before = await paths()
      const response = await upload(archive({ 'innocent.py': 'x', [path]: 'payload' }))
      expect(response.statusCode).toBe(422)
      expect(response.json().error.code).toBe('invalid_path')
      expect(await paths()).toEqual(before)
    })

    it('rejects a traversal path on a directory entry', async () => {
      fixture = await createRoomFixture(api)
      const response = await upload(archive({ '../outside/': '' }))
      expect(response.statusCode).toBe(422)
    })

    it('rejects more than 200 files', async () => {
      fixture = await createRoomFixture(api)
      const entries: Record<string, string> = {}
      for (let index = 0; index <= ZIP_LIMITS.maxFiles; index++) entries[`f${index}.py`] = 'x'
      const response = await upload(archive(entries))
      expect(response.statusCode).toBe(422)
      expect(response.json().error.code).toBe('too_many_files')
    })

    it('accepts exactly 200 files', async () => {
      fixture = await createRoomFixture(api)
      const entries: Record<string, string> = {}
      for (let index = 0; index < ZIP_LIMITS.maxFiles; index++) entries[`f${index}.py`] = 'x'
      expect((await upload(archive(entries))).statusCode).toBe(201)
    })

    it('rejects an archive over 10 MB', async () => {
      fixture = await createRoomFixture(api)
      const response = await upload(Buffer.alloc(ZIP_LIMITS.maxArchiveBytes + 1))
      expect(response.statusCode).toBe(413)
    })

    it('refuses a zip bomb before inflating it', async () => {
      fixture = await createRoomFixture(api)
      const entries: Zippable = {}
      const block = new Uint8Array(ZIP_LIMITS.maxExpandedBytes / 8)
      for (let index = 0; index < 10; index++) entries[`bomb${index}.txt`] = block
      const compressed = Buffer.from(zipSync(entries, { level: 9 }))
      expect(compressed.byteLength).toBeLessThan(ZIP_LIMITS.maxArchiveBytes)
      const response = await upload(compressed)
      expect(response.statusCode).toBe(422)
      expect(response.json().error.code).toBe('archive_too_large')
    })

    it('rejects a single file over 2 MB', async () => {
      fixture = await createRoomFixture(api)
      const response = await upload(archive({ 'big.txt': 'x'.repeat(2 * 1024 * 1024 + 1) }))
      expect(response.json().error.code).toBe('file_too_large')
    })

    it('rejects binary files', async () => {
      fixture = await createRoomFixture(api)
      const response = await upload(
        Buffer.from(zipSync({ 'image.png': Uint8Array.of(0x89, 0x50, 0xff, 0xfe) })),
      )
      expect(response.json().error.code).toBe('binary_file')
    })

    it('rejects something that is not a zip', async () => {
      fixture = await createRoomFixture(api)
      const response = await upload(Buffer.from('this is not a zip archive at all'))
      expect(response.statusCode).toBe(422)
      expect(response.json().error.code).toBe('invalid_archive')
    })

    it('is all-or-nothing when one path already exists', async () => {
      fixture = await createRoomFixture(api)
      const response = await upload(archive({ 'fresh.py': 'x', 'main.py': 'overwrite' }))
      expect(response.statusCode).toBe(409)
      expect(await paths()).toEqual(['main.py'])
    })

    it('ignores macOS metadata', async () => {
      fixture = await createRoomFixture(api)
      const response = await upload(
        archive({ 'app.py': 'x', '__MACOSX/._app.py': 'y', 'src/.DS_Store': 'z' }),
      )
      expect(response.json()).toEqual({ imported: 1 })
    })
  })

  describe('import and export', () => {
    it('round-trips content through zip, creating folders', async () => {
      fixture = await createRoomFixture(api)
      await upload(archive({ 'src/app/main.py': 'print(1)\n', 'README.md': '# hi\n' }))
      expect(await paths()).toEqual([
        'README.md',
        'main.py',
        'src',
        'src/app',
        'src/app/main.py',
      ])

      const response = await api.app.inject(
        as(fixture.viewer, { method: 'GET', url: `/projects/${fixture.projectId}/export` }),
      )
      expect(response.headers['content-type']).toBe('application/zip')
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="project-${fixture.projectId}.zip"`,
      )
      const files = unzipSync(response.rawPayload)
      expect(Object.keys(files).sort()).toEqual(['README.md', 'main.py', 'src/app/main.py'])
      expect(strFromU8(files['src/app/main.py'] as Uint8Array)).toBe('print(1)\n')
      expect(strFromU8(files['main.py'] as Uint8Array)).toBe('print("Hello, CodeSync!")\n')
    })
  })

  describe('path rules', () => {
    it.each(['a.py', 'src/a.py', 'dir with space/a b.py', 'नमस्ते/a.py', '.gitignore'])(
      'accepts %j',
      (path) => {
        expect(validateProjectPath(path)).toBe(path)
      },
    )

    it('normalizes unicode so one name cannot exist in two forms', () => {
      expect(validateProjectPath('cafe\u0301.py')).toBe('caf\u00e9.py')
    })
  })

  describe('create, rename, move and delete', () => {
    it('rejects traversal through the file API too', async () => {
      fixture = await createRoomFixture(api)
      const response = await createFile('../escape.py')
      expect(response.statusCode).toBe(422)
    })

    it('creates missing parent folders', async () => {
      fixture = await createRoomFixture(api)
      expect((await createFile('a/b/c.py')).statusCode).toBe(201)
      expect(await paths()).toEqual(['a', 'a/b', 'a/b/c.py', 'main.py'])
    })

    it('refuses a duplicate path', async () => {
      fixture = await createRoomFixture(api)
      expect((await createFile('main.py')).statusCode).toBe(409)
    })

    it('refuses a file used as a folder', async () => {
      fixture = await createRoomFixture(api)
      const response = await createFile('main.py/inner.py')
      expect(response.json().error.code).toBe('path_is_file')
    })

    it('moves a folder with everything inside it', async () => {
      fixture = await createRoomFixture(api)
      await createFile('src/lib/util.py')
      const folder = await api.prisma.file.findFirstOrThrow({
        where: { projectId: fixture.projectId, path: 'src' },
      })
      const response = await api.app.inject(
        as(fixture.editor, {
          method: 'PATCH',
          url: `/projects/${fixture.projectId}/files/${folder.id}`,
          payload: { path: 'pkg/core' },
        }),
      )
      expect(response.statusCode).toBe(200)
      expect(await paths()).toEqual([
        'main.py',
        'pkg',
        'pkg/core',
        'pkg/core/lib',
        'pkg/core/lib/util.py',
      ])
    })

    it('does not treat a sibling with the same prefix as a child', async () => {
      fixture = await createRoomFixture(api)
      await createFile('src/a.py')
      await createFile('src2/b.py')
      const folder = await api.prisma.file.findFirstOrThrow({
        where: { projectId: fixture.projectId, path: 'src' },
      })
      await api.app.inject(
        as(fixture.owner, {
          method: 'DELETE',
          url: `/projects/${fixture.projectId}/files/${folder.id}`,
        }),
      )
      expect(await paths()).toEqual(['main.py', 'src2', 'src2/b.py'])
    })

    it('refuses to move a folder into itself', async () => {
      fixture = await createRoomFixture(api)
      await createFile('src/a.py')
      const folder = await api.prisma.file.findFirstOrThrow({
        where: { projectId: fixture.projectId, path: 'src' },
      })
      const response = await api.app.inject(
        as(fixture.owner, {
          method: 'PATCH',
          url: `/projects/${fixture.projectId}/files/${folder.id}`,
          payload: { path: 'src/inner' },
        }),
      )
      expect(response.json().error.code).toBe('invalid_move')
    })

    it('refuses to rename onto an existing file', async () => {
      fixture = await createRoomFixture(api)
      await createFile('other.py')
      const response = await api.app.inject(
        as(fixture.owner, {
          method: 'PATCH',
          url: `/projects/${fixture.projectId}/files/${fixture.fileId}`,
          payload: { path: 'other.py' },
        }),
      )
      expect(response.statusCode).toBe(409)
    })

    it('cannot reach a file through another project', async () => {
      fixture = await createRoomFixture(api)
      const other = await createRoomFixture(api)
      const response = await api.app.inject(
        as(fixture.owner, {
          method: 'DELETE',
          url: `/projects/${fixture.projectId}/files/${other.fileId}`,
        }),
      )
      expect(response.statusCode).toBe(404)
    })

    it('tells collab about every tree change', async () => {
      fixture = await createRoomFixture(api)
      const before = api.transport.controlMessages().length
      await createFile(`${randomUUID()}.py`)
      expect(api.transport.controlMessages().slice(before)).toEqual([
        { type: 'tree.changed', projectId: fixture.projectId },
      ])
    })
  })
})
