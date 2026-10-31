import * as Y from 'yjs'

export interface LineFix {
  lineStart: number
  lineEnd: number
  replacement: string
}

function lineOffsets(content: string, fix: LineFix): { start: number; end: number } | null {
  const lines = content.split('\n')
  if (fix.lineStart < 1 || fix.lineEnd < fix.lineStart || fix.lineEnd > lines.length) return null
  const start = lines.slice(0, fix.lineStart - 1).reduce((total, line) => total + line.length + 1, 0)
  const selected = lines.slice(fix.lineStart - 1, fix.lineEnd).join('\n')
  return { start, end: start + selected.length }
}

// Applied as one ordinary edit, so collaborators see it arrive and the author can undo it. A
// review can be stale by the time a fix is applied, so the caller passes the lines it was written
// for, and a fix for code that has since changed is refused rather than pasted over someone's work.
export function applyLineFix(text: Y.Text, fix: LineFix, expected: string): boolean {
  const content = text.toString()
  const range = lineOffsets(content, fix)
  if (!range || content.slice(range.start, range.end) !== expected) return false
  const apply = (): void => {
    text.delete(range.start, range.end - range.start)
    text.insert(range.start, fix.replacement)
  }
  if (text.doc) text.doc.transact(apply)
  else apply()
  return true
}
