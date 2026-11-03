import { FollowController, type CollabSession, type PresencePeer } from '@codesync/collab-client'
import { WsCloseCode } from '@codesync/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { Link, useParams } from 'react-router'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { Badge, Button, ErrorNotice, Loading } from '../../components/ui'
import { api } from '../../lib/api'
import { useMediaQuery, usePreferences } from '../../lib/preferences'
import { useSession } from '../../lib/session'
import type { ReviewFinding, RoomDetail, User } from '../../lib/types'
import type { CollabEditor, LineMarker } from '../presence/collabEditor'
import { PresenceSidebar } from '../presence/PresenceSidebar'
import { useFileTree, usePresenceActivity } from '../presence/PresenceWorkspace'
import { ChatPanel } from './ChatPanel'
import { CommentsPanel } from './CommentsPanel'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'
import { HistoryPanel } from './HistoryPanel'
import { useChannelEvent, useCollabSession, useConnection } from './hooks'
import { EMPTY_TABS, closeTab, keepExisting, openTab, type ConnectionState, type Tabs } from './model'
import { ReviewPanel } from './ReviewPanel'
import { RunPanel } from './RunPanel'
import { ShareDialog } from './ShareDialog'

const PHONE_QUERY = '(max-width: 767px)'
const NOTICE_MS = 5_000
const NO_FOLLOW = (): null => null
const NO_SUBSCRIPTION = (): (() => void) => () => undefined

const CONNECTION_LABELS: Record<ConnectionState, { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'bg-ok' },
  reconnecting: { label: 'Reconnecting', className: 'bg-warn' },
  offline: { label: 'Offline', className: 'bg-danger' },
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const { label, className } = CONNECTION_LABELS[state]
  return (
    <span role="status" className="flex items-center gap-1 text-xs text-muted">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  )
}

const RIGHT_TABS = ['Users', 'Chat', 'Comments', 'AI Review', 'History'] as const
type RightTab = (typeof RIGHT_TABS)[number]

interface TabStripProps {
  tabs: Tabs
  pathOf: (fileId: string) => string | undefined
  onSelect: (fileId: string) => void
  onClose: (fileId: string) => void
}

function TabStrip({ tabs, pathOf, onSelect, onClose }: TabStripProps) {
  return (
    <div role="group" aria-label="Open files" className="flex overflow-x-auto border-b border-line">
      {tabs.open.map((id) => {
        const path = pathOf(id) ?? ''
        const active = id === tabs.active
        return (
          <span
            key={id}
            className={`flex shrink-0 items-center border-r border-line text-sm ${
              active ? 'bg-canvas font-medium' : 'text-muted'
            }`}
          >
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              title={path}
              onClick={() => onSelect(id)}
              className="py-1 pr-1 pl-2"
            >
              {path.split('/').pop()}
            </button>
            <button
              type="button"
              aria-label={`Close ${path}`}
              onClick={() => onClose(id)}
              className="px-1.5 hover:text-ink"
            >
              ×
            </button>
          </span>
        )
      })}
    </div>
  )
}

interface WorkspaceProps {
  room: RoomDetail
  session: CollabSession
  self: User
  projectId: string
}

