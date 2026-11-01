import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'

const MESSAGE_SYNC = 0
const SYNC_STEP_1 = 0
const SYNC_STEP_2 = 1
const SYNC_UPDATE = 2
const STAMP_MARK = 126 // '~'
const STAMP_DIGITS = 13

function syncFrame(subtype: number, payload: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  encoding.writeVarUint(encoder, subtype)
  encoding.writeVarUint8Array(encoder, payload)
  return encoding.toUint8Array(encoder)
}

export const hello = (doc: Y.Doc): Uint8Array =>
  syncFrame(SYNC_STEP_1, Y.encodeStateVector(doc))

// A simulated typist edits its own copy and never applies other typists' updates. That keeps the
// client cheap, so the load generator does not become the thing being measured.
export function typeStamp(doc: Y.Doc, fileId: string, now: number): Uint8Array | null {
  const text = doc.getMap<Y.Text>('files').get(fileId)
  if (!text) return null
  let update: Uint8Array | null = null
  const capture = (bytes: Uint8Array): void => {
    update = bytes
  }
  doc.once('update', capture)
  text.insert(0, `~${now}~`)
  return update === null ? null : syncFrame(SYNC_UPDATE, update)
}

// Applies the server's step 2, which is what tells a client the file's Y.Text exists.
export function applyServerState(doc: Y.Doc, frame: Uint8Array): boolean {
  const decoder = decoding.createDecoder(frame)
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return false
  if (decoding.readVarUint(decoder) !== SYNC_STEP_2) return false
  Y.applyUpdate(doc, decoding.readVarUint8Array(decoder))
  return true
}

// Finds the send time inside an update frame without decoding the CRDT.
export function readStamp(frame: Uint8Array): number | null {
  if (frame[0] !== MESSAGE_SYNC || frame[1] !== SYNC_UPDATE) return null
  for (let index = 0; index + STAMP_DIGITS + 1 < frame.length; index++) {
    if (frame[index] !== STAMP_MARK || frame[index + STAMP_DIGITS + 1] !== STAMP_MARK) continue
    let value = 0
    for (let digit = 1; digit <= STAMP_DIGITS; digit++) {
      value = value * 10 + ((frame[index + digit] as number) - 48)
    }
    return value
  }
  return null
}

export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)
  return sorted[index] as number
}
