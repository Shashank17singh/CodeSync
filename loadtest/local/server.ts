import pino from 'pino'
import { startCollabServer } from '../../apps/collab/src/server.js'
import { MemoryHub } from '../../apps/collab/src/storage/memory.js'

// The real collab server, with the in-memory hub in place of Redis and PostgreSQL. It runs in its
// own process so that the numbers it reports describe the server and not the load generator.
export const SECRET = 'loadtest-secret-with-at-least-32-characters'
export const ORIGIN = 'http://loadtest.local'

const port = Number(process.env['PORT'] ?? 4300)
const fileId = process.env['FILE_ID'] as string
const hub = new MemoryHub()
const storage = hub.storage()
storage.catalog.resolveAccess = async () => ({ role: 'editor', locked: false })
storage.catalog.listFiles = async () => [{ id: fileId, path: 'main.py', kind: 'FILE' }]

await startCollabServer({
  port,
  storage,
  logger: pino({ level: 'error' }),
  config: {
    tokenSecret: SECRET,
    allowedOrigins: new Set([ORIGIN]),
    compactionIntervalMs: 30_000,
    snapshotIntervalMs: 300_000,
    maxPendingUpdates: 500,
  },
})
process.send?.('ready')
