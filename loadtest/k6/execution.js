import { check, sleep } from 'k6'
import exec from 'k6/execution'
import http from 'k6/http'
import { Rate, Trend } from 'k6/metrics'

const targets = JSON.parse(open('../results/targets.json')).execution
const API_URL = __ENV.API_URL ?? 'http://127.0.0.1:3000'
const POLL_SECONDS = 0.5
const GIVE_UP_SECONDS = 180
const FINISHED = new Set([
  'OK',
  'COMPILE_ERROR',
  'RUNTIME_ERROR',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'OUTPUT_LIMIT_EXCEEDED',
  'INTERNAL_ERROR',
])

const queueWait = new Trend('queue_wait', true)
const runTime = new Trend('run_time', true)
const failures = new Rate('run_failures')

// One user and one room for each request, because the API limits runs per user and per room,
// and those limits are not what this test is measuring.
export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: targets.length,
      iterations: 1,
      maxDuration: `${GIVE_UP_SECONDS + 30}s`,
    },
  },
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max', 'avg'],
  thresholds: { run_failures: ['rate<0.01'] },
}

export default function run() {
  const target = targets[exec.scenario.iterationInTest]
  const headers = {
    authorization: `Bearer ${target.accessToken}`,
    'content-type': 'application/json',
  }
  const created = http.post(
    `${API_URL}/api/v1/rooms/${target.roomId}/executions`,
    JSON.stringify({ projectId: target.projectId, entryPath: 'main.py', stdin: '' }),
    { headers },
  )
  if (!check(created, { accepted: (response) => response.status === 202 })) {
    failures.add(true)
    return
  }
  const { id } = created.json('execution')

  const deadline = Date.now() + GIVE_UP_SECONDS * 1_000
  while (Date.now() < deadline) {
    sleep(POLL_SECONDS)
    const polled = http.get(`${API_URL}/api/v1/executions/${id}`, { headers })
    const execution = polled.json('execution')
    if (!execution || !FINISHED.has(execution.status)) continue
    const queued = Date.parse(execution.queuedAt)
    const started = Date.parse(execution.startedAt)
    const finished = Date.parse(execution.finishedAt)
    if (started) {
      queueWait.add(started - queued)
      runTime.add(finished - started)
    }
    failures.add(execution.status !== 'OK')
    return
  }
  failures.add(true)
}

export function handleSummary(data) {
  const values = (name) => data.metrics[name]?.values ?? {}
  const summary = {
    tool: 'k6',
    load: { concurrentRuns: targets.length },
    queueWaitMs: values('queue_wait'),
    runTimeMs: values('run_time'),
    failureRate: values('run_failures').rate,
  }
  return { 'results/execution-k6.json': JSON.stringify(summary, null, 2) }
}
