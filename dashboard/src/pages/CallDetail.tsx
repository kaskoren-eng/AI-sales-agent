import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, User, Bot, Clock, Phone, AlertCircle, CheckCircle, XCircle } from 'lucide-react'
import { useCallDetail } from '../hooks/useCallDetail.js'
import { Badge, statusToBadgeVariant } from '../components/ui/Badge.js'
import { Card } from '../components/ui/Card.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { Button } from '../components/ui/Button.js'
import { formatDate, formatDuration } from '../lib/format.js'
import type { CallLearnings, TranscriptTurn } from '../lib/types.js'

function humanizeSnake(s: string): string {
  const words = s.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function scoreVariant(score: number): 'success' | 'warning' | 'error' {
  if (score >= 7) return 'success'
  if (score >= 4) return 'warning'
  return 'error'
}

const SCORE_COLOR: Record<'success' | 'warning' | 'error', string> = {
  success: 'var(--success)',
  warning: 'var(--warning)',
  error: 'var(--error)',
}

// -------------------------------------------------------------------------
// Verdict strip — the call's outcome at a glance, above the grid (§4.1)
// -------------------------------------------------------------------------
function VerdictStrip({ learnings }: { learnings: CallLearnings }) {
  const inProgress = learnings.status === 'pending' || learnings.status === 'transcribing'
  const score = learnings.sales_analysis?.overall_effectiveness_score ?? null
  const notice = learnings.compliance.recording_notice_played
  const disclosure = learnings.compliance.ai_disclosure

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }} aria-label="Call verdict">
      {learnings.outcome && (
        <Badge variant={statusToBadgeVariant(learnings.outcome)}>{humanizeSnake(learnings.outcome)}</Badge>
      )}
      {learnings.end_reason && <Badge variant="violet">{humanizeSnake(learnings.end_reason)}</Badge>}
      {score != null && (
        <Badge variant={scoreVariant(score)}>{score}/10 effectiveness</Badge>
      )}
      {notice != null && (
        <Badge variant={notice ? 'success' : 'error'}>
          {notice ? <CheckCircle size={11} strokeWidth={1.5} /> : <XCircle size={11} strokeWidth={1.5} />}
          Recording notice {notice ? 'played' : 'not played'}
        </Badge>
      )}
      {disclosure && (
        <Badge variant={disclosure === 'during_call' ? 'success' : disclosure === 'at_end' ? 'warning' : 'error'}>
          {disclosure === 'during_call' ? (
            <CheckCircle size={11} strokeWidth={1.5} />
          ) : disclosure === 'at_end' ? (
            <AlertCircle size={11} strokeWidth={1.5} />
          ) : (
            <XCircle size={11} strokeWidth={1.5} />
          )}
          {disclosure === 'during_call'
            ? 'AI disclosed during call'
            : disclosure === 'at_end'
              ? 'AI disclosed at end'
              : 'AI disclosure missed'}
        </Badge>
      )}
      {inProgress && (
        <Badge variant="default">
          <Clock size={11} strokeWidth={1.5} />
          Analysis in progress…
        </Badge>
      )}
    </div>
  )
}

// -------------------------------------------------------------------------
// Tool-call timeline — one pill per tool invocation, ordered by time (§4.2)
// -------------------------------------------------------------------------
function ToolCallStrip({ toolCalls }: { toolCalls: CallLearnings['tool_calls'] }) {
  if (toolCalls.length === 0) return null
  const sorted = [...toolCalls].sort((a, b) => a.atMs - b.atMs)

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px',
        paddingInline: '20px',
        paddingBlock: '12px',
        borderBottom: '1px solid var(--border-subtle)',
      }}
      aria-label="Tool calls during this call"
    >
      {sorted.map((tc, i) => (
        <ToolCallPill key={`${tc.name}-${tc.atMs}-${i}`} tc={tc} />
      ))}
    </div>
  )
}

