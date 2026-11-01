import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

// Turns the result files into results/REPORT.md and an SVG chart for the project report.
// It only formats numbers that a run wrote. A run that has not happened is listed as not run.
interface CollabResult {
  tool: string
  environment?: { note: string; cpus?: string; logicalCores?: number; totalMemoryGb?: number }
  load: Record<string, number>
  updates: { sent: number; delivered: number; expected?: number }
  deliveredPercent?: number
  latencyMs: { p50: number; p95: number; p99: number; max: number }
  server: Record<string, number | undefined>
}

const BAR_MAX_WIDTH = 420
const ROW_HEIGHT = 34
const LEFT = 90

const read = <T>(path: string): T | null =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null

const round = (value: number | undefined): string =>
  value === undefined || Number.isNaN(value) ? 'not measured' : value.toFixed(1)

function collabSection(title: string, result: CollabResult): string {
  const { latencyMs, server, updates } = result
  const load = Object.entries(result.load)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ')
  return [
    `## ${title}`,
    '',
    `Tool: ${result.tool}. Load: ${load}.`,
    result.environment ? `Environment: ${result.environment.note}` : '',
    result.environment?.cpus
      ? `Machine: ${result.environment.cpus}, ${result.environment.logicalCores} logical cores, ${result.environment.totalMemoryGb} GB RAM.`
      : '',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Update latency p50 | ${latencyMs.p50} ms |`,
    `| Update latency p95 | ${latencyMs.p95} ms |`,
    `| Update latency p99 | ${latencyMs.p99} ms |`,
    `| Update latency max | ${latencyMs.max} ms |`,
    `| Updates sent | ${updates.sent} |`,
    `| Updates delivered | ${updates.delivered} |`,
    `| Delivered of expected | ${result.deliveredPercent ?? 'not measured'}% |`,
    `| Server CPU average | ${round(server['cpuPercentAverage'])}% of one core |`,
    `| Server CPU peak | ${round(server['cpuPercentPeak'])}% of one core |`,
    `| Server memory average | ${round(server['rssMbAverage'])} MB |`,
    `| Server memory peak | ${round(server['rssMbPeak'])} MB |`,
    '',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')
}

function chart(result: CollabResult): string {
  const rows: Array<[string, number]> = [
    ['p50', result.latencyMs.p50],
    ['p95', result.latencyMs.p95],
    ['p99', result.latencyMs.p99],
  ]
  const top = Math.max(...rows.map(([, value]) => value), 1)
  const bars = rows
    .map(([label, value], index) => {
      const y = 30 + index * ROW_HEIGHT
      const width = Math.max(2, (value / top) * BAR_MAX_WIDTH)
      return [
        `<text x="${LEFT - 10}" y="${y + 16}" text-anchor="end">${label}</text>`,
        `<rect x="${LEFT}" y="${y}" width="${width}" height="22" fill="#0f766e"/>`,
        `<text x="${LEFT + width + 8}" y="${y + 16}">${value} ms</text>`,
      ].join('')
    })
    .join('')
  const height = 40 + rows.length * ROW_HEIGHT
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${height}" font-family="sans-serif" font-size="14" fill="#1b1f23"><text x="${LEFT}" y="18" font-weight="600">Update propagation latency</text>${bars}</svg>\n`
}

const steps = readdirSync('results')
  .filter((name) => /^collab-local-r\d+.*\.json$/.test(name))
  .map((name) => read<CollabResult>(`results/${name}`) as CollabResult)
  .sort(
    (a, b) =>
      (a.load['rooms'] ?? 0) * (a.load['usersPerRoom'] ?? 0) * (a.load['keysPerSecond'] ?? 0) -
      (b.load['rooms'] ?? 0) * (b.load['usersPerRoom'] ?? 0) * (b.load['keysPerSecond'] ?? 0),
  )
const local = steps.at(-1) ?? null
const k6Collab = read<CollabResult>('results/collab-k6.json')
const k6Execution = read<{
  load: { concurrentRuns: number }
  queueWaitMs: Record<string, number>
  runTimeMs: Record<string, number>
  failureRate: number
}>('results/execution-k6.json')

const sections = ['# Load test results', '']
if (k6Collab) sections.push(collabSection('Collaboration, k6', k6Collab))
else sections.push('## Collaboration, k6', '', 'Not run yet. See loadtest/README.md.', '')
if (steps.length > 0) {
  sections.push(
    '## Collaboration, local Node driver, by scale',
    '',
    steps[0]?.environment?.note ?? '',
    '',
    `Machine: ${steps[0]?.environment?.cpus}, ${steps[0]?.environment?.logicalCores} logical cores, ${steps[0]?.environment?.totalMemoryGb} GB RAM.`,
    '',
    '| Rooms | Users | Keys/s each | p50 ms | p95 ms | p99 ms | Max ms | Delivered | Server CPU avg | Server RSS peak |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...steps.map(
      ({ load, latencyMs, deliveredPercent, server }) =>
        `| ${load['rooms']} | ${(load['rooms'] ?? 0) * (load['usersPerRoom'] ?? 0)} | ${load['keysPerSecond']} | ${latencyMs.p50} | ${latencyMs.p95} | ${latencyMs.p99} | ${latencyMs.max} | ${deliveredPercent}% | ${round(server['cpuPercentAverage'])}% | ${round(server['rssMbPeak'])} MB |`,
    ),
    '',
    'Each row is a single run. CPU is a percentage of one core. The 10 rooms × 50 users run at 5 keys/s did not finish: it asks',
    'for about 122,500 deliveries a second, which one Node process cannot generate and absorb, so',
    'there is no measurement for that row. Only the k6 test from a separate machine can answer it.',
    '',
  )
}
if (k6Execution) {
  const { queueWaitMs: wait, runTimeMs: run } = k6Execution
  sections.push(
    '## Execution, k6',
    '',
    `Concurrent runs: ${k6Execution.load.concurrentRuns}.`,
    '',
    '| Metric | p50 | p95 | p99 | Max |',
    '| --- | --- | --- | --- | --- |',
    `| Queue wait (ms) | ${round(wait['p(50)'])} | ${round(wait['p(95)'])} | ${round(wait['p(99)'])} | ${round(wait['max'])} |`,
    `| Run time (ms) | ${round(run['p(50)'])} | ${round(run['p(95)'])} | ${round(run['p(99)'])} | ${round(run['max'])} |`,
    '',
    `Failure rate: ${(k6Execution.failureRate * 100).toFixed(2)}%.`,
    '',
  )
} else {
  sections.push(
    '## Execution, k6',
    '',
    'Not run yet. It needs Docker, the sandbox images and a worker. See loadtest/README.md.',
    '',
  )
}
writeFileSync('results/REPORT.md', `${sections.join('\n')}\n`)

const source = k6Collab ?? local
if (source) writeFileSync('results/latency.svg', chart(source))
console.log('wrote results/REPORT.md')
