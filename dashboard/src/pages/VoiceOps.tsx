import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Phone, AlertTriangle, CheckCircle2, ArrowRight } from 'lucide-react'
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { Skeleton } from '../components/ui/Skeleton.js'
import { useVoiceMetrics } from '../hooks/useVoiceMetrics.js'
import { useTheme } from '../hooks/useTheme.js'
import type { VoiceMetrics } from '../lib/api.js'

type Range = 'today' | 'd7' | 'd30'

/**
 * Latency budgets, in milliseconds. The 1s worst case is the product's hard requirement — a caller
 * waiting longer than a second hears a machine — and the per-stage figures are how that second is
 * spent. They are UI thresholds only: the agent enforces nothing from here.
 */
const WORST_CASE_BUDGET_MS = 1000
const STAGE_BUDGET_MS = { endOfTurn: 500, llmTtft: 300, ttsTtfb: 200 }
/** The tool-call budget CallDetail already tints amber against. */
const TOOL_BUDGET_MS = 500

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

/** Bar colour per end reason. Amber is a fill here, never a text colour (brief §1.4). */
const REASON_COLOR: Record<string, string> = {
  meeting_booked: 'var(--data-1)',
  not_qualified: 'var(--status-neutral)',
  not_interested: 'var(--status-neutral)',
  opt_out: 'var(--status-warning)',
  wrong_person: 'var(--status-neutral)',
  unknown: 'var(--border-strong)',
}
/** Fixed order so the list doesn't reshuffle between refetches; `unknown` always last. */
const REASON_ORDER = ['meeting_booked', 'not_qualified', 'not_interested', 'opt_out', 'wrong_person']

