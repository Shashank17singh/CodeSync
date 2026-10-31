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

export interface ExecutionQueue {
  enqueueRun(job: RunJob): Promise<void>
  waitingCount(): Promise<number>
}

export class BullExecutionQueue implements ExecutionQueue {
  private readonly run: Queue

  constructor(connection: Redis) {
    this.run = new Queue(EXECUTION_QUEUES.run, { connection })
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

  waitingCount(): Promise<number> {
    return this.run.getWaitingCount()
  }

  close(): Promise<void> {
    return this.run.close()
  }
}

export function watchRunFailures(
  redisUrl: string,
  onFailed: (executionId: string) => void | Promise<void>,
): QueueEvents {
  const { hostname, port, username, password, pathname } = new URL(redisUrl)
  const events = new QueueEvents(EXECUTION_QUEUES.run, {
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
