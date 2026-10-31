import type { PresencePeer } from '@codesync/collab-client'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresenceSidebar, type PresenceSidebarProps } from './PresenceSidebar'
import { presenceStyles } from './presenceStyles'

const SELF = { userId: '11111111-1111-4111-8111-111111111111', name: 'Asha Rao' }

function peer(overrides: Partial<PresencePeer> = {}): PresencePeer {
  return {
    clientId: 42,
    userId: '22222222-2222-4222-8222-222222222222',
    name: 'Ben Okafor',
    initials: 'BO',
    color: '#1D4ED8',
    fileId: 'file-1',
    status: 'active',
    ...overrides,
  }
}

function renderSidebar(overrides: Partial<PresenceSidebarProps> = {}) {
  const onFollow = vi.fn()
  const onStopFollowing = vi.fn()
  render(
    <PresenceSidebar
      self={SELF}
      peers={[peer()]}
      filePath={(id) => (id === 'file-1' ? 'src/main.py' : undefined)}
      following={null}
      onFollow={onFollow}
      onStopFollowing={onStopFollowing}
      {...overrides}
    />,
  )
  return { onFollow, onStopFollowing }
}

describe('PresenceSidebar', () => {
  afterEach(cleanup)

  it('counts everyone online, including this user', () => {
    renderSidebar()
    expect(screen.getByRole('heading').textContent).toBe('Online (2)')
    expect(screen.getByText('Asha Rao (you)')).toBeTruthy()
  })

  it('shows which file each person is in and their status', () => {
    renderSidebar({ peers: [peer({ status: 'idle' })] })
    expect(screen.getByText('Idle · src/main.py')).toBeTruthy()
  })

  it('leaves out the file when a peer has none open', () => {
    renderSidebar({ peers: [peer({ fileId: null, status: 'away' })] })
    expect(screen.getByText('Away')).toBeTruthy()
  })

  it('offers no follow control for this user', () => {
    renderSidebar({ peers: [] })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('follows a peer on click and by keyboard', async () => {
    const user = userEvent.setup()
    const { onFollow } = renderSidebar()
    const button = screen.getByRole('button', { name: /Ben Okafor/ })
    await user.click(button)
    expect(onFollow).toHaveBeenLastCalledWith(42)
    button.focus()
    await user.keyboard('{Enter}')
    expect(onFollow).toHaveBeenCalledTimes(2)
  })

  it('marks the followed peer and stops on a second click', async () => {
    const user = userEvent.setup()
    const { onFollow, onStopFollowing } = renderSidebar({ following: 42 })
    const button = screen.getByRole('button', { name: /Ben Okafor/ })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    await user.click(button)
    expect(onStopFollowing).toHaveBeenCalledOnce()
    expect(onFollow).not.toHaveBeenCalled()
  })

  it('renders a hostile display name as plain text', () => {
    const name = '<img src=x onerror=alert(1)>'
    renderSidebar({ peers: [peer({ name })] })
    expect(screen.getByText(name)).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })
})

describe('presenceStyles', () => {
  it('highlights selections at 25% opacity', () => {
    expect(presenceStyles()).toContain('.cs-sel-6 { background-color: rgb(29 78 216 / 0.25); }')
  })
})
