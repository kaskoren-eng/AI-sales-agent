import { useQuery } from '@tanstack/react-query'
import { Users, Phone, CalendarDays, MessageSquare, ArrowRight } from 'lucide-react'
import { StatCard } from '../components/ui/StatCard.js'
import { Card } from '../components/ui/Card.js'
import { Badge, statusToBadgeVariant } from '../components/ui/Badge.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { fetchLeads, fetchCalls } from '../lib/api.js'
import { formatDate } from '../lib/format.js'
import { Link } from 'react-router-dom'

interface PipelineStage {
  label: string
  count: number
}

const PIPELINE_STAGES: PipelineStage[] = [
  { label: 'Sourced', count: 0 },
  { label: 'Researched', count: 0 },
  { label: 'Qualified', count: 0 },
  { label: 'Engaged', count: 0 },
  { label: 'Booked', count: 0 },
]

function buildPipelineFromLeads(leads: { status: string }[]): PipelineStage[] {
  const counts = { Sourced: 0, Researched: 0, Qualified: 0, Engaged: 0, Booked: 0 }
  for (const lead of leads) {
    switch (lead.status?.toLowerCase()) {
      case 'new':
        counts.Sourced++
        break
      case 'contacted':
        counts.Researched++
        break
      case 'qualified':
        counts.Qualified++
        break
      case 'engaged':
        counts.Engaged++
        break
      case 'booked':
        counts.Booked++
        break
    }
  }
  return PIPELINE_STAGES.map((s) => ({ ...s, count: counts[s.label as keyof typeof counts] }))
}

