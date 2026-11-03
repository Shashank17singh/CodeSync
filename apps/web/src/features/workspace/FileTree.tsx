import type { TreeEntry } from '@codesync/shared'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Button, Dialog, ErrorNotice, Field } from '../../components/ui'
import { api } from '../../lib/api'
import { buildTree, type TreeNode } from './model'

const FILE_BADGES: Record<string, { label: string; className: string }> = {
  // The letters tell files apart; colour is kept for people and measurements.
  py: { label: 'Py', className: 'text-ink-2' },
  cpp: { label: 'C+', className: 'text-ink-2' },
  cc: { label: 'C+', className: 'text-ink-2' },
  java: { label: 'Jv', className: 'text-ink-2' },
  js: { label: 'JS', className: 'text-ink-2' },
  md: { label: 'Md', className: 'text-muted' },
}

function FileIcon({ node }: { node: TreeNode }) {
  if (node.kind === 'DIRECTORY') {
    return (
      <span aria-hidden="true" className="w-5 shrink-0 text-center text-xs text-muted">
        ▸
      </span>
    )
  }
  const badge = FILE_BADGES[node.name.split('.').pop()?.toLowerCase() ?? '']
  return (
    <span
      aria-hidden="true"
      className={`w-5 shrink-0 text-center text-[10px] font-bold ${badge?.className ?? 'text-muted'}`}
    >
      {badge?.label ?? '·'}
    </span>
  )
}

type Prompt =
  | { type: 'create'; kind: 'FILE' | 'DIRECTORY'; parent: string }
  | { type: 'rename'; node: TreeNode }
  | { type: 'move'; node: TreeNode }

const DRAG_TYPE = 'application/x-codesync-file'

export interface FileTreeProps {
  entries: ReadonlyMap<string, TreeEntry>
  projectId: string
  canWrite: boolean
  activeFileId: string | null
  onOpen: (fileId: string) => void
}

