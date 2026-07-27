import { useState, useEffect, useId } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as Tabs from '@radix-ui/react-tabs'
import * as Dialog from '@radix-ui/react-dialog'
import { Eye, EyeOff, RefreshCw, X, Save, CheckCircle2, Phone, Trash2 } from 'lucide-react'
import {
  fetchTenantMe,
  updateTenantMe,
  regenerateApiKey,
  fetchBusinessProfile,
  saveBusinessProfile,
  fetchTwilioSettings,
  saveTwilioSettings,
  deleteTwilioSettings,
  type BusinessProfile,
} from '../lib/api.js'
import { Button } from '../components/ui/Button.js'
import { Card } from '../components/ui/Card.js'
import { Skeleton } from '../components/ui/Skeleton.js'

function maskApiKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length)
  return key.slice(0, 4) + '•'.repeat(Math.max(0, key.length - 8)) + key.slice(-4)
}

function GeneralTab() {
  const nameId = useId()
  const queryClient = useQueryClient()
  const { data: tenant, isLoading } = useQuery({
    queryKey: ['tenant-me'],
    queryFn: fetchTenantMe,
    staleTime: 60_000,
  })

  const [displayName, setDisplayName] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (tenant?.name) setDisplayName(tenant.name)
  }, [tenant?.name])

  const mutation = useMutation({
    mutationFn: () => updateTenantMe({ name: displayName }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenant-me'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '480px' }}>
      <Card>
        <h3
          style={{
            fontFamily: "'Montserrat', sans-serif",
            fontWeight: 700,
            fontSize: '12px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            marginBottom: '16px',
          }}
        >
          Account
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label
              htmlFor={nameId}
              style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px', fontWeight: 600 }}
            >
              Display Name
            </label>
            {isLoading ? (
              <Skeleton height="36px" />
            ) : (
              <input
                id={nameId}
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your organization name"
                style={{
                  width: '100%',
                  height: '36px',
                  backgroundColor: 'var(--bg-inset)',
                  border: '1px solid var(--border-default)',
                  borderRadius: '8px',
                  padding: '0 12px',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  fontFamily: "'Assistant', sans-serif",
                  outline: 'none',
                }}
              />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => mutation.mutate()}
              loading={mutation.isPending}
              disabled={isLoading || !displayName.trim()}
            >
              <Save size={14} strokeWidth={1.5} /> Save Changes
            </Button>
            {saved && (
              <span style={{ fontSize: '12px', color: 'var(--success)' }}>Saved</span>
            )}
            {mutation.isError && (
              <span role="alert" style={{ fontSize: '12px', color: 'var(--error)' }}>
                Save failed
              </span>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

function FlowsTab() {
  const queryClient = useQueryClient()
  const { data: tenant, isLoading } = useQuery({
    queryKey: ['tenant-me'],
    queryFn: fetchTenantMe,
    staleTime: 60_000,
  })

  const [flowJson, setFlowJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (tenant?.settings != null) {
      setFlowJson(JSON.stringify(tenant.settings, null, 2))
    }
  }, [tenant?.settings])

  const handleChange = (val: string) => {
    setFlowJson(val)
    try {
      JSON.parse(val)
      setJsonError(null)
    } catch {
      setJsonError('Invalid JSON')
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = JSON.parse(flowJson) as Record<string, unknown>
      return updateTenantMe({ settings: parsed })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenant-me'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '680px' }}>
      <Card>
        <h3
          style={{
            fontFamily: "'Montserrat', sans-serif",
            fontWeight: 700,
            fontSize: '12px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            marginBottom: '8px',
          }}
        >
          Flow Configuration
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
          Define automation flows in JSON. Changes are applied on the next lead qualification cycle.
        </p>
        {isLoading ? (
          <Skeleton height="240px" />
        ) : (
          <textarea
            value={flowJson}
            onChange={(e) => handleChange(e.target.value)}
            aria-label="Flow configuration JSON"
            aria-describedby={jsonError ? 'json-error' : undefined}
            aria-invalid={jsonError != null}
            spellCheck={false}
            style={{
              width: '100%',
              height: '280px',
              backgroundColor: 'var(--bg-inset)',
              border: `1px solid ${jsonError ? 'var(--error)' : 'var(--border-default)'}`,
              borderRadius: '8px',
              padding: '12px',
              color: 'var(--text-primary)',
              fontSize: '13px',
              fontFamily: "'Courier New', monospace",
              lineHeight: 1.6,
              outline: 'none',
              resize: 'vertical',
              marginBottom: '8px',
            }}
          />
        )}
        {jsonError && (
          <p id="json-error" role="alert" style={{ fontSize: '12px', color: 'var(--error)', marginBottom: '8px' }}>
            {jsonError}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={isLoading || !!jsonError || !flowJson.trim()}
          >
            <Save size={14} strokeWidth={1.5} /> Save Flow Config
          </Button>
          {saved && <span style={{ fontSize: '12px', color: 'var(--success)' }}>Saved</span>}
          {mutation.isError && (
            <span role="alert" style={{ fontSize: '12px', color: 'var(--error)' }}>
              Save failed
            </span>
          )}
        </div>
      </Card>
    </div>
  )
}

function ApiTab() {
  const [showKey, setShowKey] = useState(false)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [regenOpen, setRegenOpen] = useState(false)

  const mutation = useMutation({
    mutationFn: regenerateApiKey,
    onSuccess: (data) => {
      setNewKey(data.apiKey)
      setRegenOpen(false)
    },
  })

  const displayKey = newKey ?? '••••••••••••••••••••••••••••••••'
  const maskedKey = maskApiKey(displayKey)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '540px' }}>
      <Card>
        <h3
          style={{
            fontFamily: "'Montserrat', sans-serif",
            fontWeight: 700,
            fontSize: '12px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            marginBottom: '16px',
          }}
        >
          API Key
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
          Use this key to authenticate API requests. Keep it secret — it grants full access to your tenant.
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 12px',
            backgroundColor: 'var(--bg-inset)',
            border: '1px solid var(--border-default)',
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          <code
            style={{
              flex: 1,
              fontSize: '13px',
              fontFamily: "'Courier New', monospace",
              color: 'var(--text-secondary)',
              wordBreak: 'break-all',
            }}
            aria-label={showKey ? 'API key (visible)' : 'API key (hidden)'}
          >
            {showKey ? displayKey : maskedKey}
          </code>
          <button
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            {showKey ? <EyeOff size={15} strokeWidth={1.5} /> : <Eye size={15} strokeWidth={1.5} />}
          </button>
        </div>

        {newKey && (
          <div
            role="alert"
            style={{
              padding: '10px 12px',
              backgroundColor: 'rgba(16, 185, 129, 0.08)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              borderRadius: '8px',
              fontSize: '13px',
              color: 'var(--success)',
              marginBottom: '16px',
              lineHeight: 1.5,
            }}
          >
            New key generated. Copy it now — it will not be shown again.
          </div>
        )}

        <Button
          variant="danger"
          size="sm"
          onClick={() => setRegenOpen(true)}
          aria-label="Regenerate API key"
        >
          <RefreshCw size={14} strokeWidth={1.5} /> Regenerate Key
        </Button>
      </Card>

      {/* Confirmation dialog */}
      <Dialog.Root open={regenOpen} onOpenChange={setRegenOpen}>
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
              width: '400px',
              backgroundColor: 'var(--glass-bg-solid)',
              border: '1px solid var(--border-default)',
              borderRadius: '12px',
              boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
              padding: '24px',
              zIndex: 51,
            }}
            aria-describedby="regen-key-desc"
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
                Regenerate API Key
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
              id="regen-key-desc"
              style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '24px' }}
            >
              This will immediately invalidate your current API key. Any integrations using the old key will stop working until updated. Are you sure?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <Dialog.Close asChild>
                <Button variant="secondary" size="sm">Cancel</Button>
              </Dialog.Close>
              <Button
                variant="danger"
                size="sm"
                onClick={() => mutation.mutate()}
                loading={mutation.isPending}
              >
                Yes, regenerate
              </Button>
            </div>
            {mutation.isError && (
              <p role="alert" style={{ fontSize: '12px', color: 'var(--error)', marginTop: '12px' }}>
                Failed to regenerate key. Please try again.
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px', fontWeight: 600 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  backgroundColor: 'var(--bg-inset)',
  border: '1px solid var(--border-default)',
  borderRadius: '8px',
  padding: '8px 12px',
  color: 'var(--text-primary)',
  fontSize: '14px',
  fontFamily: "'Assistant', sans-serif",
  outline: 'none',
  boxSizing: 'border-box',
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: '80px',
  lineHeight: 1.5,
}

const EMPTY_PROFILE: BusinessProfile = {
  companyName: '',
  description: '',
  product: '',
  targetAudience: '',
  pricing: '',
  commonObjections: '',
  toneOfVoice: '',
  language: 'hebrew',
}

function AgentTab() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['business-profile'],
    queryFn: fetchBusinessProfile,
    staleTime: 60_000,
  })

  const [form, setForm] = useState<BusinessProfile>(EMPTY_PROFILE)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (data?.businessProfile) setForm(data.businessProfile)
  }, [data?.businessProfile])

  const set = (field: keyof BusinessProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }))
  }

  const mutation = useMutation({
    mutationFn: () => saveBusinessProfile(form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['business-profile'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  if (isLoading) return <Skeleton height="400px" />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '560px' }}>
      <Card>
        <h3 style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '4px' }}>
          Agent Business Profile
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px', lineHeight: 1.5 }}>
          This information is injected into every call so your agent speaks as your brand — not a generic bot.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FieldGroup label="Company Name">
            <input style={inputStyle} value={form.companyName} onChange={set('companyName')} placeholder="e.g. ClickScales" />
          </FieldGroup>

          <FieldGroup label="What does your business do?">
            <textarea style={textareaStyle} value={form.description} onChange={set('description')} placeholder="We build AI-powered sales agents for Israeli SMBs that qualify leads and book meetings automatically..." />
          </FieldGroup>

          <FieldGroup label="What are you selling?">
            <textarea style={textareaStyle} value={form.product} onChange={set('product')} placeholder="An AI sales agent SaaS platform — monthly subscription starting at ₪499/mo..." />
          </FieldGroup>

          <FieldGroup label="Who is your ideal customer?">
            <textarea style={{ ...textareaStyle, minHeight: '64px' }} value={form.targetAudience} onChange={set('targetAudience')} placeholder="Israeli business owners with 2–20 person sales teams who spend too much time manually following up with leads..." />
          </FieldGroup>

          <FieldGroup label="Pricing (optional)">
            <input style={inputStyle} value={form.pricing} onChange={set('pricing')} placeholder="₪499/mo Starter, ₪1,499/mo Pro, ₪3,999/mo Enterprise" />
          </FieldGroup>

          <FieldGroup label="Common objections & how to handle them (optional)">
            <textarea style={textareaStyle} value={form.commonObjections} onChange={set('commonObjections')} placeholder="'It's too expensive' → Remind them of the cost of a human SDR. 'We're not ready' → Ask what would need to change..." />
          </FieldGroup>

          <FieldGroup label="Tone of voice (optional)">
            <input style={inputStyle} value={form.toneOfVoice} onChange={set('toneOfVoice')} placeholder="Confident but warm. Direct. Not pushy. Speak like a trusted advisor." />
          </FieldGroup>

          <FieldGroup label="Language">
            <select style={{ ...inputStyle, height: '36px', cursor: 'pointer' }} value={form.language} onChange={set('language')}>
              <option value="hebrew">Hebrew (default)</option>
              <option value="english">English</option>
              <option value="both">Both — follow the lead</option>
            </select>
          </FieldGroup>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '20px' }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!form.companyName.trim() || !form.description.trim() || !form.product.trim()}
          >
            <Save size={14} strokeWidth={1.5} /> Save Profile
          </Button>
          {saved && <span style={{ fontSize: '12px', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '4px' }}><CheckCircle2 size={13} /> Saved</span>}
          {mutation.isError && <span role="alert" style={{ fontSize: '12px', color: 'var(--error)' }}>Save failed — try again</span>}
        </div>
      </Card>
    </div>
  )
}

