import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Button, Dialog, ErrorNotice, Field } from '../../components/ui'
import { api } from '../../lib/api'

const HOURS_PER_WEEK = 168

export interface ShareDialogProps {
  roomId: string
  profanityFilter: boolean
  open: boolean
  onClose: () => void
}

export function ShareDialog({ roomId, profanityFilter, open, onClose }: ShareDialogProps) {
  const client = useQueryClient()
  const [role, setRole] = useState('EDITOR')
  const [copied, setCopied] = useState(false)
  const invite = useMutation({
    mutationFn: () =>
      api<{ inviteUrl: string }>(`/rooms/${roomId}/invites`, {
        method: 'POST',
        body: { role, expiresInHours: HOURS_PER_WEEK },
      }),
    onSuccess: () => setCopied(false),
  })
  // Held here so the box changes on the click itself. The saved value takes over if saving fails.
  const [filterChoice, setFilterChoice] = useState<boolean | null>(null)
  const moderation = useMutation({
    mutationFn: (enabled: boolean) =>
      api(`/rooms/${roomId}`, { method: 'PATCH', body: { profanityFilter: enabled } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['room', roomId] }),
    onError: () => setFilterChoice(null),
  })
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    invite.mutate()
  }
  const copy = (url: string): void => {
    navigator.clipboard
      .writeText(url)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }
  return (
    <Dialog title="Share this room" open={open} onClose={onClose}>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={filterChoice ?? profanityFilter}
          onChange={(event) => {
            setFilterChoice(event.target.checked)
            moderation.mutate(event.target.checked)
          }}
        />
        Filter profanity in chat
      </label>
      <ErrorNotice error={moderation.error} />
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          People with the link can
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="rounded border border-line-strong bg-deep text-ink px-3 py-2 font-normal"
          >
            <option value="EDITOR">Edit</option>
            <option value="VIEWER">View</option>
          </select>
        </label>
        <ErrorNotice error={invite.error} />
        <Button type="submit" variant="primary" disabled={invite.isPending}>
          Create invite link
        </Button>
      </form>
      {invite.data && (
        <div className="flex flex-col gap-2">
          <Field label="Invite link, valid for 7 days" readOnly value={invite.data.inviteUrl} />
          <Button onClick={() => copy(invite.data.inviteUrl)}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
      )}
    </Dialog>
  )
}
