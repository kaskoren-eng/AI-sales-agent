import { useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft,
  User,
  Mail,
  Phone,
  Calendar as CalendarIcon,
  MessageCircle,
  Mic,
  Send,
  Inbox,
  Sparkles,
  UserPlus,
  Clock,
  PhoneCall,
} from 'lucide-react'
import { useLeadDetail, useUpdateLead } from '../hooks/useLeadDetail.js'
import { Badge, statusToBadgeVariant } from '../components/ui/Badge.js'
import { Card } from '../components/ui/Card.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { Button } from '../components/ui/Button.js'
import { formatDate } from '../lib/format.js'
import type {
  LeadTimelineResponse,
  LeadConversation,
  LeadMessage,
  LeadScheduledCall,
} from '../lib/types.js'

// -------------------------------------------------------------------------
// Status options — matches the state machine documented in keren-product-capabilities
// -------------------------------------------------------------------------
const STATUS_OPTIONS = [
  'new',
  'contacted',
  'qualifying',
  'qualified',
  'booked',
  'disqualified',
  'lost',
  'opted_out',
] as const

const CHANNEL_LABEL: Record<string, string> = {
  voice: 'Voice',
  whatsapp: 'WhatsApp',
  email: 'Email',
}

const SOURCE_LABEL: Record<string, string> = {
  meta_ads: 'Meta Ads',
  facebook: 'Facebook',
  google_sheets: 'Google Sheets',
  csv: 'CSV import',
  webhook: 'Webhook',
  api: 'API',
  voice_inbound: 'Inbound call',
}

// -------------------------------------------------------------------------
// Timeline event model — unified shape for anything we render on the feed
// -------------------------------------------------------------------------
type TimelineEvent =
  | { kind: 'lead_created'; at: string }
  | { kind: 'conversation_started'; at: string; conversation: LeadConversation }
  | {
      kind: 'message'
      at: string
      message: LeadMessage
      conversation: LeadConversation | null
    }
  | { kind: 'meeting_scheduled'; at: string; booking: LeadScheduledCall }
  | { kind: 'meeting_upcoming'; at: string; booking: LeadScheduledCall }

// -------------------------------------------------------------------------
// Page
// -------------------------------------------------------------------------
export function LeadDetail() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, isError, error } = useLeadDetail(id!)

  if (isLoading) return <LeadDetailSkeleton />

  if (isError) {
    const is404 = (error as { status?: number })?.status === 404
    return (
      <div style={{ textAlign: 'center', padding: '64px 0' }}>
        <User size={36} strokeWidth={1} style={{ color: 'var(--text-disabled)', display: 'block', margin: '0 auto 16px' }} />
        <p style={{ fontSize: '16px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '8px' }}>
          {is404 ? 'Lead not found' : 'Failed to load lead'}
        </p>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px' }}>
          {is404
            ? 'This lead does not exist or has been removed.'
            : 'Something went wrong. Please try again.'}
        </p>
        <Link to="/leads">
          <Button variant="secondary" size="sm">
            <ArrowLeft size={14} strokeWidth={1.5} /> Back to Leads
          </Button>
        </Link>
      </div>
    )
  }

  if (!data) return null

  return <LeadDetailContent data={data} />
}

// -------------------------------------------------------------------------
// Content
// -------------------------------------------------------------------------
function LeadDetailContent({ data }: { data: LeadTimelineResponse }) {
  const { lead, conversations, messages, scheduledCalls } = data
  const events = useMemo(() => buildTimeline(data), [data])
  const displayName = lead.name?.trim() || lead.email || lead.phone || 'Unnamed lead'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Back link */}
      <div>
        <Link
          to="/leads"
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
          Back to Leads
        </Link>
      </div>

      {/* Page header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
          <div
            aria-hidden="true"
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              backgroundColor: 'rgba(0, 245, 255, 0.12)',
              border: '1px solid rgba(0, 245, 255, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-cyan)',
              flexShrink: 0,
            }}
          >
            <User size={18} strokeWidth={1.5} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h1
              style={{
                fontFamily: "'Montserrat', sans-serif",
                fontWeight: 700,
                fontSize: '18px',
                color: 'var(--text-primary)',
                margin: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {displayName}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
              <Badge variant={statusToBadgeVariant(lead.status)}>{lead.status}</Badge>
              {lead.source && (
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  via {SOURCE_LABEL[lead.source] ?? lead.source}
                </span>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Updated {formatDate(lead.updatedAt)}
          </span>
        </div>
      </div>

      {/* 3-column layout */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '280px 1fr 320px',
          gap: '20px',
          alignItems: 'start',
        }}
      >
        {/* LEFT: Lead identity + editable status */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <LeadIdentityCard lead={lead} />
          <StatusEditor leadId={lead.id} currentStatus={lead.status} />
          <LeadMetadataCard lead={lead} />
        </div>

        {/* CENTER: Timeline */}
        <TimelineFeed events={events} />

        {/* RIGHT: Conversations summary + Bookings */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <ConversationsSummary conversations={conversations} messages={messages} />
          <BookingsCard bookings={scheduledCalls} />
        </div>
      </div>
    </div>
  )
}

