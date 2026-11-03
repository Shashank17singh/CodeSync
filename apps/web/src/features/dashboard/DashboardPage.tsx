import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Badge, Button, ErrorNotice, Field, Loading } from '../../components/ui'
import { api } from '../../lib/api'
import type { RoomSummary } from '../../lib/types'

const TEMPLATES = [
  { value: 'PYTHON', label: 'Python' },
  { value: 'CPP', label: 'C++' },
  { value: 'JAVA', label: 'Java' },
  { value: 'JAVASCRIPT', label: 'JavaScript' },
  { value: 'BLANK', label: 'Blank' },
]

const RECENT_COUNT = 3

export function DashboardPage() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('PYTHON')
  const [link, setLink] = useState('')
  const rooms = useQuery({
    queryKey: ['rooms'],
    queryFn: () => api<{ rooms: RoomSummary[] }>('/rooms'),
  })
  const create = useMutation({
    mutationFn: () =>
      api<{ room: { id: string } }>('/rooms', {
        method: 'POST',
        body: { name, template, visibility: 'PRIVATE' },
      }),
    onSuccess: async ({ room }) => {
      await client.invalidateQueries({ queryKey: ['rooms'] })
      await navigate(`/rooms/${room.id}`)
    },
  })

  const onCreate = (event: FormEvent): void => {
    event.preventDefault()
    create.mutate()
  }
  const onJoin = (event: FormEvent): void => {
    event.preventDefault()
    const url = new URL(link.trim(), location.origin)
    void navigate(`/invite${url.hash}`)
  }

  const list = rooms.data?.rooms ?? []
  const recent = [...list]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_COUNT)

  const roomLink = (room: RoomSummary) => (
    <li key={room.id}>
      <Link
        to={`/rooms/${room.id}`}
        className="flex min-h-11 items-center justify-between gap-2 px-4 py-2.5 hover:bg-raised"
      >
        <span className="truncate text-sm font-medium">{room.name}</span>
        <Badge>{(room.role ?? 'visitor').toLowerCase()}</Badge>
      </Link>
    </li>
  )

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-6">
        {recent.length > 0 && (
          <section aria-labelledby="recent-rooms">
            <h1 id="recent-rooms" className="mb-3 text-2xl font-medium">
              Recent
            </h1>
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">{recent.map(roomLink)}</ul>
          </section>
        )}
        <section aria-labelledby="my-rooms">
          <h2 id="my-rooms" className="mb-3 text-lg font-medium">
            My rooms
          </h2>
          {rooms.isPending && <Loading />}
          <ErrorNotice error={rooms.error} />
          {rooms.isSuccess && list.length === 0 && (
            <p className="text-sm text-muted">No rooms yet. Create one to start coding.</p>
          )}
          {list.length > 0 && (
            <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">{list.map(roomLink)}</ul>
          )}
        </section>
      </div>
      <div className="flex flex-col gap-6">
        <form onSubmit={onCreate} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <h2 className="font-medium">Create a room</h2>
          <Field
            label="Room name"
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <label className="flex flex-col gap-1 text-sm font-medium">
            Template
            <select
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              className="rounded border border-line-strong bg-deep px-3 py-2 font-normal"
            >
              {TEMPLATES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <ErrorNotice error={create.error} />
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create room
          </Button>
        </form>
        <form onSubmit={onJoin} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <h2 className="font-medium">Join by link</h2>
          <Field
            label="Invite link"
            required
            value={link}
            onChange={(event) => setLink(event.target.value)}
          />
          <Button type="submit">Join</Button>
        </form>
      </div>
    </div>
  )
}
