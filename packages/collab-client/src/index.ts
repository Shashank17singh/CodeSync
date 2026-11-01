import { WsCloseCode, YDOC_ROOTS, type TreeEntry } from '@codesync/shared'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { AppChannel } from './channel.js'
import { PresenceTracker } from './presence.js'

export * from './channel.js'
export * from './comments.js'
export * from './presence.js'
export * from './reviewFix.js'

export interface CollabSessionOptions {
  serverUrl: string
  projectId: string
  getToken: () => Promise<string>
  // Off in Node, where IndexedDB does not exist.
  offline?: boolean
  webSocket?: typeof WebSocket
  // Tests turn this off: same-process providers otherwise sync without the server.
  disableBroadcastChannel?: boolean
  doc?: Y.Doc
  onFatalClose?: (code: number) => void
}

export interface CollabSession {
  doc: Y.Doc
  provider: WebsocketProvider
  presence: PresenceTracker
  channel: AppChannel
  files: Y.Map<Y.Text>
  tree: Y.Map<TreeEntry>
  destroy: () => Promise<void>
}

export async function createCollabSession(options: CollabSessionOptions): Promise<CollabSession> {
  const doc = options.doc ?? new Y.Doc()
  const offline =
    options.offline === false ? null : new IndexeddbPersistence(`codesync:${options.projectId}`, doc)
  await offline?.whenSynced

  const provider = new WebsocketProvider(options.serverUrl, options.projectId, doc, {
    params: { token: await options.getToken() },
    ...(options.webSocket ? { WebSocketPolyfill: options.webSocket } : {}),
    disableBc: options.disableBroadcastChannel ?? false,
    // y-websocket doubles its retry delay up to this ceiling.
    maxBackoffTime: 15_000,
  })

  const channel = new AppChannel(provider)
  const presence = new PresenceTracker(provider.awareness)
  presence.start()

  provider.on('status', ({ status }) => {
    if (status === 'connected') presence.announce()
  })

  provider.on('connection-close', (event) => {
    if (!event) return
    if (event.code === WsCloseCode.tokenExpired) {
      // The token is read from params on each connect, so refresh before reconnecting.
      provider.disconnect()
      void options
        .getToken()
        .then((token) => {
          provider.params['token'] = token
          provider.connect()
        })
        .catch(() => options.onFatalClose?.(event.code))
    } else if (event.code >= 4400 && event.code < 4500) {
      options.onFatalClose?.(event.code)
    }
  })

  return {
    doc,
    provider,
    presence,
    channel,
    files: doc.getMap(YDOC_ROOTS.files),
    tree: doc.getMap(YDOC_ROOTS.tree),
    destroy: async () => {
      presence.destroy()
      provider.destroy()
      await offline?.destroy()
      doc.destroy()
    },
  }
}
