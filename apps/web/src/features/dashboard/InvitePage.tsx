import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ErrorNotice, Loading } from '../../components/ui'
import { api } from '../../lib/api'

export function InvitePage() {
  const navigate = useNavigate()
  const [error, setError] = useState<unknown>(null)
  const started = useRef(false)

  useEffect(() => {
    // Accepting twice is harmless on the server, and StrictMode runs effects twice in development.
    if (started.current) return
    started.current = true
    const token = new URLSearchParams(location.hash.slice(1)).get('token')
    history.replaceState(null, '', location.pathname)
    if (!token) {
      setError('This invite link is not complete.')
      return
    }
    api<{ roomId: string }>('/invites/accept', { method: 'POST', body: { token } })
      .then(({ roomId }) => navigate(`/rooms/${roomId}`, { replace: true }))
      .catch(setError)
  }, [navigate])

  if (!error) return <Loading label="Joining the room…" />
  return (
    <div className="flex flex-col gap-2">
      <ErrorNotice error={error} />
      <Link to="/" className="text-sm underline">
        Back to your rooms
      </Link>
    </div>
  )
}