function ToolCallPill({ tc }: { tc: CallLearnings['tool_calls'][number] }) {
  const failed = !tc.ok
  // The agent's tool budget is <500ms (voice-agent-development-methodology) — flag breaches
  const slow = tc.ok && tc.durationMs > 500
  const tint: React.CSSProperties = failed
    ? { backgroundColor: 'rgba(239, 68, 68, 0.10)', border: '1px solid rgba(239, 68, 68, 0.30)', color: 'var(--error)' }
    : slow
      ? { backgroundColor: 'rgba(245, 158, 11, 0.10)', border: '1px solid rgba(245, 158, 11, 0.30)', color: 'var(--warning)' }
      : { backgroundColor: 'var(--bg-inset)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }

  return (
    <span
      title={failed ? (tc.error ?? 'Tool call failed') : slow ? 'Over the 500ms tool-latency budget' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        paddingInline: '9px',
        paddingBlock: '3px',
        borderRadius: '9999px',
        fontSize: '11px',
        fontWeight: 600,
        fontFamily: "'Assistant', sans-serif",
        whiteSpace: 'nowrap',
        ...tint,
      }}
    >
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', fontWeight: 400, color: 'var(--text-muted)' }}>
        {formatDuration(Math.floor(tc.atMs / 1000))}
      </span>
      {tc.name}
      {tc.ok ? <CheckCircle size={11} strokeWidth={1.5} /> : <XCircle size={11} strokeWidth={1.5} />}
      <span style={{ fontSize: '10px', fontWeight: 400, color: slow ? 'var(--warning)' : 'var(--text-muted)' }}>
        {tc.durationMs}ms
      </span>
    </span>
  )
}

