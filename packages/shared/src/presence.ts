import { z } from 'zod'

export const PRESENCE_TIMINGS = {
  cursorThrottleMs: 50,
  idleAfterMs: 60_000,
  labelFadeMs: 3_000,
} as const

// Every color carries white label text at a contrast of at least 4.5:1.
export const PRESENCE_PALETTE = [
  '#B91C1C',
  '#C2410C',
  '#A16207',
  '#15803D',
  '#0F766E',
  '#0369A1',
  '#1D4ED8',
  '#6D28D9',
  '#A21CAF',
  '#BE123C',
] as const

export type PresenceColor = (typeof PRESENCE_PALETTE)[number]

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

export function colorIndexForUser(userId: string): number {
  let hash = FNV_OFFSET
  for (let index = 0; index < userId.length; index++) {
    hash = Math.imul(hash ^ userId.charCodeAt(index), FNV_PRIME)
  }
  return (hash >>> 0) % PRESENCE_PALETTE.length
}

export function colorForUser(userId: string): PresenceColor {
  return PRESENCE_PALETTE[colorIndexForUser(userId)] as PresenceColor
}

export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = [...(words[0] ?? '')][0] ?? '?'
  const last = words.length > 1 ? ([...(words[words.length - 1] ?? '')][0] ?? '') : ''
  return `${first}${last}`.toUpperCase()
}

const yjsIdSchema = z.object({
  client: z.number().int().nonnegative(),
  clock: z.number().int().nonnegative(),
})

const relativePositionSchema = z.object({
  type: yjsIdSchema.nullish(),
  tname: z.string().max(64).nullish(),
  item: yjsIdSchema.nullish(),
  assoc: z.number().int().optional(),
})
export type RelativePositionJson = z.infer<typeof relativePositionSchema>

export const presenceCursorSchema = z.object({
  anchor: relativePositionSchema,
  head: relativePositionSchema,
})
export type PresenceCursor = z.infer<typeof presenceCursorSchema>

export const presenceStatusSchema = z.enum(['active', 'idle', 'away'])
export type PresenceStatus = z.infer<typeof presenceStatusSchema>

// The fields a client may set. Unknown keys are stripped, which removes any claimed identity.
export const clientPresenceSchema = z.object({
  fileId: z.uuid().nullable().optional(),
  cursor: presenceCursorSchema.nullable().optional(),
  status: presenceStatusSchema.optional(),
})
export type ClientPresence = z.infer<typeof clientPresenceSchema>

export const presenceStateSchema = clientPresenceSchema.extend({
  userId: z.uuid(),
  name: z.string(),
  initials: z.string(),
  color: z.string(),
})
export type PresenceState = z.infer<typeof presenceStateSchema>
