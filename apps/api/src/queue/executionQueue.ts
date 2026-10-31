import { EXECUTION_QUEUES } from '@codesync/shared'
import { Queue, QueueEvents } from 'bullmq'
import type { Redis } from 'ioredis'

// Field names match RunRequest in services/executor, which refuses unknown fields.
export interface RunJob {
  execution_id: string
  room_id: string
  user_id: string
  language: 'PYTHON' | 'CPP' | 'JAVA' | 'JAVASCRIPT'
  entry_path: string
  files: Array<{ path: string; content: string }>
  stdin: string
}

// Field names match ReviewRequest in services/executor.
export interface ReviewJob {
  review_id: string
  mode: 'REVIEW' | 'EXPLAIN' | 'WHY_FAILING'
  language: RunJob['language']
  code: string
  error_output: string
  practice: boolean
}

export interface ExecutionQueue {
  enqueueRun(job: RunJob): Promise<void>
  enqueueJudge(submissionId: string): Promise<void>
  enqueueReview(job: ReviewJob): Promise<void>
  waitingCount(): Promise<number>
}

export class BullExecutionQueue implements ExecutionQueue {
  private readonly run: Queue
  private readonly judge: Queue
  private readonly review: Queue

  constructor(connection: Redis) {
    this.run = new Queue(EXECUTION_QUEUES.run, { connection })
    this.judge = new Queue(EXECUTION_QUEUES.judge, { connection })
    this.review = new Queue(EXECUTION_QUEUES.review, { connection })
  }

  async enqueueRun(job: RunJob): Promise<void> {
    await this.run.add('run', job, {
      // The execution id as job id, so a repeated enqueue cannot create a second job.
      jobId: job.execution_id,
      // A program failing is a result, not a job failure. The only retry is the one BullMQ
      // makes after a worker crash, which is limited by maxStalledCount on the worker.
      attempts: 1,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    })
  }

  async enqueueJudge(submissionId: string): Promise<void> {
    // Only the id: workers fetch the source and hidden tests from the API when they start.
    await this.judge.add(
      'judge',
      { submission_id: submissionId },
      {
        jobId: submissionId,
        attempts: 1,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 1000 },
      },
    )
  }

  async enqueueReview(job: ReviewJob): Promise<void> {
    await this.review.add('review', job, {
      jobId: job.review_id,
      attempts: 1,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    })
  }

  waitingCount(): Promise<number> {
    return this.run.getWaitingCount()
  }

  async close(): Promise<void> {
    await Promise.all([this.run.close(), this.judge.close(), this.review.close()])
  }
}

export function watchQueueFailures(
  queue: string,
  redisUrl: string,
  onFailed: (executionId: string) => void | Promise<void>,
): QueueEvents {
  const { hostname, port, username, password, pathname } = new URL(redisUrl)
  const events = new QueueEvents(queue, {
    connection: {
      host: hostname,
      port: Number(port || 6379),
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      db: Number(pathname.slice(1) || 0),
    },
  })
  events.on('failed', ({ jobId }) => void onFailed(jobId))
  return events
}