export function VoiceOps() {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  const [range, setRange] = useState<Range>('today')

  const q = useVoiceMetrics(range)
  const m = q.data
  const loading = q.isLoading

  const num = (n: number) => n.toLocaleString(isHebrew ? 'he-IL' : 'en-US')
  const ms = (v: number | null) => (v == null ? '—' : `${num(v)}`)

  const hasCalls = (m?.calls.total ?? 0) > 0
  const hasLatency = (m?.latency.callsWithLatency ?? 0) > 0
  const avgDur = m?.calls.avgDurationSecs ?? null

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

      {q.isError && (
        <p role="alert" style={{ fontSize: '13px', color: 'var(--status-danger)', marginBlockEnd: '14px' }}>
          {t('voiceOps.errors.load')}
        </p>
      )}

      {/* KPI row */}
      <section aria-label={t('voiceOps.kpi.sectionLabel')} className="kpi-grid" style={{ display: 'grid', gap: '14px' }}>
        <Kpi label={t('voiceOps.kpi.calls')} value={num(m?.calls.total ?? 0)} loading={loading} isHebrew={isHebrew} />
        <Kpi
          label={t('voiceOps.kpi.minutes')}
          value={num(m?.usage.minutes ?? 0)}
          loading={loading}
          isHebrew={isHebrew}
          note={avgDur == null ? undefined : t('voiceOps.kpi.avgDuration', { n: formatDuration(avgDur) })}
        />
        <Kpi
          label={t('voiceOps.kpi.bookingRate')}
          value={m?.outcomes.bookingRatePct == null ? '—' : num(m.outcomes.bookingRatePct)}
          suffix={m?.outcomes.bookingRatePct == null ? undefined : '%'}
          loading={loading}
          isHebrew={isHebrew}
          accent
          note={
            m?.outcomes.bookingRatePct == null
              ? t('voiceOps.kpi.bookingRateNone')
              : t('voiceOps.kpi.bookingRateOf', { booked: num(m.outcomes.booked), total: num(m.outcomes.withEndReason) })
          }
        />
        {/* No cost tile. What a call costs US in provider fees is margin information and stays in
            the operator console; the tenant sees minutes used, which is what they are billed on. */}
        <Kpi
          label={t('voiceOps.kpi.failed')}
          value={num(m?.calls.failed ?? 0)}
          loading={loading}
          isHebrew={isHebrew}
          danger={(m?.calls.failed ?? 0) > 0}
        />
      </section>

      {/* Latency */}
      <SectionHeading
        title={t('voiceOps.latency.title')}
        hint={
          hasLatency
            ? t('voiceOps.latency.basedOn', { n: num(m!.latency.callsWithLatency), total: num(m!.calls.total) })
            : undefined
        }
      />
      {loading ? (
        <div className="kpi-grid" style={{ display: 'grid', gap: '14px' }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ ...CARD, padding: '16px', minBlockSize: '118px' }}>
              <Skeleton width="100%" height="70px" />
            </div>
          ))}
        </div>
      ) : hasLatency ? (
        <div className="kpi-grid" style={{ display: 'grid', gap: '14px' }}>
          <LatencyTile
            label={t('voiceOps.latency.endOfTurn')}
            stat={m!.latency.endOfTurnMs}
            budget={STAGE_BUDGET_MS.endOfTurn}
            isHebrew={isHebrew}
            fmt={ms}
            t={t}
          />
          <LatencyTile
            label={t('voiceOps.latency.llmTtft')}
            stat={m!.latency.llmTtftMs}
            budget={STAGE_BUDGET_MS.llmTtft}
            isHebrew={isHebrew}
            fmt={ms}
            t={t}
          />
          <LatencyTile
            label={t('voiceOps.latency.ttsTtfb')}
            stat={m!.latency.ttsTtfbMs}
            budget={STAGE_BUDGET_MS.ttsTtfb}
            isHebrew={isHebrew}
            fmt={ms}
            t={t}
          />
          <LatencyTile
            label={t('voiceOps.latency.worstCase')}
            stat={m!.latency.worstCaseMs}
            budget={WORST_CASE_BUDGET_MS}
            primary
            isHebrew={isHebrew}
            fmt={ms}
            t={t}
          />
        </div>
      ) : (
        // Every call made before the agent started persisting its report lands here. Say so plainly
        // rather than drawing four zeroes that look like a sub-millisecond agent.
        <div
          style={{
            ...CARD,
            background: 'transparent',
            boxShadow: 'none',
            border: '1px dashed var(--border-strong)',
            padding: '26px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            alignItems: 'center',
            textAlign: 'center',
          }}
        >
          <Eyebrow isHebrew={isHebrew}>{t('voiceOps.latency.awaitingTitle')}</Eyebrow>
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', maxInlineSize: '52ch' }}>
            {t('voiceOps.latency.awaitingNote')}
          </p>
        </div>
      )}

      {/* Outcomes + trend */}
      <div style={{ display: 'grid', gap: '16px', marginBlockStart: '16px' }} className="ov-bottom">
        <section style={{ ...CARD, padding: '18px' }} aria-label={t('voiceOps.outcome.title')}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '15px', marginBlockEnd: '14px' }}>
            {t('voiceOps.outcome.title')}
          </h3>
          <OutcomeBars data={m} loading={loading} isHebrew={isHebrew} />
        </section>

        <section style={{ ...CARD, padding: '18px' }} aria-label={t('voiceOps.chart.title')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBlockEnd: '14px', gap: '12px', flexWrap: 'wrap' }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '15px' }}>{t('voiceOps.chart.title')}</h3>
            <div style={{ display: 'flex', gap: '14px' }}>
              <Legend color="var(--data-1)" label={t('voiceOps.chart.calls')} />
              <Legend color="var(--data-2)" label={t('voiceOps.chart.minutes')} />
            </div>
          </div>
          <VoiceTrendChart
            series={m?.series ?? []}
            loading={loading}
            error={q.isError}
            isHebrew={isHebrew}
            emptyLabel={t('voiceOps.chart.empty')}
          />
        </section>
      </div>

      {/* Attention */}
      <SectionHeading title={t('voiceOps.attention.title')} />
      <AttentionList data={m} loading={loading} hasCalls={hasCalls} isHebrew={isHebrew} />
    </div>
  )
}

/* ---------------------------------------------------------------- pieces */

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', margin: '26px 0 12px', flexWrap: 'wrap' }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '17px' }}>{title}</h2>
      {hint && <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{hint}</span>}
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

