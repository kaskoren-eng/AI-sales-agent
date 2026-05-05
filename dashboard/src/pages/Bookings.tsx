import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, X } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import { fetchBookings } from '../lib/api.js'
import { Badge, statusToBadgeVariant } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'
import { Card } from '../components/ui/Card.js'
import { TableSkeleton } from '../components/ui/Skeleton.js'
import { formatDate } from '../lib/format.js'
import { apiFetch } from '../lib/apiClient.js'
import type { Booking } from '../lib/types.js'

const providerLabel: Record<string, string> = {
  google_calendar: 'Google Calendar',
  trafft: 'Trafft',
}

function CancelDialog({
  booking,
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  booking: Booking | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onConfirm: () => void
  isPending: boolean
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.6)',
            zIndex: 50,
          }}
        />
        <Dialog.Content
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '380px',
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-default)',
            borderRadius: '12px',
            boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
            padding: '24px',
            zIndex: 51,
          }}
          aria-describedby="cancel-booking-desc"
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
            <Dialog.Title
              style={{
                fontFamily: "'Montserrat', sans-serif",
                fontWeight: 700,
                fontSize: '15px',
                color: 'var(--text-primary)',
              }}
            >
              Cancel Booking
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="Close dialog"
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px' }}
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>
          <p
            id="cancel-booking-desc"
            style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '24px' }}
          >
            Are you sure you want to cancel the booking for{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {booking?.leadName ?? 'this lead'}
            </strong>
            {' '}on{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {booking ? formatDate(booking.scheduledAt) : ''}
            </strong>
            ? This action cannot be undone.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <Dialog.Close asChild>
              <Button variant="secondary" size="sm">Keep booking</Button>
            </Dialog.Close>
            <Button variant="danger" size="sm" onClick={onConfirm} loading={isPending}>
              Cancel booking
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function Bookings() {
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <Card padding="none">
        {isError && (
          <div
            role="alert"
            style={{ padding: '32px', textAlign: 'center', color: 'var(--error)', fontSize: '14px' }}
          >
            Failed to load bookings. Please try again.
          </div>
        )}

        {!isError && (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{ width: '100%', borderCollapse: 'collapse', minWidth: '540px' }}
              aria-label="Bookings table"
              aria-busy={isLoading}
            >
              <thead>
                <tr>
                  {['Lead', 'Date / Time', 'Status', 'Provider', 'Actions'].map((h) => (
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
                  <TableSkeleton rows={6} cols={5} />
                ) : bookings.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: '64px 20px', textAlign: 'center' }}>
                      <CalendarDays size={32} strokeWidth={1} style={{ color: 'var(--text-disabled)', display: 'block', margin: '0 auto 12px' }} />
                      <p style={{ fontSize: '15px', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '6px' }}>
                        No bookings yet
                      </p>
                      <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                        Bookings will appear here once leads are scheduled.
                      </p>
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
                        ;(e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--bg-elevated)'
                      }}
                      onMouseLeave={(e) => {
                        ;(e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent'
                      }}
                    >
                      <td style={{ padding: '13px 16px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {booking.leadName ?? '—'}
                      </td>
                      <td style={{ padding: '13px 16px', fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {formatDate(booking.scheduledAt)}
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Badge variant={statusToBadgeVariant(booking.status)}>{booking.status}</Badge>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        <Badge variant="default">
                          {providerLabel[booking.provider] ?? booking.provider}
                        </Badge>
                      </td>
                      <td style={{ padding: '13px 16px' }}>
                        {booking.status !== 'cancelled' && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setCancelTarget(booking)}
                            aria-label={`Cancel booking for ${booking.leadName ?? 'this lead'}`}
                          >
                            Cancel
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

      <CancelDialog
        booking={cancelTarget}
        open={cancelTarget !== null}
        onOpenChange={(open) => { if (!open) setCancelTarget(null) }}
        onConfirm={() => cancelTarget && cancelMutation.mutate(cancelTarget.id)}
        isPending={cancelMutation.isPending}
      />

      {cancelMutation.isError && (
        <p role="alert" style={{ fontSize: '13px', color: 'var(--error)' }}>
          Failed to cancel booking. Please try again.
        </p>
      )}
    </div>
  )
}
