// Bundled by `pnpm build:k6`, because k6 cannot resolve npm packages at run time.
import { check, sleep } from 'k6'
import exec from 'k6/execution'
import http from 'k6/http'
import { Counter, Trend } from 'k6/metrics'
import ws from 'k6/ws'
import * as Y from 'yjs'
import { applyServerState, hello, readStamp, typeStamp } from '../src/protocol.js'

interface Target {
  projectId: string
  fileId: string
  token: string
}

const targets: Target[] = JSON.parse(open('../results/targets.json')).collab
const COLLAB_URL = __ENV['COLLAB_URL'] ?? 'ws://127.0.0.1:4000'
const METRICS_URL = __ENV['METRICS_URL']
const ORIGIN = __ENV['ORIGIN'] ?? 'http://localhost:5173'
const DURATION_S = Number(__ENV['DURATION'] ?? 120)
const KEYS_PER_SECOND = Number(__ENV['RATE'] ?? 5)

const latency = new Trend('update_latency', true)
const sent = new Counter('updates_sent')
const delivered = new Counter('updates_delivered')
const serverCpu = new Trend('server_cpu_percent')
const serverRss = new Trend('server_rss_mb')

export const options = {
  scenarios: {
    typists: {
      executor: 'per-vu-iterations',
      vus: targets.length,
      iterations: 1,
      maxDuration: `${DURATION_S + 60}s`,
    },
    ...(METRICS_URL
      ? {
          server: {
            executor: 'constant-vus',
            exec: 'sampleServer',
            vus: 1,
            duration: `${DURATION_S}s`,
          },
        }
      : {}),
  },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max', 'avg'],
  thresholds: {
    update_latency: ['p(95)<200', 'p(99)<500'],
  },
}

export default function typist(): void {
  const target = targets[exec.scenario.iterationInTest] as Target
  const doc = new Y.Doc()
  let ready = false
  const url = `${COLLAB_URL}/collab/${target.projectId}?token=${target.token}`
  const response = ws.connect(url, { headers: { Origin: ORIGIN } }, (socket) => {
    socket.on('open', () => socket.sendBinary(hello(doc).slice().buffer))
    socket.on('binaryMessage', (data: ArrayBuffer) => {
      const frame = new Uint8Array(data)
      if (!ready && applyServerState(doc, frame)) {
        ready = true
        return
      }
      const stamp = readStamp(frame)
      if (stamp === null) return
      latency.add(Date.now() - stamp)
      delivered.add(1)
    })
    socket.setInterval(() => {
      const frame = ready ? typeStamp(doc, target.fileId, Date.now()) : null
      if (!frame) return
      socket.sendBinary(frame.slice().buffer)
      sent.add(1)
    }, 1_000 / KEYS_PER_SECOND)
    socket.setTimeout(() => socket.close(), DURATION_S * 1_000)
  })
  check(response, { upgraded: (result) => result?.status === 101 })
}

let lastCpu: { seconds: number; at: number } | null = null

export function sampleServer(): void {
  const body = String(http.get(METRICS_URL as string).body)
  const read = (name: string): number =>
    Number(new RegExp(`^${name} (\\S+)$`, 'm').exec(body)?.[1] ?? 0)
  const seconds = read('process_cpu_seconds_total')
  const at = Date.now()
  if (lastCpu) serverCpu.add(((seconds - lastCpu.seconds) / ((at - lastCpu.at) / 1_000)) * 100)
  lastCpu = { seconds, at }
  serverRss.add(read('process_resident_memory_bytes') / 1_048_576)
  sleep(5)
}

export function handleSummary(data: { metrics: Record<string, { values: Record<string, number> }> }) {
  const values = (name: string): Record<string, number> => data.metrics[name]?.values ?? {}
  const trend = values('update_latency')
  const summary = {
    tool: 'k6',
    load: { typists: targets.length, durationSeconds: DURATION_S, keysPerSecond: KEYS_PER_SECOND },
    updates: { sent: values('updates_sent')['count'], delivered: values('updates_delivered')['count'] },
    latencyMs: {
      p50: trend['p(50)'],
      p95: trend['p(95)'],
      p99: trend['p(99)'],
      max: trend['max'],
    },
    server: {
      cpuPercentAverage: values('server_cpu_percent')['avg'],
      cpuPercentPeak: values('server_cpu_percent')['max'],
      rssMbAverage: values('server_rss_mb')['avg'],
      rssMbPeak: values('server_rss_mb')['max'],
    },
  }
  return { 'results/collab-k6.json': JSON.stringify(summary, null, 2) }
}
