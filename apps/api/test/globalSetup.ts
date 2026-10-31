import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import EmbeddedPostgres from 'embedded-postgres'

const PORT = 54330
const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/prisma/migrations', import.meta.url))

// Permission and uniqueness rules depend on real SQL, so tests use a real server. Set
// TEST_DATABASE_URL to use your own migrated database instead of the embedded one.
export default async function setup(): Promise<() => Promise<void>> {
  if (process.env['TEST_DATABASE_URL']) return async () => undefined

  const databaseDir = mkdtempSync(join(tmpdir(), 'codesync-api-pg-'))
  const postgres = new EmbeddedPostgres({
    databaseDir,
    user: 'codesync',
    password: 'codesync',
    port: PORT,
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
    `postgresql://codesync:codesync@127.0.0.1:${PORT}/codesync`

  return async () => {
    await postgres.stop()
    rmSync(databaseDir, { recursive: true, force: true })
  }
}