function Workspace({ room, session, self, projectId }: WorkspaceProps) {
  const entries = useFileTree(session)
  usePresenceActivity(session)
  const peers: readonly PresencePeer[] = useSyncExternalStore(
    session.presence.subscribe,
    session.presence.getPeers,
  )
  const connection = useConnection(session)
  const isPhone = useMediaQuery(PHONE_QUERY)
  const runShortcut = usePreferences((state) => state.runShortcut)

  const [panes, setPanes] = useState<[Tabs, Tabs]>([EMPTY_TABS, EMPTY_TABS])
  const [split, setSplit] = useState(false)
  const [focused, setFocused] = useState<0 | 1>(0)
  const [editors, setEditors] = useState<[CollabEditor | null, CollabEditor | null]>([null, null])
  const [rightTab, setRightTab] = useState<RightTab>('Users')
  const [phoneTab, setPhoneTab] = useState<'Code' | 'Chat'>('Code')
  const [unread, setUnread] = useState(0)
  const [shareOpen, setShareOpen] = useState(false)
  const [commentLines, setCommentLines] = useState<number[]>([])
  const [review, setReview] = useState<{ fileId: string | null; findings: readonly ReviewFinding[] }>({
    fileId: null,
    findings: [],
  })
  const [blame, setBlame] = useState<{ fileId: string | null; markers: readonly LineMarker[] }>({
    fileId: null,
    markers: [],
  })
  const [notice, setNotice] = useState<string | null>(null)
  const [follow, setFollow] = useState<FollowController | null>(null)
  const runRef = useRef<(() => void) | null>(null)

  const isOwner = room.role === 'owner'
  const canEdit = room.role !== 'viewer' && room.lockedAt === null && !isPhone
  const members = useQuery({
    queryKey: ['members', room.id],
    queryFn: () =>
      api<{ members: Array<{ id: string; displayName: string }> }>(`/rooms/${room.id}/members`),
  })
  const memberList = useMemo(() => members.data?.members ?? [], [members.data])
  const names = useMemo(
    () => new Map(memberList.map((member) => [member.id, member.displayName])),
    [memberList],
  )

  const activePane = split ? focused : 0
  const activeFileId = panes[activePane].active
  const activeEditor = editors[activePane]
  const pathOf = useCallback((fileId: string) => entries.get(fileId)?.path, [entries])

  const updatePane = useCallback((pane: 0 | 1, change: (tabs: Tabs) => Tabs) => {
    setPanes((current) => {
      const next: [Tabs, Tabs] = [current[0], current[1]]
      next[pane] = change(current[pane])
      return next
    })
  }, [])

  const open = useCallback(
    (fileId: string, pane: 0 | 1 = activePane) => updatePane(pane, (tabs) => openTab(tabs, fileId)),
    [activePane, updatePane],
  )

  // Someone else can delete a file that is open here.
  useEffect(() => {
    setPanes(
      ([first, second]) =>
        [
          keepExisting(first, (id) => entries.has(id)),
          keepExisting(second, (id) => entries.has(id)),
        ] as [Tabs, Tabs],
    )
  }, [entries])

  useEffect(() => {
    const first = [...entries].find(([, entry]) => entry.kind === 'FILE')
    if (first && panes[0].active === null && panes[0].open.length === 0) open(first[0], 0)
  }, [entries, panes, open])

  const primary = editors[0]
  useEffect(() => {
    if (!primary) return undefined
    const controller = new FollowController({
      doc: session.doc,
      presence: session.presence,
      onOpenFile: (fileId) => open(fileId, 0),
      onReveal: (fileId, cursor) => primary.reveal(fileId, cursor),
    })
    setFollow(controller)
    return () => {
      controller.destroy()
      setFollow(null)
    }
  }, [primary, session, open])
  const following = useSyncExternalStore(
    follow?.subscribe ?? NO_SUBSCRIPTION,
    follow?.getFollowing ?? NO_FOLLOW,
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const matches =
        runShortcut === 'f5' ? event.key === 'F5' : event.ctrlKey && event.key === 'Enter'
      if (!matches || event.defaultPrevented) return
      event.preventDefault()
      runRef.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runShortcut])

  const onRunKey = useCallback(
    (key: 'ctrl-enter' | 'f5') => {
      if (key === runShortcut) runRef.current?.()
    },
    [runShortcut],
  )

  useChannelEvent(
    session,
    'notify.created',
    useCallback(() => setNotice('You were mentioned in chat'), []),
  )
  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const onLines = useCallback((lines: number[]) => setCommentLines(lines), [])
  const onFindings = useCallback(
    (fileId: string | null, findings: readonly ReviewFinding[]) => setReview({ fileId, findings }),
    [],
  )

  const onBlame = useCallback(
    (fileId: string | null, markers: readonly LineMarker[]) => setBlame({ fileId, markers }),
    [],
  )

  const markersFor = useCallback(
    (fileId: string | null): readonly LineMarker[] => {
      const reviewMarkers: LineMarker[] =
        fileId !== null && review.fileId === fileId
          ? review.findings.map((finding) => ({
              line: finding.line_start,
              endLine: finding.line_end,
              kind: finding.severity,
              message: finding.message,
            }))
          : []
      const comments: LineMarker[] =
        fileId === activeFileId
          ? commentLines.map((line) => ({ line, kind: 'comment' as const }))
          : []
      const authors = fileId !== null && blame.fileId === fileId ? blame.markers : []
      return [...comments, ...reviewMarkers, ...authors]
    },
    [review, commentLines, activeFileId, blame],
  )
  const firstMarkers = useMemo(() => markersFor(panes[0].active), [markersFor, panes])
  const secondMarkers = useMemo(() => markersFor(panes[1].active), [markersFor, panes])

  const setFirstEditor = useCallback(
    (editor: CollabEditor | null) => setEditors(([, second]) => [editor, second]),
    [],
  )
  const setSecondEditor = useCallback(
    (editor: CollabEditor | null) => setEditors(([first]) => [first, editor]),
    [],
  )

  const showComments = useCallback(() => setRightTab('Comments'), [])

  const onTabKey = (event: ReactKeyboardEvent): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    const next = (RIGHT_TABS.indexOf(rightTab) + step + RIGHT_TABS.length) % RIGHT_TABS.length
    setRightTab(RIGHT_TABS[next] as RightTab)
    const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')
    tabs?.[next]?.focus()
  }

  const chat = (visible: boolean) => (
    <ChatPanel
      session={session}
      roomId={room.id}
      selfId={self.id}
      isOwner={isOwner}
      visible={visible}
      members={memberList}
      onUnread={setUnread}
    />
  )

  const topBar = (
    <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
      <Link to="/" className="text-sm text-muted underline">
        Rooms
      </Link>
      <h1 className="truncate font-medium">{room.name}</h1>
      <Badge>{room.role}</Badge>
      {room.lockedAt && <Badge>locked</Badge>}
      <ConnectionBadge state={connection} />
      {notice && (
        <p role="status" className="text-xs text-accent">
          {notice}
        </p>
      )}
      <span className="ml-auto flex gap-1">
        {!isPhone && (
          <Button
            aria-pressed={split}
            onClick={() => {
              if (!split && panes[0].active) open(panes[0].active, 1)
              setSplit(!split)
              setFocused(0)
            }}
          >
            Split
          </Button>
        )}
        {isOwner && <Button onClick={() => setShareOpen(true)}>Share</Button>}
      </span>
      <ShareDialog
        roomId={room.id}
        profanityFilter={room.profanityFilter}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />
    </header>
  )

  if (isPhone) {
    return (
      <div className="flex h-dvh flex-col">
        {topBar}
        <div role="tablist" aria-label="View" className="flex border-b border-line bg-surface">
          {(['Code', 'Chat'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={phoneTab === tab}
              onClick={() => setPhoneTab(tab)}
              className={`flex-1 py-2 text-sm ${phoneTab === tab ? 'font-medium' : 'text-muted'}`}
            >
              {tab}
              {tab === 'Chat' && unread > 0 ? ` (${unread})` : ''}
            </button>
          ))}
        </div>
        <div className={phoneTab === 'Code' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <label className="p-2 text-sm">
            <span className="sr-only">File</span>
            <select
              value={panes[0].active ?? ''}
              onChange={(event) => open(event.target.value, 0)}
              className="w-full rounded border border-line-strong bg-deep text-ink px-2 py-1"
            >
              {[...entries]
                .filter(([, entry]) => entry.kind === 'FILE')
                .map(([id, entry]) => (
                  <option key={id} value={id}>
                    {entry.path}
                  </option>
                ))}
            </select>
          </label>
          <div className="min-h-0 flex-1">
            <EditorPane
              session={session}
              fileId={panes[0].active}
              readOnly
              peers={peers}
              markers={firstMarkers}
              onEditor={setFirstEditor}
              onRunKey={onRunKey}
              onGlyphClick={showComments}
            />
          </div>
        </div>
        <div className={phoneTab === 'Chat' ? 'min-h-0 flex-1 bg-surface' : 'hidden'}>
          {chat(phoneTab === 'Chat')}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col">
      {topBar}
      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel id="files" defaultSize="18" minSize="10">
          <FileTree
            entries={entries}
            projectId={projectId}
            canWrite={canEdit}
            activeFileId={activeFileId}
            onOpen={(fileId) => open(fileId)}
          />
        </Panel>
        <Separator className="w-1 bg-line" />
        <Panel id="center" defaultSize="56" minSize="30">
          <Group orientation="vertical">
            <Panel id="editors" defaultSize="70" minSize="20">
              <Group orientation="horizontal">
                <Panel id="first-editor" minSize="20">
                  <div className="flex h-full min-h-0 flex-col bg-surface">
                    <TabStrip
                      tabs={panes[0]}
                      pathOf={pathOf}
                      onSelect={(fileId) => open(fileId, 0)}
                      onClose={(fileId) => updatePane(0, (tabs) => closeTab(tabs, fileId))}
                    />
                    <div className="min-h-0 flex-1">
                      <ErrorBoundary fallback="The editor stopped working.">
                        <EditorPane
                          session={session}
                          fileId={panes[0].active}
                          readOnly={!canEdit}
                          peers={peers}
                          markers={firstMarkers}
                          onEditor={setFirstEditor}
                          onFocus={() => setFocused(0)}
                          onRunKey={onRunKey}
                          onGlyphClick={showComments}
                        />
                      </ErrorBoundary>
                    </div>
                  </div>
                </Panel>
                {split && (
                  <>
                    <Separator className="w-1 bg-line" />
                    <Panel id="second-editor" minSize="20">
                      <div className="flex h-full min-h-0 flex-col bg-surface">
                        <TabStrip
                          tabs={panes[1]}
                          pathOf={pathOf}
                          onSelect={(fileId) => open(fileId, 1)}
                          onClose={(fileId) => updatePane(1, (tabs) => closeTab(tabs, fileId))}
                        />
                        <div className="min-h-0 flex-1">
                          <EditorPane
                            session={session}
                            fileId={panes[1].active}
                            readOnly={!canEdit}
                            peers={peers}
                            markers={secondMarkers}
                            onEditor={setSecondEditor}
                            onFocus={() => setFocused(1)}
                            onRunKey={onRunKey}
                            onGlyphClick={showComments}
                          />
                        </div>
                      </div>
                    </Panel>
                  </>
                )}
              </Group>
            </Panel>
            <Separator className="h-1 bg-line" />
            <Panel id="run" defaultSize="30" minSize="12">
              <RunPanel
                session={session}
                roomId={room.id}
                projectId={projectId}
                canRun={canEdit}
                entries={entries}
                activeFileId={activeFileId}
                runRef={runRef}
              />
            </Panel>
          </Group>
        </Panel>
        <Separator className="w-1 bg-line" />
        <Panel id="right" defaultSize="26" minSize="16">
          <div className="flex h-full min-h-0 flex-col bg-surface">
            <div
              role="tablist"
              aria-label="Side panel"
              className="flex overflow-x-auto border-b border-line"
            >
              {RIGHT_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={rightTab === tab}
                  tabIndex={rightTab === tab ? 0 : -1}
                  onClick={() => setRightTab(tab)}
                  onKeyDown={onTabKey}
                  className={`shrink-0 px-2 py-1.5 text-sm ${
                    rightTab === tab ? 'border-b-2 border-accent font-medium' : 'text-muted'
                  }`}
                >
                  {tab}
                  {tab === 'Chat' && unread > 0 ? ` (${unread})` : ''}
                </button>
              ))}
            </div>
            {/* Panels stay mounted, so chat keeps its history and unread count while hidden. */}
            <div className="min-h-0 flex-1">
              <div hidden={rightTab !== 'Users'} className="h-full overflow-y-auto">
                <PresenceSidebar
                  self={{ userId: self.id, name: self.displayName }}
                  peers={peers}
                  filePath={pathOf}
                  following={following}
                  onFollow={(clientId) => follow?.follow(clientId)}
                  onStopFollowing={() => follow?.stop()}
                />
              </div>
              <div hidden={rightTab !== 'Chat'} className="h-full">
                {chat(rightTab === 'Chat')}
              </div>
              <div hidden={rightTab !== 'Comments'} className="h-full">
                <CommentsPanel
                  session={session}
                  fileId={activeFileId}
                  selfId={self.id}
                  isOwner={isOwner}
                  names={names}
                  editor={activeEditor}
                  onLines={onLines}
                />
              </div>
              <div hidden={rightTab !== 'AI Review'} className="h-full">
                <ReviewPanel
                  session={session}
                  roomId={room.id}
                  projectId={projectId}
                  fileId={activeFileId}
                  path={activeFileId ? pathOf(activeFileId) : undefined}
                  canEdit={canEdit}
                  editor={activeEditor}
                  onFindings={onFindings}
                />
              </div>
              <div hidden={rightTab !== 'History'} className="h-full">
                <HistoryPanel
                  session={session}
                  projectId={projectId}
                  fileId={activeFileId}
                  canEdit={canEdit}
                  onBlame={onBlame}
                />
              </div>
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  )
}

