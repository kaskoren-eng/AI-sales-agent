import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X, KeyRound, Copy, Check, Power, PowerOff, Building2, AlertTriangle } from 'lucide-react'
import {
  fetchAdminTenants,
  fetchAdminTenant,
  createTenant,
  fetchAdminPlans,
  updateTenant,
  rotateTenantKey,
  type TenantRollup,
} from '../../lib/admin-api.js'
import { StatusDot } from './AdminOverview.js'

const CARD: React.CSSProperties = { background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--r)', boxShadow: 'var(--shadow-card)' }
const num = (n: number) => n.toLocaleString('en-US')
const numTd: React.CSSProperties = { padding: '12px 14px', textAlign: 'end', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--font-mono)' }

export function AdminTenants() {
  const list = useQuery({ queryKey: ['admin', 'tenants'], queryFn: fetchAdminTenants })
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const rows = list.data?.data ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '22px' }}>Tenants</h1>
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBlockStart: '4px' }}>Create, monitor, suspend, and rotate keys across the whole platform.</p>
        </div>
        <button onClick={() => setCreating(true)} style={btnPrimary}>
          <Plus size={16} strokeWidth={2} /> New tenant
        </button>
      </div>

      <div style={{ ...CARD, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ inlineSize: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ color: 'var(--text-tertiary)' }}>
                {['Tenant', 'Status', 'Plan', 'Leads', 'Msgs', 'Calls', 'Min', 'Mtgs', 'Created'].map((h, i) => (
                  <th key={h} style={{ padding: '11px 14px', textAlign: i > 2 ? 'end' : 'start', fontWeight: 600, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.isLoading ? (
                <tr><td colSpan={9} style={{ padding: '28px', textAlign: 'center', color: 'var(--text-tertiary)' }}>Loading…</td></tr>
              ) : list.isError ? (
                <tr><td colSpan={9} style={{ padding: '28px', textAlign: 'center', color: 'var(--status-danger)' }}>{(list.error as Error).message}</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={9} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-tertiary)' }}>No tenants yet. Create the first one.</td></tr>
              ) : (
                rows.map((t: TenantRollup) => (
                  <tr key={t.id} onClick={() => setSelected(t.id)} style={{ borderBlockStart: '1px solid var(--border-default)', cursor: 'pointer' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-sunken)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                    <td style={{ padding: '12px 14px' }}>
                      <div style={{ fontWeight: 600 }}>{t.name}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-tertiary)' }}>{t.slug}</div>
                    </td>
                    <td style={{ padding: '12px 14px' }}><StatusDot active={t.isActive} /></td>
                    {/* A workspace with no plan bills as free and unlimited, and the snapshot is
                        frozen for its whole first month — so "none" is the one value here that
                        needs to look wrong rather than blank. */}
                    <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                      {t.planCode ? (
                        <>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{t.planCode}</span>
                          {t.billingStatus !== 'active' && (
                            <span style={{ marginInlineStart: '6px', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                              {t.billingStatus}
                            </span>
                          )}
                        </>
                      ) : (
                        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--status-danger)' }}>no plan</span>
                      )}
                    </td>
                    <td style={numTd}>{num(t.leads)}</td>
                    <td style={numTd}>{num(t.messages)}</td>
                    <td style={numTd}>{num(t.calls)}</td>
                    <td style={numTd}>{num(t.voiceMinutes)}</td>
                    <td style={numTd}>{num(t.meetings)}</td>
                    <td style={{ padding: '12px 14px', textAlign: 'end', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{new Date(t.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <TenantDrawer id={selected} onClose={() => setSelected(null)} />}
      {creating && <CreateTenantModal onClose={() => setCreating(false)} />}
    </div>
  )
}

function TenantDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const detail = useQuery({ queryKey: ['admin', 'tenant', id], queryFn: () => fetchAdminTenant(id) })
  const [rotated, setRotated] = useState<string | null>(null)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const t = detail.data?.tenant
  const s = detail.data?.stats

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'tenant', id] })
    void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'overview'] })
  }

  const toggleActive = useMutation({
    mutationFn: () => updateTenant(id, { isActive: !t?.isActive }),
    onSuccess: invalidate,
  })

  /**
   * Billing controls. Until these existed a plan could be chosen at creation and never changed —
   * no upgrade, no downgrade, no way off the internal tier — so every price change meant SQL
   * against production.
   */
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: fetchAdminPlans })
  const [periodNote, setPeriodNote] = useState<string | null>(null)
  const saveBilling = useMutation({
    mutationFn: (patch: { planCode?: string; billingStatus?: string; quotaEnforcement?: string }) =>
      updateTenant(id, patch),
    onSuccess: (res) => {
      // The plan moved but this month's invoice did not. Say so where the operator is looking,
      // because they have usually just quoted the customer the new price.
      setPeriodNote(
        res.openPeriodStillPricedAs
          ? `This month still bills as "${res.openPeriodStillPricedAs.planCode}". The new plan applies from the next period.`
          : null,
      )
      invalidate()
    },
  })
  const rotate = useMutation({
    mutationFn: () => rotateTenantKey(id),
    onSuccess: (data) => { setRotated(data.apiKey); setConfirmRotate(false); invalidate() },
  })

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50 }} />
      <aside style={{ position: 'fixed', insetBlock: 0, insetInlineEnd: 0, inlineSize: 'min(460px, 100vw)', background: 'var(--surface-card)', borderInlineStart: '1px solid var(--border-default)', boxShadow: 'var(--shadow-overlay)', zIndex: 51, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 22px', borderBlockEnd: '1px solid var(--border-default)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minInlineSize: 0 }}>
            <Building2 size={18} strokeWidth={1.7} style={{ color: 'var(--accent-fg)', flexShrink: 0 }} />
            <div style={{ minInlineSize: 0 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t?.name ?? '…'}</div>
              {t && <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-tertiary)' }}>{t.slug}</div>}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={iconBtn}><X size={17} strokeWidth={1.7} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {detail.isLoading ? (
            <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>Loading…</div>
          ) : detail.isError ? (
            <div role="alert" style={{ color: 'var(--status-danger)', fontSize: '13px' }}>{(detail.error as Error).message}</div>
          ) : t && s ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <StatusDot active={t.isActive} />
                <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Created {new Date(t.createdAt).toLocaleDateString()}</span>
                <span style={{ fontSize: '12px', color: t.hasApiKey ? 'var(--text-tertiary)' : 'var(--status-warning)' }}>{t.hasApiKey ? 'API key set' : 'No API key'}</span>
              </div>

              {/* Usage / billing signals */}
              <Section title="Usage">
                <StatGrid items={[
                  ['Leads', num(s.leads.total)],
                  ['Conversations', num(s.conversations)],
                  ['Messages', `${num(s.messages.total)}`],
                  ['↳ in / out', `${num(s.messages.inbound)} / ${num(s.messages.outbound)}`],
                  ['Calls', num(s.calls.total)],
                  ['Voice minutes', num(s.calls.voiceMinutes)],
                  ['Meetings', num(s.meetings.total)],
                  ['↳ upcoming', num(s.meetings.upcoming)],
                ]} />
              </Section>

              {Object.keys(s.leads.byStatus).length > 0 && (
                <Section title="Leads by status">
                  <ChipRow entries={s.leads.byStatus} />
                </Section>
              )}
              {Object.keys(s.calls.byOutcome).length > 0 && (
                <Section title="Calls by outcome">
                  <ChipRow entries={s.calls.byOutcome} />
                </Section>
              )}

              {/* Billing posture */}
              <Section title="Billing">
                <div style={{ display: 'grid', gap: '10px' }}>
                  <label style={fieldLabel}>
                    Plan
                    <select
                      value={t.planCode ?? ''}
                      onChange={(e) => saveBilling.mutate({ planCode: e.target.value })}
                      disabled={saveBilling.isPending || plans.isLoading}
                      style={{ ...selectStyle, ...(t.planCode ? null : { color: 'var(--status-danger)' }) }}
                    >
                      {!t.planCode && <option value="">no plan — bills as free</option>}
                      {(plans.data?.data ?? []).map((p) => (
                        <option key={p.code} value={p.code}>
                          {p.code}{p.isActive ? '' : ' (internal)'}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label style={fieldLabel}>
                    Billing status
                    <select
                      value={t.billingStatus}
                      onChange={(e) => saveBilling.mutate({ billingStatus: e.target.value })}
                      disabled={saveBilling.isPending}
                      style={selectStyle}
                    >
                      {['trialing', 'active', 'past_due', 'suspended'].map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  </label>

                  <label style={fieldLabel}>
                    Quota enforcement
                    <select
                      value={t.quotaEnforcement}
                      onChange={(e) => saveBilling.mutate({ quotaEnforcement: e.target.value })}
                      disabled={saveBilling.isPending}
                      style={selectStyle}
                    >
                      <option value="off">off — meter only</option>
                      <option value="soft">soft — warn at the cap</option>
                      <option value="hard">hard — block at the cap</option>
                    </select>
                  </label>

                  {periodNote && (
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5, border: '1px solid color-mix(in srgb, var(--status-warning) 34%, transparent)', background: 'color-mix(in srgb, var(--status-warning) 8%, transparent)', borderRadius: '10px', padding: '10px 12px' }}>
                      <AlertTriangle size={15} strokeWidth={1.8} style={{ color: 'var(--status-warning)', flexShrink: 0, marginBlockStart: '1px' }} />
                      {periodNote}
                    </div>
                  )}
                  {saveBilling.isError && <span role="alert" style={{ fontSize: '12px', color: 'var(--status-danger)' }}>{(saveBilling.error as Error).message}</span>}
                </div>
              </Section>

              {/* Actions */}
              <Section title="Operator actions">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <button
                    onClick={() => toggleActive.mutate()}
                    disabled={toggleActive.isPending}
                    style={t.isActive ? btnWarnOutline : btnSuccessOutline}
                  >
                    {t.isActive ? <PowerOff size={15} strokeWidth={1.8} /> : <Power size={15} strokeWidth={1.8} />}
                    {t.isActive ? 'Suspend tenant' : 'Activate tenant'}
                  </button>

                  {!confirmRotate ? (
                    <button onClick={() => setConfirmRotate(true)} style={btnOutline}>
                      <KeyRound size={15} strokeWidth={1.8} /> Rotate API key
                    </button>
                  ) : (
                    <div style={{ border: '1px solid color-mix(in srgb, var(--status-danger) 34%, transparent)', background: 'color-mix(in srgb, var(--status-danger) 8%, transparent)', borderRadius: '10px', padding: '12px' }}>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        <AlertTriangle size={15} strokeWidth={1.8} style={{ color: 'var(--status-danger)', flexShrink: 0, marginBlockStart: '1px' }} />
                        Rotating invalidates the tenant's current key immediately. Any integration using it stops until updated.
                      </div>
                      <div style={{ display: 'flex', gap: '8px', marginBlockStart: '10px' }}>
                        <button onClick={() => setConfirmRotate(false)} style={{ ...btnOutline, flex: 1 }}>Cancel</button>
                        <button onClick={() => rotate.mutate()} disabled={rotate.isPending} style={{ ...btnDanger, flex: 1 }}>{rotate.isPending ? 'Rotating…' : 'Yes, rotate'}</button>
                      </div>
                    </div>
                  )}

                  {rotated && <KeyReveal label="New API key — copy it now, it won't be shown again" value={rotated} />}
                  {toggleActive.isError && <span role="alert" style={{ fontSize: '12px', color: 'var(--status-danger)' }}>{(toggleActive.error as Error).message}</span>}
                </div>
              </Section>
            </>
          ) : null}
        </div>
      </aside>
    </>
  )
}

function CreateTenantModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [planCode, setPlanCode] = useState('')
  const [created, setCreated] = useState<{ name: string; apiKey: string } | null>(null)

  /**
   * The plan is chosen here, at creation, because it cannot be usefully chosen later.
   *
   * `usage_periods` snapshots the plan when the billing period opens — deliberately, so a
   * mid-month change cannot reprice history. A workspace created without one bills as free and
   * unlimited for its whole first month, and assigning the right plan afterwards does not fix it.
   */
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: fetchAdminPlans })
  const planOptions = plans.data?.data ?? []

  const autoSlug = (v: string) => v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const effectiveSlug = slugTouched ? slug : autoSlug(name)

  const create = useMutation({
    mutationFn: () => createTenant({ name: name.trim(), slug: effectiveSlug, planCode }),
    onSuccess: (data) => {
      setCreated({ name: data.name, apiKey: data.apiKey })
      void qc.invalidateQueries({ queryKey: ['admin', 'tenants'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] })
    },
  })

  const valid = name.trim().length > 0 && /^[a-z0-9-]+$/.test(effectiveSlug) && planCode !== ''

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 60 }} />
      <div role="dialog" aria-label="Create tenant" style={{ position: 'fixed', insetBlockStart: '50%', insetInlineStart: '50%', transform: 'translate(-50%, -50%)', inlineSize: 'min(440px, calc(100vw - 32px))', background: 'var(--surface-overlay)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-overlay)', zIndex: 61, padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBlockEnd: '16px' }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '17px' }}>{created ? 'Tenant created' : 'New tenant'}</h2>
          <button onClick={onClose} aria-label="Close" style={iconBtn}><X size={17} strokeWidth={1.7} /></button>
        </div>

        {created ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}><strong>{created.name}</strong> is ready. Copy its API key now — it is shown once.</p>
            <KeyReveal label="Tenant API key" value={created.apiKey} />
            <button onClick={onClose} style={btnPrimary}>Done</button>
          </div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate() }} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Acme Corp" style={inputStyle} />
            </Field>
            <Field label="Slug" hint="lowercase, letters/numbers/hyphens — used in URLs and keys">
              <input value={effectiveSlug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value) }} placeholder="acme-corp" style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} />
            </Field>
            <Field label="Plan" hint="billed from the moment the first lead arrives — it cannot be changed retroactively">
              <select
                value={planCode}
                onChange={(e) => setPlanCode(e.target.value)}
                style={inputStyle}
                disabled={plans.isLoading}
              >
                <option value="" disabled>
                  {plans.isLoading ? 'Loading plans…' : 'Choose a plan'}
                </option>
                {planOptions.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name}
                    {' — '}
                    {p.monthlyPriceAgorot === 0 ? 'free' : `₪${(p.monthlyPriceAgorot / 100).toLocaleString()}/mo`}
                    {p.includedLeads === null ? ', unlimited leads' : `, ${p.includedLeads} leads`}
                    {p.isActive ? '' : ' (internal)'}
                  </option>
                ))}
              </select>
            </Field>
            {plans.isError && (
              <span role="alert" style={{ fontSize: '12.5px', color: 'var(--status-danger)' }}>
                Could not load plans — a workspace cannot be created without one.
              </span>
            )}
            {create.isError && <span role="alert" style={{ fontSize: '12.5px', color: 'var(--status-danger)' }}>{(create.error as Error).message}</span>}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginBlockStart: '4px' }}>
              <button type="button" onClick={onClose} style={btnOutline}>Cancel</button>
              <button type="submit" disabled={!valid || create.isPending} style={{ ...btnPrimary, opacity: !valid || create.isPending ? 0.6 : 1 }}>{create.isPending ? 'Creating…' : 'Create tenant'}</button>
            </div>
          </form>
        )}
      </div>
    </>
  )
}