// -------------------------------------------------------------------------
// Sales Analysis card — the worker's coaching read on the call (§4.3)
// -------------------------------------------------------------------------
function ListBlock({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div style={{ marginBlockEnd: '12px' }}>
      <p
        style={{
          fontSize: '11px',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          margin: 0,
          marginBlockEnd: '6px',
        }}
      >
        {label}
      </p>
      <ul style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {items.map((item, i) => (
          <li
            key={i}
            dir="auto"
            style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.55, listStylePosition: 'inside' }}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SalesAnalysisCard({ analysis }: { analysis: NonNullable<CallLearnings['sales_analysis']> }) {
  const score = analysis.overall_effectiveness_score
  const hasCoachingNotes =
    analysis.what_worked.length > 0 ||
    analysis.what_didnt_work.length > 0 ||
    analysis.key_questions_asked.length > 0 ||
    analysis.recommendations.length > 0

  return (
    <Card>
      <h3
        style={{
          fontFamily: "'Montserrat', sans-serif",
          fontWeight: 700,
          fontSize: '11px',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          marginBottom: '16px',
        }}
      >
        Sales Analysis
      </h3>

      {score != null && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '5px', marginBlockEnd: '14px' }}>
          <span
            style={{
              fontFamily: "'Montserrat', sans-serif",
              fontWeight: 800,
              fontSize: '32px',
              lineHeight: 1,
              color: SCORE_COLOR[scoreVariant(score)],
            }}
          >
            {score}
          </span>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>/10 effectiveness</span>
        </div>
      )}

      <ListBlock label="Pain points" items={analysis.pain_points_uncovered} />

      {analysis.objections.length > 0 && (
        <div style={{ marginBlockEnd: '12px' }}>
          <p
            style={{
              fontSize: '11px',
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
              margin: 0,
              marginBlockEnd: '6px',
            }}
          >
            Objections
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {analysis.objections.map((o, i) => (
              <div
                key={i}
                style={{
                  paddingInline: '10px',
                  paddingBlock: '8px',
                  backgroundColor: 'var(--bg-inset)',
                  borderRadius: '6px',
                  border: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '7px',
                }}
              >
                {o.handled_well ? (
                  <CheckCircle size={13} strokeWidth={1.5} style={{ color: 'var(--success)', flexShrink: 0, marginBlockStart: '2px' }} />
                ) : (
                  <XCircle size={13} strokeWidth={1.5} style={{ color: 'var(--error)', flexShrink: 0, marginBlockStart: '2px' }} />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p dir="auto" style={{ margin: 0, fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.5 }}>
                    {o.objection}
                  </p>
                  <p dir="auto" style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    {o.response}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(analysis.opening_technique || analysis.closing_technique || analysis.rapport_building) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBlockEnd: '12px' }}>
          {analysis.opening_technique && (
            <MetaRow label="Opening" value={<span dir="auto">{analysis.opening_technique}</span>} />
          )}
          {analysis.closing_technique && (
            <MetaRow label="Closing" value={<span dir="auto">{analysis.closing_technique}</span>} />
          )}
          {analysis.rapport_building && (
            <MetaRow label="Rapport" value={<span dir="auto">{analysis.rapport_building}</span>} />
          )}
        </div>
      )}

      {hasCoachingNotes && (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>
            Coaching notes
          </summary>
          <div style={{ marginBlockStart: '10px' }}>
            <ListBlock label="What worked" items={analysis.what_worked} />
            <ListBlock label="What didn't work" items={analysis.what_didnt_work} />
            <ListBlock label="Key questions" items={analysis.key_questions_asked} />
            <ListBlock label="Recommendations" items={analysis.recommendations} />
          </div>
        </details>
      )}
    </Card>
  )
}

function TranscriptBubble({ turn }: { turn: TranscriptTurn }) {
  const isAgent = turn.role === 'agent'
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isAgent ? 'row-reverse' : 'row',
        alignItems: 'flex-end',
        gap: '8px',
        marginBottom: '12px',
      }}
    >
      {/* Avatar */}
      <div
        aria-hidden="true"
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '50%',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isAgent ? 'rgba(15, 163, 172, 0.1)' : 'var(--glass-hover)',
          border: `1px solid ${isAgent ? 'rgba(15, 163, 172, 0.25)' : 'var(--border-default)'}`,
          color: isAgent ? 'var(--accent-teal)' : 'var(--text-secondary)',
        }}
      >
        {isAgent ? <Bot size={14} strokeWidth={1.5} /> : <User size={14} strokeWidth={1.5} />}
      </div>

      {/* Bubble */}
      <div
        style={{
          maxWidth: '72%',
          padding: '10px 14px',
          borderRadius: isAgent ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
          backgroundColor: isAgent ? 'rgba(15, 163, 172, 0.08)' : 'var(--glass-hover)',
          border: `1px solid ${isAgent ? 'rgba(15, 163, 172, 0.15)' : 'var(--border-subtle)'}`,
          fontSize: '13px',
          lineHeight: 1.6,
          color: 'var(--text-primary)',
        }}
      >
        <p dir="auto">{turn.message}</p>
        {turn.time_in_call_secs != null && (
          <p
            style={{
              fontSize: '10px',
              color: 'var(--text-muted)',
              marginTop: '4px',
              textAlign: isAgent ? 'left' : 'right',
            }}
          >
            {formatDuration(turn.time_in_call_secs)}
          </p>
        )}
      </div>
    </div>
  )
}

function AnalysisIcon({ value }: { value: string | null }) {
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower === 'yes' || lower === 'true' || lower === 'successful') {
    return <CheckCircle size={14} strokeWidth={1.5} style={{ color: 'var(--success)' }} />
  }
  if (lower === 'no' || lower === 'false' || lower === 'unsuccessful') {
    return <XCircle size={14} strokeWidth={1.5} style={{ color: 'var(--error)' }} />
  }
  return <AlertCircle size={14} strokeWidth={1.5} style={{ color: 'var(--warning)' }} />
}