function TwilioTab() {
  const queryClient = useQueryClient()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [form, setForm] = useState({ accountSid: '', authToken: '', phoneNumber: '' })
  const [saved, setSaved] = useState(false)

  const { data: status, isLoading } = useQuery({
    queryKey: ['twilio-settings'],
    queryFn: fetchTwilioSettings,
    staleTime: 60_000,
  })

  const saveMutation = useMutation({
    mutationFn: () => saveTwilioSettings(form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['twilio-settings'] })
      setForm({ accountSid: '', authToken: '', phoneNumber: '' })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: deleteTwilioSettings,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['twilio-settings'] })
      setConfirmDisconnect(false)
    },
  })

  const canSave = form.accountSid.startsWith('AC') && form.accountSid.length === 34 && form.authToken.length >= 32 && form.phoneNumber.length >= 7

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '560px' }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
          <Phone size={16} strokeWidth={1.5} color="var(--accent-teal)" />
          <h3 style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Twilio Account
          </h3>
        </div>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '20px', lineHeight: 1.5 }}>
          Connect your own Twilio account. Your agent will make and receive calls using your number — billed directly by Twilio.
        </p>

        {isLoading ? (
          <Skeleton height="120px" />
        ) : status?.configured ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ padding: '12px 14px', backgroundColor: 'rgba(16, 185, 129, 0.07)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <CheckCircle2 size={14} color="var(--success)" />
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--success)' }}>Connected</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Account SID: <code style={{ color: 'var(--text-secondary)' }}>{status.accountSid}</code></span>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Phone: <code style={{ color: 'var(--text-secondary)' }}>{status.phoneNumber}</code></span>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Auth Token: <code style={{ color: 'var(--text-secondary)' }}>{status.authTokenMasked}</code></span>
                {status.configuredAt && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Configured {new Date(status.configuredAt).toLocaleDateString()}</span>}
              </div>
            </div>
            <Button variant="danger" size="sm" onClick={() => setConfirmDisconnect(true)}>
              <Trash2 size={13} strokeWidth={1.5} /> Disconnect Twilio
            </Button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <FieldGroup label="Account SID">
              <input
                style={inputStyle}
                value={form.accountSid}
                onChange={(e) => setForm((p) => ({ ...p, accountSid: e.target.value.trim() }))}
                placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                autoComplete="off"
              />
            </FieldGroup>

            <FieldGroup label="Auth Token">
              <div style={{ position: 'relative' }}>
                <input
                  style={{ ...inputStyle, paddingRight: '40px' }}
                  type={showToken ? 'text' : 'password'}
                  value={form.authToken}
                  onChange={(e) => setForm((p) => ({ ...p, authToken: e.target.value.trim() }))}
                  placeholder="Your Twilio Auth Token"
                  autoComplete="new-password"
                />
                <button
                  onClick={() => setShowToken((v) => !v)}
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                  style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center' }}
                >
                  {showToken ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
                </button>
              </div>
            </FieldGroup>

            <FieldGroup label="Phone Number (E.164 format)">
              <input
                style={inputStyle}
                value={form.phoneNumber}
                onChange={(e) => setForm((p) => ({ ...p, phoneNumber: e.target.value.trim() }))}
                placeholder="+972501234567"
                autoComplete="off"
              />
            </FieldGroup>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
              <Button
                variant="primary"
                size="sm"
                onClick={() => saveMutation.mutate()}
                loading={saveMutation.isPending}
                disabled={!canSave}
              >
                <Save size={14} strokeWidth={1.5} /> Connect Twilio
              </Button>
              {saved && <span style={{ fontSize: '12px', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '4px' }}><CheckCircle2 size={13} /> Connected</span>}
              {saveMutation.isError && <span role="alert" style={{ fontSize: '12px', color: 'var(--error)' }}>Save failed — check credentials</span>}
            </div>

            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.5 }}>
              Find your Account SID and Auth Token in the{' '}
              <span style={{ color: 'var(--accent-teal)' }}>Twilio Console → Dashboard</span>.
              Your auth token is encrypted before storage.
            </p>
          </div>
        )}
      </Card>

      {/* Disconnect confirmation dialog */}
      <Dialog.Root open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <Dialog.Portal>
          <Dialog.Overlay style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 50 }} />
          <Dialog.Content
            style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '400px', backgroundColor: 'var(--glass-bg-solid)', border: '1px solid var(--border-default)', borderRadius: '12px', boxShadow: '0 16px 48px rgba(0,0,0,0.6)', padding: '24px', zIndex: 51 }}
            aria-describedby="disconnect-desc"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <Dialog.Title style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>
                Disconnect Twilio?
              </Dialog.Title>
              <Dialog.Close asChild>
                <button aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px' }}>
                  <X size={16} strokeWidth={1.5} />
                </button>
              </Dialog.Close>
            </div>
            <p id="disconnect-desc" style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '24px' }}>
              Your Twilio credentials will be removed. Voice calls will stop working until you reconnect.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <Dialog.Close asChild>
                <Button variant="secondary" size="sm">Cancel</Button>
              </Dialog.Close>
              <Button variant="danger" size="sm" onClick={() => disconnectMutation.mutate()} loading={disconnectMutation.isPending}>
                Yes, disconnect
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

