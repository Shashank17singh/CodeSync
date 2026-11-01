import type { CollabSession } from '@codesync/collab-client'
import type { TreeEntry } from '@codesync/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Badge, Button, ErrorNotice } from '../../components/ui'
import { api } from '../../lib/api'
import { useResolvedTheme } from '../../lib/preferences'
import { LANGUAGES, languageOfPath, type Execution, type Language } from '../../lib/types'
import { useChannelEvent } from './hooks'
import { formatBytes } from './model'

const POLL_MS = 2_000
const UNFINISHED = new Set(['QUEUED', 'RUNNING'])

const TERMINAL_THEMES = {
  dark: { background: '#171b1f', foreground: '#e6e9ec' },
  light: { background: '#ffffff', foreground: '#1b1f23', cursor: '#1b1f23' },
}

const forTerminal = (text: string): string => text.replace(/\r?\n/g, '\r\n')

interface OutputEvent {
  executionId: string
  seq: number
  data: string
}

export interface RunPanelProps {
  session: CollabSession
  roomId: string
  projectId: string
  canRun: boolean
  entries: ReadonlyMap<string, TreeEntry>
  activeFileId: string | null
  runRef: MutableRefObject<(() => void) | null>
}

export function RunPanel({
  session,
  roomId,
  projectId,
  canRun,
  entries,
  activeFileId,
  runRef,
}: RunPanelProps) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const lastSeq = useRef(0)
  const sawOutput = useRef(false)
  const [executionId, setExecutionId] = useState<string | null>(null)
  const [language, setLanguage] = useState<Language | ''>('')
  const [stdin, setStdin] = useState('')
  const theme = useResolvedTheme()
  const themeRef = useRef(theme)
  themeRef.current = theme

  // Program output is hostile. It goes only to the terminal emulator, which has no link or
  // clipboard addons here, and the terminal takes no keyboard input.
  useEffect(() => {
    let disposed = false
    let created: Terminal | null = null
    let observer: ResizeObserver | null = null
    void Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ]).then(([{ Terminal: Term }, { FitAddon: Fit }]) => {
      if (disposed || !host.current) return
      created = new Term({
        disableStdin: true,
        fontSize: 13,
        scrollback: 5_000,
        theme: TERMINAL_THEMES[themeRef.current],
      })
      const addon: FitAddon = new Fit()
      created.loadAddon(addon)
      created.open(host.current)
      addon.fit()
      terminal.current = created
      observer = new ResizeObserver(() => addon.fit())
      observer.observe(host.current)
    })
    return () => {
      disposed = true
      observer?.disconnect()
      created?.dispose()
      terminal.current = null
    }
  }, [])

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = TERMINAL_THEMES[theme]
  }, [theme])

  const begin = useCallback((id: string): void => {
    setExecutionId(id)
    lastSeq.current = 0
    sawOutput.current = false
    terminal.current?.reset()
  }, [])

  useChannelEvent<{ executionId: string }>(
    session,
    'exec.started',
    useCallback((event) => begin(event.executionId), [begin]),
  )
  useChannelEvent<OutputEvent>(
    session,
    'exec.output',
    useCallback((event) => {
      if (event.seq <= lastSeq.current) return
      lastSeq.current = event.seq
      sawOutput.current = true
      terminal.current?.write(forTerminal(event.data))
    }, []),
  )

  // Live events can be missed across a reconnect, so the stored record decides the end state.
  const execution = useQuery({
    queryKey: ['execution', executionId],
    enabled: executionId !== null,
    queryFn: () => api<{ execution: Execution }>(`/executions/${executionId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.execution.status
      return status && !UNFINISHED.has(status) ? false : POLL_MS
    },
  })
  const result = execution.data?.execution
  const finished = result ? !UNFINISHED.has(result.status) : false

  useEffect(() => {
    if (!result || !finished || sawOutput.current) return
    sawOutput.current = true
    const parts = [result.compileOutput, result.stdout, result.stderr, result.message]
    terminal.current?.write(forTerminal(parts.filter(Boolean).join('\n')))
  }, [result, finished])

  const files = useMemo(
    () =>
      [...entries]
        .filter(([, entry]) => entry.kind === 'FILE')
        .map(([id, entry]) => ({ id, path: entry.path, language: languageOfPath(entry.path) })),
    [entries],
  )
  const activeFile = files.find((file) => file.id === activeFileId)
  const selected = language || activeFile?.language || ''
  const entry =
    activeFile?.language === selected
      ? activeFile
      : files.find((file) => file.language === selected)

  const run = useMutation({
    mutationFn: () =>
      api<{ execution: { id: string } }>(`/rooms/${roomId}/executions`, {
        method: 'POST',
        body: { projectId, entryPath: entry?.path, stdin },
      }),
    onSuccess: ({ execution: created }) => {
      if (created.id !== executionId) begin(created.id)
    },
  })

  const running = executionId !== null && !finished
  const canStart = canRun && Boolean(entry) && !running && !run.isPending
  const start = useCallback(() => {
    if (canStart) run.mutate()
  }, [canStart, run])
  runRef.current = start

  return (
    <section aria-label="Run" className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1">
        <Button variant="primary" onClick={start} disabled={!canStart}>
          {running ? 'Running…' : 'Run'}
        </Button>
        <label className="flex items-center gap-1 text-sm">
          <span className="sr-only">Language</span>
          <select
            value={selected}
            onChange={(event) => setLanguage(event.target.value as Language)}
            className="rounded border border-line bg-surface px-2 py-1 text-sm"
          >
            <option value="" disabled>
              Language
            </option>
            {LANGUAGES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span className="truncate text-xs text-muted">{entry?.path ?? 'No file to run'}</span>
        <span role="status" className="ml-auto flex items-center gap-2 text-xs text-muted">
          {result && <Badge>{result.status.replaceAll('_', ' ').toLowerCase()}</Badge>}
          {result?.timeMs != null && <span>{result.timeMs} ms</span>}
          {result?.memoryKb != null && <span>{formatBytes(result.memoryKb)}</span>}
        </span>
      </div>
      <ErrorNotice error={run.error} />
      <div className="flex min-h-0 flex-1">
        <label className="flex w-40 shrink-0 flex-col border-r border-line p-1 text-xs text-muted">
          Input
          <textarea
            value={stdin}
            onChange={(event) => setStdin(event.target.value)}
            className="mt-1 min-h-0 flex-1 resize-none rounded border border-line bg-canvas p-1 font-mono text-xs text-ink"
          />
        </label>
        <div ref={host} data-testid="terminal" className="min-w-0 flex-1 overflow-hidden p-1" />
      </div>
    </section>
  )
}
