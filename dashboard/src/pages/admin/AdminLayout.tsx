import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ShieldCheck, LayoutDashboard, Building2, LogOut, Lock } from 'lucide-react'
import { getAdminKey, clearAdminKey, verifyAdminKey } from '../../lib/admin-api.js'

/**
 * Operator console shell. A SEPARATE surface from the tenant dashboard: its own super-admin key,
 * its own nav, and a visible "super-admin" marker so an operator always knows they're in the
 * cross-tenant context. English-only by design (internal tool); theme follows the global toggle.
 */
export function AdminLayout() {
  const [authed, setAuthed] = useState(() => !!getAdminKey())

  if (!authed) return <AdminLogin onAuthed={() => setAuthed(true)} />

  return (
    <div style={{ display: 'flex', minBlockSize: '100vh', background: 'var(--surface-page)', color: 'var(--text-primary)' }}>
      <AdminRail />
      <div style={{ flex: 1, minInlineSize: 0, display: 'flex', flexDirection: 'column' }}>
        <AdminTopBar onSignOut={() => { clearAdminKey(); setAuthed(false) }} />
        <main style={{ flex: 1, padding: '28px', maxInlineSize: '1240px', inlineSize: '100%', marginInline: 'auto' }}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

const NAV = [
  { to: '/admin', label: 'Overview', icon: <LayoutDashboard size={18} strokeWidth={1.6} />, end: true },
  { to: '/admin/tenants', label: 'Tenants', icon: <Building2 size={18} strokeWidth={1.6} /> },
]

function AdminRail() {
  const { pathname } = useLocation()
  return (
    <aside style={{ inlineSize: '236px', minInlineSize: '236px', borderInlineEnd: '1px solid var(--border-default)', background: 'var(--surface-card)', display: 'flex', flexDirection: 'column', position: 'sticky', top: 0, blockSize: '100vh' }}>
      <div style={{ height: '60px', display: 'flex', alignItems: 'center', gap: '10px', paddingInline: '20px', borderBottom: '1px solid var(--border-default)' }}>
        <ShieldCheck size={20} strokeWidth={1.8} style={{ color: 'var(--accent-fg)' }} />
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '16px' }}>Operator</span>
      </div>
      <nav style={{ padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {NAV.map((item) => {
          const active = item.end ? pathname === item.to : pathname.startsWith(item.to)
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              style={{
                display: 'flex', alignItems: 'center', gap: '11px', padding: '9px 12px', borderRadius: '10px',
                fontSize: '14px', fontWeight: active ? 600 : 500, textDecoration: 'none',
                color: active ? 'var(--accent-fg)' : 'var(--text-secondary)',
                background: active ? 'var(--accent-tint)' : 'transparent',
              }}
            >
              <span style={{ flexShrink: 0 }}>{item.icon}</span>
              {item.label}
            </NavLink>
          )
        })}
      </nav>
      <div style={{ marginBlockStart: 'auto', padding: '16px 20px', borderTop: '1px solid var(--border-default)' }}>
        <a href="/" style={{ fontSize: '12.5px', color: 'var(--text-tertiary)', textDecoration: 'none' }}>← Back to tenant dashboard</a>
      </div>
    </aside>
  )
}

function AdminTopBar({ onSignOut }: { onSignOut: () => void }) {
  return (
    <header style={{ height: '60px', flexShrink: 0, borderBottom: '1px solid var(--border-default)', background: 'var(--surface-card)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingInline: '28px', position: 'sticky', top: 0, zIndex: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '16px' }}>Multi-tenant console</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--status-warning)', background: 'color-mix(in srgb, var(--status-warning) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--status-warning) 34%, transparent)', padding: '3px 8px', borderRadius: 'var(--r-full)' }}>
          Super-admin
        </span>
      </div>
      <button onClick={onSignOut} style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '8px 14px', borderRadius: '10px', border: '1px solid var(--border-default)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}>
        <LogOut size={15} strokeWidth={1.7} /> Sign out
      </button>
    </header>
  )
}

function AdminLogin({ onAuthed }: { onAuthed: () => void }) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!key.trim()) return
    setBusy(true)
    setError('')
    const ok = await verifyAdminKey(key.trim())
    setBusy(false)
    if (ok) onAuthed()
    else setError('That key was rejected. Check the operator key, or that the console is configured on the server.')
  }

  return (
    <div style={{ minBlockSize: '100vh', display: 'grid', placeItems: 'center', background: 'var(--surface-page)', color: 'var(--text-primary)', padding: '24px' }}>
      <form onSubmit={submit} style={{ inlineSize: '100%', maxInlineSize: '400px', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-card)', padding: '30px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBlockEnd: '6px' }}>
          <ShieldCheck size={22} strokeWidth={1.8} style={{ color: 'var(--accent-fg)' }} />
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '20px' }}>Operator console</h1>
        </div>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBlockEnd: '20px', lineHeight: 1.5 }}>
          Restricted to ClickScales operators. Enter the operator key to manage and monitor all tenants.
        </p>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBlockEnd: '6px' }}>Operator key</label>
        <div style={{ position: 'relative' }}>
          <Lock size={15} strokeWidth={1.7} style={{ position: 'absolute', insetInlineStart: '12px', insetBlockStart: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
            placeholder="••••••••••••••••"
            style={{ inlineSize: '100%', paddingBlock: '10px', paddingInlineStart: '36px', paddingInlineEnd: '12px', borderRadius: '10px', border: '1px solid var(--border-strong)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: '14px', outline: 'none' }}
          />
        </div>
        {error && <p role="alert" style={{ fontSize: '12.5px', color: 'var(--status-danger)', marginBlockStart: '10px', lineHeight: 1.5 }}>{error}</p>}
        <button type="submit" disabled={busy || !key.trim()} style={{ inlineSize: '100%', marginBlockStart: '18px', padding: '11px', borderRadius: '10px', border: 0, background: 'var(--accent)', color: 'var(--text-on-accent)', fontFamily: 'var(--font-body)', fontSize: '14px', fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy || !key.trim() ? 0.6 : 1 }}>
          {busy ? 'Verifying…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
