import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  AudioLines,
  LayoutDashboard,
  Users,
  Phone,
  CalendarDays,
  Plug,
  Settings,
} from 'lucide-react'
import { KerenStatusChip } from '../KerenStatusChip.js'
import { LanguageSwitcher } from '../LanguageSwitcher.js'

interface NavItem {
  to: string
  labelKey: string
  icon: React.ReactNode
  end?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.overview', icon: <LayoutDashboard size={18} strokeWidth={1.5} />, end: true },
  { to: '/leads', labelKey: 'nav.leads', icon: <Users size={18} strokeWidth={1.5} /> },
  { to: '/calls', labelKey: 'nav.calls', icon: <Phone size={18} strokeWidth={1.5} /> },
  { to: '/voice', labelKey: 'nav.testKeren', icon: <AudioLines size={18} strokeWidth={1.5} /> },
  { to: '/bookings', labelKey: 'nav.bookings', icon: <CalendarDays size={18} strokeWidth={1.5} /> },
  { to: '/integrations', labelKey: 'nav.integrations', icon: <Plug size={18} strokeWidth={1.5} /> },
  { to: '/settings', labelKey: 'nav.settings', icon: <Settings size={18} strokeWidth={1.5} /> },
]

export function Sidebar() {
  const location = useLocation()
  const { t } = useTranslation()

  return (
    <aside
      style={{
        width: '240px',
        minWidth: '240px',
        height: '100vh',
        position: 'sticky',
        top: 0,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--bg-inset)',
        borderInlineEnd: '1px solid var(--border-subtle)',
        zIndex: 40,
        overflow: 'hidden',
      }}
      aria-label={t('nav.mainNavigation')}
    >
      {/* Logo */}
      <div
        style={{
          padding: '20px 20px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <img
          src="/logo.png"
          alt="KEREN logo"
          style={{ width: '36px', height: '36px', objectFit: 'contain', flexShrink: 0 }}
        />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span
            style={{
              fontFamily: "'Montserrat', sans-serif",
              fontWeight: 800,
              fontSize: '18px',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              lineHeight: 1.2,
              background: 'linear-gradient(135deg, var(--accent-cyan) 0%, var(--accent-violet) 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            KEREN
          </span>
          <span
            style={{
              fontSize: '10px',
              fontWeight: 600,
              letterSpacing: '0.08em',
              color: 'var(--text-muted)',
              fontFamily: "'Assistant', sans-serif",
            }}
          >
            {t('sidebar.tagline')}
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav
        style={{ flex: 1, padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'auto' }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive = item.end
            ? location.pathname === item.to
            : location.pathname.startsWith(item.to)

          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '9px 12px',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: isActive ? 600 : 400,
                color: isActive ? 'var(--accent-cyan)' : 'var(--text-secondary)',
                backgroundColor: isActive ? 'rgba(15, 163, 172, 0.07)' : 'transparent',
                borderInlineStart: isActive ? '2px solid var(--accent-cyan)' : '2px solid transparent',
                transition: `background-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)`,
                textDecoration: 'none',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  ;(e.currentTarget as HTMLAnchorElement).style.backgroundColor = 'var(--bg-elevated)'
                  ;(e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-primary)'
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  ;(e.currentTarget as HTMLAnchorElement).style.backgroundColor = 'transparent'
                  ;(e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-secondary)'
                }
              }}
              aria-current={isActive ? 'page' : undefined}
            >
              <span style={{ flexShrink: 0 }}>{item.icon}</span>
              {t(item.labelKey)}
            </NavLink>
          )
        })}
      </nav>

      {/* Footer: language switcher + status chip */}
      <div
        style={{
          padding: '16px 16px 20px',
          borderTop: '1px solid var(--border-subtle)',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <LanguageSwitcher />
        <KerenStatusChip />
      </div>
    </aside>
  )
}
