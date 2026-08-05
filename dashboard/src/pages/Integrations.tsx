import { useState, type FormEvent, type ReactNode } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@radix-ui/react-dialog'
import {
  MessageSquare, Mail, Phone, BarChart3, FileSpreadsheet,
  CalendarDays, Calendar, FileUp, Table2, X, Check,
} from 'lucide-react'
import { Card } from '../components/ui/Card.js'
import { Badge } from '../components/ui/Badge.js'
import { Button } from '../components/ui/Button.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import {
  fetchAirtableStatus, configureAirtable, disconnectAirtable,
  fetchMondayStatus, disconnectMonday,
} from '../lib/api.js'

/**
 * Integrations.
 *
 * WHAT THIS PAGE USED TO BE: a static array of eight cards, every one hardcoded to
 * "Not configured", every button a no-op. Meanwhile the backend has had a complete per-tenant
 * Airtable API the whole time — configure, status, disconnect — that nothing ever called. A second
 * tenant therefore had no way to connect their own base, which is the entire point of the feature.
 *
 * The honest structure is that these are not eight equivalent things. Two are self-service and
 * really connect from here. The rest are provisioned by ClickScales during onboarding and are not
 * tenant-editable yet — showing those as "Not configured" beside a button that does nothing tells
 * a customer their product is broken while it is running fine. So they are grouped and labelled
 * for what they actually are.
 */

// ── Self-service: real status, real buttons ──────────────────────────────────────────────────

interface ConnectableMeta {
  id: 'airtable' | 'monday'
  name: string
  description: string
  icon: ReactNode
  color: string
}

const CONNECTABLE: ConnectableMeta[] = [
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Read and write leads in your own Airtable base',
    icon: <Table2 size={22} strokeWidth={1.5} />,
    color: '#FCB400',
  },
  {
    id: 'monday',
    name: 'Monday.com',
    description: 'Sync lead status and call summaries to a Monday board',
    icon: <BarChart3 size={22} strokeWidth={1.5} />,
    color: '#F62B54',
  },
]

// ── Provisioned by ClickScales ───────────────────────────────────────────────────────────────

const PROVISIONED = [
  { id: 'voice', name: 'Voice', description: 'Hebrew-first AI calls — Zadarma SIP, LiveKit, Cartesia', icon: <Phone size={22} strokeWidth={1.5} />, color: 'var(--accent-fg)' },
  { id: 'whatsapp', name: 'WhatsApp', description: 'Inbound and outbound messaging', icon: <MessageSquare size={22} strokeWidth={1.5} />, color: '#25D366' },
  { id: 'email', name: 'Email', description: 'Send and receive email', icon: <Mail size={22} strokeWidth={1.5} />, color: 'var(--data-1)' },
  { id: 'google_calendar', name: 'Google Calendar', description: 'Meetings booked straight into the calendar', icon: <CalendarDays size={22} strokeWidth={1.5} />, color: '#4285F4' },
  { id: 'google_sheets', name: 'Google Sheets', description: 'Import leads from a sheet', icon: <FileSpreadsheet size={22} strokeWidth={1.5} />, color: '#34A853' },
  { id: 'trafft', name: 'Trafft', description: 'Alternate booking provider', icon: <Calendar size={22} strokeWidth={1.5} />, color: 'var(--data-1)' },
  { id: 'csv_import', name: 'CSV Import', description: 'Bulk import — on the Leads page', icon: <FileUp size={22} strokeWidth={1.5} />, color: 'var(--status-warning)' },
]

// ── Shared bits ──────────────────────────────────────────────────────────────────────────────

const iconTile = (color: string, size = 44): React.CSSProperties => ({
  inlineSize: `${size}px`,
  blockSize: `${size}px`,
  borderRadius: size >= 44 ? '11px' : '10px',
  backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
  border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color,
  flexShrink: 0,
})

const cardTitle: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: '14px',
  color: 'var(--text-primary)',
  marginBlockEnd: '4px',
}

const cardBody: React.CSSProperties = {
  fontSize: '13px',
  color: 'var(--text-tertiary)',
  lineHeight: 1.5,
}

const sectionCap: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--text-tertiary)',
  marginBlockEnd: '10px',
}

const field: React.CSSProperties = {
  inlineSize: '100%',
  paddingBlock: '9px',
  paddingInline: '11px',
  borderRadius: '9px',
  border: '1px solid var(--border-default)',
  background: 'var(--surface-sunken)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '13px',
  outline: 'none',
}

