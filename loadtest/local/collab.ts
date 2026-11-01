import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { freemem, cpus, totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { applyServerState, hello, percentile, readStamp, typeStamp } from '../src/protocol.js'

const SECRET = 'loadtest-secret-with-at-least-32-characters'
const ORIGIN = 'http://loadtest.local'
const PORT = Number(process.env['PORT'] ?? 4300)
const ROOMS = Number(process.env['ROOMS'] ?? 2)
const USERS = Number(process.env['USERS'] ?? 10)
const DURATION_S = Number(process.env['DURATION'] ?? 30)
const KEYS_PER_SECOND = Number(process.env['RATE'] ?? 3)
const SAMPLE_MS = 1_000
const SETTLE_MS = 2_000
const OUTPUT = process.env['OUTPUT'] ?? 'results/collab-local.json'

const FILE_ID = randomUUID()
const server = fork(fileURLToPath(new URL('./server.ts', import.meta.url)), {
  env: { ...process.env, PORT: String(PORT), FILE_ID },
  execArgv: ['--import', 'tsx'],
})
// A stalled run must not outlive its time limit or leave the server holding the port.
const WATCHDOG_MS = (DURATION_S + 60) * 1_000
const watchdog = setTimeout(() => {
  console.error('load run stalled, giving up')
  server.kill()
  process.exit(2)
}, WATCHDOG_MS)
await new Promise<void>((resolve, reject) => {
  server.once('message', () => resolve())
  server.once('exit', (code) => reject(new Error(`server exited with ${code}`)))
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const latencies: number[] = []
const stats = { sent: 0, received: 0, closed: 0, missedSamples: 0 }

interface Typist {
  socket: WebSocket
  doc: Y.Doc
  ready: boolean
}

function connect(projectId: string, roomId: string): Promise<Typist> {
  const userId = randomUUID()
  const token = jwt.sign({ name: 'load', roomId, projectId, role: 'editor' }, SECRET, {
    algorithm: 'HS256',
    subject: userId,
    audience: 'collab',
    expiresIn: 3_600,
  })
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/collab/${projectId}?token=${token}`, {
    origin: ORIGIN,
  })
  const typist: Typist = { socket, doc: new Y.Doc(), ready: false }
  return new Promise((resolve, reject) => {
    socket.binaryType = 'nodebuffer'
    socket.on('open', () => socket.send(hello(typist.doc)))
    socket.on('close', () => {
      stats.closed += 1
    })
    socket.on('error', reject)
    socket.on('message', (data: Buffer) => {
      const frame = new Uint8Array(data)
      if (!typist.ready && applyServerState(typist.doc, frame)) {
        typist.ready = true
        resolve(typist)
        return
      }
      const sentAt = readStamp(frame)
      if (sentAt === null) return
      latencies.push(Date.now() - sentAt)
      stats.received += 1
    })
  })
}

// A busy server can reset the connection, which costs one sample and not the whole run.
async function scrape(): Promise<{ cpuSeconds: number; rssMb: number } | null> {
  const text = await fetch(`http://127.0.0.1:${PORT}/metrics`)
    .then((response) => response.text())
    .catch(() => null)
  if (text === null) {
    stats.missedSamples += 1
    return null
  }
  const read = (name: string): number =>
    Number(new RegExp(`^${name} (\\S+)$`, 'm').exec(text)?.[1] ?? 0)
  return {
    cpuSeconds: read('process_cpu_seconds_total'),
    rssMb: read('process_resident_memory_bytes') / 1_048_576,
  }
}

const typists: Typist[] = []
for (let room = 0; room < ROOMS; room++) {
  const projectId = randomUUID()
  const roomId = randomUUID()
  const joined = Array.from({ length: USERS }, () => connect(projectId, roomId))
  typists.push(...(await Promise.all(joined)))
}
console.log(`connected ${typists.length} typists in ${ROOMS} rooms`)

const timers = typists.map((typist) => {
  const interval = 1_000 / KEYS_PER_SECOND
  // Random phase, so typists do not all press a key on the same millisecond.
  return setTimeout(() => {
    const timer = setInterval(() => {
      const frame = typeStamp(typist.doc, FILE_ID, Date.now())
      if (frame && typist.socket.readyState === WebSocket.OPEN) {
        typist.socket.send(frame)
        stats.sent += 1
      }
    }, interval)
    timers.push(timer)
  }, Math.random() * interval)
})

const samples: Array<{ cpuPercent: number; rssMb: number }> = []
let previous = await scrape()
let previousAt = Date.now()
const started = Date.now()
while (Date.now() - started < DURATION_S * 1_000) {
  await sleep(SAMPLE_MS)
  const current = await scrape()
  const now = Date.now()
  if (current && previous) {
    samples.push({
      cpuPercent: ((current.cpuSeconds - previous.cpuSeconds) / ((now - previousAt) / 1_000)) * 100,
      rssMb: current.rssMb,
    })
  }
  if (current) {
    previous = current
    previousAt = now
  }
}
timers.forEach(clearTimeout)
timers.forEach(clearInterval)
await sleep(SETTLE_MS)

const sorted = [...latencies].sort((a, b) => a - b)
const expected = stats.sent * (USERS - 1)
const mean = (values: number[]): number =>
  values.reduce((total, value) => total + value, 0) / Math.max(1, values.length)
const cpu = samples.map((sample) => sample.cpuPercent)
const rss = samples.map((sample) => sample.rssMb)

const result = {
  tool: 'node driver',
  environment: {
    note: 'One laptop, load generator and server on the same machine, in-memory stand-in for Redis and PostgreSQL.',
    cpus: cpus()[0]?.model.trim(),
    logicalCores: cpus().length,
    totalMemoryGb: Number((totalmem() / 1_073_741_824).toFixed(1)),
    freeMemoryGbAtEnd: Number((freemem() / 1_073_741_824).toFixed(1)),
    node: process.version,
  },
  load: { rooms: ROOMS, usersPerRoom: USERS, durationSeconds: DURATION_S, keysPerSecond: KEYS_PER_SECOND },
  updates: { sent: stats.sent, delivered: stats.received, expected },
  deliveredPercent: Number(((stats.received / Math.max(1, expected)) * 100).toFixed(2)),
  disconnects: stats.closed,
  missedServerSamples: stats.missedSamples,
  latencyMs: {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  },
  server: {
    cpuPercentAverage: Number(mean(cpu).toFixed(1)),
    cpuPercentPeak: Number(Math.max(...cpu).toFixed(1)),
    rssMbAverage: Number(mean(rss).toFixed(1)),
    rssMbPeak: Number(Math.max(...rss).toFixed(1)),
  },
}

mkdirSync('results', { recursive: true })
writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result.latencyMs), JSON.stringify(result.server), result.deliveredPercent)

clearTimeout(watchdog)
typists.forEach(({ socket }) => socket.terminate())
server.kill()
process.exit(0)
