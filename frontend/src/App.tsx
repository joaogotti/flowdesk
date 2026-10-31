import { useCallback, useEffect, useRef, useState } from 'react'
import Login from './pages/Login'
import Dashboard from './pages/dashboard'
import Categories from './pages/categories'
import Users from './pages/users'
import Reports from './pages/reports'
import Settings from './pages/settings'
import Tickets from './pages/tickets'
import NewTicket from './pages/new-ticket'
import TicketDetails from './pages/ticket-details'
import AuthenticatedLayout from './layouts/authenticated-layout'
import { ApiError, ObsoleteRequestError, beginAuthentication, getAuthenticationGeneration, getAuthenticationLossMessage, onAuthenticationLost } from './services/api'
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
  const [identityGeneration, setIdentityGeneration] = useState(getAuthenticationGeneration)
  const handleIdentityUpdated = useCallback((updated: AuthenticatedUser) => {
    if (identityGeneration !== getAuthenticationGeneration()) return
    setUser(current => identityGeneration === getAuthenticationGeneration() && current?.id === updated.id ? updated : current)
  }, [identityGeneration])

  useEffect(() => onAuthenticationLost(event => {
    if (event.generation !== getAuthenticationGeneration()) return
    setIdentityGeneration(getAuthenticationGeneration())
    setUser(null)
    setCreationMessage(null)
    setLogoutError(null)
    setError(getAuthenticationLossMessage(event))
    setIsCheckingSession(false)
    submissionInProgress.current = false
    logoutInProgress.current = false
    setIsSubmitting(false)
    setIsLoggingOut(false)
  }), [])

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
    const generation = getAuthenticationGeneration()

    getCurrentUser()
      .then((currentUser) => {
        if (active && generation === getAuthenticationGeneration()) setUser(currentUser)
      })
      .catch((cause: unknown) => {
        if (active && generation === getAuthenticationGeneration() && !(cause instanceof ObsoleteRequestError) && !(cause instanceof ApiError && cause.status === 401)) {
          setError(getAuthErrorMessage(cause, 'session'))
        }
      })
      .finally(() => {
        if (active && generation === getAuthenticationGeneration()) setIsCheckingSession(false)
      })

    return () => { active = false }
  }, [])

  async function handleLogin(credentials: LoginCredentials): Promise<boolean> {
    if (submissionInProgress.current || isCheckingSession || user) return false

    submissionInProgress.current = true
    setIsSubmitting(true)
    setError(null)
    const generation = beginAuthentication()
    let context: 'login' | 'session' = 'login'

    try {
      await login(credentials, generation)
      context = 'session'
      const currentUser = await getCurrentUser()
      if (generation !== getAuthenticationGeneration()) return false
      setIdentityGeneration(generation)
      setUser(currentUser)
      return true
    } catch (cause) {
      if (generation !== getAuthenticationGeneration() || cause instanceof ObsoleteRequestError) return false
      setError(getAuthErrorMessage(cause, context))
      return false
    } finally {
      if (generation === getAuthenticationGeneration()) {
        submissionInProgress.current = false
        setIsSubmitting(false)
      }
    }
  }

  async function handleLogout(): Promise<void> {
    if (logoutInProgress.current) return

    logoutInProgress.current = true
    setIsLoggingOut(true)
    setLogoutError(null)
    setCreationMessage(null)
    const generation = getAuthenticationGeneration()

    try {
      await logout(generation)
    } catch (cause) {
      if (generation !== getAuthenticationGeneration() || cause instanceof ObsoleteRequestError) return
      setLogoutError(cause instanceof ApiError && cause.status === 419
        ? 'Não foi possível validar a saída. Atualize a página e tente novamente.'
        : 'Não foi possível sair da conta. Verifique sua conexão e tente novamente.')
    } finally {
      if (generation === getAuthenticationGeneration()) {
        logoutInProgress.current = false
        setIsLoggingOut(false)
      }
    }
  }

  if (user) {
    return (
      <AuthenticatedLayout key={identityGeneration} page={page} user={user} isLoggingOut={isLoggingOut} logoutError={logoutError} onLogout={handleLogout}>
        {route.page === 'ticket-details' ? (
          <TicketDetails key={route.ticketId ?? 'invalid'} ticketId={route.ticketId} user={user} />
        ) : page === 'settings' ? (
          <Settings user={user} onUserUpdated={handleIdentityUpdated} />
        ) : page === 'reports' ? (
          <Reports user={user} />
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
