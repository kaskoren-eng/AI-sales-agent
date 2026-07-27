import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import { CalendarDays } from 'lucide-react'
import { fetchBookings } from '../lib/api.js'
import { Badge, statusToBadgeVariant } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'
import { Card } from '../components/ui/Card.js'
import { Modal } from '../components/ui/Modal.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { Bidi } from '../components/ui/Bidi.js'
import { TableSkeleton } from '../components/ui/Skeleton.js'
import { formatDate } from '../lib/format.js'
import { apiFetch } from '../lib/apiClient.js'
import type { Booking } from '../lib/types.js'

export function Bookings() {
  const { t } = useTranslation()
  const [cancelTarget, setCancelTarget] = useState<Booking | null>(null)
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['bookings'],
    queryFn: fetchBookings,
    staleTime: 30_000,
  })

  const cancelMutation = useMutation({
    mutationFn: (bookingId: string) =>
      apiFetch(`/scheduling/bookings/${bookingId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bookings'] })
      setCancelTarget(null)
    },
  })

  const bookings = data?.data ?? []

  const columns: Array<{ key: string; label: string }> = [
    { key: 'lead', label: t('bookings.columns.lead') },
    { key: 'dateTime', label: t('bookings.columns.dateTime') },
    { key: 'status', label: t('bookings.columns.status') },
    { key: 'provider', label: t('bookings.columns.provider') },
    { key: 'actions', label: t('bookings.columns.actions') },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <Card padding="none">
        {isError && (
          <div
            role="alert"
            style={{ padding: '32px', textAlign: 'center', color: 'var(--error)', fontSize: '14px' }}
          >
            {t('bookings.loadError')}
          </div>
        )}

        {!isError && (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{ width: '100%', borderCollapse: 'collapse', minWidth: '540px' }}
              aria-label={t('bookings.tableLabel')}
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
                  <TableSkeleton rows={6} cols={5} />
                ) : bookings.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: 0 }}>
                      <EmptyState
                        style={{ padding: '64px 20px' }}
                        icon={<CalendarDays size={32} strokeWidth={1} />}
                        title={t('bookings.emptyTitle')}
                        description={t('bookings.emptyDescription')}
                      />
                    </td>
                  </tr>
                ) : (
                  bookings.map((booking) => (
                    <tr
                      key={booking.id}
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
                      <td style={{ padding: '13px 16px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        <Bidi>{booking.leadName ?? '—'}</Bidi>
                      </td>
                      <td style={{ padding: '13px 16px', fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        <Bidi>{formatDate(booking.scheduledAt)}</Bidi>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Badge variant={statusToBadgeVariant(booking.status)}>
                          {t(`status.${booking.status}`, { defaultValue: booking.status })}
                        </Badge>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Badge variant="default">
                          {t(`providers.${booking.provider}`, { defaultValue: booking.provider })}
                        </Badge>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        {booking.status !== 'cancelled' && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setCancelTarget(booking)}
                            aria-label={t('bookings.cancelFor', { name: booking.leadName ?? t('bookings.thisLead') })}
                          >
                            {t('bookings.cancel')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={cancelTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCancelTarget(null)
        }}
        title={t('bookings.cancelTitle')}
        description={
          <Trans
            i18nKey="bookings.cancelConfirm"
            values={{
              name: cancelTarget?.leadName ?? t('bookings.thisLead'),
              date: cancelTarget ? formatDate(cancelTarget.scheduledAt) : '',
            }}
            components={{ strong: <strong style={{ color: 'var(--text-primary)' }} /> }}
          />
        }
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCancelTarget(null)}>
              {t('bookings.keepBooking')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => cancelTarget && cancelMutation.mutate(cancelTarget.id)}
              loading={cancelMutation.isPending}
            >
              {t('bookings.confirmCancel')}
            </Button>
          </>
        }
      />

      {cancelMutation.isError && (
        <p role="alert" style={{ fontSize: '13px', color: 'var(--error)' }}>
          {t('bookings.cancelError')}
        </p>
      )}
    </div>
  )
}
