import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router'
import { AppShell } from './components/AppShell'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Loading } from './components/ui'
import { useApplyTheme } from './lib/preferences'
import { useSession } from './lib/session'

const named = <T extends string>(
  load: () => Promise<Record<T, React.ComponentType>>,
  name: T,
): React.LazyExoticComponent<React.ComponentType> =>
  lazy(async () => ({ default: (await load())[name] }))

const auth = () => import('./features/auth/AuthPages')
const practice = () => import('./features/practice/PracticePages')

const LoginPage = named(auth, 'LoginPage')
const SignupPage = named(auth, 'SignupPage')
const VerifyEmailPage = named(auth, 'VerifyEmailPage')
const ForgotPasswordPage = named(auth, 'ForgotPasswordPage')
const ResetPasswordPage = named(auth, 'ResetPasswordPage')
const OAuthCallbackPage = named(auth, 'OAuthCallbackPage')
const DashboardPage = named(() => import('./features/dashboard/DashboardPage'), 'DashboardPage')
const InvitePage = named(() => import('./features/dashboard/InvitePage'), 'InvitePage')
const WorkspacePage = named(() => import('./features/workspace/WorkspacePage'), 'WorkspacePage')
const SettingsPage = named(() => import('./features/settings/SettingsPage'), 'SettingsPage')
const ProblemListPage = named(practice, 'ProblemListPage')
const ProblemPage = named(practice, 'ProblemPage')
const LeaderboardPage = named(practice, 'LeaderboardPage')
const ContestPage = named(practice, 'ContestPage')

// The invite token sits in the URL fragment, which has to survive the trip through sign-in.
function RequireSession() {
  const status = useSession((state) => state.status)
  const location = useLocation()
  if (status === 'loading') return <Loading />
  if (status === 'signedOut') {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  return <Outlet />
}

export function App() {
  useApplyTheme()
  const restore = useSession((state) => state.restore)
  useEffect(() => {
    void restore()
  }, [restore])

  return (
    <ErrorBoundary>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignupPage />} />
          <Route path="verify-email" element={<VerifyEmailPage />} />
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route path="auth/callback" element={<OAuthCallbackPage />} />
          <Route element={<RequireSession />}>
            <Route path="rooms/:roomId" element={<WorkspacePage />} />
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />
              <Route path="invite" element={<InvitePage />} />
              <Route path="practice" element={<ProblemListPage />} />
              <Route path="practice/sets/:setId" element={<LeaderboardPage />} />
              <Route path="practice/:slug" element={<ProblemPage />} />
              <Route path="contests/:contestId" element={<ContestPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}
