import { useState } from 'react'
import { ErrorNotice } from '../../components/ui'
import { api } from '../../lib/api'
import {
  usePreferences,
  type Keybindings,
  type RunShortcut,
  type ThemeChoice,
} from '../../lib/preferences'
import { useSession } from '../../lib/session'

const SHORTCUTS = [
  ['Run the program', 'Your run shortcut, above'],
  ['Save a checkpoint', 'History panel'],
  ['Find in file', 'Ctrl+F'],
  ['Command palette', 'F1'],
  ['Undo your own edits', 'Ctrl+Z'],
]

const inputClass = 'rounded border border-line-strong bg-deep text-ink px-3 py-2 text-sm'

export function SettingsPage() {
  const preferences = usePreferences()
  const [error, setError] = useState<unknown>(null)

  // Local first, so the change shows at once and still holds if the save fails.
  const saveTheme = (theme: ThemeChoice): void => {
    preferences.set({ theme })
    api('/me', { method: 'PATCH', body: { theme } }).catch(setError)
  }
  const saveEditor = (changes: {
    fontSize?: number
    tabSize?: number
    keybindings?: Keybindings
  }): void => {
    preferences.set(changes)
    api('/me', { method: 'PATCH', body: { editorSettings: changes } }).catch(setError)
  }

  return (
    <div className="flex max-w-lg flex-col gap-6">
      <h1 className="text-xl font-medium">Settings</h1>
      <p className="text-sm text-muted">{useSession((state) => state.user?.email)}</p>
      <ErrorNotice error={error} />

      <section className="flex flex-col gap-3" aria-labelledby="appearance">
        <h2 id="appearance" className="font-medium">
          Appearance
        </h2>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Theme
          <select
            className={inputClass}
            value={preferences.theme}
            onChange={(event) => saveTheme(event.target.value as ThemeChoice)}
          >
            <option value="system">Match the system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="editor">
        <h2 id="editor" className="font-medium">
          Editor
        </h2>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Font size
          <input
            type="number"
            min={8}
            max={32}
            className={inputClass}
            value={preferences.fontSize}
            onChange={(event) => saveEditor({ fontSize: Number(event.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Tab size
          <input
            type="number"
            min={1}
            max={8}
            className={inputClass}
            value={preferences.tabSize}
            onChange={(event) => saveEditor({ tabSize: Number(event.target.value) })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={preferences.wordWrap}
            onChange={(event) => preferences.set({ wordWrap: event.target.checked })}
          />
          Wrap long lines
        </label>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="keybindings">
        <h2 id="keybindings" className="font-medium">
          Keybindings
        </h2>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Editor keys
          <select
            className={inputClass}
            value={preferences.keybindings}
            onChange={(event) => saveEditor({ keybindings: event.target.value as Keybindings })}
          >
            <option value="default">Default</option>
            <option value="vim">Vim</option>
            <option value="emacs">Emacs</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Run shortcut
          <select
            className={inputClass}
            value={preferences.runShortcut}
            onChange={(event) =>
              preferences.set({ runShortcut: event.target.value as RunShortcut })
            }
          >
            <option value="ctrl-enter">Ctrl+Enter</option>
            <option value="f5">F5</option>
          </select>
        </label>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          {SHORTCUTS.map(([action, keys]) => (
            <div key={action} className="contents">
              <dt>{action}</dt>
              <dd className="text-muted">{keys}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  )
}