// -------------------------------------------------------------------------
// LEFT column components
// -------------------------------------------------------------------------
function LeadIdentityCard({ lead }: { lead: LeadTimelineResponse['lead'] }) {
  return (
    <Card>
      <CardHeader label="Identity" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <MetaRow label="Name" value={lead.name ?? '—'} />
        <MetaRow
          label="Email"
          value={
            lead.email ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <Mail size={12} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
                {lead.email}
              </span>
            ) : (
              '—'
            )
          }
        />
        <MetaRow
          label="Phone"
          value={
            lead.phone ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <Phone size={12} strokeWidth={1.5} style={{ color: 'var(--text-muted)' }} />
                {lead.phone}
              </span>
            ) : (
              '—'
            )
          }
        />
        <MetaRow label="Score" value={lead.score != null ? `${lead.score} / 100` : '—'} />
        <MetaRow label="Created" value={formatDate(lead.createdAt)} />
      </div>
    </Card>
  )
}

function StatusEditor({ leadId, currentStatus }: { leadId: string; currentStatus: string }) {
  const [status, setStatus] = useState(currentStatus)
  const mutation = useUpdateLead(leadId)

  const dirty = status !== currentStatus

  return (
    <Card>
      <CardHeader label="Status" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          disabled={mutation.isPending}
          style={{
            height: '36px',
            backgroundColor: 'var(--bg-inset)',
            border: '1px solid var(--border-default)',
            borderRadius: '8px',
            padding: '0 32px 0 12px',
            color: 'var(--text-primary)',
            fontSize: '13px',
            fontFamily: "'Assistant', sans-serif",
            outline: 'none',
            cursor: mutation.isPending ? 'wait' : 'pointer',
            appearance: 'none',
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236B7280' stroke-width='1.5'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'right 10px center',
            width: '100%',
          }}
          aria-label="Lead status"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          size="sm"
          onClick={() => mutation.mutate({ status })}
          disabled={!dirty || mutation.isPending}
          style={{ width: '100%' }}
        >
          {mutation.isPending ? 'Saving…' : dirty ? 'Save change' : 'Saved'}
        </Button>
        {mutation.isError && (
          <p style={{ fontSize: '12px', color: 'var(--error)', margin: 0 }}>
            Failed to save. Try again.
          </p>
        )}
      </div>
    </Card>
  )
}

function LeadMetadataCard({ lead }: { lead: LeadTimelineResponse['lead'] }) {
  const meta = lead.metadata as Record<string, unknown> | null
  if (!meta || Object.keys(meta).length === 0) return null

  // Common qualification fields we surface if present — the rest fold into a "More" block
  const known = ['role', 'company', 'niche', 'business_type', 'budget', 'timeline']
  const knownRows = known
    .map((k) => [k, meta[k]] as const)
    .filter(([, v]) => v != null && v !== '')

  const rest = Object.entries(meta).filter(([k]) => !known.includes(k))

  if (knownRows.length === 0 && rest.length === 0) return null

  return (
    <Card>
      <CardHeader label="Extracted by agent" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {knownRows.map(([k, v]) => (
          <MetaRow key={k} label={humanizeKey(k)} value={String(v)} />
        ))}
        {rest.length > 0 && (
          <details style={{ marginTop: '4px' }}>
            <summary
              style={{
                cursor: 'pointer',
                fontSize: '12px',
                color: 'var(--text-muted)',
                fontWeight: 600,
              }}
            >
              More ({rest.length})
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
              {rest.map(([k, v]) => (
                <MetaRow key={k} label={humanizeKey(k)} value={String(v)} />
              ))}
            </div>
          </details>
        )}
      </div>
    </Card>
  )
}

