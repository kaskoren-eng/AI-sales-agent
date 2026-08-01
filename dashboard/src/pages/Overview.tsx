import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Phone, ArrowRight } from 'lucide-react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Skeleton } from '../components/ui/Skeleton.js'
import { fetchCalls, fetchMetricsSummary } from '../lib/api.js'
import { useTheme } from '../hooks/useTheme.js'

type Range = 'today' | 'd7' | 'd30'

const PIPELINE: { key: string; labelKey: string; dot: string; accent?: string }[] = [
  { key: 'new', labelKey: 'overview.pipeline.new', dot: 'var(--status-neutral)' },
  { key: 'contacted', labelKey: 'overview.pipeline.contacted', dot: 'var(--status-neutral)' },
  { key: 'qualifying', labelKey: 'overview.pipeline.qualifying', dot: 'var(--data-2)' },
  { key: 'qualified', labelKey: 'overview.pipeline.qualified', dot: 'var(--status-success)', accent: 'var(--status-success)' },
  { key: 'booked', labelKey: 'overview.pipeline.booked', dot: 'var(--accent-fg)', accent: 'var(--accent-fg)' },
]

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

export function Overview() {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  const [range, setRange] = useState<Range>('today')

  const metricsQ = useQuery({
    queryKey: ['metrics', range],
    queryFn: () => fetchMetricsSummary(range),
    staleTime: 60_000,
  })
  const callsRecentQ = useQuery({
    queryKey: ['calls', { limit: 6 }],
    queryFn: () => fetchCalls({ limit: 6 }),
    staleTime: 60_000,
  })

  const m = metricsQ.data
  const loadingM = metricsQ.isLoading
  const stageCount = (key: string) => m?.pipeline[key] ?? 0
  const totalLeads = m?.kpis.leadsTotal ?? 0
  const qualified = m?.kpis.qualified ?? 0
  const booked = m?.kpis.booked ?? 0
  const totalCalls = m?.kpis.callsTotal ?? 0
  const callsInRange = m?.kpis.callsInRange ?? 0
  const quality = m?.kpis.qualityScore ?? null
  const recent = callsRecentQ.data?.data ?? []

  const num = (n: number) => n.toLocaleString(isHebrew ? 'he-IL' : 'en-US')
  const rangeCallsLabel =
    range === 'today' ? t('overview.kpi.callsToday') : t('overview.kpi.callsRange', { n: range === 'd7' ? 7 : 30 })

  return (
    <div style={{ maxInlineSize: 'var(--container-max)', marginInline: 'auto' }}>
      {/* header row: freshness + range (page title lives in the top bar) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          flexWrap: 'wrap',
          marginBlockEnd: '20px',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
          <span style={{ inlineSize: '6px', blockSize: '6px', borderRadius: '50%', background: 'var(--status-success)' }} />
          {t('overview.live')}
        </span>
        <div
          role="group"
          aria-label={t('overview.range.label')}
          style={{
            display: 'inline-flex',
            padding: '3px',
            background: 'var(--surface-sunken)',
            border: '1px solid var(--border-default)',
            borderRadius: '10px',
          }}
        >
          {(['today', 'd7', 'd30'] as Range[]).map((r) => {
            const active = range === r
            return (
              <button
                key={r}
                type="button"
                aria-pressed={active}
                onClick={() => setRange(r)}
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: '13px',
                  fontWeight: 500,
                  padding: '6px 12px',
                  border: 0,
                  borderRadius: '7px',
                  cursor: active ? 'default' : 'pointer',
                  background: active ? 'var(--surface-card)' : 'transparent',
                  boxShadow: active ? 'var(--shadow-card)' : 'none',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                {t(`overview.range.${r}`)}
              </button>
            )
          })}
        </div>
      </div>

      {/* KPI grid — all real. Quality shows once at least one call is analyzed; else designed-empty. */}
      <section aria-label="Key metrics" className="kpi-grid" style={{ display: 'grid', gap: '14px' }}>
        <Kpi label={rangeCallsLabel} value={num(callsInRange)} loading={loadingM} />
        <Kpi label={t('overview.kpi.meetings')} value={num(booked)} loading={loadingM} money />
        <Kpi label={t('overview.kpi.leads')} value={num(totalLeads)} loading={loadingM} />
        <Kpi label={t('overview.kpi.qualified')} value={num(qualified)} loading={loadingM} />
        <Kpi label={t('overview.kpi.totalCalls')} value={num(totalCalls)} loading={loadingM} />
        {quality != null ? (
          <Kpi label={t('overview.kpi.quality')} value={`${num(quality)}`} loading={loadingM} suffix="/100" />
        ) : (
          <div
            style={{
              ...CARD,
              background: 'transparent',
              boxShadow: 'none',
              border: '1px dashed var(--border-strong)',
              padding: '16px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: '6px',
              minBlockSize: '128px',
            }}
          >
            <Eyebrow isHebrew={isHebrew}>{t('overview.kpi.quality')}</Eyebrow>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '20px', color: 'var(--text-tertiary)' }}>
              {t('overview.kpi.soon')}
            </span>
            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{t('overview.kpi.qualityNote')}</span>
          </div>
        )}
      </section>

      {metricsQ.isError && (
        <p role="alert" style={{ fontSize: '13px', color: 'var(--status-danger)', marginBlockStart: '12px' }}>
          {t('overview.errors.leads')}
        </p>
      )}

      {/* Pipeline — real lead statuses; each stage filters the Leads list */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', margin: '26px 0 12px' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '17px' }}>{t('overview.pipeline.title')}</h2>
        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{t('overview.pipeline.hint')}</span>
      </div>
      <div style={{ ...CARD, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)' }} role="group" aria-label={t('overview.pipeline.title')}>
        {PIPELINE.map((s, idx) => (
          <Link
            key={s.key}
            to={`/leads?status=${s.key}`}
            style={{
              textAlign: 'start',
              padding: '16px 18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              borderInlineEnd: idx < PIPELINE.length - 1 ? '1px solid var(--border-default)' : '0',
              textDecoration: 'none',
              transition: 'background var(--duration-fast) var(--ease-standard)',
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = 'var(--surface-sunken)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLAnchorElement).style.background = 'transparent')}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
              <span style={{ inlineSize: '8px', blockSize: '8px', borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
              <span style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{t(s.labelKey)}</span>
            </span>
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontVariantNumeric: 'tabular-nums',
                fontWeight: 700,
                fontSize: '26px',
                letterSpacing: '-0.02em',
                color: s.accent ?? 'var(--text-primary)',
              }}
            >
              {loadingM ? <Skeleton width="40px" height="26px" /> : num(stageCount(s.key))}
            </span>
          </Link>
        ))}
      </div>

      {/* Bottom row: weekly chart (needs metrics endpoint — designed empty) + recent activity (real) */}
      <div style={{ display: 'grid', gap: '16px', marginBlockStart: '16px' }} className="ov-bottom">
        {/* chart — real daily trend from the metrics endpoint */}
        <section style={{ ...CARD, padding: '18px' }} aria-label={t('overview.chart.title')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBlockEnd: '14px', gap: '12px', flexWrap: 'wrap' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '15px' }}>{t('overview.chart.title')}</h3>
            <div style={{ display: 'flex', gap: '14px' }}>
              <Legend color="var(--data-1)" label={t('overview.chart.leads')} />
              <Legend color="var(--data-2)" label={t('overview.chart.calls')} />
            </div>
          </div>
          <TrendChart series={m?.series ?? []} loading={loadingM} error={metricsQ.isError} isHebrew={isHebrew} emptyLabel={t('overview.chart.empty')} />
        </section>

        {/* recent activity — real, from recent calls */}
        <section style={{ ...CARD, padding: '18px' }} aria-label={t('overview.activity.title')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBlockEnd: '10px' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '15px' }}>{t('overview.activity.title')}</h3>
            <Link
              to="/calls"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '13px', fontWeight: 600, color: 'var(--accent-fg)' }}
            >
              {t('overview.activity.viewAll')} <ArrowRight size={13} strokeWidth={1.6} className="flip-rtl" />
            </Link>
          </div>

          {callsRecentQ.isLoading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', paddingBlock: '8px' }}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
                  <Skeleton width="28px" height="28px" borderRadius="8px" />
                  <Skeleton width="60%" height="14px" />
                </div>
              ))}
            </div>
          )}

          {callsRecentQ.isError && (
            <p role="alert" style={{ fontSize: '13px', color: 'var(--status-danger)', paddingBlock: '12px' }}>
              {t('overview.errors.calls')}
            </p>
          )}

          {!callsRecentQ.isLoading && !callsRecentQ.isError && recent.length === 0 && (
            <div style={{ padding: '40px 12px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
              <Phone size={26} strokeWidth={1.4} />
              <p style={{ fontSize: '13.5px', marginBlockStart: '10px' }}>{t('overview.activity.empty')}</p>
            </div>
          )}

          {!callsRecentQ.isLoading && !callsRecentQ.isError && recent.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {recent.map((call, idx) => (
                <div
                  key={call.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '11px',
                    padding: '11px 0',
                    borderBlockEnd: idx < recent.length - 1 ? '1px solid var(--border-default)' : '0',
                  }}
                >
                  <span
                    style={{
                      inlineSize: '28px',
                      blockSize: '28px',
                      borderRadius: '8px',
                      display: 'grid',
                      placeItems: 'center',
                      flexShrink: 0,
                      background: 'var(--surface-sunken)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <Phone size={15} strokeWidth={1.7} />
                  </span>
                  <div style={{ flex: 1, minInlineSize: 0 }}>
                    <div style={{ fontSize: '13.5px', color: 'var(--text-primary)' }}>
                      <span>{t('overview.activity.call')}</span> ·{' '}
                      <span style={{ fontWeight: 600 }} dir="auto">
                        {call.lead?.name ?? call.lead?.email ?? '—'}
                      </span>
                    </div>
                  </div>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontVariantNumeric: 'tabular-nums',
                      fontSize: '11px',
                      color: 'var(--text-tertiary)',
                      flexShrink: 0,
                      marginInlineStart: '8px',
                    }}
                  >
                    {new Date(call.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Eyebrow({ children, isHebrew }: { children: React.ReactNode; isHebrew: boolean }) {
  return (
    <span
      style={{
        fontFamily: isHebrew ? 'var(--font-body)' : 'var(--font-mono)',
        fontSize: isHebrew ? '12px' : '11px',
        fontWeight: isHebrew ? 600 : 400,
        letterSpacing: isHebrew ? 'normal' : '0.12em',
        textTransform: isHebrew ? 'none' : 'uppercase',
        color: 'var(--text-tertiary)',
      }}
    >
      {children}
    </span>
  )
}

function Kpi({ label, value, loading, money, suffix }: { label: string; value: string; loading?: boolean; money?: boolean; suffix?: string }) {
  const { i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  return (
    <div
      style={{
        ...CARD,
        ...(money ? { borderColor: 'var(--accent)' } : null),
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        minBlockSize: '128px',
      }}
    >
      <Eyebrow isHebrew={isHebrew}>{label}</Eyebrow>
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 700,
          fontSize: '34px',
          lineHeight: 1,
          letterSpacing: '-0.02em',
          color: money ? 'var(--accent-fg)' : 'var(--text-primary)',
        }}
      >
        {loading ? <Skeleton width="60px" height="34px" /> : value}
        {!loading && suffix && <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-tertiary)', marginInlineStart: '3px' }}>{suffix}</span>}
      </span>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-tertiary)' }}>
      <span style={{ inlineSize: '10px', blockSize: '10px', borderRadius: '3px', background: color }} />
      {label}
    </span>
  )
}

/** Daily leads/calls trend. Colors are read from the CSS vars and recomputed on theme change so the
 *  chart tracks light/dark (SVG attributes don't resolve CSS custom properties on their own). */
function TrendChart({ series, loading, error, isHebrew, emptyLabel }: { series: Array<{ date: string; leads: number; calls: number }>; loading: boolean; error: boolean; isHebrew: boolean; emptyLabel: string }) {
  const { resolved } = useTheme()
  const c = useMemo(() => {
    const cs = getComputedStyle(document.documentElement)
    const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb
    return {
      leads: v('--data-1', '#2F35C7'),
      calls: v('--data-2', '#D9861B'),
      grid: v('--border-default', '#D9E0EA'),
      axis: v('--text-tertiary', '#7A8598'),
      surface: v('--surface-overlay', '#fff'),
      border: v('--border-default', '#D9E0EA'),
      text: v('--text-primary', '#0C1226'),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved])

  const fmtDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(isHebrew ? 'he-IL' : 'en-GB', { day: '2-digit', month: '2-digit' })

  if (loading) return <Skeleton width="100%" height="200px" />
  if (error) return <div style={{ minBlockSize: '200px', display: 'grid', placeItems: 'center', color: 'var(--status-danger)', fontSize: '13px' }}>{emptyLabel}</div>

  return (
    <div style={{ inlineSize: '100%', blockSize: '200px' }} dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="gLeads" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.leads} stopOpacity={0.28} />
              <stop offset="100%" stopColor={c.leads} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gCalls" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.calls} stopOpacity={0.24} />
              <stop offset="100%" stopColor={c.calls} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDay} tick={{ fill: c.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: c.grid }} minTickGap={24} />
          <YAxis allowDecimals={false} width={34} tick={{ fill: c.axis, fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ stroke: c.grid }}
            contentStyle={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 10, fontSize: 12, color: c.text }}
            labelFormatter={(l) => fmtDay(String(l))}
          />
          <Area type="monotone" dataKey="leads" stroke={c.leads} strokeWidth={2} fill="url(#gLeads)" />
          <Area type="monotone" dataKey="calls" stroke={c.calls} strokeWidth={2} fill="url(#gCalls)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
