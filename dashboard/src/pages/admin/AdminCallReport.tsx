import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Phone, CheckCircle, XCircle } from 'lucide-react'
import {
  fetchAdminCallReport,
  type CallReportEnvelope,
  type CallReportView,
  type FirstAudio,
  type ReportToolCall,
  type ReportTranscriptLine,
  type Verdict,
} from '../../lib/admin-api.js'

/**
 * ONE CALL, IN FULL — the report the agent has been writing since the engine went live and which
 * nothing has ever displayed.
 *
 * THE RULE THIS PAGE IS BUILT AROUND: it never draws a number the call did not produce. An absent
 * figure is an em-dash, an absent section does not render, and a call with no report at all gets a
 * sentence saying so instead of a grid of zeros. A zero looks like a measurement, and this repo has
 * shipped several instruments whose failure mode was a comfortable number in place of nothing.
 *
 * The per-turn badge is `first_audio_frame` — the caller stopped talking, and this is how long
 * until she made a sound. The server has already classified it; this page only renders the three
 * states it is given, and renders NOTHING at all on a line that has no badge (a dash there would
 * claim a measurement was attempted on a line that was never a turn opener).
 */

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

/**
 * Where a reply stops feeling like a conversation. Presentation thresholds only — nothing is
 * enforced from here, and the agent has never heard of them.
 */
const FAST_MS = 1000
const SLOW_MS = 2000

export function AdminCallReport() {
  const { id = '' } = useParams()
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')

  const q = useQuery({
    queryKey: ['admin', 'call-report', id],
    queryFn: () => fetchAdminCallReport(id),
    retry: (count, error: unknown) =>
      (error as { status?: number })?.status === 404 ? false : count < 2,
  })

  if (q.isLoading) {
    return <p style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>…</p>
  }

  if (q.isError) {
    const is404 = (q.error as { status?: number })?.status === 404
    return (
      <div style={{ textAlign: 'center', padding: '64px 0' }}>
        <Phone size={36} strokeWidth={1} style={{ color: 'var(--text-tertiary)', display: 'block', marginInline: 'auto', marginBlockEnd: '16px' }} />
        <p style={{ fontSize: '16px', color: 'var(--text-secondary)', fontWeight: 600, marginBlockEnd: '8px' }}>
          {is404 ? t('adminCall.report.notFound') : t('adminCall.report.error')}
        </p>
        {is404 && (
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>{t('adminCall.report.notFoundNote')}</p>
        )}
        <BackLink t={t} />
      </div>
    )
  }

  const env = q.data!

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
      <BackLink t={t} />
      <Header env={env} isHebrew={isHebrew} t={t} />
      {env.report === null ? (
        <Absence absence={env.absence} t={t} />
      ) : (
        <Report view={env.report} isHebrew={isHebrew} t={t} />
      )}
    </div>
  )
}

type T = (key: string, opts?: Record<string, unknown>) => string

function BackLink({ t }: { t: T }) {
  return (
    <Link
      to="/admin/calls"
      style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 600, color: 'var(--accent-fg)', textDecoration: 'none' }}
    >
      <ArrowLeft size={14} strokeWidth={1.7} className="flip-rtl" />
      {t('adminCall.report.back')}
    </Link>
  )
}

function Header({ env, isHebrew, t }: { env: CallReportEnvelope; isHebrew: boolean; t: T }) {
  const rows: Array<[string, React.ReactNode]> = [
    ['tenant', <span dir="auto">{env.tenantName ?? '—'}</span>],
    ['room', <span dir="ltr" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{env.room ?? '—'}</span>],
    ['when', <span dir="ltr">{formatWhen(env.createdAt, isHebrew)}</span>],
    ['duration', <span dir="ltr">{formatDuration(env.durationSecs)}</span>],
    ['status', env.status],
    ['outcome', env.outcome ?? '—'],
    ['endReason', env.endReason ?? '—'],
    // Presence, not a player. The audio proxy went with the retired engine and nothing serves
    // `recording_url`; a play button here would 404, which is worse than no button.
    [
      'recording',
      <span title={t('adminCall.report.meta.recordingNote')}>
        {env.recordingStored ? t('adminCall.report.meta.recordingStored') : t('adminCall.report.meta.recordingNone')}
      </span>,
    ],
  ]

  return (
    <div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '22px', marginBlockEnd: '14px' }}>
        {t('adminCall.report.title')}
      </h1>
      <div style={{ ...CARD, padding: '16px 18px', display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: '2px', minInlineSize: 0 }}>
            <span style={{ fontSize: '11.5px', color: 'var(--text-tertiary)' }}>{t(`adminCall.report.meta.${k}`)}</span>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * The honest empty state. Which KIND of nothing, in a sentence — not a figure strip of zeros, and
 * not a generic "no data" that reads as though the page were broken.
 */
