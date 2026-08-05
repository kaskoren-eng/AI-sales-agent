import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LogOut, Check } from 'lucide-react'
import { getSession, subscribe, logout, switchTenant, type Session } from '../../lib/auth'

/** Initials from a display name, falling back to the email — never a hardcoded brand. */
function initials(session: Session): string {
  const source = session.user.name?.trim() || session.user.email
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

export function AccountMenu() {
  const { t } = useTranslation()
  const [session, setSession] = useState<Session | null>(getSession())
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)

  useEffect(() => subscribe(setSession), [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!session) return null

  const otherTenants: never[] = []

  return (
    <div ref={wrapper} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={session.user.email}
        title={`${session.user.email} · ${session.tenant.name}`}
        style={{
          inlineSize: '34px',
          blockSize: '34px',
          borderRadius: '50%',
          backgroundColor: 'var(--accent)',
          border: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '13px',
          fontWeight: 700,
          color: 'var(--text-on-accent)',
          cursor: 'pointer',
          fontFamily: 'var(--font-display)',
        }}
      >
        {initials(session)}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            insetBlockStart: 'calc(100% + 8px)',
            // Logical inset so the menu hangs from the correct edge under Hebrew RTL.
            insetInlineEnd: 0,
            minInlineSize: '232px',
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--r)',
            boxShadow: 'var(--shadow-overlay)',
            padding: '6px',
            zIndex: 80,
          }}
        >
          <div style={{ padding: '8px 10px 10px' }}>
            <div
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              dir="auto"
            >
              {session.user.name || session.user.email}
            </div>
            {/* Mono for identifiers — brief v5 §3.1: mono carries data, not prose. */}
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: 'var(--text-tertiary)',
                marginBlockStart: '3px',
              }}
              dir="ltr"
            >
              {session.tenant.slug} · {session.tenant.role}
            </div>
          </div>

          {otherTenants.length > 0 && (
            <div style={{ borderBlockStart: '1px solid var(--border-default)', paddingBlock: '4px' }}>
              {otherTenants.map((tenantOption: { id: string; name: string }) => (
                <button
                  key={tenantOption.id}
                  role="menuitem"
                  onClick={() => void switchTenant(tenantOption.id).then(() => window.location.reload())}
                  style={menuItem}
                >
                  <Check size={14} strokeWidth={1.8} style={{ opacity: 0 }} aria-hidden />
                  {tenantOption.name}
                </button>
              ))}
            </div>
          )}

          <div style={{ borderBlockStart: '1px solid var(--border-default)', paddingBlockStart: '4px' }}>
            <button
              role="menuitem"
              onClick={() => void logout().then(() => window.location.replace('/'))}
              style={menuItem}
            >
              <LogOut size={14} strokeWidth={1.8} aria-hidden />
              {t('auth.signOut')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const menuItem: React.CSSProperties = {
  inlineSize: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: '9px',
  padding: '8px 10px',
  background: 'none',
  border: 0,
  borderRadius: '8px',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-body)',
  fontSize: '13px',
  textAlign: 'start',
  cursor: 'pointer',
}
