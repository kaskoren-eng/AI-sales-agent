import { MessageSquare, Mail, Phone, BarChart3, FileSpreadsheet, CalendarDays, Calendar, FileUp } from 'lucide-react'
import { Card } from '../components/ui/Card.js'
import { Badge } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'

interface Integration {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  status: 'connected' | 'not_configured'
  configRoute?: string
}

const INTEGRATIONS: Integration[] = [
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Inbound and outbound messaging via UChat',
    icon: <MessageSquare size={24} strokeWidth={1.5} />,
    status: 'not_configured',
  },
  {
    id: 'email',
    name: 'Email',
    description: 'Send and receive emails via Resend',
    icon: <Mail size={24} strokeWidth={1.5} />,
    status: 'not_configured',
  },
  {
    id: 'voice',
    name: 'Voice',
    description: 'Hebrew-first AI voice calls — Zadarma SIP + Retell, migrating to LiveKit + Cartesia',
    icon: <Phone size={24} strokeWidth={1.5} />,
    status: 'not_configured',
  },
  {
    id: 'monday',
    name: 'Monday.com',
    description: 'Sync leads and deals to Monday boards',
    icon: <BarChart3 size={24} strokeWidth={1.5} />,
    status: 'not_configured',
  },
  {
    id: 'google_sheets',
    name: 'Google Sheets',
    description: 'Import leads from Google Sheets',
    icon: <FileSpreadsheet size={24} strokeWidth={1.5} />,
    status: 'not_configured',
  },
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    description: 'Book calls directly to Google Calendar',
    icon: <CalendarDays size={24} strokeWidth={1.5} />,
    status: 'not_configured',
  },
  {
    id: 'trafft',
    name: 'Trafft',
    description: 'Alternate booking provider via Trafft',
    icon: <Calendar size={24} strokeWidth={1.5} />,
    status: 'not_configured',
  },
  {
    id: 'csv_import',
    name: 'CSV Import',
    description: 'Bulk import leads from CSV files',
    icon: <FileUp size={24} strokeWidth={1.5} />,
    status: 'not_configured',
  },
]

const iconColor: Record<Integration['id'], string> = {
  whatsapp: '#25D366',
  email: 'var(--data-1)',
  voice: 'var(--accent-fg)',
  monday: '#F62B54',
  google_sheets: '#34A853',
  google_calendar: '#4285F4',
  trafft: 'var(--data-1)',
  csv_import: 'var(--status-warning)',
}

export function Integrations() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <p style={{ fontSize: '14px', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        Connect your channels and third-party tools. Each integration extends Keren's reach and capabilities.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '16px',
        }}
        role="list"
        aria-label="Available integrations"
      >
        {INTEGRATIONS.map((integration) => {
          const color = iconColor[integration.id] ?? 'var(--data-1)'
          return (
            <Card
              key={integration.id}
              role="listitem"
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              {/* Icon + status row */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '12px',
                    backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
                    border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color,
                    flexShrink: 0,
                  }}
                  aria-hidden="true"
                >
                  {integration.icon}
                </div>
                <Badge
                  variant={integration.status === 'connected' ? 'success' : 'default'}
                >
                  {integration.status === 'connected' ? 'Connected' : 'Not configured'}
                </Badge>
              </div>

              {/* Name + description */}
              <div style={{ flex: 1 }}>
                <h3
                  style={{
                    fontFamily: "'Montserrat', sans-serif",
                    fontWeight: 700,
                    fontSize: '14px',
                    color: 'var(--text-primary)',
                    marginBottom: '4px',
                  }}
                >
                  {integration.name}
                </h3>
                <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                  {integration.description}
                </p>
              </div>

              {/* Configure button */}
              <Button
                variant={integration.status === 'connected' ? 'secondary' : 'secondary'}
                size="sm"
                aria-label={`Configure ${integration.name}`}
                style={{ alignSelf: 'flex-start' }}
              >
                {integration.status === 'connected' ? 'Manage' : 'Configure'}
              </Button>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
