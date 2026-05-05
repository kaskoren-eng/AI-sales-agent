import { useState, useId } from 'react'
import { Users, Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { useLeadsList } from '../hooks/useLeadsList.js'
import { Badge, statusToBadgeVariant } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'
import { Card } from '../components/ui/Card.js'
import { TableSkeleton } from '../components/ui/Skeleton.js'
import { formatDate } from '../lib/format.js'

const STATUS_OPTIONS = ['', 'new', 'contacted', 'qualified', 'booked', 'lost']
const LIMIT = 20

const channelLabel: Record<string, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
  voice: 'Voice',
  meta_ads: 'Meta Ads',
  csv: 'CSV',
}

function ScoreBar({ score }: { score: number | null }) {
  if (score == null) {
    return <span style={{ fontSize: '13px', color: 'var(--text-disabled)' }}>—</span>
  }
  const color =
    score >= 70 ? 'var(--success)' : score >= 40 ? 'var(--warning)' : 'var(--error)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <div
        style={{
          flex: 1,
          height: '4px',
          borderRadius: '2px',
          backgroundColor: 'var(--bg-inset)',
          overflow: 'hidden',
          maxWidth: '60px',
        }}
        aria-hidden="true"
      >
        <div
          style={{
            height: '100%',
            width: `${score}%`,
            borderRadius: '2px',
            backgroundColor: color,
          }}
        />
      </div>
      <span style={{ fontSize: '12px', color, fontWeight: 600, minWidth: '28px' }}>{score}</span>
    </div>
  )
}

export function Leads() {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)

  const searchId = useId()
  const statusId = useId()

  // Debounce search input effect
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const handleSearch = (val: string) => {
    setSearch(val)
    clearTimeout((window as unknown as Record<string, number>)['_leadSearchTimer'])
    ;(window as unknown as Record<string, number>)['_leadSearchTimer'] = setTimeout(() => {
      setDebouncedSearch(val)
      setPage(1)
    }, 350)
  }

  const { data, isLoading, isError } = useLeadsList({
    status: status || undefined,
    search: debouncedSearch || undefined,
    page,
    limit: LIMIT,
  })

  const leads = data?.data ?? []
  const meta = data?.meta
  const totalPages = meta?.total_pages ?? 1

  const handleStatusChange = (val: string) => {
    setStatus(val)
    setPage(1)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Filter bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          flexWrap: 'wrap',
        }}
        role="search"
        aria-label="Filter leads"
      >
        {/* Search */}
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: '360px' }}>
          <label htmlFor={searchId} className="sr-only">Search leads</label>
          <Search
            size={15}
            strokeWidth={1.5}
            style={{
              position: 'absolute',
              left: '11px',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
              pointerEvents: 'none',
            }}
            aria-hidden="true"
          />
          <input
            id={searchId}
            type="search"
            placeholder="Search name, email, phone..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            style={{
              width: '100%',
              height: '36px',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              borderRadius: '8px',
              padding: '0 12px 0 36px',
              color: 'var(--text-primary)',
              fontSize: '13px',
              fontFamily: "'Assistant', sans-serif",
              outline: 'none',
            }}
          />
        </div>

        {/* Status filter */}
        <div>
          <label htmlFor={statusId} className="sr-only">Filter by status</label>
          <select
            id={statusId}
            value={status}
            onChange={(e) => handleStatusChange(e.target.value)}
            style={{
              height: '36px',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              borderRadius: '8px',
              padding: '0 32px 0 12px',
              color: status ? 'var(--text-primary)' : 'var(--text-muted)',
              fontSize: '13px',
              fontFamily: "'Assistant', sans-serif",
              outline: 'none',
              cursor: 'pointer',
              appearance: 'none',
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236B7280' stroke-width='1.5'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 10px center',
            }}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.filter(Boolean).map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>

        {meta && (
          <span style={{ fontSize: '13px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
            {meta.total.toLocaleString()} {meta.total === 1 ? 'lead' : 'leads'}
          </span>
        )}
      </div>

      {/* Table */}
      <Card padding="none">
        {isError && (
          <div
            role="alert"
            style={{
              padding: '32px',
              textAlign: 'center',
              color: 'var(--error)',
              fontSize: '14px',
            }}
          >
            Failed to load leads. Please try again.
          </div>
        )}

        {!isError && (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{ width: '100%', borderCollapse: 'collapse', minWidth: '640px' }}
              aria-label="Leads table"
              aria-busy={isLoading}
            >
              <thead>
                <tr>
                  {['Name', 'Contact', 'Channel', 'Status', 'Score', 'Last Activity', 'Actions'].map((h) => (
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
                  <TableSkeleton rows={8} cols={7} />
                ) : leads.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: '64px 20px', textAlign: 'center' }}>
                      <Users size={32} strokeWidth={1} style={{ color: 'var(--text-disabled)', marginBottom: '12px', display: 'block', margin: '0 auto 12px' }} />
                      <p style={{ fontSize: '15px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '6px' }}>
                        No leads yet
                      </p>
                      <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        Connect a channel to start receiving leads.
                      </p>
                    </td>
                  </tr>
                ) : (
                  leads.map((lead) => (
                    <tr
                      key={lead.id}
                      style={{
                        borderBottom: '1px solid var(--border-subtle)',
                        transition: `background-color var(--duration-fast) var(--ease-standard)`,
                      }}
                      onMouseEnter={(e) => {
                        ;(e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--bg-elevated)'
                      }}
                      onMouseLeave={(e) => {
                        ;(e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent'
                      }}
                    >
                      <td style={{ padding: '13px 16px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {lead.name ?? '—'}
                        </span>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          {lead.email && (
                            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                              {lead.email}
                            </span>
                          )}
                          {lead.phone && (
                            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                              {lead.phone}
                            </span>
                          )}
                          {!lead.email && !lead.phone && (
                            <span style={{ fontSize: '12px', color: 'var(--text-disabled)' }}>—</span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        {lead.channel ? (
                          <Badge variant="default">
                            {channelLabel[lead.channel] ?? lead.channel}
                          </Badge>
                        ) : (
                          <span style={{ fontSize: '13px', color: 'var(--text-disabled)' }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Badge variant={statusToBadgeVariant(lead.status)}>
                          {lead.status}
                        </Badge>
                      </td>
                      <td style={{ padding: '13px 16px', minWidth: '100px' }}>
                        <ScoreBar score={lead.score} />
                      </td>
                      <td style={{ padding: '13px 16px', fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {formatDate(lead.lastActivityAt ?? lead.updatedAt)}
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`View details for ${lead.name ?? 'lead'}`}
                          style={{ fontSize: '12px', color: 'var(--accent-cyan)' }}
                        >
                          View
                        </Button>
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
      {!isLoading && !isError && leads.length > 0 && totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: '4px',
          }}
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
