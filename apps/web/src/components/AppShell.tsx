import { NavLink, Outlet } from 'react-router'
import { useSession } from '../lib/session'
import { Button } from './ui'

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  `inline-flex min-h-8 items-center rounded px-3 text-sm transition-colors ${isActive ? 'bg-raised font-medium text-ink' : 'text-muted hover:text-ink'}`

export function AppShell() {
  const { user, signOut } = useSession()
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <span className="mr-4 text-base font-medium tracking-tight">CodeSync</span>
        <nav aria-label="Main" className="flex gap-1">
          <NavLink to="/" end className={linkClass}>
            Rooms
          </NavLink>
          <NavLink to="/practice" className={linkClass}>
            Practice
          </NavLink>
          <NavLink to="/settings" className={linkClass}>
            Settings
          </NavLink>
        </nav>
        <span className="ml-auto truncate text-sm text-muted">{user?.displayName}</span>
        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
