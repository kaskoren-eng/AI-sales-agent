import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar.js'
import { TopBar } from './TopBar.js'
import { ToastProvider } from '../ui/Toast.js'

interface AppLayoutProps {
  children: ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <ToastProvider>
      <div
        style={{
          display: 'flex',
          minHeight: '100vh',
          backgroundColor: 'var(--surface-page)',
        }}
      >
        <Sidebar />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <TopBar />
          <main
            style={{
              flex: 1,
              padding: '28px',
              overflowY: 'auto',
            }}
          >
            {children}
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
