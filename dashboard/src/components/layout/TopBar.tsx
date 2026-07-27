import { Bell } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

const PAGE_TITLE_KEYS: Record<string, string> = {
  '/': 'nav.overview',
  '/leads': 'nav.leads',
  '/calls': 'nav.calls',
  '/voice': 'nav.testKeren',
  '/bookings': 'nav.bookings',
  '/integrations': 'nav.integrations',
  '/settings': 'nav.settings',
}

function getTitleKey(pathname: string): string {
  if (pathname.startsWith('/calls/')) return 'topbar.callDetail'
  if (pathname.startsWith('/leads/')) return 'topbar.leadDetail'
  return PAGE_TITLE_KEYS[pathname] ?? 'topbar.dashboard'
}

export function TopBar() {
  const location = useLocation()
  const { t, i18n } = useTranslation()
  const title = t(getTitleKey(location.pathname))
  const isHebrew = i18n.language.startsWith('he')

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        height: '60px',
        backgroundColor: 'var(--bg-page)',
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
          fontFamily: isHebrew ? "'Heebo', sans-serif" : "'Montserrat', sans-serif",
          fontWeight: 700,
          fontSize: '15px',
          letterSpacing: isHebrew ? 'normal' : '0.06em',
          textTransform: isHebrew ? 'none' : 'uppercase',
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
            ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--glass-hover)'
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
            background: 'linear-gradient(135deg, var(--accent-teal) 0%, var(--accent-violet) 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '13px',
            fontWeight: 700,
            color: 'var(--text-on-teal)',
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
