import {
  FollowController,
  type CollabSession,
  type PresencePeer,
} from '@codesync/collab-client'
import type { TreeEntry } from '@codesync/shared'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { CollabEditor } from './collabEditor'
import { PresenceSidebar } from './PresenceSidebar'

const NO_FOLLOW = (): null => null
const NO_SUBSCRIPTION = (): (() => void) => () => undefined

export function useFileTree(session: CollabSession): ReadonlyMap<string, TreeEntry> {
  const snapshot = useRef<ReadonlyMap<string, TreeEntry>>(new Map(session.tree.entries()))
  const subscribe = useCallback(
    (listener: () => void) => {
      const onChange = (): void => {
        snapshot.current = new Map(session.tree.entries())
        listener()
      }
      onChange()
      session.tree.observe(onChange)
      return () => session.tree.unobserve(onChange)
    },
    [session],
  )
  return useSyncExternalStore(subscribe, () => snapshot.current)
}

export function usePresenceActivity(session: CollabSession): void {
  useEffect(() => {
    const onActivity = (): void => session.presence.noteActivity()
    const onVisibility = (): void => session.presence.setVisible(!document.hidden)
    window.addEventListener('keydown', onActivity)
    window.addEventListener('pointerdown', onActivity)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('pointerdown', onActivity)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [session])
}

export interface PresenceWorkspaceProps {
  session: CollabSession
  self: { userId: string; name: string }
  theme?: 'vs' | 'vs-dark'
}

export function PresenceWorkspace({ session, self, theme = 'vs' }: PresenceWorkspaceProps) {
  const container = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<CollabEditor | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [follow, setFollow] = useState<FollowController | null>(null)
  const tree = useFileTree(session)
  const peers: readonly PresencePeer[] = useSyncExternalStore(
    session.presence.subscribe,
    session.presence.getPeers,
  )
  const following = useSyncExternalStore(
    follow?.subscribe ?? NO_SUBSCRIPTION,
    follow?.getFollowing ?? NO_FOLLOW,
  )

  // Loaded on demand because Monaco is by far the largest dependency.
  useEffect(() => {
    let disposed = false
    let created: CollabEditor | null = null
    import('./collabEditor')
      .then(({ CollabEditor }) => {
        if (disposed || !container.current) return
        created = new CollabEditor({ container: container.current, session, theme })
        setEditor(created)
      })
      .catch(() => setLoadFailed(true))
    return () => {
      disposed = true
      created?.dispose()
      setEditor(null)
    }
  }, [session, theme])

  useEffect(() => {
    if (!editor) return undefined
    const controller = new FollowController({
      doc: session.doc,
      presence: session.presence,
      onOpenFile: (fileId) => {
        editor.openFile(fileId)
        setActiveFileId(fileId)
      },
      onReveal: (fileId, cursor) => editor.reveal(fileId, cursor),
    })
    setFollow(controller)
    return () => {
      controller.destroy()
      setFollow(null)
    }
  }, [editor, session])

  useEffect(() => editor?.renderPeers(peers), [editor, peers])

  usePresenceActivity(session)

  const files = useMemo(
    () =>
      [...tree]
        .filter(([, entry]) => entry.kind === 'FILE')
        .sort(([, a], [, b]) => a.path.localeCompare(b.path)),
    [tree],
  )

  const open = (fileId: string): void => {
    editor?.openFile(fileId)
    setActiveFileId(fileId)
    editor?.focus()
  }

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Files" className="w-48 shrink-0 border-r border-line p-2">
        <ul>
          {files.map(([id, entry]) => (
            <li key={id}>
              <button
                type="button"
                disabled={!editor}
                aria-current={id === activeFileId ? 'true' : undefined}
                onClick={() => open(id)}
                className={`w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-raised disabled:opacity-50 ${
                  id === activeFileId ? 'bg-raised font-medium' : ''
                }`}
              >
                {entry.path}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="relative min-w-0 flex-1">
        {/* Monaco renders nothing until a model is set, so the hint fills the empty state. */}
        <div ref={container} data-testid="editor" className="absolute inset-0" />
        {!activeFileId && (
          <p role={loadFailed ? 'alert' : 'status'} className="p-4 text-sm text-muted">
            {loadFailed
              ? 'The editor failed to load. Reload the page to try again.'
              : editor
                ? 'Select a file to start editing.'
                : 'Loading editor…'}
          </p>
        )}
      </div>
      <aside className="w-64 shrink-0 overflow-y-auto border-l border-line">
        <PresenceSidebar
          self={self}
          peers={peers}
          filePath={(fileId) => tree.get(fileId)?.path}
          following={following}
          onFollow={(clientId) => follow?.follow(clientId)}
          onStopFollowing={() => follow?.stop()}
        />
      </aside>
    </div>
  )
}