export function WorkspacePage() {
  const { roomId = '' } = useParams()
  const self = useSession((state) => state.user)
  const client = useQueryClient()
  const room = useQuery({
    queryKey: ['room', roomId],
    queryFn: () => api<{ room: RoomDetail }>(`/rooms/${roomId}`),
  })
  const detail = room.data?.room
  const projectId = detail?.projects[0]?.id
  const needsJoin = detail !== undefined && detail.role === null

  // A public room opened from a link: joining makes the visitor a viewer.
  useEffect(() => {
    if (!needsJoin) return
    api(`/rooms/${roomId}/join`, { method: 'POST' })
      .then(() => client.invalidateQueries({ queryKey: ['room', roomId] }))
      .catch(() => undefined)
  }, [needsJoin, roomId, client])

  const { session, fatalCode, failed } = useCollabSession(
    roomId,
    needsJoin ? undefined : projectId,
  )

  if (room.error) {
    return (
      <div className="flex flex-col gap-2 p-6">
        <ErrorNotice error={room.error} />
        <Link to="/" className="text-sm underline">
          Back to your rooms
        </Link>
      </div>
    )
  }
  if (fatalCode !== null || failed) {
    const removed = fatalCode === WsCloseCode.forbidden
    return (
      <div className="flex flex-col gap-2 p-6">
        <ErrorNotice
          error={
            removed
              ? 'You no longer have access to this room.'
              : 'The connection to this room failed. Reload the page to try again.'
          }
        />
        <Link to="/" className="text-sm underline">
          Back to your rooms
        </Link>
      </div>
    )
  }
  if (!detail || !session || !self || !projectId) return <Loading label="Opening the room…" />
  return <Workspace room={detail} session={session} self={self} projectId={projectId} />
}
