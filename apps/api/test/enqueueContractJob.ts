// Adds one job the way the API does, for the Node to Python test in services/executor.
import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import { Redis } from 'ioredis'

const [redisUrl, queueName, executionId] = process.argv.slice(2) as [string, string, string]

const connection = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
const queue = new Queue(queueName, { connection })
await queue.add(
  'run',
  {
    execution_id: executionId,
    room_id: randomUUID(),
    user_id: randomUUID(),
    language: 'PYTHON',
    entry_path: 'main.py',
    files: [{ path: 'main.py', content: 'print("नमस्ते")\n' }],
    stdin: '',
  },
  { jobId: executionId, attempts: 1 },
)
await queue.close()
await connection.quit()
