import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/prisma/migrations', import.meta.url))

// A fixed port would let one crashed run's leftover database block every run after it.
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

// Permission and uniqueness rules depend on real SQL, so tests use a real server. Set
// TEST_DATABASE_URL to use your own migrated database instead of the embedded one.
export default async function setup(): Promise<() => Promise<void>> {
  if (process.env['TEST_DATABASE_URL']) return async () => undefined

  const port = await freePort()
  const databaseDir = mkdtempSync(join(tmpdir(), 'codesync-api-pg-'))
  const postgres = new EmbeddedPostgres({
    databaseDir,
    user: 'codesync',
    password: 'codesync',
    port,
    persistent: false,
    onLog: () => undefined,
  })
  await postgres.initialise()
  await postgres.start()
  await postgres.createDatabase('codesync')

  const client = postgres.getPgClient('codesync')
  await client.connect()
  const migrations = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  for (const migration of migrations) {
    await client.query(readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8'))
  }
  await client.end()

  process.env['TEST_DATABASE_URL'] =
    `postgresql://codesync:codesync@127.0.0.1:${port}/codesync`

  return async () => {
    await postgres.stop()
    rmSync(databaseDir, { recursive: true, force: true })
  }
}
