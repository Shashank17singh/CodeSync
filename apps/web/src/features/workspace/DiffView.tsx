import '../presence/monacoEnvironment'
import * as monaco from 'monaco-editor'
import { useEffect, useRef } from 'react'
import { useResolvedTheme } from '../../lib/preferences'

export interface DiffViewProps {
  original: string
  modified: string
  path: string
}

// Both sides are read-only copies: the snapshot on the left, the file as it was when opened on
// the right. Nothing here touches the shared document.
export function DiffView({ original, modified, path }: DiffViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const theme = useResolvedTheme()

  useEffect(() => {
    if (!host.current) return undefined
    const uri = (side: string): monaco.Uri =>
      monaco.Uri.parse(`diff://${side}/${crypto.randomUUID()}/${encodeURIComponent(path)}`)
    const left = monaco.editor.createModel(original, undefined, uri('snapshot'))
    const right = monaco.editor.createModel(modified, undefined, uri('current'))
    const editor = monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: true,
      theme: theme === 'dark' ? 'vs-dark' : 'vs',
    })
    editor.setModel({ original: left, modified: right })
    return () => {
      editor.dispose()
      left.dispose()
      right.dispose()
    }
  }, [original, modified, path, theme])

  return <div ref={host} data-testid="diff" className="h-full" />
}
