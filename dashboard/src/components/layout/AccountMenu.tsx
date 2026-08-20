import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LogOut, Check } from 'lucide-react'
import { getSession, subscribe, logout, switchTenant, type Session } from '../../lib/auth'
import { fetchMemberships, type Membership } from '../../lib/api'

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
  const [tenants, setTenants] = useState<Membership[] | null>(null)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)

  useEffect(() => subscribe(setSession), [])

  /**
   * Workspaces are fetched when the menu OPENS, not on mount.
   *
   * Most people belong to exactly one workspace and never open this menu, so paying a request on
   * every page load to discover that would be a cost with no reader. Opening the menu is the
   * moment the answer is actually needed, and the result is cached for the life of the component
   * — the list only changes when someone is added to a workspace, which is not a thing that
   * happens while you hold a dropdown open.
   *
   * A failure leaves the array empty rather than surfacing an error: this is a navigation
   * convenience hanging off a menu whose real job is Sign out, and an error banner inside a
   * 232px dropdown helps nobody.
   */
  useEffect(() => {
    if (!open || tenants) return
    let cancelled = false
    void fetchMemberships()
      .then((rows) => { if (!cancelled) setTenants(rows) })
      .catch(() => { if (!cancelled) setTenants([]) })
    return () => { cancelled = true }
  }, [open, tenants])

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

  // Show the picker only when there is a choice to make. One workspace needs no switcher.
  const showSwitcher = (tenants?.length ?? 0) > 1

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

          {showSwitcher && (
            <div style={{ borderBlockStart: '1px solid var(--border-default)', paddingBlock: '4px' }}>
              <div
                style={{
                  padding: '6px 10px 4px',
                  fontSize: '10px',
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--text-tertiary)',
                }}
              >
                {t('auth.workspaces')}
              </div>
              {tenants!.map((option) => {
                const current = option.tenantId === session.tenant.id
                const busy = switchingTo !== null
                return (
                  <button
                    key={option.tenantId}
                    role="menuitemradio"
                    aria-checked={current}
                    disabled={current || busy}
                    onClick={() => {
                      setSwitchingTo(option.tenantId)
                      void switchTenant(option.tenantId)
                        // Land on the root, NOT reload(). The current URL may be a detail route
                        // (/leads/<id>) whose id belongs to the workspace being left, and every
                        // one of those 404s under the new tenant — which reads as "switching is
                        // broken" rather than "that lead lives somewhere else".
                        .then(() => window.location.assign('/'))
                        .catch(() => setSwitchingTo(null))
                    }}
                    style={{
                      ...menuItem,
                      cursor: current || busy ? 'default' : 'pointer',
                      opacity: busy && switchingTo !== option.tenantId ? 0.45 : 1,
                    }}
                  >
                    <Check
                      size={14}
                      strokeWidth={1.8}
                      style={{ opacity: current ? 1 : 0, flexShrink: 0 }}
                      aria-hidden
                    />
                    <span
                      dir="auto"
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {option.name}
                    </span>
                  </button>
                )
              })}
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
