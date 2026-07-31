import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Building2, Users, MessageSquare, Phone, Clock, CalendarCheck } from 'lucide-react'
import { fetchAdminOverview, fetchAdminTenants } from '../../lib/admin-api.js'

const CARD: React.CSSProperties = { background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--r)', boxShadow: 'var(--shadow-card)' }
const num = (n: number) => n.toLocaleString('en-US')

function Kpi({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div style={{ ...CARD, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-tertiary)' }}>
        <span style={{ display: 'inline-flex' }}>{icon}</span>
        <span style={{ fontSize: '12px', fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '26px', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{sub}</div>}
    </div>
  )
}

export function AdminOverview() {
  const ov = useQuery({ queryKey: ['admin', 'overview'], queryFn: fetchAdminOverview })
  const tn = useQuery({ queryKey: ['admin', 'tenants'], queryFn: fetchAdminTenants })
  const o = ov.data
  const rows = tn.data?.data ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '22px' }}>System overview</h1>
        <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBlockStart: '4px' }}>Live totals across every tenant. All figures are measured, not estimated.</p>
      </div>

      {ov.isError ? (
        <div role="alert" style={{ ...CARD, padding: '20px', color: 'var(--status-danger)', fontSize: '14px' }}>
          {(ov.error as Error).message}
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <Kpi icon={<Building2 size={16} strokeWidth={1.7} />} label="Tenants" value={o ? num(o.tenants.total) : '—'} sub={o ? `${o.tenants.active} active · ${o.tenants.suspended} suspended` : undefined} />
            <Kpi icon={<Users size={16} strokeWidth={1.7} />} label="Leads" value={o ? num(o.totals.leads) : '—'} sub={o ? `+${num(o.last24h.leads)} in 24h` : undefined} />
            <Kpi icon={<MessageSquare size={16} strokeWidth={1.7} />} label="Messages" value={o ? num(o.totals.messages) : '—'} sub={o ? `+${num(o.last24h.messages)} in 24h` : undefined} />
            <Kpi icon={<Phone size={16} strokeWidth={1.7} />} label="Calls" value={o ? num(o.totals.calls) : '—'} sub={o ? `+${num(o.last24h.calls)} in 24h` : undefined} />
            <Kpi icon={<Clock size={16} strokeWidth={1.7} />} label="Voice minutes" value={o ? num(o.totals.voiceMinutes) : '—'} sub="billing basis" />
            <Kpi icon={<CalendarCheck size={16} strokeWidth={1.7} />} label="Meetings" value={o ? num(o.totals.meetings) : '—'} />
          </div>

          <div style={{ ...CARD, overflow: 'hidden' }}>
            <div style={{ padding: '14px 18px', borderBlockEnd: '1px solid var(--border-default)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '15px' }}>Per-tenant rollup</span>
              <Link to="/admin/tenants" style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--accent-fg)' }}>Manage tenants →</Link>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ inlineSize: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ color: 'var(--text-tertiary)', textAlign: 'start' }}>
                    {['Tenant', 'Status', 'Leads', 'Msgs', 'Calls', 'Min', 'Mtgs', 'Last activity'].map((h, i) => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: i > 1 ? 'end' : 'start', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tn.isLoading ? (
                    <tr><td colSpan={8} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)' }}>Loading…</td></tr>
                  ) : rows.length === 0 ? (
                    <tr><td colSpan={8} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)' }}>No tenants yet.</td></tr>
                  ) : (
                    rows.map((t) => (
                      <tr key={t.id} style={{ borderBlockStart: '1px solid var(--border-default)' }}>
                        <td style={{ padding: '11px 14px' }}>
                          <Link to="/admin/tenants" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{t.name}</Link>
                          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-tertiary)' }}>{t.slug}</div>
                        </td>
                        <td style={{ padding: '11px 14px' }}><StatusDot active={t.isActive} /></td>
                        <td style={num_td}>{num(t.leads)}</td>
                        <td style={num_td}>{num(t.messages)}</td>
                        <td style={num_td}>{num(t.calls)}</td>
                        <td style={num_td}>{num(t.voiceMinutes)}</td>
                        <td style={num_td}>{num(t.meetings)}</td>
                        <td style={{ padding: '11px 14px', textAlign: 'end', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{t.lastActivityAt ? new Date(t.lastActivityAt).toLocaleDateString() : '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const num_td: React.CSSProperties = { padding: '11px 14px', textAlign: 'end', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }

export function StatusDot({ active }: { active: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: active ? 'var(--status-success)' : 'var(--text-tertiary)' }}>
      <span style={{ inlineSize: '7px', blockSize: '7px', borderRadius: '50%', background: active ? 'var(--status-success)' : 'var(--text-tertiary)' }} />
      {active ? 'Active' : 'Suspended'}
    </span>
  )
}