const tabTriggerStyle = (active: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  backgroundColor: 'transparent',
  border: 'none',
  borderBottom: active ? '2px solid var(--accent-teal)' : '2px solid transparent',
  color: active ? 'var(--accent-teal)' : 'var(--text-secondary)',
  fontFamily: "'Assistant', sans-serif",
  fontWeight: 600,
  fontSize: '14px',
  cursor: 'pointer',
  transition: `color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)`,
  whiteSpace: 'nowrap',
})

export function Settings() {
  const [activeTab, setActiveTab] = useState('agent')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
        {/* Tab list */}
        <Tabs.List
          aria-label="Settings sections"
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-subtle)',
            marginBottom: '24px',
          }}
        >
          {[
            { value: 'agent', label: 'Agent' },
            { value: 'twilio', label: 'Twilio' },
            { value: 'general', label: 'General' },
            { value: 'flows', label: 'Flows' },
            { value: 'api', label: 'API' },
          ].map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              style={tabTriggerStyle(activeTab === tab.value)}
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="agent">
          <AgentTab />
        </Tabs.Content>
        <Tabs.Content value="twilio">
          <TwilioTab />
        </Tabs.Content>
        <Tabs.Content value="general">
          <GeneralTab />
        </Tabs.Content>
        <Tabs.Content value="flows">
          <FlowsTab />
        </Tabs.Content>
        <Tabs.Content value="api">
          <ApiTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}
