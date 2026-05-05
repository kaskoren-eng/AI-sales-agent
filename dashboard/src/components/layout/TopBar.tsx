import { Bell } from 'lucide-react'
import { useLocation } from 'react-router-dom'

const PAGE_TITLES: Record<string, string> = {
  '/': 'Overview',
  '/leads': 'Leads',
  '/calls': 'Calls',
  '/bookings': 'Bookings',
  '/integrations': 'Integrations',
  '/settings': 'Settings',
}

function getTitle(pathname: string): string {
  if (pathname.startsWith('/calls/')) return 'Call Detail'
  return PAGE_TITLES[pathname] ?? 'Dashboard'
}

export function TopBar() {
  const location = useLocation()
  const title = getTitle(location.pathname)

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        height: '60px',
        backgroundColor: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingInline: '28px',
        zIndex: 30,
        flexShrink: 0,
      }}
    >
      <h2
        style={{
          fontFamily: "'Montserrat', sans-serif",
          fontWeight: 700,
          fontSize: '15px',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--text-primary)',
        }}
      >
        {title}
      </h2>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button
          aria-label="Notifications"
          style={{
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '8px',
            border: '1px solid var(--border-subtle)',
            backgroundColor: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transition: `background-color var(--duration-fast) var(--ease-standard)`,
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-elevated)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'
          }}
        >
          <Bell size={16} strokeWidth={1.5} />
        </button>

        {/* User avatar placeholder */}
        <div
          aria-label="User menu"
          style={{
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, var(--accent-cyan) 0%, var(--accent-violet) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '13px',
            fontWeight: 700,
            color: 'var(--text-on-cyan)',
            flexShrink: 0,
            cursor: 'pointer',
            fontFamily: "'Montserrat', sans-serif",
          }}
        >
          D
        </div>
      </div>
    </header>
  )
}