// -------------------------------------------------------------------------
// CENTER: Timeline feed
// -------------------------------------------------------------------------
function TimelineFeed({ events }: { events: TimelineEvent[] }) {
  return (
    <Card padding="none" style={{ display: 'flex', flexDirection: 'column', minHeight: '480px' }}>
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
          Activity Timeline
        </h3>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </span>
      </div>

      <div style={{ padding: '20px', overflowY: 'auto', maxHeight: '680px', flex: 1 }}>
        {events.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 20px' }}>
            <Inbox
              size={28}
              strokeWidth={1}
              style={{ color: 'var(--text-disabled)', margin: '0 auto 12px', display: 'block' }}
            />
            <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              No activity yet. Once the agent reaches out, it will show up here.
            </p>
          </div>
        ) : (
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {events.map((event, idx) => (
              <TimelineItem
                key={`${event.kind}-${event.at}-${idx}`}
                event={event}
                isLast={idx === events.length - 1}
              />
            ))}
          </ol>
        )}
      </div>
    </Card>
  )
}

function TimelineItem({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
  const { icon, iconBg, iconBorder, iconColor, title, subtitle, body } = describeEvent(event)

  return (
    <li style={{ position: 'relative', paddingLeft: '32px', paddingBottom: isLast ? 0 : '20px' }}>
      {/* vertical connector line */}
      {!isLast && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '11px',
            top: '24px',
            bottom: '0',
            width: '1px',
            backgroundColor: 'var(--border-subtle)',
          }}
        />
      )}

      {/* icon dot */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          backgroundColor: iconBg,
          border: `1px solid ${iconBorder}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: iconColor,
        }}
      >
        {icon}
      </div>

      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '10px',
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            {title}
          </p>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
            {formatDate(event.at)}
          </span>
        </div>
        {subtitle && (
          <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
            {subtitle}
          </p>
        )}
        {body}
      </div>
    </li>
  )
}

// -------------------------------------------------------------------------
// RIGHT column components
// -------------------------------------------------------------------------
function ConversationsSummary({
  conversations,
  messages,
}: {
  conversations: LeadConversation[]
  messages: LeadMessage[]
}) {
  if (conversations.length === 0) {
    return (
      <Card>
        <CardHeader label="Conversations" />
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
          No conversations yet.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader label={`Conversations (${conversations.length})`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {conversations.map((c) => {
          const count = messages.filter((m) => m.conversationId === c.id).length
          const linkTo = c.channel === 'voice' ? `/calls/${c.id}` : null
          const content = (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                backgroundColor: 'var(--bg-inset)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                cursor: linkTo ? 'pointer' : 'default',
                transition: 'border-color var(--duration-fast) var(--ease-standard)',
              }}
            >
              <ChannelIcon channel={c.channel} size={14} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginBottom: '2px',
                  }}
                >
                  <span
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                    }}
                  >
                    {CHANNEL_LABEL[c.channel] ?? c.channel}
                  </span>
                  <Badge variant={statusToBadgeVariant(c.status)}>{c.status}</Badge>
                </div>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {count} {count === 1 ? 'message' : 'messages'} · {formatDate(c.updatedAt)}
                </span>
              </div>
            </div>
          )
          return linkTo ? (
            <Link
              key={c.id}
              to={linkTo}
              style={{ textDecoration: 'none' }}
              aria-label={`Open ${c.channel} conversation`}
            >
              {content}
            </Link>
          ) : (
            <div key={c.id}>{content}</div>
          )
        })}
      </div>
    </Card>
  )
}

function BookingsCard({ bookings }: { bookings: LeadScheduledCall[] }) {
  if (bookings.length === 0) {
    return (
      <Card>
        <CardHeader label="Meetings" />
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
          No meetings scheduled.
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader label={`Meetings (${bookings.length})`} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {bookings.map((b) => {
          const isFuture = new Date(b.scheduledAt).getTime() > Date.now()
          return (
            <div
              key={b.id}
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                backgroundColor: 'var(--bg-inset)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                  }}
                >
                  <CalendarIcon
                    size={12}
                    strokeWidth={1.5}
                    style={{ color: 'var(--accent-violet)' }}
                  />
                  {formatDate(b.scheduledAt)}
                </span>
                <Badge variant={statusToBadgeVariant(b.status)}>{b.status}</Badge>
              </div>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {b.duration ?? 30} min · {b.provider}
                {isFuture ? ' · upcoming' : ' · past'}
              </span>
              {b.notes && (
                <p
                  style={{
                    margin: '4px 0 0',
                    fontSize: '12px',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                  }}
                >
                  {b.notes}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// -------------------------------------------------------------------------
// Shared primitives (kept local — will be extracted in the Design System sprint)
// -------------------------------------------------------------------------
function CardHeader({ label }: { label: string }) {
  return (
    <h3
      style={{
        fontFamily: "'Montserrat', sans-serif",
        fontWeight: 700,
        fontSize: '11px',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        marginBottom: '14px',
        marginTop: 0,
      }}
    >
      {label}
    </h3>
  )
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}
    >
      <span style={{ fontSize: '12px', color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <span
        style={{
          fontSize: '13px',
          color: 'var(--text-secondary)',
          textAlign: 'right',
          wordBreak: 'break-word',
        }}
      >
        {value}
      </span>
    </div>
  )
}

function ChannelIcon({ channel, size = 12 }: { channel: string; size?: number }) {
  const { color, bg, border, Icon } = channelVisual(channel)
  return (
    <span
      aria-hidden="true"
      style={{
        width: '22px',
        height: '22px',
        borderRadius: '50%',
        backgroundColor: bg,
        border: `1px solid ${border}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color,
        flexShrink: 0,
      }}
    >
      <Icon size={size} strokeWidth={1.5} />
    </span>
  )
}

function LeadDetailSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <Skeleton height="20px" width="120px" />
      <Skeleton height="40px" width="280px" />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '280px 1fr 320px',
          gap: '20px',
          alignItems: 'start',
        }}
      >
        <Card style={{ height: '280px' }}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} style={{ marginBottom: '14px' }}>
              <Skeleton height="12px" width="40%" style={{ marginBottom: '6px' }} />
              <Skeleton height="14px" width="80%" />
            </div>
          ))}
        </Card>
        <Card style={{ height: '480px' }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ display: 'flex', gap: '10px', marginBottom: '16px' }}>
              <Skeleton width="24px" height="24px" borderRadius="50%" />
              <div style={{ flex: 1 }}>
                <Skeleton height="12px" width="40%" style={{ marginBottom: '6px' }} />
                <Skeleton height="14px" width="70%" />
              </div>
            </div>
          ))}
        </Card>
        <Card style={{ height: '280px' }}>
          {[1, 2].map((i) => (
            <div key={i} style={{ marginBottom: '14px' }}>
              <Skeleton height="14px" width="60%" style={{ marginBottom: '6px' }} />
              <Skeleton height="12px" width="90%" />
            </div>
          ))}
        </Card>
      </div>
    </div>
  )
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------
function buildTimeline(data: LeadTimelineResponse): TimelineEvent[] {
  const events: TimelineEvent[] = []
  const convoMap = new Map(data.conversations.map((c) => [c.id, c]))

  // Lead creation is always the origin event
  events.push({ kind: 'lead_created', at: data.lead.createdAt })

  // Conversation-start events
  for (const c of data.conversations) {
    events.push({ kind: 'conversation_started', at: c.createdAt, conversation: c })
  }

  // Every message becomes a timeline event; the timeline may look busy for voice calls
  // (dozens of transcript lines) so we skip content_type='transcript' — those are viewable
  // in the dedicated Call page. WhatsApp/email content stays inline.
  for (const m of data.messages) {
    if (m.contentType === 'transcript') continue
    events.push({
      kind: 'message',
      at: m.createdAt,
      message: m,
      conversation: convoMap.get(m.conversationId) ?? null,
    })
  }

  // Each meeting produces two events: the moment it was booked, and the meeting time itself
  for (const b of data.scheduledCalls) {
    events.push({ kind: 'meeting_scheduled', at: b.createdAt, booking: b })
    events.push({ kind: 'meeting_upcoming', at: b.scheduledAt, booking: b })
  }

  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  return events
}

