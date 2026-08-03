import { useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar.js'
import { TopBar } from './TopBar.js'
import { ToastProvider } from '../ui/Toast.js'
import { ErrorBoundary } from '../ErrorBoundary.js'

interface AppLayoutProps {
  children: ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  // Mobile nav drawer state. Desktop ignores it (the sidebar is always visible there).
  const [navOpen, setNavOpen] = useState(false)
  const { pathname } = useLocation()

  return (
    <ToastProvider>
      <div className="app-shell">
        <Sidebar isOpen={navOpen} onNavigate={() => setNavOpen(false)} />
        {/* Scrim: visible only on mobile while the drawer is open (CSS-gated). */}
        <div className={`app-scrim${navOpen ? ' is-open' : ''}`} onClick={() => setNavOpen(false)} aria-hidden />

        <div className="app-content">
          <TopBar onMenu={() => setNavOpen(true)} />
          <main className="app-main">
            {/* A page render error stays contained here; the shell keeps working. Keyed by route
                so navigating away clears the error. */}
            <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
