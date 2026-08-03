import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard,
  Sparkles,
  Users,
  Phone,
  CalendarDays,
  SlidersHorizontal,
  AudioLines,
  Settings,
  Plug,
  CreditCard,
} from 'lucide-react'
interface NavItem {
  to: string
  labelKey: string
  icon: React.ReactNode
  end?: boolean
  disabled?: boolean
}

interface NavGroup {
  capKey: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    capKey: 'navgroup.monitor',
    items: [
      { to: '/', labelKey: 'nav.analytics', icon: <LayoutDashboard size={18} strokeWidth={1.6} />, end: true },
      { to: '/chat', labelKey: 'nav.copilot', icon: <Sparkles size={18} strokeWidth={1.6} /> },
    ],
  },
  {
    capKey: 'navgroup.activity',
    items: [
      { to: '/leads', labelKey: 'nav.leads', icon: <Users size={18} strokeWidth={1.6} /> },
      { to: '/calls', labelKey: 'nav.calls', icon: <Phone size={18} strokeWidth={1.6} /> },
      { to: '/bookings', labelKey: 'nav.calendar', icon: <CalendarDays size={18} strokeWidth={1.6} /> },
    ],
  },
  {
    capKey: 'navgroup.setup',
    items: [
      { to: '/agent', labelKey: 'nav.personality', icon: <SlidersHorizontal size={18} strokeWidth={1.6} /> },
      { to: '/simulator', labelKey: 'nav.simulator', icon: <AudioLines size={18} strokeWidth={1.6} /> },
    ],
  },
  {
    capKey: 'navgroup.general',
    items: [
      { to: '/settings', labelKey: 'nav.settings', icon: <Settings size={18} strokeWidth={1.6} /> },
      { to: '/integrations', labelKey: 'nav.integrations', icon: <Plug size={18} strokeWidth={1.6} /> },
      { to: '/billing', labelKey: 'nav.billing', icon: <CreditCard size={18} strokeWidth={1.6} />, disabled: true },
    ],
  },
]

interface SidebarProps {
  isOpen?: boolean
  onNavigate?: () => void
}

export function Sidebar({ isOpen = false, onNavigate }: SidebarProps) {
  const location = useLocation()
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')

  return (
    <aside
      className={`app-sidebar${isOpen ? ' is-open' : ''}`}
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

      {/* Grouped nav */}
      <nav style={{ flex: 1, padding: '10px 10px 16px', overflow: 'auto' }}>
        {NAV_GROUPS.map((group) => (
          <div key={group.capKey} style={{ marginBlockStart: '14px' }}>
            <div
              style={{
                paddingInline: '12px',
                paddingBlockEnd: '6px',
                fontFamily: isHebrew ? 'var(--font-body)' : 'var(--font-mono)',
                fontSize: isHebrew ? '12px' : '10.5px',
                fontWeight: 600,
                letterSpacing: isHebrew ? 'normal' : '0.1em',
                textTransform: isHebrew ? 'none' : 'uppercase',
                color: 'var(--text-tertiary)',
              }}
            >
              {t(group.capKey)}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {group.items.map((item) =>
                item.disabled ? (
                  <div
                    key={item.to}
                    aria-disabled="true"
                    title={t('navgroup.soon')}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '11px',
                      padding: '9px 12px',
                      borderRadius: '10px',
                      fontSize: '14px',
                      fontWeight: 500,
                      color: 'var(--text-tertiary)',
                      opacity: 0.6,
                      cursor: 'default',
                    }}
                  >
                    <span style={{ flexShrink: 0 }}>{item.icon}</span>
                    <span style={{ flex: 1 }}>{t(item.labelKey)}</span>
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: 'var(--r-full)',
                        backgroundColor: 'var(--surface-sunken)',
                        color: 'var(--text-tertiary)',
                      }}
                    >
                      {t('navgroup.soon')}
                    </span>
                  </div>
                ) : (
                  <NavItemLink key={item.to} item={item} pathname={location.pathname} label={t(item.labelKey)} onNavigate={onNavigate} />
                ),
              )}
            </div>
          </div>
        ))}
      </nav>
      {/* Language + appearance live in Settings › Preferences (not pinned to the shell). */}
    </aside>
  )
}

function NavItemLink({ item, pathname, label, onNavigate }: { item: NavItem; pathname: string; label: string; onNavigate?: () => void }) {
  const isActive = item.end ? pathname === item.to : pathname.startsWith(item.to)
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
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
      {label}
    </NavLink>
  )
}
