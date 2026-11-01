import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createPrismaClient } from '@codesync/db'
import jwt from 'jsonwebtoken'

// Creates the rooms and users for the k6 tests, directly in the database of a TEST deployment,
// and writes their tokens to results/targets.json. Never point this at production.
const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const databaseUrl = required('DATABASE_URL')
const collabSecret = required('COLLAB_TOKEN_SECRET')
const accessSecret = required('ACCESS_TOKEN_SECRET')
const ROOMS = Number(process.env['ROOMS'] ?? 10)
const USERS = Number(process.env['USERS'] ?? 50)
const RUNS = Number(process.env['RUNS'] ?? 200)
const TOKEN_SECONDS = 2 * 60 * 60

const prisma = createPrismaClient(databaseUrl)

async function createUser(): Promise<string> {
  const id = randomUUID()
  await prisma.user.create({
    data: { id, email: `${id}@loadtest.local`, displayName: 'Load', emailVerifiedAt: new Date() },
  })
  return id
}

async function createRoom(ownerId: string, memberIds: string[], source: string) {
  const projectId = randomUUID()
  const fileId = randomUUID()
  const roomId = randomUUID()
  await prisma.room.create({
    data: {
      id: roomId,
      name: `Load ${roomId.slice(0, 8)}`,
      ownerId,
      members: {
        create: [ownerId, ...memberIds].map((userId) => ({ userId, role: 'EDITOR' as const })),
      },
      projects: {
        create: {
          id: projectId,
          name: 'main',
          files: { create: { id: fileId, path: 'main.py' } },
        },
      },
    },
  })
  return { roomId, projectId, fileId, source }
}

const collab: Array<{ projectId: string; fileId: string; token: string }> = []
for (let room = 0; room < ROOMS; room++) {
  const users = await Promise.all(Array.from({ length: USERS }, createUser))
  const [owner, ...members] = users as [string, ...string[]]
  const { roomId, projectId, fileId } = await createRoom(owner, members, '')
  for (const userId of users) {
    const token = jwt.sign({ name: 'Load', roomId, projectId, role: 'editor' }, collabSecret, {
      algorithm: 'HS256',
      subject: userId,
      audience: 'collab',
      expiresIn: TOKEN_SECONDS,
    })
    collab.push({ projectId, fileId, token })
  }
}

const execution: Array<{ roomId: string; projectId: string; accessToken: string }> = []
for (let run = 0; run < RUNS; run++) {
  const userId = await createUser()
  const { roomId, projectId } = await createRoom(userId, [], 'print("load")\n')
  const accessToken = jwt.sign({}, accessSecret, {
    algorithm: 'HS256',
    subject: userId,
    audience: 'api',
    expiresIn: TOKEN_SECONDS,
  })
  execution.push({ roomId, projectId, accessToken })
}

mkdirSync('results', { recursive: true })
writeFileSync('results/targets.json', JSON.stringify({ collab, execution }))
console.log(`seeded ${collab.length} typists and ${execution.length} runs`)
await prisma.$disconnect()
