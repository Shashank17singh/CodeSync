import type { CollabSession } from '@codesync/collab-client'
import { CHAT_LIMITS } from '@codesync/shared'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Markdown } from '../../components/Markdown'
import { Button, ErrorNotice } from '../../components/ui'
import { api } from '../../lib/api'
import type { ChatMessage } from '../../lib/types'
import { useChannelEvent } from './hooks'
import { findMentions } from './model'

const TYPING_CLEAR_MS = 3_000
const TYPING_SEND_MS = 2_000

const merge = (older: ChatMessage[], newer: ChatMessage[]): ChatMessage[] => {
  const byId = new Map([...older, ...newer].map((message) => [message.id, message]))
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export interface ChatPanelProps {
  session: CollabSession
  roomId: string
  selfId: string
  isOwner: boolean
  visible: boolean
  members: ReadonlyArray<{ id: string; displayName: string }>
  onUnread: (count: number) => void
}

export function ChatPanel({
  session,
  roomId,
  selfId,
  isOwner,
  visible,
  members,
  onUnread,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [draft, setDraft] = useState('')
  const [typing, setTyping] = useState<ReadonlyMap<string, string>>(new Map())
  const [error, setError] = useState<unknown>(null)
  const [unread, setUnread] = useState(0)
  const log = useRef<HTMLOListElement>(null)
  const lastTypingSent = useRef(0)
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const history = useQuery({
    queryKey: ['chat', roomId],
    queryFn: () => api<{ messages: ChatMessage[] }>(`/rooms/${roomId}/messages`),
    staleTime: Infinity,
  })
  const initial = useQuery({
    queryKey: ['chat-unread', roomId],
    queryFn: () => api<{ unread: number }>(`/rooms/${roomId}/unread`),
    staleTime: Infinity,
  })

  useEffect(() => {
    if (history.data) setMessages((current) => merge(history.data.messages, current))
  }, [history.data])
  useEffect(() => {
    if (initial.data) setUnread((count) => count + initial.data.unread)
  }, [initial.data])
  useEffect(() => onUnread(unread), [unread, onUnread])

  useEffect(() => {
    if (!visible || unread === 0) return
    setUnread(0)
    api(`/rooms/${roomId}/read`, { method: 'POST' }).catch(() => undefined)
  }, [visible, unread, roomId])

  useEffect(() => {
    const element = log.current
    if (element && visible) element.scrollTop = element.scrollHeight
  }, [messages.length, visible])

  useChannelEvent<ChatMessage>(
    session,
    'chat.message',
    useCallback(
      (message) => {
        setMessages((current) => merge(current, [message]))
        if (message.authorId !== selfId && !visibleRef.current) setUnread((count) => count + 1)
      },
      [selfId],
    ),
  )
  useChannelEvent<{ id: string }>(
    session,
    'chat.deleted',
    useCallback(({ id }) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, body: '', deletedAt: new Date().toISOString() } : message,
        ),
      )
    }, []),
  )
  useChannelEvent<{ userId: string; name: string; typing: boolean }>(
    session,
    'chat.typing',
    useCallback(({ userId, name, typing: isTyping }) => {
      const timers = typingTimers.current
      clearTimeout(timers.get(userId))
      const remove = (): void =>
        setTyping((current) => {
          const next = new Map(current)
          next.delete(userId)
          return next
        })
      if (!isTyping) {
        remove()
        return
      }
      setTyping((current) => new Map(current).set(userId, name))
      timers.set(userId, setTimeout(remove, TYPING_CLEAR_MS))
    }, []),
  )
  useChannelEvent<{ message: string }>(
    session,
    'error',
    useCallback(({ message }) => setError(message), []),
  )

  const loadOlder = async (): Promise<void> => {
    const oldest = messages[0]
    if (!oldest) return
    try {
      const before = encodeURIComponent(oldest.createdAt)
      const page = await api<{ messages: ChatMessage[] }>(
        `/rooms/${roomId}/messages?before=${before}`,
      )
      setHasMore(page.messages.length === CHAT_LIMITS.historyPageSize)
      setMessages((current) => merge(page.messages, current))
    } catch (failure) {
      setError(failure)
    }
  }

  const send = (event: FormEvent): void => {
    event.preventDefault()
    const body = draft.trim()
    if (!body) return
    setError(null)
    const sent = session.channel.sendChat({
      clientMsgId: crypto.randomUUID(),
      body,
      mentions: findMentions(body, members),
    })
    if (sent) setDraft('')
    else setError('You are offline. The message was not sent.')
  }

  const onDraft = (value: string): void => {
    setDraft(value)
    if (Date.now() - lastTypingSent.current < TYPING_SEND_MS) return
    lastTypingSent.current = Date.now()
    session.channel.sendTyping(true)
  }

  const remove = (id: string): void => {
    api(`/rooms/${roomId}/messages/${id}`, { method: 'DELETE' }).catch(setError)
  }

  const partial = /(?:^|\s)@([^\s@]*)$/.exec(draft)?.[1]
  const suggestions =
    partial === undefined
      ? []
      : members
          .filter((member) => member.id !== selfId)
          .filter((member) => member.displayName.toLowerCase().startsWith(partial.toLowerCase()))
          .slice(0, 5)

  return (
    <section aria-label="Chat" className="flex h-full min-h-0 flex-col">
      <ol
        ref={log}
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
      >
        {hasMore && messages.length >= CHAT_LIMITS.historyPageSize && (
          <li className="text-center">
            <Button variant="ghost" onClick={() => void loadOlder()}>
              Load older messages
            </Button>
          </li>
        )}
        {messages.map((message) => (
          <li key={message.id} className="group">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium">{message.authorName}</span>
              <time dateTime={message.createdAt} className="text-xs text-muted">
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
              {isOwner && !message.deletedAt && (
                <button
                  type="button"
                  aria-label={`Delete message from ${message.authorName}`}
                  onClick={() => remove(message.id)}
                  className="ml-auto text-xs text-muted opacity-0 group-hover:opacity-100 focus:opacity-100"
                >
                  Delete
                </button>
              )}
            </div>
            {message.deletedAt ? (
              <p className="text-sm text-muted italic">Message removed</p>
            ) : (
              <div
                className={
                  message.mentionedUserIds.includes(selfId) ? 'border-l-2 border-accent pl-2' : ''
                }
              >
                <Markdown>{message.body}</Markdown>
              </div>
            )}
          </li>
        ))}
      </ol>
      <p role="status" className="h-5 px-2 text-xs text-muted">
        {typing.size > 0 && `${[...typing.values()].join(', ')} typing…`}
      </p>
      {suggestions.length > 0 && (
        <ul className="flex flex-wrap gap-1 px-2">
          {suggestions.map((member) => (
            <li key={member.id}>
              <Button
                variant="ghost"
                className="!px-1.5 !py-0.5"
                onClick={() => setDraft(draft.replace(/@[^\s@]*$/, `@${member.displayName} `))}
              >
                {member.displayName}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={send} className="flex flex-col gap-1 border-t border-line p-2">
        <ErrorNotice error={error} />
        <div className="flex gap-1">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Message</span>
            <textarea
              rows={2}
              value={draft}
              maxLength={CHAT_LIMITS.maxBodyChars}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) send(event)
              }}
              placeholder="Message, Markdown works"
              className="w-full resize-none rounded border border-line-strong bg-deep text-ink p-1 text-sm"
            />
          </label>
          <Button type="submit" variant="primary">
            Send
          </Button>
        </div>
      </form>
    </section>
  )
}