function Kpi({
  label,
  value,
  loading,
  isHebrew,
  suffix,
  note,
  accent,
  danger,
}: {
  label: string
  value: string
  loading?: boolean
  isHebrew: boolean
  suffix?: string
  note?: string
  accent?: boolean
  danger?: boolean
}) {
  const color = danger ? 'var(--status-danger)' : accent ? 'var(--accent-fg)' : 'var(--text-primary)'
  return (
    <div
      style={{
        ...CARD,
        ...(accent ? { borderColor: 'var(--accent)' } : null),
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        minBlockSize: '128px',
      }}
    >
      <Eyebrow isHebrew={isHebrew}>{label}</Eyebrow>
      <span
        dir="ltr"
        style={{
          fontFamily: 'var(--font-display)',
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 700,
          fontSize: '34px',
          lineHeight: 1,
          letterSpacing: '-0.02em',
          color,
          textAlign: isHebrew ? 'end' : 'start',
        }}
      >
        {loading ? <Skeleton width="60px" height="34px" /> : value}
        {!loading && suffix && (
          <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-tertiary)', marginInlineStart: '3px' }}>{suffix}</span>
        )}
      </span>
      {!loading && note && (
        <span style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginBlockStart: 'auto' }}>{note}</span>
      )}
    </div>
  )
}

/** One latency stage: median large, p95 beneath, coloured against its budget. */
function LatencyTile({
  label,
  stat,
  budget,
  primary,
  isHebrew,
  fmt,
  t,
}: {
  label: string
  stat: { median: number | null; p95: number | null; max?: number | null }
  budget: number
  primary?: boolean
  isHebrew: boolean
  fmt: (v: number | null) => string
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  // Median over budget is a broken agent; only p95 over budget is a tail worth watching.
  const state =
    stat.median == null ? 'none' : stat.median > budget ? 'danger' : (stat.p95 ?? 0) > budget ? 'warning' : 'ok'
  const color =
    state === 'danger' ? 'var(--status-danger)' : state === 'ok' ? 'var(--status-success)' : 'var(--text-primary)'
  const dot =
    state === 'danger' ? 'var(--status-danger)' : state === 'warning' ? 'var(--data-2)' : 'var(--status-success)'

  return (
    <div
      style={{
        ...CARD,
        ...(primary ? { borderColor: state === 'danger' ? 'var(--status-danger)' : 'var(--border-strong)' } : null),
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '9px',
        minBlockSize: '118px',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
        {state !== 'none' && (
          <span style={{ inlineSize: '7px', blockSize: '7px', borderRadius: '50%', background: dot, flexShrink: 0 }} />
        )}
        <Eyebrow isHebrew={isHebrew}>{label}</Eyebrow>
      </span>
      <span
        dir="ltr"
        style={{
          fontFamily: 'var(--font-display)',
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 700,
          fontSize: '28px',
          lineHeight: 1,
          letterSpacing: '-0.02em',
          color,
          textAlign: isHebrew ? 'end' : 'start',
        }}
      >
        {fmt(stat.median)}
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-tertiary)', marginInlineStart: '3px' }}>ms</span>
      </span>
      <span
        dir="ltr"
        style={{
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: '11.5px',
          color: 'var(--text-tertiary)',
          marginBlockStart: 'auto',
          textAlign: isHebrew ? 'end' : 'start',
        }}
      >
        p95 {fmt(stat.p95)} ms · {t('voiceOps.latency.budget')} {budget} ms
      </span>
    </div>
  )
}

function OutcomeBars({ data, loading, isHebrew }: { data?: VoiceMetrics; loading: boolean; isHebrew: boolean }) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', paddingBlock: '6px' }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} width="100%" height="16px" />
        ))}
      </div>
    )
  }

  const by = sortReasons(data?.outcomes.byEndReason ?? {})
  const total = by.reduce((n, r) => n + r.count, 0)
  if (total === 0) {
    return (
      <div style={{ padding: '34px 12px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
        <Phone size={24} strokeWidth={1.4} />
        <p style={{ fontSize: '13.5px', marginBlockStart: '10px' }}>{t('voiceOps.outcome.empty')}</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {by.map((r) => {
        const pct = Math.round((r.count / total) * 100)
        const unknown = r.key === 'unknown'
        return (
          <div key={r.key} style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' }}>
              <span style={{ fontSize: '13px', color: unknown ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>
                {t(`voiceOps.outcome.${r.key}`)}
              </span>
              <span
                dir="ltr"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontVariantNumeric: 'tabular-nums',
                  fontSize: '12px',
                  color: 'var(--text-tertiary)',
                  flexShrink: 0,
                }}
              >
                {r.count.toLocaleString(isHebrew ? 'he-IL' : 'en-US')} · {pct}%
              </span>
            </div>
            <div style={{ blockSize: '8px', borderRadius: 'var(--r-full)', background: 'var(--surface-sunken)', overflow: 'hidden' }}>
              <div
                style={{
                  inlineSize: `${Math.max(pct, 2)}%`,
                  blockSize: '100%',
                  borderRadius: 'var(--r-full)',
                  background: REASON_COLOR[r.key] ?? 'var(--status-neutral)',
                }}
              />
            </div>
          </div>
        )
      })}
      {by.some((r) => r.key === 'unknown') && (
        <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginBlockStart: '2px' }}>
          {t('voiceOps.outcome.unknownHint')}
        </p>
      )}
    </div>
  )
}