export function Overview() {
  const {
    data: leadsData,
    isLoading: leadsLoading,
    isError: leadsError,
  } = useQuery({
    queryKey: ['leads', { limit: 100 }],
    queryFn: () => fetchLeads({ limit: 100 }),
    staleTime: 60_000,
  })

  const {
    data: callsData,
    isLoading: callsLoading,
    isError: callsError,
  } = useQuery({
    queryKey: ['calls', { limit: 5 }],
    queryFn: () => fetchCalls({ limit: 5 }),
    staleTime: 60_000,
  })

  const totalLeads = leadsData?.meta.total ?? 0
  const qualifiedCount = leadsData?.data.filter((l) => l.status === 'qualified').length ?? 0
  const bookedCount = leadsData?.data.filter((l) => l.status === 'booked').length ?? 0
  const totalCalls = callsData?.meta.total ?? 0

  const pipeline = leadsData ? buildPipelineFromLeads(leadsData.data) : PIPELINE_STAGES
  const maxPipelineCount = Math.max(...pipeline.map((s) => s.count), 1)

  const recentCalls = callsData?.data ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>

      {/* KPI Cards */}
      <section aria-label="Key performance indicators">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '16px',
          }}
        >
          <StatCard
            icon={<Users size={20} strokeWidth={1.5} />}
            label="Total Leads"
            value={leadsLoading ? '—' : totalLeads.toLocaleString()}
            loading={leadsLoading}
            accentColor="var(--accent-violet)"
          />
          <StatCard
            icon={<Users size={20} strokeWidth={1.5} />}
            label="Qualified Leads"
            value={leadsLoading ? '—' : qualifiedCount.toLocaleString()}
            loading={leadsLoading}
            accentColor="var(--success)"
          />
          <StatCard
            icon={<CalendarDays size={20} strokeWidth={1.5} />}
            label="Calls Booked"
            value={leadsLoading ? '—' : bookedCount.toLocaleString()}
            loading={leadsLoading}
            accentColor="var(--accent-teal)"
          />
          <StatCard
            icon={<MessageSquare size={20} strokeWidth={1.5} />}
            label="Total Calls"
            value={callsLoading ? '—' : totalCalls.toLocaleString()}
            loading={callsLoading}
            accentColor="var(--warning)"
          />
        </div>
      </section>

      {/* Pipeline visualizer */}
      <section aria-label="Lead pipeline stages">
        <Card>
          <h3
            style={{
              fontFamily: "'Montserrat', sans-serif",
              fontWeight: 700,
              fontSize: '12px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
              marginBottom: '20px',
            }}
          >
            Pipeline
          </h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: '12px',
            }}
            role="list"
            aria-label="Pipeline stages"
          >
            {pipeline.map((stage, idx) => {
              const heightPct = maxPipelineCount > 0 ? (stage.count / maxPipelineCount) * 100 : 0
              const isLast = idx === pipeline.length - 1
              return (
                <div
                  key={stage.label}
                  role="listitem"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '8px',
                    position: 'relative',
                  }}
                >
                  {/* Connector arrow */}
                  {!isLast && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        right: '-10px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        color: 'var(--text-disabled)',
                        zIndex: 1,
                        fontSize: '12px',
                      }}
                    >
                      ›
                    </span>
                  )}

                  {/* Count */}
                  <span
                    style={{
                      fontFamily: "'Montserrat', sans-serif",
                      fontWeight: 700,
                      fontSize: '22px',
                      color: 'var(--text-primary)',
                    }}
                    aria-label={`${stage.count} leads`}
                  >
                    {leadsLoading ? (
                      <Skeleton width="40px" height="22px" />
                    ) : (
                      stage.count
                    )}
                  </span>

                  {/* Bar */}
                  <div
                    style={{
                      width: '100%',
                      height: '6px',
                      borderRadius: '3px',
                      backgroundColor: 'var(--bg-inset)',
                      overflow: 'hidden',
                    }}
                    aria-hidden="true"
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${heightPct}%`,
                        borderRadius: '3px',
                        backgroundColor: 'var(--accent-violet)',
                        transition: 'width var(--duration-slow) var(--ease-standard)',
                      }}
                    />
                  </div>

                  {/* Label */}
                  <span
                    style={{
                      fontSize: '11px',
                      color: 'var(--text-muted)',
                      textAlign: 'center',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {stage.label}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      </section>

      {/* Recent activity */}
      <section aria-label="Recent calls">
        <Card padding="none">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid var(--border-subtle)',
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
              Recent Calls
            </h3>
            <Link
              to="/calls"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '12px',
                color: 'var(--accent-teal)',
                fontWeight: 600,
              }}
            >
              View all <ArrowRight size={13} strokeWidth={1.5} />
            </Link>
          </div>

          {callsLoading && (
            <div style={{ padding: '20px' }}>
              {[1, 2, 3].map((i) => (
                <div key={i} style={{ display: 'flex', gap: '16px', marginBottom: '16px', alignItems: 'center' }}>
                  <Skeleton width="120px" height="14px" />
                  <Skeleton width="70px" height="20px" borderRadius="9999px" />
                  <Skeleton width="60px" height="14px" />
                  <Skeleton width="120px" height="14px" />
                </div>
              ))}
            </div>
          )}

          {callsError && (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '14px' }}>
              Could not load recent calls.
            </div>
          )}

          {!callsLoading && !callsError && recentCalls.length === 0 && (
            <div style={{ padding: '48px 20px', textAlign: 'center' }}>
              <Phone size={28} strokeWidth={1} style={{ color: 'var(--text-disabled)', marginBottom: '12px' }} />
              <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>No calls yet</p>
            </div>
          )}

          {!callsLoading && !callsError && recentCalls.length > 0 && (
            <table
              style={{ width: '100%', borderCollapse: 'collapse' }}
              aria-label="Recent calls"
            >
              <thead>
                <tr>
                  {['Lead', 'Status', 'Duration', 'Date'].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      style={{
                        padding: '10px 20px',
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textAlign: 'left',
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentCalls.map((call) => (
                  <tr
                    key={call.id}
                    style={{
                      borderBottom: '1px solid var(--border-subtle)',
                      transition: `background-color var(--duration-fast) var(--ease-standard)`,
                    }}
                    onMouseEnter={(e) => {
                      ;(e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--glass-hover)'
                    }}
                    onMouseLeave={(e) => {
                      ;(e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent'
                    }}
                  >
                    <td style={{ padding: '12px 20px', fontSize: '13px', color: 'var(--text-primary)' }}>
                      {call.lead?.name ?? call.lead?.email ?? 'Unknown'}
                    </td>
                    <td style={{ padding: '12px 20px' }}>
                      <Badge variant={statusToBadgeVariant(call.status)}>{call.status}</Badge>
                    </td>
                    <td style={{ padding: '12px 20px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                      {call.duration_secs != null
                        ? `${Math.floor(call.duration_secs / 60)}m ${call.duration_secs % 60}s`
                        : '—'}
                    </td>
                    <td style={{ padding: '12px 20px', fontSize: '13px', color: 'var(--text-muted)' }}>
                      {formatDate(call.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>

      {leadsError && (
        <p role="alert" style={{ fontSize: '13px', color: 'var(--error)' }}>
          Could not load lead metrics.
        </p>
      )}
    </div>
  )
}
