import { NavLink, useLocation } from 'react-router-dom'
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

interface NavItem {
  to: string
  label: string
  icon: React.ReactNode
  end?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: <LayoutDashboard size={18} strokeWidth={1.5} />, end: true },
  { to: '/leads', label: 'Leads', icon: <Users size={18} strokeWidth={1.5} /> },
  { to: '/calls', label: 'Calls', icon: <Phone size={18} strokeWidth={1.5} /> },
  { to: '/voice', label: 'Test Keren', icon: <AudioLines size={18} strokeWidth={1.5} /> },
  { to: '/bookings', label: 'Bookings', icon: <CalendarDays size={18} strokeWidth={1.5} /> },
  { to: '/integrations', label: 'Integrations', icon: <Plug size={18} strokeWidth={1.5} /> },
  { to: '/settings', label: 'Settings', icon: <Settings size={18} strokeWidth={1.5} /> },
]

export function Sidebar() {
  const location = useLocation()

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
        borderRight: '1px solid var(--border-subtle)',
        zIndex: 40,
        overflow: 'hidden',
      }}
      aria-label="Main navigation"
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
            by ClickScales
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
                backgroundColor: isActive ? 'rgba(0, 245, 255, 0.07)' : 'transparent',
                borderLeft: isActive ? '2px solid var(--accent-cyan)' : '2px solid transparent',
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
              {item.label}
            </NavLink>
          )
        })}
      </nav>

      {/* Status chip */}
      <div
        style={{
          padding: '16px 16px 20px',
          borderTop: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <KerenStatusChip />
      </div>
    </aside>
  )
}
