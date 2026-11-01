import { createCollabSession, type CollabSession } from '@codesync/collab-client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../../lib/api'
import { connectionState, type ConnectionState } from './model'

const collabUrl = (): string =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collab`

export interface CollabHandle {
  session: CollabSession | null
  // A close code the client must not retry: the room is gone or access was removed.
  fatalCode: number | null
  failed: boolean
}

export function useCollabSession(roomId: string, projectId: string | undefined): CollabHandle {
  const [session, setSession] = useState<CollabSession | null>(null)
  const [fatalCode, setFatalCode] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!projectId) return undefined
    let disposed = false
    let created: CollabSession | null = null
    createCollabSession({
      serverUrl: collabUrl(),
      projectId,
      getToken: async () => {
        const { token } = await api<{ token: string }>(`/rooms/${roomId}/collab-token`, {
          method: 'POST',
          body: { projectId },
        })
        return token
      },
      onFatalClose: setFatalCode,
    })
      .then((opened) => {
        if (disposed) {
          void opened.destroy()
          return
        }
        created = opened
        setSession(opened)
      })
      .catch(() => {
        if (!disposed) setFailed(true)
      })
    return () => {
      disposed = true
      void created?.destroy()
      setSession(null)
    }
  }, [roomId, projectId])

  return { session, fatalCode, failed }
}

function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener('online', listener)
      window.addEventListener('offline', listener)
      return () => {
        window.removeEventListener('online', listener)
        window.removeEventListener('offline', listener)
      }
    },
    () => navigator.onLine,
  )
}

// The retry itself lives in y-websocket: it doubles the delay on each failure up to a ceiling.
export function useConnection(session: CollabSession | null): ConnectionState {
  const [socket, setSocket] = useState('connecting')
  const online = useOnline()
  useEffect(() => {
    if (!session) return undefined
    const onStatus = ({ status }: { status: string }): void => setSocket(status)
    setSocket(session.provider.wsconnected ? 'connected' : 'connecting')
    session.provider.on('status', onStatus)
    return () => session.provider.off('status', onStatus)
  }, [session])
  return connectionState(socket, online)
}

export function useChannelEvent<T>(
  session: CollabSession | null,
  type: string,
  listener: (data: T) => void,
): void {
  useEffect(() => {
    if (!session) return undefined
    return session.channel.on(type, (data) => listener(data as T))
  }, [session, type, listener])
}
