import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users, Search, X, CalendarDays } from 'lucide-react'
import { useLeadsList } from '../hooks/useLeadsList.js'
import { useLeadDetail } from '../hooks/useLeadDetail.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { formatDate } from '../lib/format.js'
import type { LeadFull } from '../lib/types.js'

const STATUS_OPTIONS = ['new', 'contacted', 'qualifying', 'qualified', 'booked', 'disqualified']
const LIMIT = 20

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

/** §1.4.1 PROPOSED status colours (await sign-off). Lead status → chip tone. */
function statusTone(status: string): string {
  switch (status) {
    case 'qualified':
      return 'var(--status-success)'
    case 'booked':
      return 'var(--accent-fg)'
    case 'qualifying':
      return 'var(--status-warning)'
    case 'disqualified':
    case 'lost':
    case 'opted_out':
      return 'var(--status-danger)'
    default:
      return 'var(--status-neutral)'
  }
}

function StatusChip({ status, label }: { status: string; label: string }) {
  const tone = statusTone(status)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px 4px 9px',
        borderRadius: 'var(--r-full)',
        fontSize: '11.5px',
        fontWeight: 600,
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tone} 26%, transparent)`,
      }}
    >
      <span style={{ inlineSize: '6px', blockSize: '6px', borderRadius: '50%', background: tone, flexShrink: 0 }} />
      {label}
    </span>
  )
}

function ScoreBar({ score }: { score: number | null }) {
  if (score == null) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
  const color = score >= 70 ? 'var(--status-success)' : score >= 40 ? 'var(--status-warning)' : 'var(--status-danger)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <div style={{ flex: 1, blockSize: '4px', borderRadius: '2px', background: 'var(--surface-sunken)', overflow: 'hidden', maxInlineSize: '60px' }} aria-hidden>
        <div style={{ blockSize: '100%', inlineSize: `${score}%`, borderRadius: '2px', background: color }} />
      </div>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color, fontWeight: 600, minInlineSize: '26px' }}>{score}</span>
    </div>
  )
}

export function Leads() {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<LeadFull | null>(null)

  const onSearch = (val: string) => {
    setSearch(val)
    clearTimeout((window as unknown as Record<string, number>)['_leadSearchTimer'])
    ;(window as unknown as Record<string, number>)['_leadSearchTimer'] = setTimeout(() => {
      setDebounced(val)
      setPage(1)
    }, 350)
  }

  const { data, isLoading, isError } = useLeadsList({
    status: status || undefined,
    search: debounced || undefined,
    page,
    limit: LIMIT,
  })
  const leads = data?.data ?? []
  const meta = data?.meta
  const totalPages = meta?.total_pages ?? 1

  const fieldStyle: React.CSSProperties = {
    height: '38px',
    background: 'var(--surface-card)',
    border: '1px solid var(--border-strong)',
    borderRadius: '10px',
    color: 'var(--text-primary)',
    fontSize: '13.5px',
    fontFamily: 'var(--font-body)',
    outline: 'none',
  }
  const th: React.CSSProperties = {
    padding: '11px 16px',
    fontFamily: 'var(--font-mono)',
    fontSize: '10.5px',
    fontWeight: 500,
    letterSpacing: isHebrew ? 'normal' : '0.08em',
    textTransform: isHebrew ? 'none' : 'uppercase',
    color: 'var(--text-tertiary)',
    textAlign: 'start',
    borderBlockEnd: '1px solid var(--border-default)',
    whiteSpace: 'nowrap',
  }
  const td: React.CSSProperties = { padding: '13px 16px', fontSize: '13.5px', verticalAlign: 'middle' }

  return (
    <div style={{ maxInlineSize: 'var(--container-max)', marginInline: 'auto' }}>
      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBlockEnd: '16px' }} role="search">
        <div style={{ position: 'relative', flex: '1 1 240px', maxInlineSize: '360px' }}>
          <Search size={15} strokeWidth={1.7} style={{ position: 'absolute', insetInlineStart: '12px', insetBlockStart: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
          <input
            type="search"
            dir="auto"
            placeholder={t('leads.searchPlaceholder')}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label={t('leads.searchLabel')}
            style={{ ...fieldStyle, inlineSize: '100%', padding: '0 12px 0 34px' }}
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          aria-label={t('leads.statusLabel')}
          style={{ ...fieldStyle, padding: '0 12px', cursor: 'pointer' }}
        >
          <option value="">{t('leads.allStatuses')}</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`, s)}
            </option>
          ))}
        </select>
        {meta && (
          <span style={{ marginInlineStart: 'auto', fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-secondary)' }}>
            {t('leads.count', { count: meta.total, formattedCount: meta.total.toLocaleString(isHebrew ? 'he-IL' : 'en-US') })}
          </span>
        )}
      </div>

      {/* Table */}
      <div style={{ ...CARD, overflow: 'hidden' }}>
        {isError ? (
          <div role="alert" style={{ padding: '40px', textAlign: 'center', color: 'var(--status-danger)', fontSize: '14px' }}>
            {t('leads.loadError')}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '640px' }} aria-busy={isLoading}>
              <thead>
                <tr>
                  <th style={th}>{t('leads.columns.name')}</th>
                  <th style={th}>{t('leads.columns.status')}</th>
                  <th style={th}>{t('leads.columns.score')}</th>
                  <th style={th}>{t('leads.columns.channel')}</th>
                  <th style={th}>{t('leads.columns.lastActivity')}</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  [...Array(8)].map((_, i) => (
                    <tr key={i} style={{ borderBlockEnd: '1px solid var(--border-default)' }}>
                      {[...Array(5)].map((__, j) => (
                        <td key={j} style={td}>
                          <Skeleton width="80%" height="14px" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : leads.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: '64px 20px', textAlign: 'center' }}>
                      <Users size={30} strokeWidth={1.2} style={{ color: 'var(--text-tertiary)', display: 'block', margin: '0 auto 12px' }} />
                      <p style={{ fontSize: '15px', color: 'var(--text-secondary)', fontWeight: 600, marginBlockEnd: '6px' }}>{t('leads.emptyTitle')}</p>
                      <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>{t('leads.emptyDescription')}</p>
                    </td>
                  </tr>
                ) : (
                  leads.map((lead) => (
                    <tr
                      key={lead.id}
                      onClick={() => setSelected(lead)}
                      style={{ borderBlockEnd: '1px solid var(--border-default)', cursor: 'pointer' }}
                      onMouseEnter={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = 'var(--surface-sunken)')}
                      onMouseLeave={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = 'transparent')}
                    >
                      <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }} dir="auto">
                        {lead.name ?? lead.email ?? '—'}
                      </td>
                      <td style={td}>
                        <StatusChip status={lead.status} label={t(`status.${lead.status}`, lead.status)} />
                      </td>
                      <td style={{ ...td, minWidth: '100px' }}>
                        <ScoreBar score={lead.score} />
                      </td>
                      <td style={td}>
                        {lead.channel ? (
                          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t(`channels.${lead.channel}`, lead.channel)}</span>
                        ) : (
                          <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                        )}
                      </td>
                      <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                        {formatDate(lead.lastActivityAt ?? lead.updatedAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {!isLoading && !isError && leads.length > 0 && totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBlockStart: '16px' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px', color: 'var(--text-tertiary)' }}>
            {t('leads.pagination.pageOf', { page, total: totalPages })}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <PageBtn disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              {t('leads.pagination.prev')}
            </PageBtn>
            <PageBtn disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              {t('leads.pagination.next')}
            </PageBtn>
          </div>
        </div>
      )}

      {selected && <LeadDrawer lead={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function PageBtn({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: 'var(--font-body)',
        fontSize: '13px',
        fontWeight: 600,
        padding: '8px 15px',
        borderRadius: '10px',
        border: '1px solid var(--border-default)',
        background: 'var(--surface-card)',
        color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  )
}

type TimelineItem =
  | { kind: 'message'; at: string; direction: 'inbound' | 'outbound'; content: string }
  | { kind: 'meeting'; at: string; status: string }

function LeadDrawer({ lead, onClose }: { lead: LeadFull; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  const { data, isLoading, isError } = useLeadDetail(lead.id)

  const items: TimelineItem[] = []
  if (data) {
    // Guard against a partial/malformed payload — a missing array must degrade to an empty
    // timeline, never blank the whole app with a "not iterable" throw.
    for (const m of data.messages ?? []) items.push({ kind: 'message', at: m.createdAt, direction: m.direction === 'inbound' ? 'inbound' : 'outbound', content: m.content })
    for (const s of data.scheduledCalls ?? []) items.push({ kind: 'meeting', at: s.scheduledAt, status: s.status })
    items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  }

  const secLabel: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '10.5px',
    letterSpacing: isHebrew ? 'normal' : '0.1em',
    textTransform: isHebrew ? 'none' : 'uppercase',
    color: 'var(--text-tertiary)',
    marginBlockEnd: '10px',
  }
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'rgba(8,12,26,0.42)' }} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={lead.name ?? 'Lead detail'}
        style={{
          position: 'fixed',
          insetBlock: 0,
          insetInlineEnd: 0,
          zIndex: 60,
          inlineSize: 'min(460px, 100vw)',
          background: 'var(--surface-card)',
          borderInlineStart: '1px solid var(--border-default)',
          boxShadow: 'var(--shadow-overlay)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ padding: '18px 20px', borderBlockEnd: '1px solid var(--border-default)', display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
          <div style={{ flex: 1, minInlineSize: 0 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }} dir="auto">
              {lead.name ?? lead.email ?? '—'}
            </div>
            <div style={{ marginBlockStart: '8px' }}>
              <StatusChip status={lead.status} label={t(`status.${lead.status}`, lead.status)} />
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t('leads.drawer.close')}
            style={{ inlineSize: '34px', blockSize: '34px', display: 'grid', placeItems: 'center', borderRadius: '9px', border: '1px solid var(--border-default)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0 }}
          >
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {/* facts */}
          <div>
            <div style={secLabel}>{t('leads.drawer.facts')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <Fact label={t('leads.drawer.channel')} value={lead.channel ? t(`channels.${lead.channel}`, lead.channel) : null} />
              <Fact label={t('leads.drawer.score')} value={lead.score != null ? String(lead.score) : null} />
              <Fact label={t('leads.drawer.email')} value={lead.email} ltr />
              <Fact label={t('leads.drawer.phone')} value={lead.phone} ltr />
            </div>
          </div>

          {/* timeline */}
          <div>
            <div style={secLabel}>{t('leads.drawer.timeline')}</div>
            {isError ? (
              <p role="alert" style={{ color: 'var(--status-danger)', fontSize: '13.5px' }}>{t('leads.drawer.loadError')}</p>
            ) : isLoading ? (
              <Skeleton width="100%" height="80px" />
            ) : items.length === 0 ? (
              <p style={{ fontSize: '12.5px', color: 'var(--text-tertiary)' }}>{t('leads.drawer.empty')}</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {items.map((it, i) =>
                  it.kind === 'meeting' ? (
                    <div key={i} style={{ ...CARD, background: 'var(--surface-sunken)', boxShadow: 'none', padding: '11px 13px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ inlineSize: '28px', blockSize: '28px', borderRadius: '8px', display: 'grid', placeItems: 'center', background: 'var(--accent-tint)', color: 'var(--accent-fg)', flexShrink: 0 }}>
                        <CalendarDays size={15} strokeWidth={1.7} />
                      </span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--text-primary)' }}>{t('leads.drawer.meeting')}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{formatDate(it.at)}</div>
                      </div>
                    </div>
                  ) : (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '3px', alignItems: it.direction === 'outbound' ? 'flex-start' : 'flex-end' }}>
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                        {it.direction === 'outbound' ? t('leads.drawer.agent') : t('leads.drawer.lead')} · <span style={{ fontFamily: 'var(--font-mono)' }}>{time(it.at)}</span>
                      </span>
                      <span
                        dir="auto"
                        style={{
                          fontSize: '13.5px',
                          lineHeight: 1.55,
                          color: 'var(--text-primary)',
                          background: it.direction === 'outbound' ? 'var(--surface-sunken)' : 'var(--accent-tint)',
                          border: '1px solid var(--border-default)',
                          borderRadius: '12px',
                          padding: '9px 13px',
                          maxInlineSize: '88%',
                        }}
                      >
                        {it.content}
                      </span>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

function Fact({ label, value, ltr }: { label: string; value?: string | null; ltr?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', justifyContent: 'space-between', paddingBlock: '7px', borderBlockEnd: '1px solid var(--border-default)' }}>
      <span style={{ fontSize: '12.5px', color: 'var(--text-tertiary)', flexShrink: 0 }}>{label}</span>
      <span
        style={{ fontSize: '13.5px', color: value ? 'var(--text-primary)' : 'var(--text-tertiary)', textAlign: 'end', fontFamily: ltr ? 'var(--font-mono)' : 'inherit' }}
        dir={ltr ? 'ltr' : 'auto'}
      >
        {value ?? '—'}
      </span>
    </div>
  )
}
