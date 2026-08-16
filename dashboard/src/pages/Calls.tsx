import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Phone, X } from 'lucide-react'
import { useCallsList } from '../hooks/useCallsList.js'
import { useCallDetail } from '../hooks/useCallDetail.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { formatDuration } from '../lib/format.js'
import type { CallSummary } from '../lib/types.js'

const LIMIT = 20
const OUTCOME_FILTERS = ['', 'done', 'in_progress', 'failed']

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

/** §1.4.1 PROPOSED status colours (await sign-off). Maps a call status to a chip tone. */
function outcomeTone(status: string): { fg: string } {
  switch (status) {
    case 'done':
      return { fg: 'var(--status-success)' }
    case 'failed':
      return { fg: 'var(--status-danger)' }
    case 'in_progress':
      return { fg: 'var(--accent-fg)' }
    default:
      return { fg: 'var(--status-neutral)' }
  }
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
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
      {children}
    </span>
  )
}

function whenLabel(iso: string, isHebrew: boolean): string {
  const d = new Date(iso)
  const date = d.toLocaleDateString(isHebrew ? 'he-IL' : 'en-GB', { day: '2-digit', month: 'short' })
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${date} · ${time}`
}

export function Calls() {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<CallSummary | null>(null)

  const { data, isLoading, isError } = useCallsList({
    status: status || undefined,
    page,
    limit: LIMIT,
  })

  const calls = data?.data ?? []
  const meta = data?.meta
  const totalPages = meta?.total_pages ?? 1

  const selectStyle: React.CSSProperties = {
    height: '38px',
    background: 'var(--surface-card)',
    border: '1px solid var(--border-strong)',
    borderRadius: '10px',
    padding: '0 34px 0 12px',
    color: 'var(--text-primary)',
    fontSize: '13.5px',
    fontFamily: 'var(--font-body)',
    outline: 'none',
    cursor: 'pointer',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237A8598' stroke-width='1.7'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: `${isHebrew ? 'left' : 'right'} 12px center`,
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
        <select
          aria-label={t('calls.cols.outcome')}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value)
            setPage(1)
          }}
          style={selectStyle}
        >
          <option value="">{t('calls.filters.statusAll')}</option>
          {OUTCOME_FILTERS.filter(Boolean).map((s) => (
            <option key={s} value={s}>
              {t(`calls.outcome.${s}`)}
            </option>
          ))}
        </select>
        {meta && (
          <span
            style={{
              marginInlineStart: 'auto',
              fontFamily: 'var(--font-mono)',
              fontVariantNumeric: 'tabular-nums',
              fontSize: '13px',
              color: 'var(--text-secondary)',
            }}
          >
            {t('calls.count', { count: meta.total })}
          </span>
        )}
      </div>

      {/* Table */}
      <div style={{ ...CARD, overflow: 'hidden' }}>
        {isError ? (
          <div role="alert" style={{ padding: '40px', textAlign: 'center', color: 'var(--status-danger)', fontSize: '14px' }}>
            {t('calls.error')}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '620px' }} aria-busy={isLoading}>
              <thead>
                <tr>
                  <th style={th}>{t('calls.cols.lead')}</th>
                  <th style={th}>{t('calls.cols.when')}</th>
                  <th style={th}>{t('calls.cols.duration')}</th>
                  <th style={th}>{t('calls.cols.outcome')}</th>
                  <th style={th}>{t('calls.cols.qualified')}</th>
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
                ) : calls.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: '64px 20px', textAlign: 'center' }}>
                      <Phone size={30} strokeWidth={1.2} style={{ color: 'var(--text-tertiary)', display: 'block', margin: '0 auto 12px' }} />
                      <p style={{ fontSize: '15px', color: 'var(--text-secondary)', fontWeight: 600, marginBlockEnd: '6px' }}>
                        {t('calls.empty.title')}
                      </p>
                      <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>{t('calls.empty.body')}</p>
                    </td>
                  </tr>
                ) : (
                  calls.map((call) => {
                    const q = call.qualification?.status
                    return (
                      <tr
                        key={call.id}
                        onClick={() => setSelected(call)}
                        style={{ borderBlockEnd: '1px solid var(--border-default)', cursor: 'pointer' }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = 'var(--surface-sunken)')}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLTableRowElement).style.background = 'transparent')}
                      >
                        <td style={{ ...td, fontWeight: 600, color: 'var(--text-primary)' }} dir="auto">
                          {call.lead?.name ?? call.lead?.email ?? '—'}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {whenLabel(call.created_at, isHebrew)}
                        </td>
                        <td style={{ ...td, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                          {formatDuration(call.duration_secs)}
                        </td>
                        <td style={td}>
                          <Chip tone={outcomeTone(call.status).fg}>{t(`calls.outcome.${call.status}`, call.status)}</Chip>
                        </td>
                        <td style={td}>
                          {q ? (
                            <span style={{ fontSize: '13px', color: q === 'qualified' ? 'var(--status-success)' : 'var(--text-secondary)' }}>
                              {t(`calls.qualified.${q}`, q)}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {!isLoading && !isError && calls.length > 0 && totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBlockStart: '16px' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px', color: 'var(--text-tertiary)' }}>
            {t('calls.page', { page, total: totalPages })}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <PageBtn disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              {t('calls.prev')}
            </PageBtn>
            <PageBtn disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              {t('calls.next')}
            </PageBtn>
          </div>
        </div>
      )}

      {selected && <CallDrawer call={selected} onClose={() => setSelected(null)} />}
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

function CallDrawer({ call, onClose }: { call: CallSummary; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  const [tab, setTab] = useState<'transcript' | 'data'>('transcript')
  const { data, isLoading, isError } = useCallDetail(call.id)

  const learnings = data?.learnings
  const score = learnings?.sales_analysis?.overall_effectiveness_score ?? null

  const secLabel: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '10.5px',
    letterSpacing: isHebrew ? 'normal' : '0.1em',
    textTransform: isHebrew ? 'none' : 'uppercase',
    color: 'var(--text-tertiary)',
    marginBlockEnd: '10px',
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'rgba(8,12,26,0.42)', backdropFilter: 'none' }}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={call.lead?.name ?? 'Call detail'}
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
        {/* header */}
        <div style={{ padding: '18px 20px', borderBlockEnd: '1px solid var(--border-default)', display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
          <div style={{ flex: 1, minInlineSize: 0 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }} dir="auto">
              {call.lead?.name ?? call.lead?.email ?? '—'}
            </div>
            {call.lead?.phone && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12.5px', color: 'var(--text-tertiary)', marginBlockStart: '2px' }} dir="ltr">
                {call.lead.phone}
              </div>
            )}
            <div style={{ marginBlockStart: '8px' }}>
              <Chip tone={outcomeTone(call.status).fg}>{t(`calls.outcome.${call.status}`, call.status)}</Chip>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t('calls.drawer.close')}
            style={{ inlineSize: '34px', blockSize: '34px', display: 'grid', placeItems: 'center', borderRadius: '9px', border: '1px solid var(--border-default)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0 }}
          >
            <X size={17} strokeWidth={1.8} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '22px' }}>
          {isError ? (
            <p role="alert" style={{ color: 'var(--status-danger)', fontSize: '14px' }}>{t('calls.drawer.loadError')}</p>
          ) : (
            <>
              {/* meta grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <Meta label={t('calls.drawer.when')} value={whenLabel(call.created_at, isHebrew)} />
                <Meta label={t('calls.drawer.duration')} value={formatDuration(call.duration_secs)} />
              </div>

              {/* The audio section lived here. Recordings were streamed from Retell's API via
                  GET /calls/:id/audio; both are gone, so this could only ever have rendered
                  "no audio". LiveKit writes call_learnings.recording_url but nothing serves it. */}

              {/* outcome & analysis */}
              <div>
                <div style={secLabel}>{t('calls.drawer.outcomeTitle')}</div>
                <p style={{ fontSize: '13.5px', lineHeight: 1.6, color: 'var(--text-primary)' }} dir="auto">
                  {isLoading ? <Skeleton width="90%" height="14px" /> : data?.summary ?? call.summary ?? t('calls.drawer.noSummary')}
                </p>
              </div>

              {/* sales analysis */}
              <div>
                <div style={{ ...secLabel, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>{t('calls.drawer.analysisTitle')}</span>
                  {score != null && (
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: '15px', fontWeight: 700, color: 'var(--accent-fg)' }}>
                      {score}
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>/100</span>
                    </span>
                  )}
                </div>
                {learnings?.sales_analysis?.what_worked?.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {learnings.sales_analysis.what_worked.slice(0, 4).map((w, i) => (
                      <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '13px', color: 'var(--text-secondary)' }} dir="auto">
                        <span style={{ color: 'var(--status-success)' }}>+</span> {w}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize: '12.5px', color: 'var(--text-tertiary)' }}>{t('calls.drawer.noAnalysis')}</p>
                )}
              </div>

              {/* tabs: transcript / data */}
              <div>
                <div style={{ display: 'flex', gap: '4px', borderBlockEnd: '1px solid var(--border-default)', marginBlockEnd: '12px' }}>
                  {(['transcript', 'data'] as const).map((tk) => (
                    <button
                      key={tk}
                      onClick={() => setTab(tk)}
                      style={{
                        fontFamily: 'var(--font-body)',
                        fontSize: '13px',
                        fontWeight: tab === tk ? 600 : 500,
                        padding: '10px 10px',
                        border: 0,
                        background: 'transparent',
                        color: tab === tk ? 'var(--text-primary)' : 'var(--text-secondary)',
                        borderBlockEnd: `2px solid ${tab === tk ? 'var(--accent)' : 'transparent'}`,
                        marginBlockEnd: '-1px',
                        cursor: 'pointer',
                      }}
                    >
                      {t(`calls.drawer.tabs.${tk}`)}
                    </button>
                  ))}
                </div>

                {tab === 'transcript' &&
                  (isLoading ? (
                    <Skeleton width="100%" height="60px" />
                  ) : data && (data.transcript?.length ?? 0) > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {(data.transcript ?? []).map((turn, i) => (
                        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
                            {turn.role === 'agent' ? t('calls.drawer.agent') : call.lead?.name ?? '—'}
                          </span>
                          <span
                            dir="auto"
                            style={{
                              fontSize: '13.5px',
                              lineHeight: 1.55,
                              color: 'var(--text-primary)',
                              background: turn.role === 'agent' ? 'var(--surface-sunken)' : 'var(--accent-tint)',
                              border: '1px solid var(--border-default)',
                              borderRadius: '12px',
                              padding: '9px 13px',
                              alignSelf: turn.role === 'agent' ? 'flex-start' : 'flex-end',
                              maxInlineSize: '85%',
                            }}
                          >
                            {turn.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: '12.5px', color: 'var(--text-tertiary)' }}>{t('calls.drawer.noTranscript')}</p>
                  ))}

                {tab === 'data' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <DataRow label={t('calls.drawer.company')} value={call.qualification?.company_name} />
                    <DataRow label={t('calls.drawer.qualification')} value={call.qualification?.status ? t(`calls.qualified.${call.qualification.status}`, call.qualification.status) : null} />
                    <DataRow label={t('calls.drawer.challenge')} value={call.qualification?.lead_primary_challenge} />
                    <DataRow
                      label={t('calls.drawer.followup')}
                      value={
                        call.qualification?.follow_up_scheduled == null
                          ? null
                          : call.qualification.follow_up_scheduled
                            ? t('calls.drawer.yes')
                            : t('calls.drawer.no')
                      }
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ ...CARD, background: 'var(--surface-sunken)', boxShadow: 'none', padding: '10px 12px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: '13.5px', color: 'var(--text-primary)', marginBlockStart: '3px' }}>
        {value}
      </div>
    </div>
  )
}

function DataRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', justifyContent: 'space-between', paddingBlock: '4px', borderBlockEnd: '1px solid var(--border-default)' }}>
      <span style={{ fontSize: '12.5px', color: 'var(--text-tertiary)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '13.5px', color: value ? 'var(--text-primary)' : 'var(--text-tertiary)', textAlign: 'end' }} dir="auto">
        {value ?? '—'}
      </span>
    </div>
  )
}
