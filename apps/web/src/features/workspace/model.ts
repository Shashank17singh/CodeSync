import type { TreeEntry } from '@codesync/shared'

export interface TreeNode {
  id: string
  name: string
  path: string
  kind: TreeEntry['kind']
  children: TreeNode[]
}

// Folders first, then by name. A file whose folder row has not arrived yet sits at the top level
// until it does, so it is never hidden.
export function buildTree(entries: ReadonlyMap<string, TreeEntry>): TreeNode[] {
  const nodes = new Map<string, TreeNode>()
  for (const [id, { path, kind }] of entries) {
    nodes.set(path, { id, path, kind, name: path.split('/').pop() ?? path, children: [] })
  }
  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    const parent = nodes.get(node.path.split('/').slice(0, -1).join('/'))
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const order = (list: TreeNode[]): TreeNode[] => {
    list.sort(
      (a, b) => (a.kind === b.kind ? 0 : a.kind === 'DIRECTORY' ? -1 : 1) || a.name.localeCompare(b.name),
    )
    list.forEach((node) => order(node.children))
    return list
  }
  return order(roots)
}

export interface Tabs {
  open: string[]
  active: string | null
}

export const EMPTY_TABS: Tabs = { open: [], active: null }

export const openTab = ({ open }: Tabs, fileId: string): Tabs => ({
  open: open.includes(fileId) ? open : [...open, fileId],
  active: fileId,
})

export function closeTab({ open, active }: Tabs, fileId: string): Tabs {
  const index = open.indexOf(fileId)
  const remaining = open.filter((id) => id !== fileId)
  if (active !== fileId) return { open: remaining, active }
  return { open: remaining, active: remaining[Math.min(index, remaining.length - 1)] ?? null }
}

export const keepExisting = (tabs: Tabs, exists: (fileId: string) => boolean): Tabs =>
  tabs.open.reduce((current, id) => (exists(id) ? current : closeTab(current, id)), tabs)

export type ConnectionState = 'connected' | 'reconnecting' | 'offline'

export function connectionState(socket: string, online: boolean): ConnectionState {
  if (!online) return 'offline'
  return socket === 'connected' ? 'connected' : 'reconnecting'
}

// Longest names first, so "@Ann Lee" is not read as a mention of "Ann".
export function findMentions(
  body: string,
  members: ReadonlyArray<{ id: string; displayName: string }>,
): string[] {
  let rest = body
  const found: string[] = []
  const byLength = [...members].sort((a, b) => b.displayName.length - a.displayName.length)
  for (const { id, displayName } of byLength) {
    const mention = `@${displayName}`
    if (rest.includes(mention)) {
      found.push(id)
      rest = rest.split(mention).join('')
    }
  }
  return found
}

export const formatBytes = (kb: number | null): string =>
  kb === null ? '–' : kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`