/** Fixed display order, `unknown` last, zero buckets dropped. */
function sortReasons(by: Record<string, number>): Array<{ key: string; count: number }> {
  const known = REASON_ORDER.filter((k) => (by[k] ?? 0) > 0).map((k) => ({ key: k, count: by[k]! }))
  const extras = Object.keys(by)
    .filter((k) => k !== 'unknown' && !REASON_ORDER.includes(k) && by[k]! > 0)
    .map((k) => ({ key: k, count: by[k]! }))
  const unknown = (by['unknown'] ?? 0) > 0 ? [{ key: 'unknown', count: by['unknown']! }] : []
  return [...known, ...extras, ...unknown]
}

function AttentionList({
  data,
  loading,
  hasCalls,
  isHebrew,
}: {
  data?: VoiceMetrics
  loading: boolean
  hasCalls: boolean
  isHebrew: boolean
}) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <div style={{ ...CARD, padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} width="70%" height="16px" />
        ))}
      </div>
    )
  }

  if (!hasCalls) {
    return (
      <div style={{ ...CARD, padding: '40px 12px', textAlign: 'center', color: 'var(--text-tertiary)' }}>
        <Phone size={26} strokeWidth={1.4} />
        <p style={{ fontSize: '14px', marginBlockStart: '10px', color: 'var(--text-secondary)' }}>{t('voiceOps.empty.title')}</p>
        <p style={{ fontSize: '12.5px', marginBlockStart: '4px' }}>{t('voiceOps.empty.note')}</p>
      </div>
    )
  }

  const a = data!.attention
  const items = [
    { key: 'failed', n: a.failedCalls, label: t('voiceOps.attention.failed', { n: a.failedCalls }), tone: 'danger', to: '/calls' },
    // A missed AI disclosure is a compliance finding, not a nit — it outranks the speech signals.
    { key: 'disclosure', n: a.disclosureMissed, label: t('voiceOps.attention.disclosureMissed', { n: a.disclosureMissed }), tone: 'danger' },
    {
      key: 'fragmented',
      n: a.fragmentedTurnCalls,
      label: t('voiceOps.attention.fragmented', { calls: a.fragmentedTurnCalls, turns: a.fragmentedTurnsTotal }),
      tone: 'warning',
    },
    {
      key: 'tools',
      n: a.overBudgetToolCalls,
      label: t('voiceOps.attention.overBudgetTools', { n: a.overBudgetToolCalls, budget: TOOL_BUDGET_MS }),
      tone: 'warning',
    },
    { key: 'cutoffs', n: a.cutOffsTotal, label: t('voiceOps.attention.cutOffs', { n: a.cutOffsTotal }), tone: 'warning' },
  ].filter((i) => i.n > 0)

  if (items.length === 0) {
    return (
      <div style={{ ...CARD, padding: '22px 18px', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <CheckCircle2 size={18} strokeWidth={1.7} color="var(--status-success)" />
        <span style={{ fontSize: '13.5px', color: 'var(--text-secondary)' }}>{t('voiceOps.attention.clear')}</span>
      </div>
    )
  }

  return (
    <div style={{ ...CARD, padding: '4px 18px' }}>
      {items.map((item, idx) => {
        const color = item.tone === 'danger' ? 'var(--status-danger)' : 'var(--data-2)'
        const row = (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '11px',
              padding: '14px 0',
              borderBlockEnd: idx < items.length - 1 ? '1px solid var(--border-default)' : '0',
            }}
          >
            {item.tone === 'danger' ? (
              <AlertTriangle size={16} strokeWidth={1.7} color={color} style={{ flexShrink: 0 }} />
            ) : (
              <span style={{ inlineSize: '8px', blockSize: '8px', borderRadius: '50%', background: color, flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, fontSize: '13.5px', color: 'var(--text-primary)' }} dir="auto">
              {item.label}
            </span>
            <span
              dir="ltr"
              style={{
                fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
                fontSize: '13px',
                fontWeight: 600,
                color: item.tone === 'danger' ? color : 'var(--text-secondary)',
                flexShrink: 0,
              }}
            >
              {item.n.toLocaleString(isHebrew ? 'he-IL' : 'en-US')}
            </span>
            {item.to && <ArrowRight size={14} strokeWidth={1.6} className="flip-rtl" color="var(--text-tertiary)" />}
          </div>
        )
        return item.to ? (
          <Link key={item.key} to={item.to} style={{ display: 'block', textDecoration: 'none' }}>
            {row}
          </Link>
        ) : (
          <div key={item.key}>{row}</div>
        )
      })}
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

/** Daily calls/minutes trend. Colors come from the CSS vars and recompute on theme change — SVG
 *  attributes don't resolve custom properties on their own. */
function VoiceTrendChart({
  series,
  loading,
  error,
  isHebrew,
  emptyLabel,
}: {
  series: VoiceMetrics['series']
  loading: boolean
  error: boolean
  isHebrew: boolean
  emptyLabel: string
}) {
  const { resolved } = useTheme()
  const c = useMemo(() => {
    const cs = getComputedStyle(document.documentElement)
    const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb
    return {
      calls: v('--data-1', '#2F35C7'),
      minutes: v('--data-2', '#D9861B'),
      grid: v('--border-default', '#D9E0EA'),
      axis: v('--text-tertiary', '#7A8598'),
      surface: v('--surface-overlay', '#fff'),
      border: v('--border-default', '#D9E0EA'),
      text: v('--text-primary', '#0C1226'),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved])

  const fmtDay = (d: string) =>
    new Date(d + 'T00:00:00').toLocaleDateString(isHebrew ? 'he-IL' : 'en-GB', { day: '2-digit', month: '2-digit' })

  if (loading) return <Skeleton width="100%" height="200px" />
  if (error)
    return (
      <div style={{ minBlockSize: '200px', display: 'grid', placeItems: 'center', color: 'var(--status-danger)', fontSize: '13px' }}>
        {emptyLabel}
      </div>
    )

  return (
    <div style={{ inlineSize: '100%', blockSize: '200px' }} dir="ltr">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="gVoiceCalls" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.calls} stopOpacity={0.28} />
              <stop offset="100%" stopColor={c.calls} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gVoiceMinutes" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={c.minutes} stopOpacity={0.24} />
              <stop offset="100%" stopColor={c.minutes} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={fmtDay}
            tick={{ fill: c.axis, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: c.grid }}
            minTickGap={24}
          />
          <YAxis allowDecimals={false} width={34} tick={{ fill: c.axis, fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ stroke: c.grid }}
            contentStyle={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 10, fontSize: 12, color: c.text }}
            labelFormatter={(l) => fmtDay(String(l))}
          />
          <Area type="monotone" dataKey="calls" stroke={c.calls} strokeWidth={2} fill="url(#gVoiceCalls)" />
          <Area type="monotone" dataKey="minutes" stroke={c.minutes} strokeWidth={2} fill="url(#gVoiceMinutes)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/** m:ss for an average call length. */
function formatDuration(secs: number): string {
  const s = Math.round(secs)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