function channelVisual(channel: string): {
  color: string
  bg: string
  border: string
  Icon: typeof Mic
} {
  switch (channel) {
    case 'voice':
      return {
        color: 'var(--accent-cyan)',
        bg: 'rgba(0, 245, 255, 0.10)',
        border: 'rgba(0, 245, 255, 0.30)',
        Icon: Mic,
      }
    case 'whatsapp':
      return {
        color: '#25D366',
        bg: 'rgba(37, 211, 102, 0.12)',
        border: 'rgba(37, 211, 102, 0.30)',
        Icon: MessageCircle,
      }
    case 'email':
      return {
        color: 'var(--info)',
        bg: 'rgba(59, 130, 246, 0.12)',
        border: 'rgba(59, 130, 246, 0.30)',
        Icon: Mail,
      }
    default:
      return {
        color: 'var(--text-muted)',
        bg: 'var(--bg-inset)',
        border: 'var(--border-default)',
        Icon: MessageCircle,
      }
  }
}

function describeEvent(event: TimelineEvent): {
  icon: React.ReactNode
  iconBg: string
  iconBorder: string
  iconColor: string
  title: string
  subtitle: string | null
  body: React.ReactNode
} {
  switch (event.kind) {
    case 'lead_created':
      return {
        icon: <UserPlus size={12} strokeWidth={1.5} />,
        iconBg: 'rgba(99, 102, 241, 0.12)',
        iconBorder: 'rgba(99, 102, 241, 0.30)',
        iconColor: 'var(--accent-violet)',
        title: 'Lead created',
        subtitle: 'Entered the system',
        body: null,
      }
    case 'conversation_started': {
      const c = event.conversation
      const viz = channelVisual(c.channel)
      return {
        icon: <viz.Icon size={12} strokeWidth={1.5} />,
        iconBg: viz.bg,
        iconBorder: viz.border,
        iconColor: viz.color,
        title: `${CHANNEL_LABEL[c.channel] ?? c.channel} conversation started`,
        subtitle: c.summary ?? null,
        body: null,
      }
    }
    case 'message': {
      const m = event.message
      const c = event.conversation
      const channel = c?.channel ?? 'unknown'
      const viz = channelVisual(channel)
      const isOut = m.direction === 'outbound'
      return {
        icon: isOut ? <Send size={12} strokeWidth={1.5} /> : <Inbox size={12} strokeWidth={1.5} />,
        iconBg: viz.bg,
        iconBorder: viz.border,
        iconColor: viz.color,
        title: `${isOut ? 'Sent' : 'Received'} · ${CHANNEL_LABEL[channel] ?? channel}`,
        subtitle: null,
        body: (
          <p
            style={{
              margin: '6px 0 0',
              fontSize: '13px',
              color: 'var(--text-secondary)',
              lineHeight: 1.55,
              padding: '8px 10px',
              backgroundColor: 'var(--bg-inset)',
              borderRadius: '6px',
              border: '1px solid var(--border-subtle)',
              whiteSpace: 'pre-wrap',
              dir: 'auto',
            }}
            dir="auto"
          >
            {m.content}
          </p>
        ),
      }
    }
    case 'meeting_scheduled': {
      const b = event.booking
      return {
        icon: <Sparkles size={12} strokeWidth={1.5} />,
        iconBg: 'rgba(99, 102, 241, 0.12)',
        iconBorder: 'rgba(99, 102, 241, 0.30)',
        iconColor: 'var(--accent-violet)',
        title: 'Meeting booked',
        subtitle: `Scheduled for ${formatDate(b.scheduledAt)} · ${b.duration ?? 30} min`,
        body: null,
      }
    }
    case 'meeting_upcoming': {
      const b = event.booking
      const isPast = new Date(event.at).getTime() < Date.now()
      return {
        icon: isPast ? (
          <PhoneCall size={12} strokeWidth={1.5} />
        ) : (
          <Clock size={12} strokeWidth={1.5} />
        ),
        iconBg: 'rgba(0, 245, 255, 0.10)',
        iconBorder: 'rgba(0, 245, 255, 0.30)',
        iconColor: 'var(--accent-cyan)',
        title: isPast ? 'Meeting time (past)' : 'Meeting upcoming',
        subtitle: `${b.provider} · ${b.duration ?? 30} min`,
        body: null,
      }
    }
  }
}

function humanizeKey(k: string): string {
  return k.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
