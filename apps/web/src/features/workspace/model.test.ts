import type { TreeEntry } from '@codesync/shared'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_TABS,
  buildTree,
  closeTab,
  connectionState,
  findMentions,
  keepExisting,
  openTab,
} from './model'

describe('buildTree', () => {
  const entries = (list: Array<[string, TreeEntry['kind']]>): Map<string, TreeEntry> =>
    new Map(list.map(([path, kind], index) => [`id${index}`, { path, kind }]))

  it('nests files under folders, folders first', () => {
    const tree = buildTree(
      entries([
        ['z.py', 'FILE'],
        ['src', 'DIRECTORY'],
        ['src/a.py', 'FILE'],
        ['a.py', 'FILE'],
      ]),
    )
    expect(tree.map((node) => node.name)).toEqual(['src', 'a.py', 'z.py'])
    expect(tree[0]?.children.map((node) => node.path)).toEqual(['src/a.py'])
  })

  it('keeps a file visible when its folder has not arrived', () => {
    expect(buildTree(entries([['lost/a.py', 'FILE']])).map((node) => node.path)).toEqual([
      'lost/a.py',
    ])
  })
})

describe('tabs', () => {
  it('opens each file once and activates it', () => {
    const tabs = openTab(openTab(openTab(EMPTY_TABS, 'a'), 'b'), 'a')
    expect(tabs).toEqual({ open: ['a', 'b'], active: 'a' })
  })

  it('moves to a neighbour when the active tab closes', () => {
    const tabs = { open: ['a', 'b', 'c'], active: 'b' }
    expect(closeTab(tabs, 'b')).toEqual({ open: ['a', 'c'], active: 'c' })
    expect(closeTab({ open: ['a', 'b'], active: 'b' }, 'b')).toEqual({ open: ['a'], active: 'a' })
    expect(closeTab({ open: ['a'], active: 'a' }, 'a')).toEqual(EMPTY_TABS)
  })

  it('leaves the active tab alone when another closes', () => {
    expect(closeTab({ open: ['a', 'b'], active: 'a' }, 'b')).toEqual({ open: ['a'], active: 'a' })
  })

  it('drops tabs for files someone deleted', () => {
    const tabs = keepExisting({ open: ['a', 'b'], active: 'b' }, (id) => id === 'a')
    expect(tabs).toEqual({ open: ['a'], active: 'a' })
  })
})

describe('connectionState', () => {
  it('separates a lost network from a lost server', () => {
    expect(connectionState('connected', true)).toBe('connected')
    expect(connectionState('disconnected', true)).toBe('reconnecting')
    expect(connectionState('connecting', true)).toBe('reconnecting')
    expect(connectionState('connected', false)).toBe('offline')
  })
})

describe('findMentions', () => {
  const members = [
    { id: '1', displayName: 'Ann' },
    { id: '2', displayName: 'Ann Lee' },
    { id: '3', displayName: 'Bo' },
  ]

  it('prefers the longest matching name', () => {
    expect(findMentions('thanks @Ann Lee', members)).toEqual(['2'])
  })

  it('finds several people and ignores strangers', () => {
    expect(findMentions('@Ann and @Bo, not @Cy', members).sort()).toEqual(['1', '3'])
  })
})