// --- small pieces ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="uppercase-track" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBlockEnd: '10px' }}>{title}</div>
      {children}
    </div>
  )
}

function StatGrid({ items }: { items: [string, string][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
      {items.map(([k, v]) => (
        <div key={k} style={{ background: 'var(--surface-sunken)', border: '1px solid var(--border-default)', borderRadius: '10px', padding: '10px 12px' }}>
          <div style={{ fontSize: '11.5px', color: 'var(--text-tertiary)' }}>{k}</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: '16px', fontWeight: 600, marginBlockStart: '2px' }}>{v}</div>
        </div>
      ))}
    </div>
  )
}

function ChipRow({ entries }: { entries: Record<string, number> }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
      {Object.entries(entries).map(([k, v]) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', background: 'var(--surface-sunken)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-full)', padding: '4px 10px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{v}</span>
        </span>
      ))}
    </div>
  )
}

function KeyReveal({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* ignore */ }
  }
  return (
    <div style={{ background: 'color-mix(in srgb, var(--status-success) 9%, transparent)', border: '1px solid color-mix(in srgb, var(--status-success) 28%, transparent)', borderRadius: '10px', padding: '12px' }}>
      <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginBlockEnd: '7px' }}>{label}</div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <code style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '12.5px', wordBreak: 'break-all', color: 'var(--text-primary)' }}>{value}</code>
        <button onClick={copy} aria-label="Copy key" style={{ ...iconBtn, flexShrink: 0 }}>{copied ? <Check size={15} strokeWidth={2} style={{ color: 'var(--status-success)' }} /> : <Copy size={15} strokeWidth={1.7} />}</button>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBlockEnd: '6px' }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginBlockStart: '5px' }}>{hint}</p>}
    </div>
  )
}

