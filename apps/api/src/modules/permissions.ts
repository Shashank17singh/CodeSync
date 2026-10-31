import type { CollabRole } from '@codesync/shared'

export const ACTIONS = [
  'room.view',
  'room.join',
  'room.update',
  'room.delete',
  'room.lock',
  'room.transfer',
  'member.list',
  'member.role',
  'member.remove',
  'invite.manage',
  'project.create',
  'project.view',
  'project.delete',
  'file.read',
  'file.write',
  'file.import',
  'file.export',
  'collab.token',
  'execution.run',
  'chat.send',
] as const

export type Action = (typeof ACTIONS)[number]

const VIEWER: readonly Action[] = [
  'room.view',
  'member.list',
  'project.view',
  'file.read',
  'file.export',
  'collab.token',
  'chat.send',
]

const EDITOR: readonly Action[] = [
  ...VIEWER,
  'project.create',
  'file.write',
  'file.import',
  'execution.run',
]

const OWNER: readonly Action[] = [
  ...EDITOR,
  'room.update',
  'room.delete',
  'room.lock',
  'room.transfer',
  'member.role',
  'member.remove',
  'invite.manage',
  'project.delete',
]

const ROLE_ACTIONS: Record<CollabRole, ReadonlySet<Action>> = {
  owner: new Set(OWNER),
  editor: new Set(EDITOR),
  viewer: new Set(VIEWER),
}

// A lock makes everyone a viewer of the content. The owner keeps room administration, because
// otherwise nobody could ever unlock the room.
const BLOCKED_WHILE_LOCKED: ReadonlySet<Action> = new Set([
  'project.create',
  'project.delete',
  'file.write',
  'file.import',
  'execution.run',
])

export interface PermissionContext {
  role: CollabRole | null
  locked: boolean
  isPublic: boolean
}

export function isAllowed(action: Action, { role, locked, isPublic }: PermissionContext): boolean {
  if (role === null) return isPublic && (action === 'room.view' || action === 'room.join')
  return ROLE_ACTIONS[role].has(action) && !(locked && BLOCKED_WHILE_LOCKED.has(action))
}
