import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, User, Bot, Clock, Phone, AlertCircle, CheckCircle, XCircle } from 'lucide-react'
import { useCallDetail } from '../hooks/useCallDetail.js'
import { Badge, statusToBadgeVariant } from '../components/ui/Badge.js'
import { Card } from '../components/ui/Card.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { Button } from '../components/ui/Button.js'
import { formatDate, formatDuration } from '../lib/format.js'
import type { TranscriptTurn } from '../lib/types.js'

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
          backgroundColor: isAgent ? 'rgba(0, 245, 255, 0.1)' : 'var(--bg-elevated)',
          border: `1px solid ${isAgent ? 'rgba(0, 245, 255, 0.25)' : 'var(--border-default)'}`,
          color: isAgent ? 'var(--accent-cyan)' : 'var(--text-secondary)',
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
          backgroundColor: isAgent ? 'rgba(0, 245, 255, 0.08)' : 'var(--bg-elevated)',
          border: `1px solid ${isAgent ? 'rgba(0, 245, 255, 0.15)' : 'var(--border-subtle)'}`,
          fontSize: '13px',
          lineHeight: 1.6,
          color: 'var(--text-primary)',
        }}
      >
        <p>{turn.message}</p>
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
        </div>
      </div>

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
