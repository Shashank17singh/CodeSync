import type { PresencePeer } from '@codesync/collab-client'
import { colorForUser, initialsFor, type PresenceStatus } from '@codesync/shared'

const STATUS_LABEL: Record<PresenceStatus, string> = {
  active: 'Active',
  idle: 'Idle',
  away: 'Away',
}

const STATUS_DOT: Record<PresenceStatus, string> = {
  active: 'bg-ok',
  idle: 'bg-warn',
  away: 'bg-muted',
}

interface AvatarProps {
  initials: string
  color: string
  status: PresenceStatus
}

function Avatar({ initials, color, status }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
      style={{ backgroundColor: color }}
    >
      {initials}
      <span
        className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${STATUS_DOT[status]}`}
      />
    </span>
  )
}

export interface PresenceSidebarProps {
  self: { userId: string; name: string }
  peers: readonly PresencePeer[]
  filePath: (fileId: string) => string | undefined
  following: number | null
  onFollow: (clientId: number) => void
  onStopFollowing: () => void
}

export function PresenceSidebar({
  self,
  peers,
  filePath,
  following,
  onFollow,
  onStopFollowing,
}: PresenceSidebarProps) {
  return (
    <section aria-label="Online users" className="flex flex-col gap-2 p-3">
      <h2 className="text-sm font-medium text-muted">
        Online ({peers.length + 1})
      </h2>
      <ul className="flex flex-col gap-1">
        <li className="flex items-center gap-2 rounded px-2 py-1.5">
          <Avatar
            initials={initialsFor(self.name)}
            color={colorForUser(self.userId)}
            status="active"
          />
          <span className="min-w-0 truncate text-sm">{self.name} (you)</span>
        </li>
        {peers.map((peer) => {
          const isFollowed = following === peer.clientId
          const status = peer.status ?? 'active'
          const location = peer.fileId ? filePath(peer.fileId) : undefined
          return (
            <li key={peer.clientId}>
              <button
                type="button"
                aria-pressed={isFollowed}
                onClick={() => (isFollowed ? onStopFollowing() : onFollow(peer.clientId))}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-raised ${
                  isFollowed ? 'bg-accent-soft' : ''
                }`}
              >
                <Avatar initials={peer.initials} color={peer.color} status={status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{peer.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {STATUS_LABEL[status]}
                    {location ? ` · ${location}` : ''}
                  </span>
                </span>
                <span className={`shrink-0 text-xs font-medium ${isFollowed ? 'text-ink' : 'text-accent'}`}>
                  {isFollowed ? 'Following' : 'Follow'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
