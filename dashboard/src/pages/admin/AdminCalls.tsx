import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { fetchAdminCalls, type AdminCallListItem } from '../../lib/admin-api.js'

/**
 * Every call on record, across every tenant — the way in to a call's report.
 *
 * `hasReport` is the column that earns its place. Most historical rows have no report at all
 * (only the LiveKit engine ever wrote one), so an operator needs to see which calls can answer a
 * question before opening one and finding an empty state.
 *
 * Bilingual, unlike the rest of the operator console: Koren asked for this page in Hebrew as well,
 * and there is now a language toggle in the console's top bar to reach it.
 */
const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

export function AdminCalls() {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  const [withReport, setWithReport] = useState(false)

  const q = useQuery({
    queryKey: ['admin', 'calls', { withReport }],
    queryFn: () => fetchAdminCalls(withReport ? { withReport: true } : {}),
  })
  const rows = q.data?.data ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '22px' }}>
            {t('adminCall.list.title')}
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBlockStart: '4px', maxInlineSize: '64ch' }}>
            {t('adminCall.list.lede')}
          </p>
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={withReport} onChange={(e) => setWithReport(e.target.checked)} />
          {t('adminCall.list.onlyWithReport')}
        </label>
      </div>

      {q.isError ? (
        <div role="alert" style={{ ...CARD, padding: '20px', color: 'var(--status-danger)', fontSize: '14px' }}>
          {t('adminCall.list.error')}
        </div>
      ) : (
        <div style={{ ...CARD, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ inlineSize: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ color: 'var(--text-tertiary)' }}>
                  {(['when', 'tenant', 'room', 'duration', 'status', 'outcome', 'report'] as const).map((k, i) => (
                    <th
                      key={k}
                      style={{
                        padding: '10px 14px',
                        textAlign: i >= 3 ? 'end' : 'start',
                        fontWeight: 600,
                        fontSize: '11px',
                        // Uppercase + tracking is a Latin device; it makes Hebrew unreadable.
                        textTransform: isHebrew ? 'none' : 'uppercase',
                        letterSpacing: isHebrew ? 'normal' : '0.05em',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t(`adminCall.list.cols.${k}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.isLoading ? (
                  <tr>
                    <td colSpan={7} style={EMPTY_CELL}>{t('adminCall.list.loading')}</td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={EMPTY_CELL}>
                      {withReport ? t('adminCall.list.emptyFiltered') : t('adminCall.list.empty')}
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => <Row key={r.learningId} r={r} isHebrew={isHebrew} t={t} />)
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({
  r,
  isHebrew,
  t,
}: {
  r: AdminCallListItem
  isHebrew: boolean
  t: (k: string) => string
}) {
  return (
    <tr style={{ borderBlockStart: '1px solid var(--border-default)' }}>
      <td style={{ padding: '11px 14px', whiteSpace: 'nowrap' }}>
        <Link to={`/admin/calls/${r.learningId}`} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          {formatWhen(r.createdAt, isHebrew)}
        </Link>
      </td>
      <td style={{ padding: '11px 14px' }}>
        <span dir="auto">{r.tenantName ?? '—'}</span>
      </td>
      <td style={{ padding: '11px 14px', fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--text-tertiary)' }}>
        <span dir="ltr">{r.room ?? '—'}</span>
      </td>
      <td style={NUM_CELL}>
        <span dir="ltr">{formatDuration(r.durationSecs)}</span>
      </td>
      <td style={{ ...NUM_CELL, fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>{r.status}</td>
      <td style={{ ...NUM_CELL, fontFamily: 'var(--font-body)', color: 'var(--text-secondary)' }}>{r.outcome ?? '—'}</td>
      <td style={NUM_CELL}>
        {/* Presence, in words. A tick against "no report" would read as a passing check. */}
        <span
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: '12px',
            fontWeight: 600,
            color: r.hasReport ? 'var(--status-success)' : 'var(--text-tertiary)',
          }}
        >
          {r.hasReport ? t('adminCall.list.hasReport') : t('adminCall.list.noReport')}
        </span>
      </td>
    </tr>
  )
}

const EMPTY_CELL: React.CSSProperties = {
  padding: '24px',
  textAlign: 'center',
  color: 'var(--text-tertiary)',
}

const NUM_CELL: React.CSSProperties = {
  padding: '11px 14px',
  textAlign: 'end',
  fontVariantNumeric: 'tabular-nums',
  fontFamily: 'var(--font-mono)',
  whiteSpace: 'nowrap',
}

/** m:ss, or an em-dash. A call with no recorded duration is not a zero-second call. */
function formatDuration(secs: number | null): string {
  if (secs === null) return '—'
  const m = Math.floor(secs / 60)
  return `${m}:${String(Math.floor(secs % 60)).padStart(2, '0')}`
}

function formatWhen(iso: string | null, isHebrew: boolean): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const locale = isHebrew ? 'he-IL' : 'en-GB'
  return `${d.toLocaleDateString(locale, { day: '2-digit', month: 'short' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}