// --- styles ---
const inputStyle: React.CSSProperties = { inlineSize: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: '10px', border: '1px solid var(--border-strong)', background: 'var(--surface-sunken)', color: 'var(--text-primary)', fontFamily: 'var(--font-body)', fontSize: '14px', outline: 'none' }
const fieldLabel: React.CSSProperties = { display: 'grid', gap: '5px', fontSize: '12px', fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }
const selectStyle: React.CSSProperties = { ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: '13px', textTransform: 'none', letterSpacing: 'normal', fontWeight: 400, cursor: 'pointer' }
const iconBtn: React.CSSProperties = { display: 'grid', placeItems: 'center', inlineSize: '32px', blockSize: '32px', borderRadius: '8px', border: '1px solid var(--border-default)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }
const btnBase: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px 16px', borderRadius: '10px', fontFamily: 'var(--font-body)', fontSize: '13.5px', fontWeight: 600, cursor: 'pointer', border: '1px solid transparent' }
const btnPrimary: React.CSSProperties = { ...btnBase, background: 'var(--accent)', color: 'var(--text-on-accent)' }
const btnOutline: React.CSSProperties = { ...btnBase, background: 'transparent', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }
const btnDanger: React.CSSProperties = { ...btnBase, background: 'var(--status-danger)', color: '#fff' }
const btnWarnOutline: React.CSSProperties = { ...btnBase, background: 'color-mix(in srgb, var(--status-warning) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--status-warning) 38%, transparent)', color: 'var(--status-warning)' }
const btnSuccessOutline: React.CSSProperties = { ...btnBase, background: 'color-mix(in srgb, var(--status-success) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--status-success) 38%, transparent)', color: 'var(--status-success)' }
