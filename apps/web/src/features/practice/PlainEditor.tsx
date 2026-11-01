import '../presence/monacoEnvironment'
import * as monaco from 'monaco-editor'
import { useEffect, useRef } from 'react'
import { usePreferences, useResolvedTheme } from '../../lib/preferences'
import type { Language } from '../../lib/types'

const MONACO_LANGUAGES: Record<Language, string> = {
  PYTHON: 'python',
  CPP: 'cpp',
  JAVA: 'java',
  JAVASCRIPT: 'javascript',
}

export interface PlainEditorProps {
  value: string
  language: Language
  onChange: (value: string) => void
}

// Practice code belongs to one person, so it has no shared document behind it.
export function PlainEditor({ value, language, onChange }: PlainEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const theme = useResolvedTheme()
  const fontSize = usePreferences((state) => state.fontSize)
  const changed = useRef(onChange)
  changed.current = onChange

  useEffect(() => {
    if (!host.current) return undefined
    const created = monaco.editor.create(host.current, {
      value,
      language: MONACO_LANGUAGES[language],
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    })
    const subscription = created.onDidChangeModelContent(() => {
      changed.current(created.getValue())
    })
    editor.current = created
    return () => {
      subscription.dispose()
      created.dispose()
      editor.current = null
    }
    // The value only seeds the editor. Changing it from outside goes through the effect below.
  }, [language])

  useEffect(() => {
    if (editor.current && editor.current.getValue() !== value) editor.current.setValue(value)
  }, [value])
  useEffect(() => monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs'), [theme])
  useEffect(() => editor.current?.updateOptions({ fontSize }), [fontSize])

  return <div ref={host} data-testid="practice-editor" className="h-full" />
}
