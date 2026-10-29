import { useEffect, useRef, useState } from 'react'
import Login from './pages/Login'
import Dashboard from './pages/dashboard'
import Categories from './pages/categories'
import Users from './pages/users'
import Tickets from './pages/tickets'
import NewTicket from './pages/new-ticket'
import TicketDetails from './pages/ticket-details'
import AuthenticatedLayout from './layouts/authenticated-layout'
import { ApiError } from './services/api'
import { getAuthErrorMessage, getCurrentUser, login, logout } from './services/auth'
import type { AuthenticatedUser, LoginCredentials } from './types/auth'
import { pageLabels } from './types/navigation'
import { parseWorkspaceHash } from './utils/navigation'

function App() {
  const [route, setRoute] = useState(() => parseWorkspaceHash(window.location.hash))
  const page = route.page
  const [creationMessage, setCreationMessage] = useState<string | null>(null)
  const [user, setUser] = useState<AuthenticatedUser | null>(null)
  const [isCheckingSession, setIsCheckingSession] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submissionInProgress = useRef(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const logoutInProgress = useRef(false)

  useEffect(() => {
    document.title = user ? `${pageLabels[page]} | Flowdesk` : 'Entrar | Flowdesk'
  }, [user, page])

  useEffect(() => {
    const handleNavigation = () => {
      const nextRoute = parseWorkspaceHash(window.location.hash)
      setRoute(nextRoute)
      if (nextRoute.page !== 'tickets') setCreationMessage(null)
    }
    window.addEventListener('hashchange', handleNavigation)
    return () => window.removeEventListener('hashchange', handleNavigation)
  }, [])

  useEffect(() => {
    let active = true

    getCurrentUser()
      .then((currentUser) => {
        if (active) setUser(currentUser)
      })
      .catch((cause: unknown) => {
        if (active && !(cause instanceof ApiError && cause.status === 401)) {
          setError(getAuthErrorMessage(cause, 'session'))
        }
      })
      .finally(() => {
        if (active) setIsCheckingSession(false)
      })

    return () => { active = false }
  }, [])

  async function handleLogin(credentials: LoginCredentials): Promise<boolean> {
    if (submissionInProgress.current || isCheckingSession || user) return false

    submissionInProgress.current = true
    setIsSubmitting(true)
    setError(null)
    let context: 'login' | 'session' = 'login'

    try {
      await login(credentials)
      context = 'session'
      const currentUser = await getCurrentUser()
      setUser(currentUser)
      return true
    } catch (cause) {
      setError(getAuthErrorMessage(cause, context))
      return false
    } finally {
      submissionInProgress.current = false
      setIsSubmitting(false)
    }
  }

  async function handleLogout(): Promise<void> {
    if (logoutInProgress.current) return

    logoutInProgress.current = true
    setIsLoggingOut(true)
    setLogoutError(null)
    setCreationMessage(null)

    try {
      await logout()
      setUser(null)
      setError(null)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setUser(null)
        setError(null)
      } else {
        setLogoutError(cause instanceof ApiError && cause.status === 419
          ? 'Não foi possível validar a saída. Atualize a página e tente novamente.'
          : 'Não foi possível sair da conta. Verifique sua conexão e tente novamente.')
      }
    } finally {
      logoutInProgress.current = false
      setIsLoggingOut(false)
    }
  }

  if (user) {
    return (
      <AuthenticatedLayout page={page} user={user} isLoggingOut={isLoggingOut} logoutError={logoutError} onLogout={handleLogout}>
        {route.page === 'ticket-details' ? (
          <TicketDetails key={route.ticketId ?? 'invalid'} ticketId={route.ticketId} user={user} />
        ) : page === 'categories' ? (
          <Categories user={user} />
        ) : page === 'users' ? (
          <Users user={user} onUserUpdated={updated => setUser(current => current?.id === updated.id ? { ...current, name: updated.name, email: updated.email } : current)} />
        ) : page === 'new-ticket' ? (
          <NewTicket onCreated={(ticketId) => {
            window.location.hash = `#/chamados/${ticketId}`
          }} />
        ) : page === 'tickets' ? (
          <Tickets successMessage={creationMessage} onDismissSuccess={() => setCreationMessage(null)} />
        ) : <Dashboard />}
      </AuthenticatedLayout>
    )
  }

  return (
    <Login
      user={user}
      error={error}
      isCheckingSession={isCheckingSession}
      isSubmitting={isSubmitting}
      onLogin={handleLogin}
    />
  )
}

export default App