export function FileTree({ entries, projectId, canWrite, activeFileId, onOpen }: FileTreeProps) {
  const tree = useMemo(() => buildTree(entries), [entries])
  const [menu, setMenu] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<unknown>(null)
  const menuElement = useRef<HTMLDivElement>(null)
  const menuTrigger = useRef<HTMLElement | null>(null)

  // Focus moves into the menu and back out, so a keyboard user is never left behind it.
  useEffect(() => {
    if (menu) menuElement.current?.querySelector('button')?.focus()
  }, [menu])

  const onMenuKey = (event: ReactKeyboardEvent): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const items = [...(menuElement.current?.querySelectorAll('button') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(index + step + items.length) % items.length]?.focus()
  }

  useEffect(() => {
    if (!menu) return undefined
    const close = (): void => setMenu(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close()
        menuTrigger.current?.focus()
      }
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const run = (task: Promise<unknown>): void => {
    setError(null)
    task.catch(setError)
  }
  const move = (node: TreeNode, path: string): void => {
    if (path === node.path) return
    run(api(`/projects/${projectId}/files/${node.id}`, { method: 'PATCH', body: { path } }))
  }
  const remove = (node: TreeNode): void => {
    if (!window.confirm(`Delete ${node.path}?`)) return
    run(api(`/projects/${projectId}/files/${node.id}`, { method: 'DELETE' }))
  }

  const ask = (next: Prompt): void => {
    setName(next.type === 'rename' ? next.node.name : next.type === 'move' ? next.node.path : '')
    setPrompt(next)
  }
  const submitPrompt = (event: FormEvent): void => {
    event.preventDefault()
    if (!prompt) return
    if (prompt.type === 'create') {
      const path = prompt.parent ? `${prompt.parent}/${name}` : name
      run(api(`/projects/${projectId}/files`, { method: 'POST', body: { path, kind: prompt.kind } }))
    } else if (prompt.type === 'move') {
      move(prompt.node, name)
    } else {
      const parent = prompt.node.path.split('/').slice(0, -1).join('/')
      move(prompt.node, parent ? `${parent}/${name}` : name)
    }
    setPrompt(null)
  }

  const onDrop = (event: DragEvent, directory: string): void => {
    event.preventDefault()
    event.stopPropagation()
    const path = event.dataTransfer.getData(DRAG_TYPE)
    const node = [...entries].find(([, entry]) => entry.path === path)
    if (!node || !canWrite) return
    const fileName = path.split('/').pop() as string
    const target = directory ? `${directory}/${fileName}` : fileName
    if (directory === path || directory.startsWith(`${path}/`)) return
    move({ id: node[0], path, name: fileName, kind: node[1].kind, children: [] }, target)
  }

  const row = (node: TreeNode, depth: number) => (
    <li key={node.id}>
      <div
        draggable={canWrite}
        onDragStart={(event) => event.dataTransfer.setData(DRAG_TYPE, node.path)}
        onDragOver={(event) => {
          if (node.kind === 'DIRECTORY') event.preventDefault()
        }}
        onDrop={(event) => {
          if (node.kind === 'DIRECTORY') onDrop(event, node.path)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          if (canWrite) setMenu({ node, x: event.clientX, y: event.clientY })
        }}
        style={{ paddingLeft: depth * 12 + 4 }}
        className={`group flex items-center rounded pr-1 hover:bg-raised ${
          node.id === activeFileId ? 'bg-raised font-medium' : ''
        }`}
      >
        <button
          type="button"
          disabled={node.kind === 'DIRECTORY'}
          aria-current={node.id === activeFileId ? 'true' : undefined}
          onClick={() => onOpen(node.id)}
          className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-sm disabled:cursor-default"
        >
          <FileIcon node={node} />
          <span className="truncate">{node.name}</span>
        </button>
        {canWrite && (
          <button
            type="button"
            aria-label={`Actions for ${node.path}`}
            aria-haspopup="menu"
            className="rounded px-1 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100"
            onClick={(event) => {
              event.stopPropagation()
              menuTrigger.current = event.currentTarget
              const box = event.currentTarget.getBoundingClientRect()
              setMenu({ node, x: box.left, y: box.bottom })
            }}
          >
            ⋯
          </button>
        )}
      </div>
      {node.children.length > 0 && <ul>{node.children.map((child) => row(child, depth + 1))}</ul>}
    </li>
  )

  const parentOf = (node: TreeNode): string =>
    node.kind === 'DIRECTORY' ? node.path : node.path.split('/').slice(0, -1).join('/')

  // Dragging is a shortcut: the Move action reaches the same result from the keyboard.
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <nav
      aria-label="Files"
      className="flex h-full flex-col gap-1 overflow-y-auto bg-surface p-2"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(event, '')}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Files</h2>
        {canWrite && (
          <span className="flex gap-1">
            <Button
              variant="ghost"
              className="!px-1.5 !py-0.5"
              onClick={() => ask({ type: 'create', kind: 'FILE', parent: '' })}
            >
              New file
            </Button>
            <Button
              variant="ghost"
              className="!px-1.5 !py-0.5"
              onClick={() => ask({ type: 'create', kind: 'DIRECTORY', parent: '' })}
            >
              New folder
            </Button>
          </span>
        )}
      </div>
      <ErrorNotice error={error} />
      <ul>{tree.map((node) => row(node, 0))}</ul>

      {menu && (
        <div
          ref={menuElement}
          role="menu"
          tabIndex={-1}
          onKeyDown={onMenuKey}
          aria-label={`Actions for ${menu.node.path}`}
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-20 flex min-w-36 flex-col rounded border border-line-strong bg-raised p-1"
        >
          {(
            [
              ['New file here', () => ask({ type: 'create', kind: 'FILE', parent: parentOf(menu.node) })],
              ['Rename', () => ask({ type: 'rename', node: menu.node })],
              ['Move', () => ask({ type: 'move', node: menu.node })],
              ['Delete', () => remove(menu.node)],
            ] as const
          ).map(([label, action]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              onClick={action}
              className="rounded px-2 py-1 text-left text-sm hover:bg-raised"
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <Dialog
        title={
          prompt?.type === 'rename'
            ? `Rename ${prompt.node.name}`
            : prompt?.type === 'move'
              ? `Move ${prompt.node.name}`
              : prompt?.kind === 'DIRECTORY'
                ? 'New folder'
                : 'New file'
        }
        open={prompt !== null}
        onClose={() => setPrompt(null)}
      >
        <form onSubmit={submitPrompt} className="flex flex-col gap-3">
          <Field
            label={prompt?.type === 'move' ? 'New path' : 'Name'}
            required
            autoFocus
            maxLength={1024}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" variant="primary">
            Save
          </Button>
        </form>
      </Dialog>
    </nav>
  )
}
