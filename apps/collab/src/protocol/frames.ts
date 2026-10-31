import { COLLAB_LIMITS, WsMessageType, type AppEnvelope } from '@codesync/shared'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as syncProtocol from 'y-protocols/sync'
import type * as Y from 'yjs'

export class ProtocolError extends Error {
  constructor(
    readonly closeCode: number,
    message: string,
  ) {
    super(message)
  }
}

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, WsMessageType.sync)
  syncProtocol.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, WsMessageType.sync)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

export function encodeAwareness(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, WsMessageType.awareness)
  encoding.writeVarUint8Array(encoder, update)
  return encoding.toUint8Array(encoder)
}

export function encodePermissionDenied(reason: string): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, WsMessageType.auth)
  encoding.writeVarUint(encoder, 0)
  encoding.writeVarString(encoder, reason)
  return encoding.toUint8Array(encoder)
}

export function encodeApp(envelope: AppEnvelope): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, WsMessageType.app)
  encoding.writeVarString(encoder, JSON.stringify(envelope))
  return encoding.toUint8Array(encoder)
}

export interface AwarenessEntry {
  clientId: number
  clock: number
  state: Record<string, unknown> | null
}

export function decodeAwarenessUpdate(update: Uint8Array): AwarenessEntry[] {
  const decoder = decoding.createDecoder(update)
  const count = decoding.readVarUint(decoder)
  if (count > COLLAB_LIMITS.maxAwarenessClientsPerConnection) {
    throw new ProtocolError(4400, 'too many awareness entries')
  }
  const entries: AwarenessEntry[] = []
  for (let index = 0; index < count; index++) {
    const clientId = decoding.readVarUint(decoder)
    const clock = decoding.readVarUint(decoder)
    const json = decoding.readVarString(decoder)
    if (Buffer.byteLength(json) > COLLAB_LIMITS.maxAwarenessStateBytes) {
      throw new ProtocolError(4400, 'awareness state too large')
    }
    const state: unknown = JSON.parse(json)
    if (state !== null && (typeof state !== 'object' || Array.isArray(state))) {
      throw new ProtocolError(4400, 'awareness state must be an object')
    }
    entries.push({ clientId, clock, state: state as Record<string, unknown> | null })
  }
  return entries
}

export function encodeAwarenessEntries(entries: AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, entries.length)
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId)
    encoding.writeVarUint(encoder, entry.clock)
    encoding.writeVarString(encoder, JSON.stringify(entry.state))
  }
  return encoding.toUint8Array(encoder)
}
