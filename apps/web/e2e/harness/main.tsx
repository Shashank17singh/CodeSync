import '../../src/index.css'
import { createCollabSession, type CollabSession } from '@codesync/collab-client'
import { createRoot } from 'react-dom/client'
import { PresenceWorkspace } from '../../src/features/presence/PresenceWorkspace'

declare global {
  interface Window {
    harness: CollabSession
  }
}

const params = new URLSearchParams(location.search)
const token = params.get('token') ?? ''
const userId = params.get('userId') ?? ''
const name = params.get('name') ?? ''

const session = await createCollabSession({
  serverUrl: params.get('server') ?? '',
  projectId: params.get('projectId') ?? '',
  getToken: async () => token,
})
window.harness = session

createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ height: '100vh' }}>
    <PresenceWorkspace session={session} self={{ userId, name }} />
  </div>,
)
