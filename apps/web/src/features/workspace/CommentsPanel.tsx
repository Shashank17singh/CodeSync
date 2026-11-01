import { createAnchor, resolveAnchor, type CollabSession } from '@codesync/collab-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Button, ErrorNotice } from '../../components/ui'
import { api } from '../../lib/api'
import type { CommentRow } from '../../lib/types'
import type { CollabEditor } from '../presence/collabEditor'
import { useChannelEvent } from './hooks'

export interface CommentsPanelProps {
  session: CollabSession
  fileId: string | null
  selfId: string
  isOwner: boolean
  names: ReadonlyMap<string, string>
  editor: CollabEditor | null
  onLines: (lines: number[]) => void
}

function Reply({ threadId, onSent }: { threadId: string; onSent: () => void }) {
  const [body, setBody] = useState('')
  const send = useMutation({
    mutationFn: () => api(`/comments/${threadId}/replies`, { method: 'POST', body: { body } }),
    onSuccess: () => {
      setBody('')
      onSent()
    },
  })
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    send.mutate()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <ErrorNotice error={send.error} />
      <span className="flex gap-1">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Reply</span>
          <input
            required
            value={body}
            placeholder="Reply"
            onChange={(event) => setBody(event.target.value)}
            className="w-full rounded border border-line bg-surface px-2 py-1 text-sm"
          />
        </label>
        <Button type="submit">Reply</Button>
      </span>
    </form>
  )
}

export function CommentsPanel({
  session,
  fileId,
  selfId,
  isOwner,
  names,
  editor,
  onLines,
}: CommentsPanelProps) {
  const client = useQueryClient()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [version, setVersion] = useState(0)
  const comments = useQuery({
    queryKey: ['comments', fileId],
    enabled: fileId !== null,
    queryFn: () => api<{ comments: CommentRow[] }>(`/files/${fileId}/comments`),
  })
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: ['comments'] }), [client])
  useChannelEvent(session, 'comment.changed', refresh)

  const text = fileId ? session.files.get(fileId) : undefined

  // Anchors follow the text, so line numbers are recomputed as the file changes.
  useEffect(() => {
    if (!text) return undefined
    const onChange = (): void => setVersion((value) => value + 1)
    text.observe(onChange)
    return () => text.unobserve(onChange)
  }, [text])

  const threads = useMemo(() => {
    const rows = comments.data?.comments ?? []
    return rows
      .filter((row) => row.parentId === null)
      .map((row) => ({
        ...row,
        replies: rows.filter((reply) => reply.parentId === row.id),
        anchor:
          text && row.anchorStart && row.anchorEnd
            ? resolveAnchor(text, { start: row.anchorStart, end: row.anchorEnd })
            : null,
      }))
      .sort((a, b) => (a.anchor?.line ?? 0) - (b.anchor?.line ?? 0))
    // version stands in for the text's contents, which React cannot compare.
  }, [comments.data, text, version])

  useEffect(() => {
    onLines(
      threads
        .filter((thread) => thread.anchor && !thread.resolvedAt)
        .map((thread) => thread.anchor?.line as number),
    )
  }, [threads, onLines])

  const add = (event: FormEvent): void => {
    event.preventDefault()
    const selection = editor?.selectionRange()
    if (!text || !selection || !fileId) return
    const { start, end } = createAnchor(text, selection.start, selection.end)
    setError(null)
    api(`/files/${fileId}/comments`, {
      method: 'POST',
      body: { body: draft, anchorStart: start, anchorEnd: end },
    })
      .then(async () => {
        setDraft('')
        await refresh()
      })
      .catch(setError)
  }

  const act = (task: Promise<unknown>): void => {
    setError(null)
    task.then(refresh).catch(setError)
  }

  if (!fileId) return <p className="p-3 text-sm text-muted">Open a file to see its comments.</p>
  return (
    <section aria-label="Comments" className="flex h-full min-h-0 flex-col">
      <form onSubmit={add} className="flex flex-col gap-1 border-b border-line p-2">
        <label className="text-xs text-muted" htmlFor="new-comment">
          Comment on the selected code
        </label>
        <textarea
          id="new-comment"
          rows={2}
          required
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="resize-none rounded border border-line bg-surface p-1 text-sm"
        />
        <Button type="submit">Add comment</Button>
      </form>
      <ErrorNotice error={error ?? comments.error} />
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {threads.length === 0 && comments.isSuccess && (
          <li className="text-sm text-muted">No comments on this file.</li>
        )}
        {threads.map((thread) => (
          <li
            key={thread.id}
            className={`flex flex-col gap-1 rounded border border-line p-2 ${
              thread.resolvedAt ? 'opacity-60' : ''
            }`}
          >
            <div className="flex items-center gap-2 text-xs text-muted">
              {thread.anchor ? (
                <button
                  type="button"
                  className="underline"
                  onClick={() => editor?.revealLine((thread.anchor as { line: number }).line)}
                >
                  Line {thread.anchor.line}
                </button>
              ) : (
                <span>Code removed</span>
              )}
              {thread.resolvedAt && <span>Resolved</span>}
            </div>
            <p className="text-sm">
              <span className="font-medium">{names.get(thread.authorId) ?? 'Someone'}: </span>
              {thread.body}
            </p>
            {thread.replies.map((reply) => (
              <p key={reply.id} className="ml-3 text-sm">
                <span className="font-medium">{names.get(reply.authorId) ?? 'Someone'}: </span>
                {reply.body}
              </p>
            ))}
            <span className="flex gap-1">
              <Button
                variant="ghost"
                className="!px-1.5 !py-0.5"
                onClick={() =>
                  act(
                    api(`/comments/${thread.id}`, {
                      method: 'PATCH',
                      body: { resolved: !thread.resolvedAt },
                    }),
                  )
                }
              >
                {thread.resolvedAt ? 'Reopen' : 'Resolve'}
              </Button>
              {(isOwner || thread.authorId === selfId) && (
                <Button
                  variant="ghost"
                  className="!px-1.5 !py-0.5"
                  onClick={() => act(api(`/comments/${thread.id}`, { method: 'DELETE' }))}
                >
                  Delete
                </Button>
              )}
            </span>
            <Reply threadId={thread.id} onSent={() => void refresh()} />
          </li>
        ))}
      </ul>
    </section>
  )
}
