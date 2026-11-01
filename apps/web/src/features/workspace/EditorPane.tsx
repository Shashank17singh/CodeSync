import type { CollabSession, PresencePeer } from '@codesync/collab-client'
import { useEffect, useRef, useState } from 'react'
import { usePreferences, useResolvedTheme } from '../../lib/preferences'
import type { CollabEditor, LineMarker } from '../presence/collabEditor'

export interface EditorPaneProps {
  session: CollabSession
  fileId: string | null
  readOnly: boolean
  peers: readonly PresencePeer[]
  markers: readonly LineMarker[]
  onEditor: (editor: CollabEditor | null) => void
  onFocus?: () => void
  onRunKey: (key: 'ctrl-enter' | 'f5') => void
  onGlyphClick: (line: number) => void
}

// Loaded on demand because Monaco is by far the largest dependency.
export function EditorPane({
  session,
  fileId,
  readOnly,
  peers,
  markers,
  onEditor,
  onFocus,
  onRunKey,
  onGlyphClick,
}: EditorPaneProps) {
  const container = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<CollabEditor | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const theme = useResolvedTheme()
  const fontSize = usePreferences((state) => state.fontSize)
  const tabSize = usePreferences((state) => state.tabSize)
  const wordWrap = usePreferences((state) => state.wordWrap)
  const keybindings = usePreferences((state) => state.keybindings)
  const vimStatus = useRef<HTMLDivElement>(null)
  const handlers = useRef({ onRunKey, onGlyphClick, onFocus })
  handlers.current = { onRunKey, onGlyphClick, onFocus }

  useEffect(() => {
    let disposed = false
    let created: CollabEditor | null = null
    import('../presence/collabEditor')
      .then(({ CollabEditor: Editor }) => {
        if (disposed || !container.current) return
        created = new Editor({
          container: container.current,
          session,
          theme: 'vs',
          onRunKey: (key) => handlers.current.onRunKey(key),
          onGlyphClick: (line) => handlers.current.onGlyphClick(line),
          onFocus: () => handlers.current.onFocus?.(),
        })
        setEditor(created)
        onEditor(created)
      })
      .catch(() => setLoadFailed(true))
    return () => {
      disposed = true
      created?.dispose()
      setEditor(null)
      onEditor(null)
    }
  }, [session, onEditor])

  useEffect(() => editor?.setTheme(theme === 'dark' ? 'vs-dark' : 'vs'), [editor, theme])
  useEffect(
    () => editor?.configure({ fontSize, tabSize, wordWrap, readOnly }),
    [editor, fontSize, tabSize, wordWrap, readOnly],
  )
  useEffect(() => {
    if (fileId) editor?.openFile(fileId)
  }, [editor, fileId])
  useEffect(() => {
    editor?.setKeybindings(keybindings, vimStatus.current).catch((error: unknown) => {
      console.error('failed to load editor keys', error)
    })
  }, [editor, keybindings])
  useEffect(() => editor?.renderPeers(peers), [editor, peers])
  useEffect(() => editor?.setMarkers(markers), [editor, markers, fileId])

  return (
    <div className="relative h-full min-h-0 min-w-0">
      {/* Monaco renders nothing until a model is set, so the hint fills the empty state. */}
      <div
        ref={container}
        data-testid="editor"
        className={`absolute inset-x-0 top-0 ${keybindings === 'vim' ? 'bottom-5' : 'bottom-0'}`}
      />
      <div
        ref={vimStatus}
        data-testid="vim-status"
        className="absolute inset-x-0 bottom-0 h-5 overflow-hidden px-2 font-mono text-xs text-muted"
        hidden={keybindings !== 'vim'}
      />
      {!fileId && (
        <p
          role={loadFailed ? 'alert' : 'status'}
          className="absolute inset-0 bg-surface p-4 text-sm text-muted"
        >
          {loadFailed
            ? 'The editor failed to load. Reload the page to try again.'
            : editor
              ? 'Select a file to start editing.'
              : 'Loading editor…'}
        </p>
      )}
    </div>
  )
}
