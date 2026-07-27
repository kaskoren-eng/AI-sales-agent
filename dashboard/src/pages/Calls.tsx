import { useState, useId } from 'react'
import { Phone, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useCallsList } from '../hooks/useCallsList.js'
import { Badge, statusToBadgeVariant } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'
import { Card } from '../components/ui/Card.js'
import { TableSkeleton } from '../components/ui/Skeleton.js'
import { formatDate, formatDuration } from '../lib/format.js'

const STATUS_OPTIONS = ['', 'done', 'in_progress', 'failed']
const QUALIFICATION_OPTIONS = ['', 'qualified', 'not_qualified', 'unknown']
const LIMIT = 20

export function Calls() {
  const [status, setStatus] = useState('')
  const [qualification, setQualification] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  const statusId = useId()
  const qualId = useId()
  const fromId = useId()
  const toId = useId()

  const { data, isLoading, isError } = useCallsList({
    status: status || undefined,
    qualification: qualification || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
    limit: LIMIT,
  })

  const calls = data?.data ?? []
  const meta = data?.meta
  const totalPages = meta?.total_pages ?? 1

  const inputStyle: React.CSSProperties = {
    height: '36px',
    backgroundColor: 'var(--glass-bg-solid)',
    border: '1px solid var(--border-default)',
    borderRadius: '8px',
    padding: '0 12px',
    color: 'var(--text-primary)',
    fontSize: '13px',
    fontFamily: "'Assistant', sans-serif",
    outline: 'none',
    cursor: 'pointer',
    colorScheme: 'dark',
  }

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    paddingRight: '32px',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236B7280' stroke-width='1.5'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 10px center',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Filter bar */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}
        role="search"
        aria-label="Filter calls"
      >
        <label htmlFor={statusId} className="sr-only">Filter by status</label>
        <select
          id={statusId}
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1) }}
          style={selectStyle}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.filter(Boolean).map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>

        <label htmlFor={qualId} className="sr-only">Filter by qualification</label>
        <select
          id={qualId}
          value={qualification}
          onChange={(e) => { setQualification(e.target.value); setPage(1) }}
          style={selectStyle}
        >
          <option value="">All qualifications</option>
          {QUALIFICATION_OPTIONS.filter(Boolean).map((q) => (
            <option key={q} value={q}>{q.replace('_', ' ')}</option>
          ))}
        </select>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <label htmlFor={fromId} className="sr-only">From date</label>
          <input
            id={fromId}
            type="date"
            value={from}
            onChange={(e) => { setFrom(e.target.value); setPage(1) }}
            style={inputStyle}
            aria-label="From date"
          />
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>to</span>
          <label htmlFor={toId} className="sr-only">To date</label>
          <input
            id={toId}
            type="date"
            value={to}
            onChange={(e) => { setTo(e.target.value); setPage(1) }}
            style={inputStyle}
            aria-label="To date"
          />
        </div>

        {meta && (
          <span style={{ fontSize: '13px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {meta.total.toLocaleString()} {meta.total === 1 ? 'call' : 'calls'}
          </span>
        )}
      </div>

      {/* Table */}
      <Card padding="none">
        {isError && (
          <div
            role="alert"
            style={{ padding: '32px', textAlign: 'center', color: 'var(--error)', fontSize: '14px' }}
          >
            Failed to load calls. Please try again.
          </div>
        )}

        {!isError && (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{ width: '100%', borderCollapse: 'collapse', minWidth: '580px' }}
              aria-label="Calls table"
              aria-busy={isLoading}
            >
              <thead>
                <tr>
                  {['Lead', 'Status', 'Qualification', 'Duration', 'Date', 'Actions'].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      style={{
                        padding: '10px 16px',
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textAlign: 'left',
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                        borderBottom: '1px solid var(--border-subtle)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <TableSkeleton rows={8} cols={6} />
                ) : calls.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: '64px 20px', textAlign: 'center' }}>
                      <Phone size={32} strokeWidth={1} style={{ color: 'var(--text-disabled)', display: 'block', margin: '0 auto 12px' }} />
                      <p style={{ fontSize: '15px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '6px' }}>
                        No calls found
                      </p>
                      <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        Calls will appear here once the voice channel is connected.
                      </p>
                    </td>
                  </tr>
                ) : (
                  calls.map((call) => (
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
                      <td style={{ padding: '13px 16px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {call.lead?.name ?? call.lead?.email ?? 'Unknown'}
                        </span>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Badge variant={statusToBadgeVariant(call.status)}>{call.status}</Badge>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        {call.qualification?.status ? (
                          <Badge variant={statusToBadgeVariant(call.qualification.status)}>
                            {call.qualification.status}
                          </Badge>
                        ) : (
                          <span style={{ fontSize: '13px', color: 'var(--text-disabled)' }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '13px 16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        {formatDuration(call.duration_secs)}
                      </td>
                      <td style={{ padding: '13px 16px', fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {formatDate(call.created_at)}
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Link to={`/calls/${call.id}`} aria-label={`View call detail for ${call.lead?.name ?? 'this call'}`}>
                          <Button variant="ghost" size="sm" style={{ fontSize: '12px', color: 'var(--accent-teal)', gap: '4px' }}>
                            <ExternalLink size={12} strokeWidth={1.5} /> View
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Pagination */}
      {!isLoading && !isError && calls.length > 0 && totalPages > 1 && (
        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '4px' }}
          aria-label="Pagination"
        >
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            Page {page} of {totalPages}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} strokeWidth={1.5} /> Prev
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              aria-label="Next page"
            >
              Next <ChevronRight size={14} strokeWidth={1.5} />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
