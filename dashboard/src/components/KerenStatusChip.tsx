import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Phone, Users, CalendarDays } from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'

interface ActivityEntry {
  id: string
  type: 'call' | 'lead' | 'booking'
  text: string
  time: string
}

/** Mock activity until a real activity endpoint exists */
const MOCK_ACTIVITY: ActivityEntry[] = [
  { id: '1', type: 'call', text: 'Call completed with Maria Santos', time: '2 min ago' },
  { id: '2', type: 'lead', text: 'New lead qualified: John Park', time: '8 min ago' },
  { id: '3', type: 'booking', text: 'Booking confirmed for Alex Chen', time: '14 min ago' },
  { id: '4', type: 'call', text: 'Outbound call initiated to Sarah Lim', time: '21 min ago' },
  { id: '5', type: 'lead', text: 'Lead scored 87/100: Tomás Rivera', time: '35 min ago' },
]

const typeIcon: Record<ActivityEntry['type'], React.ReactNode> = {
  call: <Phone size={13} strokeWidth={1.5} />,
  lead: <Users size={13} strokeWidth={1.5} />,
  booking: <CalendarDays size={13} strokeWidth={1.5} />,
}

const typeColor: Record<ActivityEntry['type'], string> = {
  call: 'var(--accent-fg)',
  lead: 'var(--data-1)',
  booking: 'var(--status-success)',
}

export function KerenStatusChip() {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          aria-label={t('sidebar.viewActivity')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 12px',
            borderRadius: '8px',
            border: '1px solid rgba(15, 163, 172, 0.2)',
            backgroundColor: 'rgba(15, 163, 172, 0.05)',
            cursor: 'pointer',
            width: '100%',
            transition: `background-color var(--duration-fast) var(--ease-standard)`,
          }}
          onMouseEnter={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(15, 163, 172, 0.1)'
          }}
          onMouseLeave={(e) => {
            ;(e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(15, 163, 172, 0.05)'
          }}
        >
          {/* Pulsing dot */}
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: 'var(--accent-fg)',
              flexShrink: 0,
              animation: 'pulse-dot 2s ease-in-out infinite',
            }}
            aria-hidden="true"
          />
          <span
            style={{
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--accent-fg)',
              fontFamily: "'Assistant', sans-serif",
            }}
          >
            {t('sidebar.kerenActive')}
          </span>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 50,
          }}
        />
        <Dialog.Content
          style={{
            position: 'fixed',
            insetInlineStart: '248px',
            bottom: '20px',
            width: '320px',
            backgroundColor: 'var(--surface-card)',
            border: '1px solid var(--border-default)',
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(38, 37, 36, 0.18)',
            zIndex: 51,
            overflow: 'hidden',
          }}
          aria-describedby="activity-desc"
        >
          <div
            style={{
              padding: '16px 16px 12px',
              borderBottom: '1px solid var(--border-default)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Dialog.Title
              style={{
                fontFamily: "'Montserrat', sans-serif",
                fontWeight: 700,
                fontSize: '13px',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--text-primary)',
              }}
            >
              {t('sidebar.recentActivity')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label={t('sidebar.closeActivity')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '28px',
                  height: '28px',
                  borderRadius: '6px',
                  border: 'none',
                  backgroundColor: 'transparent',
                  color: 'var(--text-tertiary)',
                  cursor: 'pointer',
                }}
              >
                <X size={15} strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>

          <p id="activity-desc" className="sr-only">
            {t('sidebar.activityDescription')}
          </p>

          <ul
            style={{ listStyle: 'none', padding: '8px 0' }}
            role="list"
          >
            {MOCK_ACTIVITY.map((entry) => (
              <li
                key={entry.id}
                style={{
                  padding: '10px 16px',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  borderBottom: '1px solid var(--border-default)',
                }}
              >
                <span
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '6px',
                    backgroundColor: `color-mix(in srgb, ${typeColor[entry.type]} 15%, transparent)`,
                    color: typeColor[entry.type],
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    marginTop: '1px',
                  }}
                  aria-hidden="true"
                >
                  {typeIcon[entry.type]}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.4 }}>
                    {entry.text}
                  </p>
                  <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                    {entry.time}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
