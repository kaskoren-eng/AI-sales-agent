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
import { LanguageSwitcher } from '../LanguageSwitcher.js'
import { ThemeToggle } from '../ThemeToggle.js'

interface NavItem {
  to: string
  labelKey: string
  icon: React.ReactNode
  end?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', labelKey: 'nav.overview', icon: <LayoutDashboard size={18} strokeWidth={1.6} />, end: true },
  { to: '/leads', labelKey: 'nav.leads', icon: <Users size={18} strokeWidth={1.6} /> },
  { to: '/calls', labelKey: 'nav.calls', icon: <Phone size={18} strokeWidth={1.6} /> },
  { to: '/voice', labelKey: 'nav.testKeren', icon: <AudioLines size={18} strokeWidth={1.6} /> },
  { to: '/bookings', labelKey: 'nav.bookings', icon: <CalendarDays size={18} strokeWidth={1.6} /> },
  { to: '/integrations', labelKey: 'nav.integrations', icon: <Plug size={18} strokeWidth={1.6} /> },
  { to: '/settings', labelKey: 'nav.settings', icon: <Settings size={18} strokeWidth={1.6} /> },
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
        backgroundColor: 'var(--surface-card)',
        borderInlineEnd: '1px solid var(--border-default)',
        zIndex: 40,
        overflow: 'hidden',
      }}
      aria-label={t('nav.mainNavigation')}
    >
      {/* Platform wordmark — ClickScales (flat, no gradient). Agent name is per-tenant elsewhere. */}
      <div
        style={{
          height: '60px',
          paddingInline: '20px',
          display: 'flex',
          alignItems: 'center',
          borderBottom: '1px solid var(--border-default)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize: '19px',
            letterSpacing: '0.01em',
            color: 'var(--text-primary)',
          }}
        >
          ClickScales
        </span>
      </div>

      {/* Nav */}
      <nav
        style={{ flex: 1, padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '3px', overflow: 'auto' }}
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
                gap: '11px',
                padding: '9px 12px',
                borderRadius: '10px',
                fontSize: '14px',
                fontWeight: isActive ? 600 : 500,
                color: isActive ? 'var(--accent-fg)' : 'var(--text-secondary)',
                backgroundColor: isActive ? 'var(--accent-tint)' : 'transparent',
                transition: `background-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)`,
                textDecoration: 'none',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  ;(e.currentTarget as HTMLAnchorElement).style.backgroundColor = 'var(--surface-sunken)'
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

      {/* Footer: interface language + appearance (theme). Canonical control also in Settings. */}
      <div
        style={{
          padding: '14px 16px 20px',
          borderTop: '1px solid var(--border-default)',
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
    </aside>
  )
}
