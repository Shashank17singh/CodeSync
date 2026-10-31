export const EXECUTION_QUEUES = {
  run: 'run',
  judge: 'judge',
} as const

export const EXECUTION_LIMITS = {
  runsPerUserPerMinute: 10,
  runsPerRoomPerMinute: 30,
  // The whole project travels in the job, so this also bounds Redis memory per queued run.
  maxPayloadBytes: 2 * 1024 * 1024,
  maxStdinChars: 256 * 1024,
  // Past this, new runs are refused. A growing queue only gives everyone a longer wait.
  maxWaitingRuns: 500,
  // One original attempt plus one retry after a worker crash.
  maxAttempts: 2,
} as const