const dialogContent: React.CSSProperties = {
  position: 'fixed',
  insetBlockStart: '50%',
  insetInlineStart: '50%',
  transform: 'translate(-50%, -50%)',
  inlineSize: 'calc(100vw - 32px)',
  maxInlineSize: '440px',
  maxBlockSize: '86vh',
  overflowY: 'auto',
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: '24px',
  zIndex: 51,
}

/**
 * The connected-state strip: the identifiers, in mono, on the card.
 *
 * Deliberately shows the real base and table ids rather than a bare "Connected" chip. "Connected
 * to WHICH base" is the question someone actually has when a lead lands somewhere unexpected, and
 * this page is the only place that can answer it.
 */
function DataStrip({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div
      style={{
        borderBlockStart: '1px solid var(--border-default)',
        paddingBlockStart: '11px',
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
          <span className="mono-label" style={{ fontSize: '10px', color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {label}
          </span>
          <span
            dir="ltr"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              color: 'var(--text-secondary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBlockStart: '14px' }}>
      <label className="mono-label" style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBlockEnd: '6px' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

// ── Airtable connect dialog ──────────────────────────────────────────────────────────────────

function AirtableDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const [apiKey, setApiKey] = useState('')
  const [baseId, setBaseId] = useState('')
  const [tableId, setTableId] = useState('')
  const [phoneFieldName, setPhoneFieldName] = useState('')
  const [emailFieldName, setEmailFieldName] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      configureAirtable({
        apiKey: apiKey.trim(),
        baseId: baseId.trim(),
        tableId: tableId.trim(),
        phoneFieldName: phoneFieldName.trim() || undefined,
        emailFieldName: emailFieldName.trim() || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['airtable-status'] })
      onOpenChange(false)
      // The token never stays in memory after a successful save — it lives encrypted server-side
      // and is never returned by the status endpoint.
      setApiKey('')
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!mutation.isPending) mutation.mutate()
  }

  const ready = apiKey.trim() !== '' && baseId.trim() !== '' && tableId.trim() !== ''

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 50 }} />
        <Dialog.Content style={dialogContent} aria-describedby="airtable-desc">
          <form onSubmit={submit}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBlockEnd: '10px' }}>
              <Dialog.Title style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '16px', color: 'var(--text-primary)' }}>
                Connect Airtable
              </Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" aria-label="Close" style={{ background: 'none', border: 0, color: 'var(--text-tertiary)', cursor: 'pointer', padding: '2px' }}>
                  <X size={16} strokeWidth={1.5} />
                </button>
              </Dialog.Close>
            </div>

            <p id="airtable-desc" style={cardBody}>
              The token is checked against Airtable before it is saved, so a wrong value fails here
              rather than silently during a call.
            </p>

            <Field label="Personal access token">
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off" autoFocus dir="ltr" style={field} placeholder="pat..." />
            </Field>
            <Field label="Base ID">
              <input value={baseId} onChange={(e) => setBaseId(e.target.value)} dir="ltr" style={field} placeholder="app..." />
            </Field>
            <Field label="Table ID">
              <input value={tableId} onChange={(e) => setTableId(e.target.value)} dir="ltr" style={field} placeholder="tbl..." />
            </Field>
            <Field label="Phone field (optional)">
              <input value={phoneFieldName} onChange={(e) => setPhoneFieldName(e.target.value)} dir="auto" style={field} />
            </Field>
            <Field label="Email field (optional)">
              <input value={emailFieldName} onChange={(e) => setEmailFieldName(e.target.value)} dir="auto" style={field} />
            </Field>

            {mutation.isError && (
              <p role="alert" style={{ fontSize: '12.5px', color: 'var(--status-danger)', marginBlockStart: '14px', lineHeight: 1.5 }}>
                {mutation.error instanceof Error ? mutation.error.message : 'Could not connect Airtable'}
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginBlockStart: '20px' }}>
              <Dialog.Close asChild>
                <Button type="button" variant="secondary" size="sm">Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" size="sm" loading={mutation.isPending} disabled={!ready}>
                Connect
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────────────────────

