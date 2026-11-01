import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, Navigate, useLocation, useNavigate, type Location } from 'react-router'
import { Button, ErrorNotice, Field, Loading } from '../../components/ui'
import { api, ApiRequestError, refreshSession } from '../../lib/api'
import { useSession } from '../../lib/session'

// Link tokens arrive in the fragment so they stay out of server logs. Removing it from the
// address bar keeps them out of history and screenshots as well.
function useFragmentToken(): string {
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') ?? '')
  useEffect(() => {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search)
  }, [])
  return token
}

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <section className="flex w-full max-w-sm flex-col gap-4 rounded-lg border border-line bg-surface p-6">
        <div>
          <p className="text-sm font-semibold text-accent">CodeSync</p>
          <h1 className="text-xl font-semibold">{title}</h1>
        </div>
        {children}
      </section>
    </main>
  )
}

function useSubmit(task: () => Promise<void>) {
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    task()
      .catch(setError)
      .finally(() => setBusy(false))
  }
  return { error, busy, submit }
}

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const signIn = useSession((state) => state.signIn)
  const status = useSession((state) => state.status)
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: Location } | null)?.from
  const target = from ? `${from.pathname}${from.search}${from.hash}` : '/'

  const { error, busy, submit } = useSubmit(async () => {
    const { accessToken } = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    })
    await signIn(accessToken)
    await navigate(target, { replace: true })
  })

  if (status === 'signedIn') return <Navigate to={target} replace />
  return (
    <AuthCard title="Sign in">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <ErrorNotice error={error} />
        <Button type="submit" variant="primary" disabled={busy}>
          Sign in
        </Button>
      </form>
      <div className="flex gap-2">
        <a href="/api/v1/auth/oauth/github" className="flex-1">
          <Button className="w-full">GitHub</Button>
        </a>
        <a href="/api/v1/auth/oauth/google" className="flex-1">
          <Button className="w-full">Google</Button>
        </a>
      </div>
      <p className="flex justify-between text-sm text-muted">
        <Link to="/signup" className="underline">
          Create an account
        </Link>
        <Link to="/forgot-password" className="underline">
          Forgot password?
        </Link>
      </p>
    </AuthCard>
  )
}

export function SignupPage() {
  const [form, setForm] = useState({ displayName: '', email: '', password: '' })
  const [sent, setSent] = useState(false)
  const { error, busy, submit } = useSubmit(async () => {
    await api('/auth/signup', { method: 'POST', body: form })
    setSent(true)
  })
  if (sent) {
    return (
      <AuthCard title="Check your email">
        <p className="text-sm text-muted">
          If this address can be used, a verification link is on its way to {form.email}.
        </p>
        <Link to="/login" className="text-sm underline">
          Back to sign in
        </Link>
      </AuthCard>
    )
  }
  return (
    <AuthCard title="Create an account">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="Name"
          autoComplete="name"
          required
          maxLength={80}
          value={form.displayName}
          onChange={(event) => setForm({ ...form, displayName: event.target.value })}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
        />
        <ErrorNotice error={error} />
        <Button type="submit" variant="primary" disabled={busy}>
          Create account
        </Button>
      </form>
      <Link to="/login" className="text-sm text-muted underline">
        Already have an account?
      </Link>
    </AuthCard>
  )
}

// Asks for the password, as the API does: a mail scanner opening the link must not be able to
// verify the account, and neither can someone who registered another person's address.
export function VerifyEmailPage() {
  const token = useFragmentToken()
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)
  const { error, busy, submit } = useSubmit(async () => {
    await api('/auth/verify-email', { method: 'POST', body: { token, password } })
    setDone(true)
  })
  if (done) {
    return (
      <AuthCard title="Email verified">
        <Link to="/login" className="text-sm underline">
          Sign in
        </Link>
      </AuthCard>
    )
  }
  return (
    <AuthCard title="Verify your email">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <ErrorNotice error={token ? error : 'This link is not complete.'} />
        <Button type="submit" variant="primary" disabled={busy || !token}>
          Verify
        </Button>
      </form>
    </AuthCard>
  )
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const { error, busy, submit } = useSubmit(async () => {
    await api('/auth/password/forgot', { method: 'POST', body: { email } })
    setSent(true)
  })
  return (
    <AuthCard title="Reset your password">
      {sent ? (
        <p role="status" className="text-sm text-muted">
          If that address has an account, a reset link is on its way.
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <ErrorNotice error={error} />
          <Button type="submit" variant="primary" disabled={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <Link to="/login" className="text-sm text-muted underline">
        Back to sign in
      </Link>
    </AuthCard>
  )
}

export function ResetPasswordPage() {
  const token = useFragmentToken()
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)
  const { error, busy, submit } = useSubmit(async () => {
    await api('/auth/password/reset', { method: 'POST', body: { token, password } })
    setDone(true)
  })
  if (done) {
    return (
      <AuthCard title="Password changed">
        <Link to="/login" className="text-sm underline">
          Sign in
        </Link>
      </AuthCard>
    )
  }
  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <ErrorNotice error={token ? error : 'This link is not complete.'} />
        <Button type="submit" variant="primary" disabled={busy || !token}>
          Change password
        </Button>
      </form>
    </AuthCard>
  )
}

export function OAuthCallbackPage() {
  const signIn = useSession((state) => state.signIn)
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    refreshSession()
      .then(async (ok) => {
        if (!ok) throw new ApiRequestError(401, 'session_expired', 'Sign in failed')
        await useSession.getState().restore()
        await navigate('/', { replace: true })
      })
      .catch(() => setFailed(true))
  }, [navigate, signIn])
  if (failed) {
    return (
      <AuthCard title="Sign in failed">
        <Link to="/login" className="text-sm underline">
          Back to sign in
        </Link>
      </AuthCard>
    )
  }
  return <Loading label="Signing you in…" />
}
