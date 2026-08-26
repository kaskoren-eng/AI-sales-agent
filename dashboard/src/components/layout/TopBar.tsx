import { Bell, Menu } from 'lucide-react'
import { AccountMenu } from './AccountMenu.js'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

const PAGE_TITLE_KEYS: Record<string, string> = {
  '/': 'nav.analytics',
  '/voice-ops': 'nav.voiceOps',
  '/chat': 'nav.copilot',
  '/leads': 'nav.leads',
  '/calls': 'nav.calls',
  '/bookings': 'nav.calendar',
  '/agent': 'nav.personality',
  '/simulator': 'nav.simulator',
  '/voice': 'nav.testKeren',
  '/integrations': 'nav.integrations',
  '/settings': 'nav.settings',
  '/members': 'nav.members',
  '/billing': 'nav.billing',
}

function getTitleKey(pathname: string): string {
  if (pathname.startsWith('/calls/')) return 'topbar.callDetail'
  if (pathname.startsWith('/leads/')) return 'topbar.leadDetail'
  return PAGE_TITLE_KEYS[pathname] ?? 'topbar.dashboard'
}

export function TopBar({ onMenu }: { onMenu?: () => void }) {
  const location = useLocation()
  const { t } = useTranslation()
  const title = t(getTitleKey(location.pathname))

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        height: '60px',
        backgroundColor: 'var(--surface-card)',
        borderBottom: '1px solid var(--border-default)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingInline: 'clamp(16px, 4vw, 28px)',
        zIndex: 30,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
        <button
          className="app-menu-btn"
          onClick={onMenu}
          aria-label={t('nav.openMenu')}
          style={{
            width: '38px',
            height: '38px',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '10px',
            border: '1px solid var(--border-default)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <Menu size={18} strokeWidth={1.8} />
        </button>
        <h1
          className="uppercase-track"
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: '17px',
            letterSpacing: '-0.01em',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </h1>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        {/* Presence — the one animated element in the shell (dot pulse). */}
        <div
          className="topbar-presence"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '9px',
            padding: '6px 12px 6px 10px',
            backgroundColor: 'var(--accent-tint)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--r-full)',
            fontSize: '13px',
            color: 'var(--text-secondary)',
          }}
        >
          <span
            style={{
              position: 'relative',
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: 'var(--accent-fg)',
              flexShrink: 0,
            }}
          >
            <span
              aria-hidden
              style={{
                position: 'absolute',
                inset: '-4px',
                borderRadius: '50%',
                border: '1px solid var(--accent-fg)',
                opacity: 0.5,
                animation: `presence-pulse 1.6s var(--ease-standard) infinite`,
              }}
            />
          </span>
          <span>{t('presence.available')}</span>
        </div>

        <button
          aria-label="Notifications"
          style={{
            width: '36px',
            height: '36px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '10px',
            border: '1px solid var(--border-default)',
            backgroundColor: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transition: `background-color var(--duration-fast) var(--ease-standard)`,
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-sunken)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'
          }}
        >
          <Bell size={16} strokeWidth={1.6} />
        </button>

        {/* Account menu. Was a hardcoded "CS" / "ClickScales" — which would have greeted every
            customer as ClickScales. It now reflects the signed-in user and their workspace. */}
        <AccountMenu />
      </div>
    </header>
  )
}
