import pino from 'pino'
import { startCollabServer } from '../src/server.js'
import { MemoryHub } from '../src/storage/memory.js'

// Real collab server with in-memory storage, used by the browser tests in apps/web.
const port = Number(process.env['E2E_COLLAB_PORT'] ?? 4199)
const origin = process.env['E2E_ORIGIN'] ?? 'http://127.0.0.1:5199'

const hub = new MemoryHub()
const storage = hub.storage()
storage.catalog.resolveAccess = async () => ({ role: 'editor', locked: false })
storage.catalog.listFiles = async () => [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', path: 'main.py', kind: 'FILE' },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', path: 'util.py', kind: 'FILE' },
]

await startCollabServer({
  port,
  storage,
  logger: pino({ level: 'warn' }),
  config: {
    tokenSecret: process.env['E2E_TOKEN_SECRET'] ?? 'e2e-secret-with-at-least-32-characters',
    allowedOrigins: new Set([origin]),
    compactionIntervalMs: 30_000,
    snapshotIntervalMs: 300_000,
    maxPendingUpdates: 500,
  },
})
