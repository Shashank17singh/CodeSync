import * as Y from 'yjs'

export interface CommentAnchor {
  start: string // base64
  end: string // base64
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0))
}

// Relative positions attach to characters, not offsets, so an anchor follows its code as other
// people edit around it. assoc -1 on the end keeps text typed right after it outside the range.
export function createAnchor(text: Y.Text, start: number, end: number): CommentAnchor {
  return {
    start: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, start))),
    end: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, end, -1))),
  }
}

export interface ResolvedAnchor {
  start: number
  end: number
  line: number
}

// Returns null once the anchored code has been deleted.
export function resolveAnchor(text: Y.Text, anchor: CommentAnchor): ResolvedAnchor | null {
  const { doc } = text
  if (!doc) return null
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(fromBase64(anchor.start)),
      doc,
    )
    const end = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(fromBase64(anchor.end)),
      doc,
    )
    if (start?.type !== text || end?.type !== text || start.index > end.index) return null
    const line = text.toString().slice(0, start.index).split('\n').length
    return { start: start.index, end: end.index, line }
  } catch {
    return null
  }
}
