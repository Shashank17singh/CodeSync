import { z } from 'zod'

export const COLLAB_LIMITS = {
  maxUsersPerRoom: 50,
  maxFileChars: 2 * 1024 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
  maxAwarenessStateBytes: 4 * 1024,
  maxAwarenessClientsPerConnection: 4,
  maxYjsClientsPerConnection: 64,
  maxPendingUpdateBytes: 1024 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxDeniedWrites: 3,
  messagesPerSecond: 60,
  messageBurst: 120,
  bytesPerSecond: 4 * 1024 * 1024,
  byteBurst: 16 * 1024 * 1024,
  awarenessPerSecond: 25,
  awarenessBurst: 40,
} as const

export const COMPACTION = {
  intervalMs: 30_000,
  maxPendingUpdates: 500,
} as const

// Types 0-3 belong to y-websocket. Type 4 is the CodeSync application channel.
export const WsMessageType = {
  sync: 0,
  awareness: 1,
  auth: 2,
  queryAwareness: 3,
  app: 4,
} as const

// y-websocket stops reconnecting on 4400-4499, so only permanent failures use that range.
export const WsCloseCode = {
  tokenExpired: 4001,
  serverDraining: 4002,
  malformed: 4400,
  invalidToken: 4401,
  forbidden: 4403,
  roomFull: 4409,
  frameTooLarge: 4413,
  rateLimited: 4429,
} as const

export const YDOC_ROOTS = {
  files: 'files',
  tree: 'tree',
} as const

export const collabRoleSchema = z.enum(['owner', 'editor', 'viewer'])
export type CollabRole = z.infer<typeof collabRoleSchema>

export const collabTokenClaimsSchema = z.object({
  sub: z.uuid(),
  name: z.string().min(1).max(80),
  roomId: z.uuid(),
  projectId: z.uuid(),
  role: collabRoleSchema,
})
export type CollabTokenClaims = z.infer<typeof collabTokenClaimsSchema>

export const COLLAB_TOKEN_AUDIENCE = 'collab'
export const COLLAB_TOKEN_TTL_SECONDS = 300

export const treeEntrySchema = z.object({
  path: z.string().min(1).max(1024),
  kind: z.enum(['FILE', 'DIRECTORY']),
})
export type TreeEntry = z.infer<typeof treeEntrySchema>

// Published on room:{roomId}:control by the API. Tree changes carry no data:
// File rows are canonical, so collab re-reads them.
export const roomControlSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('role.changed'),
    userId: z.uuid(),
    role: collabRoleSchema,
  }),
  z.object({ type: z.literal('member.removed'), userId: z.uuid() }),
  z.object({ type: z.literal('room.locked'), locked: z.boolean() }),
  z.object({ type: z.literal('room.deleted') }),
  z.object({ type: z.literal('tree.changed'), projectId: z.uuid() }),
])
export type RoomControl = z.infer<typeof roomControlSchema>

// Redis names shared by collab and the API, which both write to a project's document.
export const collabKeys = {
  updates: (projectId: string): string => `collab:${projectId}:updates`,
  slots: (projectId: string): string => `collab:${projectId}:slots`,
  sync: (projectId: string): string => `collab:${projectId}:sync`,
  awareness: (projectId: string): string => `collab:${projectId}:awareness`,
  control: (roomId: string): string => `room:${roomId}:control`,
  events: (roomId: string): string => `room:${roomId}:events`,
  lock: (name: string): string => `lock:${name}`,
  treeLock: (projectId: string): string => `tree:${projectId}`,
}

// Every pub/sub payload starts with the sender's id, so a sender can skip its own messages.
export const BUS_SENDER_ID_BYTES = 16

// Published by the executor and forwarded by collab to everyone in the room.
export const executionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exec.started'),
    executionId: z.uuid(),
    userId: z.uuid(),
    language: z.enum(['PYTHON', 'CPP', 'JAVA', 'JAVASCRIPT']),
  }),
  z.object({
    type: z.literal('exec.output'),
    executionId: z.uuid(),
    stream: z.enum(['stdout', 'stderr', 'compile']),
    seq: z.number().int().positive(),
    data: z.string().max(16_000),
  }),
  z.object({
    type: z.literal('exec.finished'),
    executionId: z.uuid(),
    status: z.enum([
      'OK',
      'COMPILE_ERROR',
      'RUNTIME_ERROR',
      'TIME_LIMIT_EXCEEDED',
      'MEMORY_LIMIT_EXCEEDED',
      'OUTPUT_LIMIT_EXCEEDED',
      'INTERNAL_ERROR',
    ]),
    exitCode: z.number().int().nullable(),
    timeMs: z.number().int().nullable(),
    memoryKb: z.number().int().nullable(),
  }),
])
export type ExecutionEvent = z.infer<typeof executionEventSchema>

export const appEnvelopeSchema = z.object({
  v: z.literal(1),
  t: z.string().min(1).max(64),
  id: z.string().max(64).optional(),
  d: z.unknown().optional(),
})
export type AppEnvelope = z.infer<typeof appEnvelopeSchema>
