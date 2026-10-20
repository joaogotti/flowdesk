import { useEffect, useRef, useState } from 'react'
import Login from './pages/Login'
import { ApiError } from './services/api'
import { getAuthErrorMessage, getCurrentUser, login } from './services/auth'
import type { AuthenticatedUser, LoginCredentials } from './types/auth'

function App() {
  const [user, setUser] = useState<AuthenticatedUser | null>(null)
  const [isCheckingSession, setIsCheckingSession] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submissionInProgress = useRef(false)

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
