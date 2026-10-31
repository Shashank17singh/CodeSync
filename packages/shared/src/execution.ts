export const EXECUTION_QUEUES = {
  run: 'run',
  judge: 'judge',
  review: 'review',
} as const

export const REVIEW_LIMITS = {
  maxLines: 400,
  maxCodeChars: 256 * 1024,
  maxErrorChars: 8 * 1024,
  perUserPerDay: 20,
} as const

export const EXECUTION_LIMITS = {
  runsPerUserPerMinute: 10,
  runsPerRoomPerMinute: 30,
  submissionsPerUserPerMinute: 6,
  // The whole project travels in the job, so this also bounds Redis memory per queued run.
  maxPayloadBytes: 2 * 1024 * 1024,
  maxStdinChars: 256 * 1024,
  // Past this, new runs are refused. A growing queue only gives everyone a longer wait.
  maxWaitingRuns: 500,
  // One original attempt plus one retry after a worker crash.
  maxAttempts: 2,
} as const
