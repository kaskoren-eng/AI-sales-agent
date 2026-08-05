import { useEffect, useState, type ReactNode } from 'react'
import { getSession, restoreSession, subscribe, type Session } from '../lib/auth'
import { Login } from '../pages/Login'

/**
 * Decides between the app and the sign-in screen.
 *
 * The nuance worth knowing: nothing about the session is persisted in localStorage — the access
 * token lives in a module variable and dies with the tab. What survives a reload is the httpOnly
 * refresh cookie, so on every mount we spend one /auth/refresh to turn that cookie back into a
 * session. That call is why there is a `checking` state at all; rendering the login form first and
 * swapping it out a moment later would flash the sign-in screen at every already-authenticated
 * user on every page load.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(getSession())
  const [checking, setChecking] = useState(session === null)

  useEffect(() => {
    const unsubscribe = subscribe(setSession)
    if (session === null) {
      void restoreSession().finally(() => setChecking(false))
    }
    return unsubscribe
    // Mount only: re-running this would fire a second refresh and rotate the token needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (checking) {
    // Deliberately blank rather than a spinner. This resolves in one round trip; a spinner that
    // appears and vanishes inside 200ms reads as a glitch.
    return <div style={{ minBlockSize: '100vh', background: 'var(--surface-page)' }} aria-busy="true" />
  }

  if (!session) return <Login onAuthed={() => setChecking(false)} />

  return <>{children}</>
}
