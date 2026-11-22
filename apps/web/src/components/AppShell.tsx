import { NavLink, Outlet } from 'react-router'
import { useSession } from '../lib/session'
import { Button } from './ui'

const linkClass = ({ isActive }: { isActive: boolean }): string =>
  `inline-flex min-h-8 items-center rounded px-3 text-sm ${isActive ? 'bg-raised font-medium text-ink' : 'text-muted hover:text-ink'}`

const CURRENT_YEAR = new Date().getFullYear()

export function AppShell() {
  const { user, signOut } = useSession()
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <NavLink to="/" className="mr-4 text-base font-semibold tracking-tight text-ink hover:text-accent">
          CodeSync
        </NavLink>
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
      <footer className="mt-auto border-t border-line bg-surface py-5 text-xs text-muted">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-4 sm:flex-row">
          <p>© {CURRENT_YEAR} CodeSync. Built by Shashank Singh.</p>
          <div className="flex flex-wrap items-center gap-4">
            <a href="https://github.com/Shashank17singh/CodeSync" target="_blank" rel="noopener noreferrer" className="hover:text-ink">
              GitHub
            </a>
            <a href="https://shashank17singh.github.io" target="_blank" rel="noopener noreferrer" className="hover:text-ink">
              Portfolio
            </a>
            <a href="https://mail.google.com/mail/?view=cm&fs=1&to=shashanksingh1709@gmail.com" target="_blank" rel="noopener noreferrer" className="hover:text-ink">
              Email
            </a>
            <a href="tel:+917905851722" className="hover:text-ink">
              +91 79058 51722
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
