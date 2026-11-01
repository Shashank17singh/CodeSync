import { YDOC_ROOTS } from '@codesync/shared'
import * as Y from 'yjs'
import { z } from 'zod'

const treeSchema = z.array(
  z.object({ id: z.uuid(), path: z.string(), kind: z.enum(['FILE', 'DIRECTORY']) }),
)
export type SnapshotEntry = z.infer<typeof treeSchema>[number]

export const parseTree = (tree: unknown): SnapshotEntry[] => treeSchema.parse(tree)

export function withDocFiles<T>(state: Uint8Array, task: (files: Y.Map<Y.Text>) => T): T {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, state)
    return task(doc.getMap<Y.Text>(YDOC_ROOTS.files))
  } finally {
    doc.destroy()
  }
}

export function readContents(state: Uint8Array, entries: SnapshotEntry[]): Map<string, string> {
  return withDocFiles(state, (files) => {
    const contents = new Map<string, string>()
    for (const { id, kind } of entries) {
      if (kind === 'FILE') contents.set(id, files.get(id)?.toString() ?? '')
    }
    return contents
  })
}

function topWriter(counts: Map<number, number>): number | null {
  let top: number | null = null
  let most = 0
  for (const [client, count] of counts) {
    if (count > most) {
      top = client
      most = count
    }
  }
  return top
}

// One Yjs client per line: whoever wrote the most of it, or the newline on an empty line.
// Items keep the id of the client that created them, which is all blame needs.
export function blameLines(text: Y.Text): Array<number | null> {
  const lines: Array<number | null> = []
  let counts = new Map<number, number>()
  let pendingNewline: number | null = null
  const endLine = (newlineClient: number): void => {
    lines.push(counts.size > 0 ? topWriter(counts) : pendingNewline)
    counts = new Map()
    pendingNewline = newlineClient
  }
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !(item.content instanceof Y.ContentString)) continue
    const { client } = item.id
    const parts = item.content.str.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) endLine(client)
      if (part.length > 0) counts.set(client, (counts.get(client) ?? 0) + part.length)
    })
  }
  lines.push(counts.size > 0 ? topWriter(counts) : pendingNewline)
  return lines
}

export interface BlameRange {
  startLine: number
  endLine: number
  userId: string | null
}

export function toRanges(
  lines: Array<number | null>,
  users: ReadonlyMap<number, string>,
): BlameRange[] {
  const ranges: BlameRange[] = []
  lines.forEach((client, index) => {
    const userId = client === null ? null : (users.get(client) ?? null)
    const last = ranges.at(-1)
    if (last?.userId === userId) last.endLine = index + 1
    else ranges.push({ startLine: index + 1, endLine: index + 1, userId })
  })
  return ranges
}