export function CallDetail() {
  const { id } = useParams<{ id: string }>()
  const { data: call, isLoading, isError, error } = useCallDetail(id!)

  if (isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <Skeleton height="20px" width="120px" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '20px', alignItems: 'start' }}>
          <Card style={{ height: '500px' }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '16px', justifyContent: i % 2 ? 'flex-end' : 'flex-start' }}>
                <Skeleton width="200px" height="48px" borderRadius="12px" />
              </div>
            ))}
          </Card>
          <Card>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} style={{ marginBottom: '16px' }}>
                <Skeleton height="12px" width="60%" style={{ marginBottom: '6px' }} />
                <Skeleton height="16px" width="80%" />
              </div>
            ))}
          </Card>
        </div>
      </div>
    )
  }

  if (isError) {
    const is404 = (error as { status?: number })?.status === 404
    return (
      <div style={{ textAlign: 'center', padding: '64px 0' }}>
        <Phone size={36} strokeWidth={1} style={{ color: 'var(--text-disabled)', display: 'block', margin: '0 auto 16px' }} />
        <p style={{ fontSize: '16px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '8px' }}>
          {is404 ? 'Call not found' : 'Failed to load call'}
        </p>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' }}>
          {is404
            ? 'This call record does not exist or has been removed.'
            : 'Something went wrong. Please try again.'}
        </p>
        <Link to="/calls">
          <Button variant="secondary" size="sm">
            <ArrowLeft size={14} strokeWidth={1.5} /> Back to Calls
          </Button>
        </Link>
      </div>
    )
  }

  if (!call) return null

  const leadName = call.lead?.name ?? call.lead?.email ?? 'Unknown'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Back link */}
      <div>
        <Link
          to="/calls"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '13px',
            color: 'var(--text-secondary)',
            fontWeight: 600,
            transition: `color var(--duration-fast) var(--ease-standard)`,
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-primary)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-secondary)'
          }}
        >
          <ArrowLeft size={14} strokeWidth={1.5} />
          Back to Calls
        </Link>
      </div>

      {/* Verdict strip — what the agent knew, did, and proved (§4.1) */}
      {call.learnings && <VerdictStrip learnings={call.learnings} />}

      {/* Two-column layout */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 340px',
          gap: '20px',
          alignItems: 'start',
        }}
      >
        {/* Left: Transcript */}
        <Card padding="none" style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              padding: '16px 20px',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <h3
              style={{
                fontFamily: "'Montserrat', sans-serif",
                fontWeight: 700,
                fontSize: '12px',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-secondary)',
              }}
            >
              Transcript
            </h3>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {call.transcript.length} {call.transcript.length === 1 ? 'turn' : 'turns'}
            </span>
          </div>

          {call.learnings && <ToolCallStrip toolCalls={call.learnings.tool_calls} />}

          <div
            style={{
              flex: 1,
              padding: '20px',
              overflowY: 'auto',
              maxHeight: '560px',
            }}
            role="log"
            aria-label="Call transcript"
            aria-live="off"
          >
            {call.transcript.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', padding: '32px 0' }}>
                No transcript available for this call.
              </p>
            ) : (
              call.transcript.map((turn, idx) => (
                <TranscriptBubble key={idx} turn={turn} />
              ))
            )}
          </div>
        </Card>

        {/* Right: Metadata */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Lead info */}
          <Card>
            <h3
              style={{
                fontFamily: "'Montserrat', sans-serif",
                fontWeight: 700,
                fontSize: '11px',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
                marginBottom: '16px',
              }}
            >
              Lead
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <MetaRow label="Name" value={leadName} />
              {call.lead?.email && <MetaRow label="Email" value={call.lead.email} />}
              {call.lead?.phone && <MetaRow label="Phone" value={call.lead.phone} />}
              {call.lead?.status && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Status</span>
                  <Badge variant={statusToBadgeVariant(call.lead.status)}>{call.lead.status}</Badge>
                </div>
              )}
              {call.lead?.score != null && (
                <MetaRow label="Score" value={`${call.lead.score} / 100`} />
              )}
            </div>
          </Card>

          {/* Call info */}
          <Card>
            <h3
              style={{
                fontFamily: "'Montserrat', sans-serif",
                fontWeight: 700,
                fontSize: '11px',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
                marginBottom: '16px',
              }}
            >
              Call Details
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Status</span>
                <Badge variant={statusToBadgeVariant(call.status)}>{call.status}</Badge>
              </div>
              <MetaRow
                label="Duration"
                value={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Clock size={12} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
                    {formatDuration(call.duration_secs)}
                  </span>
                }
              />
              <MetaRow label="Date" value={formatDate(call.created_at)} />
            </div>
          </Card>

          {/* Qualification */}
          {call.qualification && (
            <Card>
              <h3
                style={{
                  fontFamily: "'Montserrat', sans-serif",
                  fontWeight: 700,
                  fontSize: '11px',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  marginBottom: '16px',
                }}
              >
                Qualification
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {call.qualification.status && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Result</span>
                    <Badge variant={statusToBadgeVariant(call.qualification.status)}>
                      {call.qualification.status}
                    </Badge>
                  </div>
                )}
                {call.qualification.company_name && (
                  <MetaRow label="Company" value={call.qualification.company_name} />
                )}
                {call.qualification.lead_primary_challenge && (
                  <MetaRow label="Challenge" value={call.qualification.lead_primary_challenge} />
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Follow-up</span>
                  <Badge variant={call.qualification.follow_up_scheduled ? 'success' : 'default'}>
                    {call.qualification.follow_up_scheduled ? 'Scheduled' : 'Not scheduled'}
                  </Badge>
                </div>
              </div>
            </Card>
          )}

          {/* Analysis */}
          {call.analysis && (
            <Card>
              <h3
                style={{
                  fontFamily: "'Montserrat', sans-serif",
                  fontWeight: 700,
                  fontSize: '11px',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  marginBottom: '16px',
                }}
              >
                AI Analysis
              </h3>
              {call.analysis.call_successful && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginBottom: '12px',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    backgroundColor: 'var(--bg-inset)',
                  }}
                >
                  <AnalysisIcon value={call.analysis.call_successful} />
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Call {call.analysis.call_successful}
                  </span>
                </div>
              )}
              {call.analysis.transcript_summary && (
                <p
                  dir="auto"
                  style={{
                    fontSize: '13px',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.65,
                  }}
                >
                  {call.analysis.transcript_summary}
                </p>
              )}
            </Card>
          )}

          {/* Sales Analysis — the worker's coaching read (§4.3) */}
          {call.learnings?.sales_analysis && (
            <SalesAnalysisCard analysis={call.learnings.sales_analysis} />
          )}
        </div>
      </div>

      {/* Audio player */}
      {call.audio_available && (
        <div
          style={{
            position: 'sticky',
            bottom: '0',
            backgroundColor: 'var(--glass-bg-solid)',
            borderTop: '1px solid var(--border-default)',
            padding: '12px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            borderRadius: '12px',
          }}
        >
          <Phone size={16} strokeWidth={1.5} style={{ color: 'var(--accent-teal)', flexShrink: 0 }} />
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>
            Call Recording
          </span>
          <audio
            controls
            src={`/api/v1/calls/${id}/audio`}
            style={{ flex: 1, height: '32px', minWidth: 0, colorScheme: 'dark' }}
            aria-label="Call recording audio player"
          >
            Your browser does not support the audio element.
          </audio>
        </div>
      )}
    </div>
  )
}

function MetaRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
      <span style={{ fontSize: '12px', color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '13px', color: 'var(--text-secondary)', textAlign: 'right', wordBreak: 'break-word' }}>
        {value}
      </span>
    </div>
  )
}