export function Integrations() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [airtableOpen, setAirtableOpen] = useState(false)

  const airtable = useQuery({ queryKey: ['airtable-status'], queryFn: fetchAirtableStatus, staleTime: 30_000 })
  const monday = useQuery({ queryKey: ['monday-status'], queryFn: fetchMondayStatus, staleTime: 30_000 })

  const disconnect = useMutation({
    mutationFn: (id: 'airtable' | 'monday') => (id === 'airtable' ? disconnectAirtable() : disconnectMonday()),
    onSuccess: (_r, id) => {
      void queryClient.invalidateQueries({ queryKey: [`${id}-status`] })
    },
  })

  const statusFor = (id: 'airtable' | 'monday') => (id === 'airtable' ? airtable : monday)

  const stripFor = (id: 'airtable' | 'monday'): Array<[string, string]> => {
    if (id === 'airtable' && airtable.data?.connected) {
      return [
        ['base', airtable.data.baseId ?? '—'],
        ['table', airtable.data.tableId ?? '—'],
      ]
    }
    if (id === 'monday' && monday.data?.connected) {
      return [['board', monday.data.boardId ?? '—']]
    }
    return []
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
      <p style={{ fontSize: '14px', color: 'var(--text-tertiary)', lineHeight: 1.6, maxInlineSize: '640px' }}>
        {t('integrations.blurb', 'Connect your own tools, and see what ClickScales runs for you.')}
      </p>

      {/* Self-service */}
      <section>
        <div className="mono-label" style={sectionCap}>
          {t('integrations.yours', 'Your tools')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }} role="list">
          {CONNECTABLE.map((meta) => {
            const q = statusFor(meta.id)
            const connected = q.data?.connected === true
            const strip = stripFor(meta.id)

            return (
              <Card key={meta.id} role="listitem" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={iconTile(meta.color)} aria-hidden>{meta.icon}</div>
                  {q.isLoading ? (
                    <Skeleton height="20px" width="88px" />
                  ) : (
                    <Badge variant={connected ? 'success' : 'default'}>
                      {connected ? t('integrations.connected', 'Connected') : t('integrations.notConnected', 'Not connected')}
                    </Badge>
                  )}
                </div>

                <div style={{ flex: 1 }}>
                  <h3 style={cardTitle}>{meta.name}</h3>
                  <p style={cardBody}>{meta.description}</p>
                </div>

                {strip.length > 0 && <DataStrip rows={strip} />}

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {meta.id === 'airtable' ? (
                    <Button variant={connected ? 'secondary' : 'primary'} size="sm" onClick={() => setAirtableOpen(true)}>
                      {connected ? t('integrations.reconnect', 'Reconnect') : t('integrations.connect', 'Connect')}
                    </Button>
                  ) : (
                    // Monday's connect flow needs a board picker, which lives behind endpoints this
                    // page does not use yet. Rather than a button that half-works, the card shows
                    // real status and says plainly where the job gets finished.
                    !connected && (
                      <span style={{ ...cardBody, fontSize: '12.5px' }}>
                        {t('integrations.viaApi', 'Connect via the API — board picker lands here next')}
                      </span>
                    )
                  )}

                  {connected && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={disconnect.isPending && disconnect.variables === meta.id}
                      onClick={() => disconnect.mutate(meta.id)}
                    >
                      {t('integrations.disconnect', 'Disconnect')}
                    </Button>
                  )}
                </div>

                {q.isError && (
                  <p role="alert" style={{ fontSize: '12px', color: 'var(--status-danger)' }}>
                    {t('integrations.statusFailed', 'Could not load status')}
                  </p>
                )}
              </Card>
            )
          })}
        </div>
      </section>

      {/* Provisioned */}
      <section>
        <div className="mono-label" style={sectionCap}>
          {t('integrations.managed', 'Run by ClickScales')}
        </div>
        <p style={{ ...cardBody, marginBlockEnd: '14px', maxInlineSize: '640px' }}>
          {t(
            'integrations.managedBlurb',
            'Set up for you during onboarding. Ask us to change one and it changes the same day.',
          )}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }} role="list">
          {PROVISIONED.map((meta) => (
            <Card key={meta.id} role="listitem" style={{ display: 'flex', alignItems: 'center', gap: '13px', padding: '14px' }}>
              <div style={iconTile(meta.color, 38)} aria-hidden>{meta.icon}</div>
              <div style={{ minInlineSize: 0 }}>
                <h3 style={{ ...cardTitle, marginBlockEnd: '2px' }}>{meta.name}</h3>
                <p style={{ ...cardBody, fontSize: '12.5px' }}>{meta.description}</p>
              </div>
              <Check size={15} strokeWidth={2} style={{ color: 'var(--status-success)', marginInlineStart: 'auto', flexShrink: 0 }} aria-hidden />
            </Card>
          ))}
        </div>
      </section>

      <AirtableDialog open={airtableOpen} onOpenChange={setAirtableOpen} />
    </div>
  )
}
