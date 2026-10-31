import { WsMessageType, appEnvelopeSchema, type ChatSend } from '@codesync/shared'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { WebsocketProvider } from 'y-websocket'

type Listener = (data: unknown) => void

// The application channel: chat, run output and notifications, on the document's WebSocket.
export class AppChannel {
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(private readonly provider: WebsocketProvider) {
    provider.messageHandlers[WsMessageType.app] = (_encoder, decoder) => {
      this.receive(decoding.readVarString(decoder))
    }
  }

  private receive(text: string): void {
    const parsed = appEnvelopeSchema.safeParse(JSON.parse(text))
    if (!parsed.success) return
    for (const listener of this.listeners.get(parsed.data.t) ?? []) listener(parsed.data.d)
  }

  on(type: string, listener: Listener): () => void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
    return () => set.delete(listener)
  }

  private send(type: string, data: unknown, id?: string): boolean {
    const socket = this.provider.ws
    if (!socket || !this.provider.wsconnected) return false
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, WsMessageType.app)
    encoding.writeVarString(encoder, JSON.stringify({ v: 1, t: type, ...(id ? { id } : {}), d: data }))
    socket.send(encoding.toUint8Array(encoder))
    return true
  }

  sendChat(message: Omit<ChatSend, 'mentions'> & { mentions?: string[] }): boolean {
    return this.send('chat.send', { mentions: [], ...message }, message.clientMsgId)
  }

  sendTyping(typing: boolean): boolean {
    return this.send('chat.typing', { typing })
  }
}
