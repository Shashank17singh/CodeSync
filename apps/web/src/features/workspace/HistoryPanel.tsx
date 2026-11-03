import type { CollabSession } from '@codesync/collab-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react'
import { Badge, Button, Dialog, ErrorNotice, Loading } from '../../components/ui'
import { api, apiDownload } from '../../lib/api'
import type { BlameRange, SnapshotRow } from '../../lib/types'
import type { LineMarker } from '../presence/collabEditor'
import { useChannelEvent } from './hooks'

const DiffView = lazy(async () => ({ default: (await import('./DiffView')).DiffView }))
const SnapshotView = lazy(async () => ({ default: (await import('./DiffView')).SnapshotView }))

const BLAME_REFRESH_MS = 10_000
const KIND_LABELS = { AUTO: 'Auto', RUN: 'Run', MANUAL: 'Checkpoint' }

interface Comparison {
  mode: 'view' | 'compare'
  snapshotId: string
  path: string
  content: string
}

export interface HistoryPanelProps {
  session: CollabSession
  projectId: string
  fileId: string | null
  canEdit: boolean
  onBlame: (fileId: string | null, markers: readonly LineMarker[]) => void
}

export function HistoryPanel({
  session,
  projectId,
  fileId,
  canEdit,
  onBlame,
}: HistoryPanelProps) {
  const client = useQueryClient()
  const [label, setLabel] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [undoId, setUndoId] = useState<string | null>(null)
  const [compare, setCompare] = useState<Comparison | null>(null)
  const [showBlame, setShowBlame] = useState(false)
  const snapshots = useQuery({
    queryKey: ['snapshots', projectId],
    queryFn: () =>
      api<{ snapshots: SnapshotRow[]; users: Record<string, string> }>(
        `/projects/${projectId}/snapshots`,
      ),
  })
  const blame = useQuery({
    queryKey: ['blame', fileId],
    enabled: showBlame && fileId !== null,
    queryFn: () =>
      api<{ ranges: BlameRange[]; users: Record<string, string> }>(`/files/${fileId}/blame`),
    refetchInterval: BLAME_REFRESH_MS,
  })

  // Shown beside the code in the editor, on the first line of each author's block.
  useEffect(() => {
    if (!showBlame || !blame.data) {
      onBlame(null, [])
      return
    }
    const { ranges, users: names } = blame.data
    onBlame(
      fileId,
      ranges.map((range) => ({
        line: range.startLine,
        kind: 'blame',
        message: range.userId ? (names[range.userId] ?? 'Someone') : 'Imported',
      })),
    )
  }, [showBlame, blame.data, fileId, onBlame])
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: ['snapshots', projectId] }),
    [client, projectId],
  )
  useChannelEvent(session, 'history.changed', refresh)

  const checkpoint = useMutation({
    mutationFn: () => api(`/projects/${projectId}/snapshots`, { method: 'POST', body: { label } }),
    onSuccess: async () => {
      setLabel('')
      await refresh()
    },
  })

  const view = async (snapshotId: string, mode: Comparison['mode']): Promise<void> => {
    setError(null)
    try {
      const file = await api<{ path: string; content: string }>(
        `/snapshots/${snapshotId}/files/${fileId}`,
      )
      setCompare({ mode, snapshotId, ...file })
    } catch (failure) {
      setError(failure)
    }
  }

  const restore = async (snapshotId: string, onlyFile: boolean): Promise<void> => {
    const scope = onlyFile ? 'this file' : 'the whole project'
    if (!window.confirm(`Restore ${scope} for everyone in the room?`)) return
    setError(null)
    try {
      const { undoSnapshotId } = await api<{ undoSnapshotId: string }>(
        `/snapshots/${snapshotId}/restore`,
        { method: 'POST', body: onlyFile ? { fileId } : {} },
      )
      setUndoId(undoSnapshotId)
      setCompare(null)
      await refresh()
    } catch (failure) {
      setError(failure)
    }
  }

  const undo = (): void => {
    if (!undoId) return
    const target = undoId
    setUndoId(null)
    api(`/snapshots/${target}/restore`, { method: 'POST', body: {} })
      .then(refresh)
      .catch(setError)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    checkpoint.mutate()
  }

  const users = snapshots.data?.users ?? {}

  return (
    <section aria-label="History" className="flex h-full min-h-0 flex-col">
      {canEdit && (
        <form onSubmit={submit} className="flex gap-1 border-b border-line p-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Checkpoint name</span>
            <input
              required
              maxLength={120}
              value={label}
              placeholder="Checkpoint name"
              onChange={(event) => setLabel(event.target.value)}
              className="w-full rounded border border-line-strong bg-deep text-ink px-2 py-1 text-sm"
            />
          </label>
          <Button type="submit" disabled={checkpoint.isPending}>
            Save
          </Button>
        </form>
      )}
      <div className="flex items-center gap-2 border-b border-line p-2">
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={showBlame}
            onChange={(event) => setShowBlame(event.target.checked)}
          />
          Who wrote each line
        </label>
        {undoId && (
          <Button className="ml-auto !px-1.5 !py-0.5" onClick={undo}>
            Undo restore
          </Button>
        )}
      </div>
      <ErrorNotice error={error ?? checkpoint.error ?? snapshots.error} />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {showBlame && blame.data && (
          <ul aria-label="Line authors" className="text-xs">
            {blame.data.ranges.map((range) => (
              <li key={range.startLine} className="flex justify-between gap-2 py-0.5">
                <span className="text-muted">
                  {range.startLine === range.endLine
                    ? `Line ${range.startLine}`
                    : `Lines ${range.startLine}–${range.endLine}`}
                </span>
                <span>{range.userId ? blame.data.users[range.userId] : 'Imported'}</span>
              </li>
            ))}
          </ul>
        )}
        {snapshots.isPending && <Loading />}
        {snapshots.data?.snapshots.length === 0 && (
          <p className="text-sm text-muted">
            No snapshots yet. One is saved every five minutes of editing and after each run.
          </p>
        )}
        <ol className="flex flex-col gap-2">
          {snapshots.data?.snapshots.map((snapshot) => (
            <li key={snapshot.id} className="flex flex-col gap-1 rounded border border-line p-2">
              <div className="flex items-center gap-2">
                <Badge>{KIND_LABELS[snapshot.kind]}</Badge>
                <time dateTime={snapshot.createdAt} className="text-xs text-muted">
                  {new Date(snapshot.createdAt).toLocaleString()}
                </time>
              </div>
              {snapshot.label && <p className="text-sm font-medium">{snapshot.label}</p>}
              {snapshot.authorIds.length > 0 && (
                <p className="text-xs text-muted">
                  {snapshot.authorIds.map((id) => users[id] ?? 'Someone').join(', ')}
                </p>
              )}
              <span className="flex flex-wrap gap-1">
                <Button
                  className="!px-1.5 !py-0.5"
                  disabled={!fileId}
                  onClick={() => void view(snapshot.id, 'view')}
                >
                  View
                </Button>
                <Button
                  className="!px-1.5 !py-0.5"
                  disabled={!fileId}
                  onClick={() => void view(snapshot.id, 'compare')}
                >
                  Compare
                </Button>
                {canEdit && (
                  <Button
                    className="!px-1.5 !py-0.5"
                    onClick={() => void restore(snapshot.id, false)}
                  >
                    Restore project
                  </Button>
                )}
                <Button
                  className="!px-1.5 !py-0.5"
                  onClick={() =>
                    void apiDownload(
                      `/snapshots/${snapshot.id}/export`,
                      `snapshot-${snapshot.id}.zip`,
                    ).catch(setError)
                  }
                >
                  Export zip
                </Button>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <Dialog
        wide
        title={
          compare?.mode === 'view'
            ? `${compare.path} at this snapshot (read-only)`
            : compare
              ? `${compare.path}: snapshot and current`
              : ''
        }
        open={compare !== null}
        onClose={() => setCompare(null)}
      >
        {compare && fileId && (
          <>
            <div className="min-h-0 flex-1">
              <Suspense fallback={<Loading label="Loading comparison…" />}>
                {compare.mode === 'view' ? (
                  <SnapshotView content={compare.content} path={compare.path} />
                ) : (
                  <DiffView
                    original={compare.content}
                    modified={session.files.get(fileId)?.toString() ?? ''}
                    path={compare.path}
                  />
                )}
              </Suspense>
            </div>
            {canEdit && (
              <Button
                variant="primary"
                className="self-start"
                onClick={() => void restore(compare.snapshotId, true)}
              >
                Restore this file
              </Button>
            )}
          </>
        )}
      </Dialog>
    </section>
  )
}
