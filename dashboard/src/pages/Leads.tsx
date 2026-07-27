import { useState, useId } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Users, Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { useLeadsList } from '../hooks/useLeadsList.js'
import { Badge, statusToBadgeVariant } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'
import { Card } from '../components/ui/Card.js'
import { Input } from '../components/ui/Input.js'
import { Select } from '../components/ui/Select.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { Bidi } from '../components/ui/Bidi.js'
import { TableSkeleton } from '../components/ui/Skeleton.js'
import { formatDate } from '../lib/format.js'

const STATUS_OPTIONS = ['new', 'contacted', 'qualified', 'booked', 'lost']
const LIMIT = 20

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
  const { t } = useTranslation()
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

  const columns: Array<{ key: string; label: string }> = [
    { key: 'name', label: t('leads.columns.name') },
    { key: 'contact', label: t('leads.columns.contact') },
    { key: 'channel', label: t('leads.columns.channel') },
    { key: 'status', label: t('leads.columns.status') },
    { key: 'score', label: t('leads.columns.score') },
    { key: 'lastActivity', label: t('leads.columns.lastActivity') },
    { key: 'actions', label: t('leads.columns.actions') },
  ]

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
        aria-label={t('leads.filterLeads')}
      >
        {/* Search */}
        <div style={{ flex: '1 1 220px', maxWidth: '360px' }}>
          <label htmlFor={searchId} className="sr-only">{t('leads.searchLabel')}</label>
          <Input
            id={searchId}
            type="search"
            placeholder={t('leads.searchPlaceholder')}
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            startIcon={<Search size={15} strokeWidth={1.5} />}
            style={{ height: '36px', backgroundColor: 'var(--glass-bg-solid)', fontSize: '13px' }}
          />
        </div>

        {/* Status filter */}
        <div>
          <label htmlFor={statusId} className="sr-only">{t('leads.statusLabel')}</label>
          <Select
            id={statusId}
            fullWidth={false}
            value={status}
            onChange={(e) => handleStatusChange(e.target.value)}
            aria-label={t('leads.statusLabel')}
            placeholder={t('leads.allStatuses')}
            options={STATUS_OPTIONS.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            style={{
              height: '36px',
              backgroundColor: 'var(--glass-bg-solid)',
              fontSize: '13px',
              color: status ? 'var(--text-primary)' : 'var(--text-muted)',
            }}
          />
        </div>

        {meta && (
          <span style={{ fontSize: '13px', color: 'var(--text-muted)', marginInlineStart: 'auto' }}>
            {t('leads.count', { count: meta.total, formattedCount: meta.total.toLocaleString() })}
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
            {t('leads.loadError')}
          </div>
        )}

        {!isError && (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{ width: '100%', borderCollapse: 'collapse', minWidth: '640px' }}
              aria-label={t('leads.tableLabel')}
              aria-busy={isLoading}
            >
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      scope="col"
                      style={{
                        padding: '10px 16px',
                        fontSize: '11px',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textAlign: 'start',
                        letterSpacing: '0.05em',
                        textTransform: 'uppercase',
                        borderBottom: '1px solid var(--border-subtle)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <TableSkeleton rows={8} cols={7} />
                ) : leads.length === 0 ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 0 }}>
                      <EmptyState
                        style={{ padding: '64px 20px' }}
                        icon={<Users size={32} strokeWidth={1} />}
                        title={t('leads.emptyTitle')}
                        description={t('leads.emptyDescription')}
                      />
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
                        ;(e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--glass-hover)'
                      }}
                      onMouseLeave={(e) => {
                        ;(e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent'
                      }}
                    >
                      <td style={{ padding: '13px 16px' }}>
                        <Bidi style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {lead.name ?? '—'}
                        </Bidi>
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
                            {t(`channels.${lead.channel}`, { defaultValue: lead.channel })}
                          </Badge>
                        ) : (
                          <span style={{ fontSize: '13px', color: 'var(--text-disabled)' }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Badge variant={statusToBadgeVariant(lead.status)}>
                          {t(`status.${lead.status}`, { defaultValue: lead.status })}
                        </Badge>
                      </td>
                      <td style={{ padding: '13px 16px', minWidth: '100px' }}>
                        <ScoreBar score={lead.score} />
                      </td>
                      <td style={{ padding: '13px 16px', fontSize: '12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        <Bidi>{formatDate(lead.lastActivityAt ?? lead.updatedAt)}</Bidi>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Link
                          to={`/leads/${lead.id}`}
                          aria-label={t('leads.viewDetails', { name: lead.name ?? t('leads.columns.name') })}
                          style={{ textDecoration: 'none' }}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            style={{ fontSize: '12px', color: 'var(--accent-teal)' }}
                          >
                            {t('leads.view')}
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
      {!isLoading && !isError && leads.length > 0 && totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: '4px',
          }}
          aria-label={t('leads.pagination.label')}
        >
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {t('leads.pagination.pageOf', { page, total: totalPages })}
          </span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              aria-label={t('leads.pagination.previousPage')}
            >
              <ChevronLeft size={14} strokeWidth={1.5} className="flip-rtl" /> {t('leads.pagination.prev')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              aria-label={t('leads.pagination.nextPage')}
            >
              {t('leads.pagination.next')} <ChevronRight size={14} strokeWidth={1.5} className="flip-rtl" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
