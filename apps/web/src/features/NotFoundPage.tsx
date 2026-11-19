import { Link } from 'react-router'
import { Button } from '../components/ui'

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center p-6 text-center">
      <p className="font-mono text-6xl font-bold text-accent">404</p>
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">Room or Page Not Found</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">
        The workspace, practice challenge, or URL you were looking for doesn&apos;t exist.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link to="/">
          <Button variant="primary">Return to Rooms</Button>
        </Link>
        <Link to="/practice">
          <Button variant="ghost">Browse Practice</Button>
        </Link>
      </div>
    </div>
  )
}