function Absence({ absence, t }: { absence: CallReportEnvelope['absence']; t: T }) {
  const key = absence ?? 'no_report'
  return (
    <div
      style={{
        ...CARD,
        background: 'transparent',
        boxShadow: 'none',
        border: '1px dashed var(--border-strong)',
        padding: '30px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <span style={{ fontSize: '15px', fontWeight: 600 }}>{t(`adminCall.report.absence.${key}.title`)}</span>
      <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', maxInlineSize: '62ch', lineHeight: 1.6 }}>
        {t(`adminCall.report.absence.${key}.note`)}
      </p>
    </div>
  )
}

function Report({ view, isHebrew, t }: { view: CallReportView; isHebrew: boolean; t: T }) {
  return (
    <>
      {view.verdicts.length > 0 && <Verdicts verdicts={view.verdicts} t={t} />}
      <Figures view={view} isHebrew={isHebrew} t={t} />
      {view.latency !== null && <ByClass view={view} t={t} />}
      <Tools toolCalls={view.toolCalls} t={t} />
      <Transcript view={view} t={t} />
      <RawBlocks view={view} t={t} />
    </>
  )
}

const STATUS_COLOR: Record<Verdict['status'], string> = {
  pass: 'var(--status-success)',
  warn: 'var(--status-warning)',
  fail: 'var(--status-danger)',
}

function Verdicts({ verdicts, t }: { verdicts: Verdict[]; t: T }) {
  return (
    <Section title={t('adminCall.report.verdict.title')} note={t('adminCall.report.verdict.note')}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
        {verdicts.map((v) => (
          <li
            key={v.id}
            style={{
              ...CARD,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              borderInlineStart: `4px solid ${STATUS_COLOR[v.status]}`,
            }}
          >
            <span style={{ fontSize: '11px', fontWeight: 700, color: STATUS_COLOR[v.status] }}>
              {t(`adminCall.report.verdict.${v.status}`)}
            </span>
            <span style={{ fontSize: '13.5px', fontWeight: 600 }}>{t(`adminCall.report.verdict.id.${v.id}`)}</span>
            <span dir="ltr" style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {verdictValue(v)}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** The measurement behind the verdict, or the detail when the verdict is not a number. */
function verdictValue(v: Verdict): string {
  const detail = v.detail
    ? Object.entries(v.detail)
        .filter(([, x]) => x !== '' && x !== undefined)
        .map(([k, x]) => `${k}=${x}`)
        .join('  ')
    : ''
  if (v.value === null) return detail
  const num = v.unit === 'ms' ? `${v.value} ms` : String(v.value)
  return detail ? `${num}  ${detail}` : num
}

function Figures({ view, isHebrew, t }: { view: CallReportView; isHebrew: boolean; t: T }) {
  const s = view.raw.summary
  const all = view.latency?.all
  const figures: Array<{ key: string; value: string; hero?: boolean }> = [
    { key: 'duration', value: formatDuration(view.raw.durationSec) },
    { key: 'turnsHeard', value: numOr(s.turnsHeard) },
    { key: 'turnsMeasured', value: all ? String(all.n) : '—' },
    { key: 'firstAudioMedian', value: ms(all?.firstAudioP50 ?? null), hero: true },
    { key: 'deadAirP90', value: ms(all?.deadAirP90 ?? null) },
    { key: 'worstCase', value: ms(asNum(s.worstCaseMs)) },
    { key: 'endOfTurn', value: ms(asNum(s.endOfTurnMedianMs)) },
    { key: 'promptCache', value: asNum(s.promptCacheHitPct) === null ? '—' : `${asNum(s.promptCacheHitPct)}%` },
  ]

  return (
    <Section title={t('adminCall.report.figures.title')} note={t('adminCall.report.figures.note')}>
      <div style={{ ...CARD, padding: '18px 20px', display: 'grid', gap: '16px 12px', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))' }}>
        {figures.map((f) => (
          <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
              {t(`adminCall.report.figures.${f.key}`)}
            </span>
            <span
              dir="ltr"
              style={{
                fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
                fontSize: f.hero ? '26px' : '19px',
                fontWeight: f.hero ? 600 : 500,
                color: f.hero ? 'var(--accent-fg)' : 'var(--text-primary)',
                lineHeight: 1.2,
                textAlign: isHebrew ? 'end' : 'start',
              }}
            >
              {f.value}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

/**
 * The split that the pooled median hides. A turn with an early receipt, a turn without one and a
 * turn that ran a tool are three populations with three different fixes; classes with no turns in
 * them are not rendered at all rather than shown as rows of dashes.
 */
function ByClass({ view, t }: { view: CallReportView; t: T }) {
  const latency = view.latency!
  const classes = Object.entries(latency.byClass).filter(([, st]) => st.n > 0)
  if (classes.length === 0) return null

  return (
    <Section title={t('adminCall.report.byClass.title')} note={t('adminCall.report.byClass.note')}>
      <div style={{ ...CARD, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {classes.map(([name, st]) => (
          <div key={name} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '6px 14px' }}>
            <span style={{ fontSize: '13.5px', fontWeight: 600, minInlineSize: '16ch' }}>
              {t(`adminCall.report.byClass.name.${name}`)}
            </span>
            <span dir="ltr" style={MONO_SMALL}>
              {st.n} {t('adminCall.report.byClass.turns')}
            </span>
            <span dir="ltr" style={MONO_SMALL}>
              {t('adminCall.report.byClass.deadAir')} {ms(st.deadAirP50)}
            </span>
            <span dir="ltr" style={MONO_SMALL}>
              {t('adminCall.report.byClass.modelTtft')} {ms(st.modelTtftP50)}
            </span>
            <span dir="ltr" style={MONO_SMALL}>
              {t('adminCall.report.byClass.ttsTtfb')} {ms(st.ttsTtfbP50)}
            </span>
          </div>
        ))}
        {latency.audioBeforeFirstTokenPct !== null && (
          <p style={{ fontSize: '12.5px', color: 'var(--text-tertiary)', marginBlockStart: '2px' }}>
            {t('adminCall.report.byClass.audioBeforeFirstToken')}:{' '}
            <span dir="ltr" style={{ fontFamily: 'var(--font-mono)' }}>{latency.audioBeforeFirstTokenPct}%</span>{' '}
            {t('adminCall.report.byClass.ofSamples', {
              n: latency.audioBeforeFirstTokenSamples,
              total: latency.turns,
            })}
          </p>
        )}
      </div>
    </Section>
  )
}

const MONO_SMALL: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
  fontSize: '12px',
  color: 'var(--text-tertiary)',
}

function Tools({ toolCalls, t }: { toolCalls: ReportToolCall[] | null; t: T }) {
  return (
    <Section title={t('adminCall.report.tools.title')}>
      <div style={{ ...CARD, padding: '14px 16px' }}>
        {toolCalls === null ? (
          // The report carries no array at all — a different fact from "no tool ran".
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>{t('adminCall.report.tools.absent')}</p>
        ) : toolCalls.length === 0 ? (
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>{t('adminCall.report.tools.none')}</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '7px' }}>
            {toolCalls.map((tc, i) => (
              <ToolPill key={`${tc.name}-${i}`} tc={tc} t={t} />
            ))}
          </div>
        )}
      </div>
    </Section>
  )
}

/** The tool budget the methodology sets — the same 500ms CallDetail already tints against. */
const TOOL_BUDGET_MS = 500

function ToolPill({ tc, t }: { tc: ReportToolCall; t: T }) {
  const failed = tc.ok === false
  const slow = !failed && tc.durationMs !== null && tc.durationMs > TOOL_BUDGET_MS
  const tint: React.CSSProperties = failed
    ? { backgroundColor: 'color-mix(in srgb, var(--status-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--status-danger) 30%, transparent)', color: 'var(--status-danger)' }
    : slow
      ? { backgroundColor: 'color-mix(in srgb, var(--status-warning) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--status-warning) 32%, transparent)', color: 'var(--status-warning)' }
      : { backgroundColor: 'var(--surface-sunken)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }

  return (
    <span
      title={failed ? (tc.error ?? t('adminCall.report.tools.failed')) : slow ? t('adminCall.report.tools.overBudget', { ms: TOOL_BUDGET_MS }) : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', paddingInline: '9px', paddingBlock: '3px', borderRadius: 'var(--r-full)', fontSize: '11.5px', fontWeight: 600, whiteSpace: 'nowrap', ...tint }}
    >
      <span dir="ltr" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 400, color: 'var(--text-tertiary)' }}>
        {tc.atMs === null ? '—' : clock(tc.atMs)}
      </span>
      <span dir="auto">{tc.name}</span>
      {/* `ok` can be null on a report that never recorded it — then neither mark is shown. */}
      {tc.ok === true && <CheckCircle size={11} strokeWidth={1.5} />}
      {tc.ok === false && <XCircle size={11} strokeWidth={1.5} />}
      <span dir="ltr" style={{ fontSize: '10px', fontWeight: 400, fontFamily: 'var(--font-mono)' }}>
        {tc.durationMs === null ? '—' : `${tc.durationMs}ms`}
      </span>
    </span>
  )
}

function Transcript({ view, t }: { view: CallReportView; t: T }) {
  const lines = view.transcript
  return (
    <Section title={t('adminCall.report.transcript.title')} note={t('adminCall.report.transcript.lede')}>
      {!view.turnsDetected && lines.length > 0 && (
        <Caveat>{t('adminCall.report.transcript.badgesSuppressed')}</Caveat>
      )}
      {view.turnsSource === 'report' && <Caveat>{t('adminCall.report.transcript.turnsFromReport')}</Caveat>}
      {view.turnsDetected && <Legend t={t} />}
      <div style={{ ...CARD, padding: '12px 14px', marginBlockStart: '12px' }}>
        {lines.length === 0 ? (
          <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', textAlign: 'center', padding: '28px 0' }}>
            {t('adminCall.report.transcript.empty')}
          </p>
        ) : (
          <ul role="log" aria-label={t('adminCall.report.transcript.title')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {lines.map((l, i) => (
              <Line key={i} line={l} t={t} />
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

function Line({ line, t }: { line: ReportTranscriptLine; t: T }) {
  const isAgent = line.role === 'assistant'
  return (
    <li
      style={{
        display: 'grid',
        gridTemplateColumns: '54px 1fr auto',
        gap: '10px',
        alignItems: 'start',
        padding: '7px 10px',
        borderRadius: '8px',
        background: isAgent ? 'var(--surface-card)' : 'var(--surface-sunken)',
        border: isAgent ? '1px solid var(--border-default)' : '1px solid transparent',
      }}
    >
      <span dir="ltr" style={{ ...MONO_SMALL, fontSize: '11.5px', paddingBlockStart: '3px' }}>
        {clock(line.spokeAtMs ?? line.atMs)}
      </span>
      {/* dir="auto" because the caller may answer in either language, mid-call. */}
      <p dir="auto" style={{ margin: 0, fontSize: '14px', lineHeight: 1.6, color: isAgent ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
        {line.text}
      </p>
      {/* Nothing at all when there is no badge — a dash would claim a failed measurement. */}
      {line.firstAudio === null ? <span /> : <Badge fa={line.firstAudio} t={t} />}
    </li>
  )
}

function Badge({ fa, t }: { fa: FirstAudio; t: T }) {
  if (fa.state === 'measured') {
    const tone = fa.ms < FAST_MS ? 'fast' : fa.ms < SLOW_MS ? 'mid' : 'slow'
    const color =
      tone === 'fast' ? 'var(--status-success)' : tone === 'mid' ? 'var(--status-warning)' : 'var(--status-danger)'
    return (
      <span
        dir="ltr"
        style={{
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: '12px',
          fontWeight: 600,
          paddingInline: '7px',
          paddingBlock: '3px',
          borderRadius: '6px',
          whiteSpace: 'nowrap',
          color,
          background: `color-mix(in srgb, ${color} 12%, transparent)`,
        }}
      >
        {fa.ms}
        <span style={{ fontWeight: 400, opacity: 0.65 }}>ms</span>
      </span>
    )
  }

  // Both remaining states are "no number", and the tooltip says WHICH — the caller was not
  // waiting, or this build never recorded it. They are not the same fact and must not read as
  // a slow turn.
  const why =
    fa.state === 'caller_not_waiting'
      ? t('adminCall.report.transcript.callerNotWaiting')
      : t('adminCall.report.transcript.notRecorded')
  return (
    <span
      title={why}
      aria-label={`${t('adminCall.report.transcript.notMeasured')} — ${why}`}
      style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', paddingInline: '7px', paddingBlock: '3px', borderRadius: '6px', whiteSpace: 'nowrap', color: 'var(--text-tertiary)', background: 'var(--surface-sunken)', cursor: 'help' }}
    >
      —
    </span>
  )
}

function Legend({ t }: { t: T }) {
  const items: Array<[string, string]> = [
    ['fast', 'var(--status-success)'],
    ['mid', 'var(--status-warning)'],
    ['slow', 'var(--status-danger)'],
    ['notMeasured', 'var(--text-tertiary)'],
  ]
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '12.5px', color: 'var(--text-tertiary)', alignItems: 'center' }}>
      {items.map(([k, color]) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ inlineSize: '10px', blockSize: '10px', borderRadius: '3px', background: color }} />
          {t(`adminCall.report.transcript.legend.${k}`)}
        </span>
      ))}
    </div>
  )
}

/**
 * The escape hatch. Everything the report holds that this page does not have a designed slot for,
 * shown verbatim and collapsed — so the day the voice agent starts writing a new counter it is
 * visible here without anyone touching the dashboard.
 */
function RawBlocks({ view, t }: { view: CallReportView; t: T }) {
  const blocks: Array<[string, unknown]> = [
    ['summaryTitle', view.raw.summary],
    ['configTitle', { config: view.raw.config, pipeline: view.raw.pipeline }],
    ['usageTitle', view.raw.usage],
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {blocks.map(([key, value]) =>
        value === null || value === undefined ? null : (
          <details key={key} style={{ ...CARD, padding: '12px 16px' }}>
            <summary style={{ cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>
              {t(`adminCall.report.raw.${key}`)}
            </summary>
            {key === 'summaryTitle' && (
              <p style={{ fontSize: '12.5px', color: 'var(--text-tertiary)', marginBlock: '8px 0', maxInlineSize: '66ch' }}>
                {t('adminCall.report.raw.summaryNote')}
              </p>
            )}
            <pre
              dir="ltr"
              style={{ marginBlockStart: '10px', marginBlockEnd: 0, overflowX: 'auto', background: 'var(--surface-sunken)', border: '1px solid var(--border-default)', borderRadius: '10px', padding: '12px 14px', fontFamily: 'var(--font-mono)', fontSize: '11.5px', lineHeight: 1.7, textAlign: 'left' }}
            >
              {JSON.stringify(value, null, 2)}
            </pre>
          </details>
        ),
      )}
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '17px', fontWeight: 600, marginBlockEnd: note ? '4px' : '10px' }}>
        {title}
      </h2>
      {note && (
        <p style={{ fontSize: '12.5px', color: 'var(--text-tertiary)', marginBlockEnd: '12px', maxInlineSize: '70ch', lineHeight: 1.6 }}>
          {note}
        </p>
      )}
      {children}
    </section>
  )
}

function Caveat({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ borderInlineStart: '3px solid var(--status-warning)', paddingInline: '12px', paddingBlock: '2px', margin: '0 0 12px', fontSize: '12.5px', color: 'var(--text-tertiary)', maxInlineSize: '70ch', lineHeight: 1.6 }}>
      {children}
    </p>
  )
}

/** An absent measurement is an em-dash. Never 0, never blank. */
function ms(v: number | null): string {
  return v === null ? '—' : `${v}`
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function numOr(v: unknown): string {
  const n = asNum(v)
  return n === null ? '—' : String(n)
}

function formatDuration(secs: number | null): string {
  if (secs === null) return '—'
  const m = Math.floor(secs / 60)
  return `${m}:${String(Math.floor(secs % 60)).padStart(2, '0')}`
}

/** mm:ss on the call's own clock. */
function clock(atMs: number): string {
  const s = Math.max(0, Math.floor(atMs / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function formatWhen(iso: string | null, isHebrew: boolean): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.toLocaleDateString(isHebrew ? 'he-IL' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}
